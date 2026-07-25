/**
 * Query · Stage 8 — Verify. Resolve every citation the model produced against
 * the ACTUAL context it was given — not "is this a real file:line somewhere
 * in the repo" (a model could plausibly guess a real symbol it was never
 * shown), but "did the model cite something it was actually handed." That's
 * the real faithfulness test — pure code, no ML, per docs/DECISIONS.md #0010.
 * →  docs: ./README.md
 */

import type { ExpandedHit } from '../05-expand/expand.ts';
import type { Citation } from '../07-generate/generate.ts';

export interface CitationCheck {
  citation: Citation;
  resolved: boolean;
  /** The context chunk that satisfied this citation, if resolved. */
  matchedSymbol?: string;
}

export interface VerifyResult {
  checks: CitationCheck[];
  resolvedCount: number;
  totalCount: number;
  /** citations.length === 0 → 1 (vacuously "fine") — see hasCitations for the real signal. */
  resolutionRate: number;
  /** false when the answer cited nothing at all — worse than "cited something wrong": no claim was checkable. */
  hasCitations: boolean;
}

/** Same file, and the claimed range overlaps the chunk's real range (doesn't need to match exactly). */
function overlaps(citation: Citation, hit: ExpandedHit): boolean {
  return (
    citation.filePath === hit.filePath &&
    citation.startLine <= hit.endLine &&
    citation.endLine >= hit.startLine
  );
}

export function verifyCitations(citations: Citation[], context: ExpandedHit[]): VerifyResult {
  const checks: CitationCheck[] = citations.map((citation) => {
    const match = context.find((hit) => overlaps(citation, hit));
    return { citation, resolved: Boolean(match), matchedSymbol: match?.symbolName };
  });

  const resolvedCount = checks.filter((c) => c.resolved).length;
  return {
    checks,
    resolvedCount,
    totalCount: citations.length,
    resolutionRate: citations.length === 0 ? 1 : resolvedCount / citations.length,
    hasCitations: citations.length > 0,
  };
}
