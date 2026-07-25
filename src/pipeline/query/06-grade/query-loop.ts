/**
 * The actual "loop back to Retrieve" — why Grade (and, eventually, LangGraph)
 * exists at all. →  docs: ./README.md
 *
 * DECISIONS.md #0006 justifies LangGraph.js specifically because this control
 * flow is a CYCLE, which a plain LCEL/DAG chain can't express — but it also
 * says the honest thing: if the flow were single-shot, reaching for LangGraph
 * would be over-engineering. Generate (Stage 7) doesn't exist yet, so there's
 * no LLM to actually consume this loop's output — hand-rolling the control
 * flow in plain `while`/`await` now, and swapping it for a real LangGraph
 * state machine when Generate needs the loop to also drive token streaming
 * and checkpointing, is the same "smallest tool for the current need"
 * judgment call Route made about not using an LLM yet.
 */

import type { Chunk } from '../../../core/types.ts';
import { indexRepo } from '../../ingest/04-index/index.ts';
import { routeQuery, type RouteResult } from '../01-route/route.ts';
import { retrieveCandidates } from '../02-retrieve/retrieve.ts';
import { fuseResults } from '../03-fuse/fuse.ts';
import { rerankResults } from '../04-rerank/rerank.ts';
import { expandResults, type ExpandedHit } from '../05-expand/expand.ts';
import { gradeContext, type GradeResult } from './grade.ts';

export interface HopTrace {
  hop: number;
  /** The query text actually sent to Retrieve this hop — augmented after hop 0. */
  query: string;
  grade: GradeResult;
}

export interface QueryLoopResult {
  route: RouteResult;
  expanded: ExpandedHit[];
  hops: HopTrace[];
}

export interface QueryLoopOptions {
  maxHops?: number;
  k?: number;
  limit?: number;
  dbPath?: string;
  lexicalDir?: string;
  /** Fires once, as soon as Route classifies the question — before any hop starts. */
  onRoute?: (route: RouteResult) => void;
  /** Fires after each hop's grade decision — the UI's hook for live progress. */
  onHop?: (hop: HopTrace) => void;
}

const DEFAULT_MAX_HOPS = 3;

/**
 * Route once, then Retrieve → Fuse → Rerank → Expand → Grade, looping back to
 * Retrieve with an augmented query when Grade says insufficient. The query
 * augmentation IS the "you don't know hop 2 until hop 1 returns" case
 * DECISIONS.md #0006 argues for: newly-discovered caller/callee symbol names
 * from Expand get folded into the next hop's query, so hop 2 searches for
 * something hop 1 had no way to know about in advance.
 */
export async function runQueryLoop(
  repoId: string,
  question: string,
  allChunks: Chunk[],
  opts: QueryLoopOptions = {},
): Promise<QueryLoopResult> {
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const route = routeQuery(question);
  opts.onRoute?.(route);
  const hops: HopTrace[] = [];

  let query = question;
  let expanded: ExpandedHit[] = [];

  for (let hop = 0; hop < maxHops; hop++) {
    const { vector, lexical } = await retrieveCandidates(repoId, query, route, {
      k: opts.k,
      dbPath: opts.dbPath,
      lexicalDir: opts.lexicalDir,
    });
    const fused = fuseResults(vector, lexical);
    const reranked = await rerankResults(repoId, query, fused, {
      limit: opts.limit,
      dbPath: opts.dbPath,
    });
    expanded = expandResults(allChunks, reranked);

    const grade = gradeContext(expanded, route, hop, { maxHops });
    const hopTrace: HopTrace = { hop, query, grade };
    hops.push(hopTrace);
    opts.onHop?.(hopTrace);

    if (grade.sufficient) break;

    const newSymbols = [
      ...new Set(expanded.filter((h) => h.via !== 'rerank').map((h) => h.symbolName)),
    ];
    query = newSymbols.length > 0 ? [question, ...newSymbols].join(' ') : question;
  }

  return { route, expanded, hops };
}

/** Convenience: index a repo's chunks/embeddings, then run the loop against it. */
export async function indexAndRunQueryLoop(
  repoId: string,
  chunks: Chunk[],
  embeddings: Parameters<typeof indexRepo>[2],
  question: string,
  opts: QueryLoopOptions = {},
): Promise<QueryLoopResult> {
  await indexRepo(repoId, chunks, embeddings, opts);
  return runQueryLoop(repoId, question, chunks, opts);
}
