/**
 * Ingest · Stage 2, part B: tree-sitter loader.
 *
 * Thin wrapper over `web-tree-sitter` that:
 *  - initialises the WASM runtime once (idempotent),
 *  - lazily loads + caches each language grammar from `tree-sitter-wasms`,
 *  - parses source with a single reused parser.
 *
 * Version note: `tree-sitter-wasms` grammars are built with tree-sitter CLI 0.20.x,
 * so the runtime is pinned to the matching `web-tree-sitter@0.20.x` (its wasm dylink
 * ABI differs from 0.22+). WASM paths are resolved from node_modules via
 * `createRequire`, so this works under tsx, vitest, or a bundle alike.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);

/** Node type, re-exported so the rest of the pipeline never imports web-tree-sitter directly. */
export type TSNode = Parser.SyntaxNode;

/** Grammar name as it appears in tree-sitter-wasms (`tree-sitter-<name>.wasm`). */
export type Grammar = 'typescript' | 'tsx' | 'javascript' | 'python' | 'java' | 'go';

let initPromise: Promise<void> | null = null;
const grammarCache = new Map<Grammar, Promise<Parser.Language>>();
let parser: Parser | null = null;

function init(): Promise<void> {
  if (!initPromise) {
    // The core runtime wasm (tree-sitter.wasm) sits next to the entry module.
    const wasmDir = dirname(require.resolve('web-tree-sitter'));
    initPromise = Parser.init({ locateFile: (name: string) => join(wasmDir, name) });
  }
  return initPromise;
}

function grammarPath(grammar: Grammar): string {
  const pkgDir = dirname(require.resolve('tree-sitter-wasms/package.json'));
  return join(pkgDir, 'out', `tree-sitter-${grammar}.wasm`);
}

function loadGrammar(grammar: Grammar): Promise<Parser.Language> {
  let cached = grammarCache.get(grammar);
  if (!cached) {
    cached = (async () => {
      await init(); // Parser.Language is only available after init()
      const bytes = await readFile(grammarPath(grammar));
      return Parser.Language.load(bytes);
    })();
    grammarCache.set(grammar, cached);
  }
  return cached;
}

/**
 * Parse `source` with the given grammar. The returned Tree owns WASM memory —
 * the caller MUST call `tree.delete()` when done.
 */
export async function parse(grammar: Grammar, source: string): Promise<Parser.Tree> {
  const language = await loadGrammar(grammar);
  if (!parser) parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(source);
}
