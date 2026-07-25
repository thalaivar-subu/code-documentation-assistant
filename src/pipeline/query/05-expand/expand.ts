/**
 * Query · Stage 5 — Expand. Pulls in a reranked hit's likely callers/callees
 * via a lightweight symbol graph, before generation. →  docs: ./README.md
 *
 * Honest scope: this is NAME-BASED reference matching, not a real semantic
 * call graph. It scans each chunk's raw content for identifier tokens and
 * matches them against every other chunk's `symbolName` in the repo — no
 * type resolution, no import-aware disambiguation, no scoping. It will
 * produce false positives (a token that happens to match an unrelated
 * symbol of the same name in another file) and false negatives (a call
 * hidden behind an alias, a method called via `this.`, dynamic dispatch).
 * A real call graph needs per-language semantic analysis (a language
 * server, or a typed AST walk with import resolution) — out of scope here.
 * What this DOES deliver: for the common case (a uniquely-named function
 * called by its own name), it correctly answers "who calls X" — something
 * nothing built before this stage could do at all (see Stage 2/Retrieve's
 * READMEs, which both call this out as a known gap).
 */

import type { Chunk } from '../../../core/types.ts';
import type { RerankedHit } from '../04-rerank/rerank.ts';

const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

export interface SymbolGraph {
  /** chunk id -> ids of chunks whose symbol this chunk's content references. */
  callees: Map<string, Set<string>>;
  /** chunk id -> ids of chunks that reference this chunk's symbol (reverse of callees). */
  callers: Map<string, Set<string>>;
}

/**
 * One pass over every chunk's content, building both directions of the graph
 * at once (a caller edge is discovered exactly when its matching callee edge
 * is), rather than re-scanning per-hit later.
 */
export function buildSymbolGraph(chunks: Chunk[]): SymbolGraph {
  const bySymbol = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const list = bySymbol.get(c.symbolName);
    if (list) list.push(c);
    else bySymbol.set(c.symbolName, [c]);
  }

  const callees = new Map<string, Set<string>>();
  const callers = new Map<string, Set<string>>();

  for (const chunk of chunks) {
    const tokens = new Set(chunk.content.match(IDENTIFIER_RE) ?? []);
    tokens.delete(chunk.symbolName); // a chunk mentioning its own name isn't a self-call
    const calleeIds = new Set<string>();

    for (const token of tokens) {
      const defs = bySymbol.get(token);
      if (!defs) continue;
      for (const def of defs) {
        if (def.id === chunk.id) continue;
        calleeIds.add(def.id);
        const callerSet = callers.get(def.id);
        if (callerSet) callerSet.add(chunk.id);
        else callers.set(def.id, new Set([chunk.id]));
      }
    }
    callees.set(chunk.id, calleeIds);
  }

  return { callees, callers };
}

export interface ExpandedHit extends RerankedHit {
  /** 'rerank' = a real result; 'caller'/'callee' = pulled in via the symbol graph, not scored. */
  via: 'rerank' | 'caller' | 'callee';
}

export interface ExpandOptions {
  /** Max callers + callees pulled in per reranked hit. */
  maxPerHit?: number;
  /** Overall cap on graph-expanded additions (reranked hits are never capped). */
  maxTotal?: number;
}

const DEFAULT_MAX_PER_HIT = 3;
const DEFAULT_MAX_TOTAL = 10;

function toExpandedHit(chunk: Chunk, via: 'caller' | 'callee'): ExpandedHit {
  return {
    id: chunk.id,
    filePath: chunk.filePath,
    symbolName: chunk.symbolName,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    commitSha: chunk.commitSha ?? '',
    rerankScore: 0,
    rrfScore: 0,
    sources: [],
    via,
  };
}

/**
 * Add each reranked hit's likely callers and callees, deduped against what's
 * already present (a hit already in the reranked list never gets re-added as
 * "expanded"), capped per-hit and overall so one heavily-referenced symbol
 * can't flood the context.
 */
export function expandResults(
  allChunks: Chunk[],
  reranked: RerankedHit[],
  opts: ExpandOptions = {},
): ExpandedHit[] {
  const maxPerHit = opts.maxPerHit ?? DEFAULT_MAX_PER_HIT;
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL;

  const graph = buildSymbolGraph(allChunks);
  const byId = new Map(allChunks.map((c) => [c.id, c]));

  const result: ExpandedHit[] = reranked.map((r) => ({ ...r, via: 'rerank' }));
  const seen = new Set(reranked.map((r) => r.id));
  let added = 0;

  outer: for (const hit of reranked) {
    const related: { id: string; via: 'caller' | 'callee' }[] = [
      ...[...(graph.callers.get(hit.id) ?? [])].map((id) => ({ id, via: 'caller' as const })),
      ...[...(graph.callees.get(hit.id) ?? [])].map((id) => ({ id, via: 'callee' as const })),
    ].slice(0, maxPerHit);

    for (const { id, via } of related) {
      if (seen.has(id)) continue;
      const chunk = byId.get(id);
      if (!chunk) continue;
      seen.add(id);
      result.push(toExpandedHit(chunk, via));
      added++;
      if (added >= maxTotal) break outer;
    }
  }

  return result;
}
