/**
 * Ingest · Stage 2, part B: code chunker (AST).
 *
 * Walk a syntax tree and emit chunks at function / method / class granularity. A
 * function stays whole by default (never split mid-statement), and each chunk carries
 * the line range + symbol name that citations are built from.
 *
 * Algorithm (per file):
 *  - LEAF nodes (functions/methods) → emit a chunk, do not descend.
 *  - CONTAINER nodes (classes/interfaces): if they contain methods, descend so the
 *    methods become chunks with `parentSymbol` = the container; if they contain none
 *    (a data class / Go struct), emit the whole container as one chunk.
 *  - A code file that yields no AST chunks (e.g. a top-level script) falls back to a
 *    single whole-file chunk, so nothing is silently dropped.
 *  - OVERSIZED functions (> MAX_FUNCTION_LINES) are split into fixed-size parts, each
 *    with the original signature line repeated at the top for context (see
 *    `splitOversized`). This keeps any single chunk from dominating retrieval/context
 *    while still being individually citable and re-findable.
 */

import type { CodeLanguage, SymbolType } from '../../../core/types.ts';
import { parse, type Grammar, type TSNode } from './treesitter.ts';

export interface RawChunk {
  symbolName: string;
  symbolType: SymbolType;
  parentSymbol?: string;
  startLine: number;
  endLine: number;
  content: string;
}

interface LangDef {
  grammar: Grammar;
  /** Emit-and-stop node types (functions/methods). */
  leaf: Set<string>;
  /** Container node types (classes/interfaces/…) → descend for methods. */
  container: Set<string>;
  /** node.type → symbol label. */
  label: (type: string) => SymbolType;
}

const jsLeaf = new Set([
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'interface_declaration', // TS
  'type_alias_declaration', // TS
  'enum_declaration', // TS
]);
const jsContainer = new Set(['class_declaration']);

function jsLabel(type: string): SymbolType {
  if (type === 'method_definition') return 'method';
  if (type === 'class_declaration') return 'class';
  if (type === 'interface_declaration') return 'interface';
  if (type === 'enum_declaration') return 'enum';
  if (type === 'type_alias_declaration') return 'type';
  return 'function';
}

/** JS/TS: an arrow/function expression bound to a variable, e.g. `const foo = () => {…}`. */
const FUNCTION_VALUE = /^(arrow_function|function|function_expression|generator_function)$/;

/**
 * Line-count proxy for ADR-0002's "~1500 tokens" oversized threshold — simple, and
 * generous enough that ordinary functions (this repo's largest is ~76 lines) stay
 * whole; only genuinely large ones split. Real token counting can replace this later
 * without changing the splitting shape.
 */
const MAX_FUNCTION_LINES = 100;
/** Lines of *new* body per part (the repeated header on parts 2+ is on top of this). */
const FUNCTION_WINDOW_LINES = 40;

/**
 * Split an oversized chunk into fixed-size parts. Part 1 keeps the original line
 * range; parts 2+ prepend the original first line (the signature) so each part stays
 * self-describing, per ADR-0002. `startLine`/`endLine` on every part describe the
 * actual file lines that part's *unique* body covers (the repeated header is a
 * synthetic addition for context, not counted in the range).
 *
 * No-op (returns [raw]) when the chunk is at or under the threshold.
 */
export function splitOversized(raw: RawChunk): RawChunk[] {
  const lines = raw.content.split('\n');
  if (lines.length <= MAX_FUNCTION_LINES) return [raw];

  const header = lines[0];
  const totalParts = Math.ceil(lines.length / FUNCTION_WINDOW_LINES);
  const parts: RawChunk[] = [];

  for (let i = 0, partNum = 1; i < lines.length; i += FUNCTION_WINDOW_LINES, partNum++) {
    const slice = lines.slice(i, i + FUNCTION_WINDOW_LINES);
    const isFirst = i === 0;
    const contentLines = isFirst
      ? slice
      : [header, `// … continued: ${raw.symbolName} (part ${partNum}/${totalParts}) …`, ...slice];

    parts.push({
      ...raw,
      symbolName: `${raw.symbolName} [part ${partNum}/${totalParts}]`,
      startLine: raw.startLine + i,
      endLine: raw.startLine + Math.min(i + slice.length, lines.length) - 1,
      content: contentLines.join('\n'),
    });
  }
  return parts;
}

/** Grammar chosen by file extension (keeps .tsx vs .ts and jsx correct). */
export function grammarForExt(ext: string): Grammar {
  switch (ext.toLowerCase()) {
    case '.tsx':
      return 'tsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.py':
      return 'python';
    case '.java':
      return 'java';
    case '.go':
      return 'go';
    default:
      return 'javascript'; // .js .jsx .mjs .cjs
  }
}

function defFor(grammar: Grammar): LangDef {
  switch (grammar) {
    case 'python':
      return {
        grammar,
        leaf: new Set(['function_definition']),
        container: new Set(['class_definition']),
        label: (t) => (t === 'class_definition' ? 'class' : 'function'),
      };
    case 'java':
      return {
        grammar,
        leaf: new Set(['method_declaration', 'constructor_declaration']),
        container: new Set([
          'class_declaration',
          'interface_declaration',
          'enum_declaration',
          'record_declaration',
        ]),
        label: (t) => {
          if (t === 'interface_declaration') return 'interface';
          if (t === 'enum_declaration') return 'enum';
          if (t === 'record_declaration') return 'record';
          if (t === 'class_declaration') return 'class';
          return 'method';
        },
      };
    case 'go':
      return {
        grammar,
        leaf: new Set(['function_declaration', 'method_declaration']),
        container: new Set(['type_declaration']),
        label: (t) =>
          t === 'type_declaration' ? 'type' : t === 'method_declaration' ? 'method' : 'function',
      };
    default: // typescript | tsx | javascript
      return { grammar, leaf: jsLeaf, container: jsContainer, label: jsLabel };
  }
}

/** Best-effort symbol name: the `name` field, else the first identifier-ish child. */
function nameOf(node: TSNode): string {
  const named = node.childForFieldName('name');
  if (named?.text) return named.text;
  for (const child of node.namedChildren) {
    if (child && /identifier/.test(child.type)) return child.text;
    // Go: `type Foo struct{}` → type_spec holds the name.
    if (child?.type === 'type_spec') {
      const n = child.childForFieldName('name');
      if (n?.text) return n.text;
    }
  }
  return '(anonymous)';
}

function emit(node: TSNode, symbolType: SymbolType, parentSymbol: string | undefined): RawChunk {
  return {
    symbolName: nameOf(node),
    symbolType,
    parentSymbol,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    content: node.text,
  };
}

function hasLeafInside(node: TSNode, leaf: Set<string>): boolean {
  return node.descendantsOfType([...leaf]).length > 0;
}

function walk(node: TSNode, def: LangDef, parent: string | undefined, out: RawChunk[]): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    const t = child.type;

    // `const foo = () => {…}` / `const bar = function() {…}` → a named function chunk.
    if (t === 'variable_declarator') {
      const value = child.childForFieldName('value');
      if (value && FUNCTION_VALUE.test(value.type)) {
        out.push(...splitOversized(emit(child, 'function', parent)));
        continue;
      }
    }

    if (def.leaf.has(t)) {
      out.push(...splitOversized(emit(child, def.label(t), parent)));
      continue; // don't descend into a function body
    }
    if (def.container.has(t)) {
      const name = nameOf(child);
      if (hasLeafInside(child, def.leaf)) {
        walk(child, def, name, out); // methods become chunks under this container
      } else {
        out.push(...splitOversized(emit(child, def.label(t), parent))); // method-less container = one chunk
      }
      continue;
    }
    walk(child, def, parent, out); // e.g. export_statement, class_body, module
  }
}

/**
 * Chunk one code file. `ext` selects the grammar. Returns [] only if parsing yields
 * nothing AND the file is empty; otherwise callers get a whole-file fallback upstream.
 */
export async function chunkCode(
  source: string,
  language: CodeLanguage,
  ext: string,
): Promise<RawChunk[]> {
  void language; // language is kept for callers/telemetry; grammar is chosen by extension
  const grammar = grammarForExt(ext);
  const def = defFor(grammar);
  const tree = await parse(grammar, source);
  try {
    const out: RawChunk[] = [];
    walk(tree.rootNode, def, undefined, out);
    return out;
  } finally {
    tree.delete(); // free WASM memory
  }
}
