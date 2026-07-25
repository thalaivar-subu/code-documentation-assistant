/**
 * Tests for Query · Stage 8 (Verify) — citation resolution against the
 * actual context the model was given.
 */

import { describe, expect, it } from 'vitest';
import type { ExpandedHit } from '../05-expand/expand.ts';
import type { Citation } from '../07-generate/generate.ts';
import { verifyCitations } from './verify.ts';

function hit(overrides: Partial<ExpandedHit> = {}): ExpandedHit {
  return {
    id: 'a',
    filePath: 'telemetry/metrics.go',
    symbolName: 'RecordTaskDuration',
    startLine: 81,
    endLine: 90,
    content: 'func RecordTaskDuration() {}',
    commitSha: '',
    rerankScore: 0.5,
    rrfScore: 0.1,
    sources: ['vector'],
    via: 'rerank',
    ...overrides,
  };
}

function citation(overrides: Partial<Citation> = {}): Citation {
  return { filePath: 'telemetry/metrics.go', startLine: 81, endLine: 90, ...overrides };
}

describe('verifyCitations', () => {
  it('resolves a citation that exactly matches a context chunk', () => {
    const result = verifyCitations([citation()], [hit()]);
    expect(result.resolvedCount).toBe(1);
    expect(result.checks[0].resolved).toBe(true);
    expect(result.checks[0].matchedSymbol).toBe('RecordTaskDuration');
  });

  it('resolves a citation whose range only overlaps, not matches exactly', () => {
    // The model said 82-85; the real chunk is 81-90. Still faithful, not hallucinated.
    const result = verifyCitations([citation({ startLine: 82, endLine: 85 })], [hit()]);
    expect(result.resolvedCount).toBe(1);
  });

  it('does not resolve a citation for a real file but a line range nowhere in context', () => {
    const result = verifyCitations([citation({ startLine: 200, endLine: 210 })], [hit()]);
    expect(result.resolvedCount).toBe(0);
    expect(result.checks[0].resolved).toBe(false);
    expect(result.checks[0].matchedSymbol).toBeUndefined();
  });

  it('does not resolve a citation for a file that was never in context (a plausible-looking guess)', () => {
    const result = verifyCitations([citation({ filePath: 'telemetry/otel.go' })], [hit()]);
    expect(result.resolvedCount).toBe(0);
  });

  it('mixes resolved and unresolved citations correctly', () => {
    const context = [
      hit({ id: 'a' }),
      hit({ id: 'b', filePath: 'telemetry/otel.go', startLine: 1, endLine: 10 }),
    ];
    const citations = [
      citation({ filePath: 'telemetry/metrics.go', startLine: 81, endLine: 90 }), // resolves
      citation({ filePath: 'telemetry/otel.go', startLine: 1, endLine: 10 }), // resolves
      citation({ filePath: 'telemetry/fake.go', startLine: 1, endLine: 5 }), // does not
    ];

    const result = verifyCitations(citations, context);
    expect(result.resolvedCount).toBe(2);
    expect(result.totalCount).toBe(3);
    expect(result.resolutionRate).toBeCloseTo(2 / 3);
  });

  it('treats an answer with zero citations as a distinct signal from a fully-resolved answer', () => {
    const result = verifyCitations([], [hit()]);
    expect(result.totalCount).toBe(0);
    expect(result.hasCitations).toBe(false);
    // resolutionRate is vacuously 1 — hasCitations is the field that actually
    // distinguishes "nothing to check" from "checked and all good".
    expect(result.resolutionRate).toBe(1);
  });

  it('a fully-resolved, non-empty answer has hasCitations true and resolutionRate 1', () => {
    const result = verifyCitations([citation()], [hit()]);
    expect(result.hasCitations).toBe(true);
    expect(result.resolutionRate).toBe(1);
  });
});
