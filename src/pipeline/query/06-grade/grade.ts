/**
 * Query · Stage 6 — Grade. "Do I have enough to answer?" If not, loop back to
 * Retrieve with what this hop learned. →  docs: ./README.md
 *
 * No LLM exists in this project yet (Generate, Stage 7, is what will need
 * one) — same situation Route was in, and the same resolution: a handful of
 * cheap, explainable heuristics instead of an LLM-as-judge call. Revisit once
 * Generate's LLM adapter exists; an LLM grading its own upcoming context is a
 * natural place to actually use it.
 */

import type { RouteResult } from '../01-route/route.ts';
import { isManifestFilePath, type ExpandedHit } from '../05-expand/expand.ts';

export interface GradeResult {
  sufficient: boolean;
  reason: string;
}

export interface GradeOptions {
  /** Below this top rerank score, confidence is too low to call it sufficient. */
  minRerankScore?: number;
  /** Hard cap — always sufficient at this hop, regardless of the checks below. */
  maxHops?: number;
}

const DEFAULT_MIN_RERANK_SCORE = 0.01;
const DEFAULT_MAX_HOPS = 3;

/**
 * Four checks, cheapest/most-decisive first:
 *  1. Hop limit — a hard stop so the query loop can never run forever.
 *  2. Nothing found at all.
 *  3. `manifest` questions are satisfied by finding a dependency-manifest file
 *     at all (Expand adds these with `rerankScore: 0` by construction — a
 *     manifest file's relevance comes from being the right *file*, not from
 *     scoring well against a casually-phrased question, so the rerank-score
 *     check below would be testing the wrong thing entirely for this intent).
 *  4. Best rerank score too low to be confident in the top match.
 *  5. `trace` questions specifically need graph edges (Stage 5) — finding the
 *     named function isn't enough if the question was about its callers.
 */
export function gradeContext(
  expanded: ExpandedHit[],
  route: RouteResult,
  hopCount: number,
  opts: GradeOptions = {},
): GradeResult {
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const minScore = opts.minRerankScore ?? DEFAULT_MIN_RERANK_SCORE;

  if (hopCount >= maxHops - 1) {
    return {
      sufficient: true,
      reason: `hop limit (${maxHops}) reached — answering with what's available`,
    };
  }

  if (expanded.length === 0) {
    return { sufficient: false, reason: 'no candidates found at all' };
  }

  if (route.intent === 'manifest') {
    // Checked by filename, not by `via` — a manifest file can reach `expanded`
    // either guaranteed-injected (via: 'manifest') or as a genuine, well-
    // scoring via: 'rerank' hit if it happened to rank well on its own; either
    // way it's already in context and another hop would be wasted work.
    const hasManifest = expanded.some((h) => isManifestFilePath(h.filePath));
    return hasManifest
      ? { sufficient: true, reason: "found the project's dependency manifest file(s)" }
      : {
          sufficient: false,
          reason:
            'manifest question, but no dependency-manifest file (go.mod, package.json, …) exists in this repo',
        };
  }

  const rerankScores = expanded.filter((h) => h.via === 'rerank').map((h) => h.rerankScore);
  const bestScore = rerankScores.length > 0 ? Math.max(...rerankScores) : 0;
  if (bestScore < minScore) {
    return {
      sufficient: false,
      reason: `best rerank score (${bestScore.toFixed(4)}) is below the confidence threshold (${minScore})`,
    };
  }

  if (route.intent === 'trace') {
    const hasGraphEdges = expanded.some((h) => h.via !== 'rerank');
    if (!hasGraphEdges) {
      return {
        sufficient: false,
        reason:
          'trace question, but the symbol graph found no callers/callees for any reranked hit',
      };
    }
  }

  return {
    sufficient: true,
    reason:
      route.intent === 'trace'
        ? 'confident top match, and the symbol graph found related callers/callees'
        : 'confident top match',
  };
}
