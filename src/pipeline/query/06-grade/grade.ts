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
import type { ExpandedHit } from '../05-expand/expand.ts';

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
 * Three checks, cheapest/most-decisive first:
 *  1. Hop limit — a hard stop so the query loop can never run forever.
 *  2. Nothing found at all.
 *  3. Best rerank score too low to be confident in the top match.
 *  4. `trace` questions specifically need graph edges (Stage 5) — finding the
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
