/**
 * Query · Stage 3 — Fuse. Merges Stage 2's two independently-ranked candidate
 * lists (dense + lexical) into one, using Reciprocal Rank Fusion.
 * →  docs: ./README.md
 *
 * RRF fuses by RANK POSITION, not raw score — it never has to reconcile a
 * cosine distance (unbounded-ish, lower=better) with a MiniSearch score
 * (unbounded, higher=better), which live on incomparable scales. See
 * docs/DECISIONS.md #0004.
 *
 *   score(doc) = Σ 1 / (k + rank_i(doc))   — one term per list the doc appears in
 */

import type { LexicalHit } from '../../ingest/04-index/lexical-store.ts';
import type { VectorHit } from '../../ingest/04-index/vector-store.ts';

export interface FusedHit {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  rrfScore: number;
  /** Which retrieval list(s) surfaced this chunk — a doc in both ranks higher, and this is visible proof why. */
  sources: ('vector' | 'lexical')[];
}

export interface FuseOptions {
  /** RRF constant — larger flattens the curve (rank 1 vs rank 10 matters less). */
  k?: number;
  limit?: number;
}

const DEFAULT_RRF_K = 60;

interface RankableHit {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
}

export function fuseResults(
  vector: VectorHit[],
  lexical: LexicalHit[],
  opts: FuseOptions = {},
): FusedHit[] {
  const k = opts.k ?? DEFAULT_RRF_K;
  const byId = new Map<
    string,
    { hit: RankableHit; score: number; sources: Set<'vector' | 'lexical'> }
  >();

  const addList = (hits: RankableHit[], source: 'vector' | 'lexical') => {
    hits.forEach((hit, index) => {
      const contribution = 1 / (k + index + 1); // rank is 1-indexed
      const existing = byId.get(hit.id);
      if (existing) {
        existing.score += contribution;
        existing.sources.add(source);
      } else {
        byId.set(hit.id, { hit, score: contribution, sources: new Set([source]) });
      }
    });
  };

  addList(vector, 'vector');
  addList(lexical, 'lexical');

  const fused: FusedHit[] = [...byId.values()].map(({ hit, score, sources }) => ({
    id: hit.id,
    filePath: hit.filePath,
    symbolName: hit.symbolName,
    startLine: hit.startLine,
    endLine: hit.endLine,
    rrfScore: score,
    sources: [...sources],
  }));

  fused.sort((a, b) => b.rrfScore - a.rrfScore);
  return opts.limit ? fused.slice(0, opts.limit) : fused;
}
