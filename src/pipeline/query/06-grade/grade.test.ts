/**
 * Tests for Query · Stage 6 (Grade) — the "enough to answer?" heuristics.
 */

import { describe, expect, it } from 'vitest';
import type { ExpandedHit } from '../05-expand/expand.ts';
import type { RouteResult } from '../01-route/route.ts';
import { gradeContext } from './grade.ts';

function hit(overrides: Partial<ExpandedHit> = {}): ExpandedHit {
  return {
    id: 'a',
    filePath: 'a.ts',
    symbolName: 'a',
    startLine: 1,
    endLine: 2,
    content: 'function a() {}',
    commitSha: '',
    rerankScore: 0.05,
    rrfScore: 0.02,
    sources: ['vector'],
    via: 'rerank',
    ...overrides,
  };
}

function route(overrides: Partial<RouteResult> = {}): RouteResult {
  return { intent: 'concept', symbols: [], files: [], reason: 'test', ...overrides };
}

describe('gradeContext', () => {
  it('is insufficient when nothing was found at all', () => {
    const result = gradeContext([], route(), 0);
    expect(result.sufficient).toBe(false);
    expect(result.reason).toMatch(/no candidates/);
  });

  it('is insufficient when the best rerank score is below the confidence threshold', () => {
    const result = gradeContext([hit({ rerankScore: 0.001 })], route(), 0, {
      minRerankScore: 0.01,
    });
    expect(result.sufficient).toBe(false);
    expect(result.reason).toMatch(/confidence threshold/);
  });

  it('is sufficient for a concept question with a confident top match', () => {
    const result = gradeContext([hit({ rerankScore: 0.5 })], route({ intent: 'concept' }), 0, {
      minRerankScore: 0.01,
    });
    expect(result.sufficient).toBe(true);
  });

  it('is insufficient for a trace question when the symbol graph found no edges', () => {
    const expanded = [hit({ rerankScore: 0.5, via: 'rerank' })]; // only the direct match, no caller/callee
    const result = gradeContext(expanded, route({ intent: 'trace' }), 0, { minRerankScore: 0.01 });
    expect(result.sufficient).toBe(false);
    expect(result.reason).toMatch(/no callers\/callees/);
  });

  it('is sufficient for a trace question once the symbol graph found at least one edge', () => {
    const expanded = [
      hit({ id: 'a', rerankScore: 0.5, via: 'rerank' }),
      hit({ id: 'b', via: 'caller' }), // via='caller' hits don't carry a real rerankScore
    ];
    const result = gradeContext(expanded, route({ intent: 'trace' }), 0, { minRerankScore: 0.01 });
    expect(result.sufficient).toBe(true);
    expect(result.reason).toMatch(/symbol graph/);
  });

  it('a symbol/concept question does not require graph edges the way trace does', () => {
    const expanded = [hit({ rerankScore: 0.5, via: 'rerank' })];
    const result = gradeContext(expanded, route({ intent: 'symbol' }), 0, { minRerankScore: 0.01 });
    expect(result.sufficient).toBe(true);
  });

  it('is always sufficient once the hop limit is reached, regardless of quality', () => {
    // maxHops: 2 -> hop 0 is the last allowed attempt (0-indexed), so it must
    // force sufficient=true even with a terrible score and a trace question
    // with no graph edges — otherwise the loop could never terminate.
    const expanded = [hit({ rerankScore: 0.0001 })];
    const result = gradeContext(expanded, route({ intent: 'trace' }), 0, { maxHops: 1 });
    expect(result.sufficient).toBe(true);
    expect(result.reason).toMatch(/hop limit/);
  });

  it('does not force sufficiency before the hop limit', () => {
    const expanded = [hit({ rerankScore: 0.0001 })];
    const result = gradeContext(expanded, route(), 0, { maxHops: 3 });
    expect(result.sufficient).toBe(false);
  });
});
