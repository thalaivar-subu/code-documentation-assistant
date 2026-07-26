/**
 * Query · Stage 4 — Rerank. Scores Stage 3's fused candidates with a
 * cross-encoder and keeps the top few — the shortlist that would go to an
 * LLM. →  docs: ./README.md
 */

import { getSharedVectorStore, getVectorsByIds } from '../../ingest/04-index/vector-store.ts';
import type { FusedHit } from '../03-fuse/fuse.ts';
import { scorePairs } from './reranker.ts';

export interface RerankedHit {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  content: string;
  /** '' means no commit was recorded at index time (see Chunk.commitSha). */
  commitSha: string;
  rerankScore: number;
  /** Carried through from Fuse, for comparison — see how much rerank actually moved things. */
  rrfScore: number;
  sources: ('vector' | 'lexical')[];
}

export interface RerankOptions {
  /** Final shortlist size — how many hits this stage returns. */
  limit?: number;
  /**
   * How many of Fuse's candidates actually reach the cross-encoder, pre-scoring —
   * a different knob from `limit` (which trims the OUTPUT). The cross-encoder
   * forward pass dominates this stage's cost (measured: ~10s for 34 candidates
   * at the old unbounded-token-length setting — see docs/REFACTOR-PLAN.md), so
   * bounding the INPUT before scoring is where the real win is. Candidates
   * beyond this are dropped by rrfScore, Fuse's own ranking — cheap and already
   * computed, no extra work to pick who gets cut.
   */
  maxCandidates?: number;
  dbPath?: string;
  /** Swap the scoring function — tests inject a fake to skip loading the real model. */
  scoreFn?: (query: string, docs: string[]) => Promise<number[]>;
  /** Swap the vector-store hydration lookup — same DIP seam as `scoreFn`, extended to the store (see `02-retrieve/retrieve.ts`'s matching `searchVectorsFn`/`searchLexicalFn`). */
  getVectorsByIdsFn?: typeof getVectorsByIds;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_CANDIDATES = 16;

/**
 * Fuse's output has no `content` for lexical-only hits (it only ranks, never
 * reads chunk text) — this stage needs the real text to score, so it hydrates
 * every candidate's content (and commitSha) from the index first, scoped to
 * exactly the ids Fuse shortlisted (`getVectorsByIds`) rather than scanning
 * every indexed row for the repo. Chunks the index no longer has (rare — a
 * desync between Fuse's ranking and a since-changed index) are dropped rather
 * than scored on missing content.
 */
export async function rerankResults(
  repoId: string,
  query: string,
  fused: FusedHit[],
  opts: RerankOptions = {},
): Promise<RerankedHit[]> {
  if (fused.length === 0) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const scoreFn = opts.scoreFn ?? scorePairs;
  const getVectorsByIdsFn = opts.getVectorsByIdsFn ?? getVectorsByIds;

  // Cut to maxCandidates by rrfScore BEFORE hydrating/scoring — the cross-encoder
  // forward pass is this stage's real cost (see RerankOptions.maxCandidates doc
  // comment), so the fewer candidates that reach it, the better. Sorted
  // defensively rather than trusting Fuse's own ordering, since a caller could
  // hand this an already-filtered or hand-built list (tests do exactly that).
  const shortlisted = [...fused].sort((a, b) => b.rrfScore - a.rrfScore).slice(0, maxCandidates);

  const db = await getSharedVectorStore(opts.dbPath);
  const rows = await getVectorsByIdsFn(
    db,
    repoId,
    shortlisted.map((f) => f.id),
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const candidates = shortlisted
    .map((f) => ({ ...f, row: rowById.get(f.id) }))
    .filter((f): f is FusedHit & { row: (typeof rows)[number] } => f.row !== undefined);

  const scores = await scoreFn(
    query,
    candidates.map((c) => c.row.content),
  );
  // A custom scoreFn (production or test) returning the wrong length silently
  // gives some candidates `rerankScore: undefined` below, which then sorts as
  // NaN — no crash, just a shortlist quietly in the wrong order. Fail loudly
  // instead, right at the one place both arrays are known to exist.
  if (scores.length !== candidates.length) {
    throw new Error(`scoreFn returned ${scores.length} scores for ${candidates.length} candidates`);
  }

  const reranked: RerankedHit[] = candidates.map((c, i) => ({
    id: c.id,
    filePath: c.filePath,
    symbolName: c.symbolName,
    startLine: c.startLine,
    endLine: c.endLine,
    content: c.row.content,
    commitSha: c.row.commitSha,
    rerankScore: scores[i],
    rrfScore: c.rrfScore,
    sources: c.sources,
  }));

  reranked.sort((a, b) => b.rerankScore - a.rerankScore);
  return reranked.slice(0, limit);
}
