/**
 * Tests for Query · Stage 3 (Fuse) — Reciprocal Rank Fusion.
 */

import { describe, expect, it } from 'vitest';
import type { LexicalHit } from '../../../../src/pipeline/ingest/04-index/lexical-store.ts';
import type { VectorHit } from '../../../../src/pipeline/ingest/04-index/vector-store.ts';
import { fuseResults } from '../../../../src/pipeline/query/03-fuse/fuse.ts';

function vHit(id: string, distance: number, overrides: Partial<VectorHit> = {}): VectorHit {
  return {
    id,
    filePath: `${id}.ts`,
    symbolName: id,
    startLine: 1,
    endLine: 2,
    content: `content of ${id}`,
    commitSha: '',
    distance,
    ...overrides,
  };
}

function lHit(id: string, score: number, overrides: Partial<LexicalHit> = {}): LexicalHit {
  return {
    id,
    filePath: `${id}.ts`,
    symbolName: id,
    startLine: 1,
    endLine: 2,
    score,
    ...overrides,
  };
}

describe('fuseResults — Reciprocal Rank Fusion', () => {
  it('computes the exact RRF score for a doc appearing in both lists at rank 1', () => {
    const fused = fuseResults([vHit('a', 0.1)], [lHit('a', 9.9)], { k: 60 });
    // 1/(60+1) from vector rank 1, + 1/(60+1) from lexical rank 1
    expect(fused[0].rrfScore).toBeCloseTo(2 / 61, 10);
    expect(fused[0].sources.sort()).toEqual(['lexical', 'vector']);
  });

  it('ranks a doc found in BOTH lists above a doc found in only one, even if the single-list doc is rank 1 there', () => {
    // 'both' is rank 2 in vector and rank 2 in lexical.
    // 'vector-only' is rank 1 in vector only.
    const vector = [vHit('vector-only', 0.05), vHit('both', 0.1)];
    const lexical = [lHit('other', 5), lHit('both', 4)];

    const fused = fuseResults(vector, lexical, { k: 60 });
    const bothScore = 1 / (60 + 2) + 1 / (60 + 2);
    const vectorOnlyScore = 1 / (60 + 1);
    expect(bothScore).toBeGreaterThan(vectorOnlyScore); // sanity-check the math itself
    expect(fused[0].id).toBe('both');
  });

  it('a doc only in the lexical list still appears, with only "lexical" as its source', () => {
    const fused = fuseResults([], [lHit('x', 3)]);
    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe('x');
    expect(fused[0].sources).toEqual(['lexical']);
    expect(fused[0].rrfScore).toBeCloseTo(1 / (60 + 1), 10);
  });

  it('a doc only in the vector list still appears, with only "vector" as its source', () => {
    const fused = fuseResults([vHit('y', 0.2)], []);
    expect(fused[0].sources).toEqual(['vector']);
  });

  it('sorts descending by rrfScore, not by insertion order', () => {
    // 'a' is inserted first (vector rank 1) but 'b' ends up with the higher
    // combined score (vector rank 2 + lexical rank 1) — a no-op "sort" would
    // leave this in [a, b] insertion order and this test would fail.
    const vector = [vHit('a', 0.1), vHit('b', 0.2)];
    const lexical = [lHit('b', 9)];

    const fused = fuseResults(vector, lexical, { k: 60 });

    expect(fused[0].id).toBe('b');
    expect(fused[1].id).toBe('a');
    expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore);
  });

  it('respects limit', () => {
    const vector = Array.from({ length: 10 }, (_, i) => vHit(`v${i}`, i));
    const fused = fuseResults(vector, [], { limit: 3 });
    expect(fused).toHaveLength(3);
  });

  it('both lists empty → empty result, no error', () => {
    expect(fuseResults([], [])).toEqual([]);
  });

  it('a larger k flattens the score gap between rank 1 and rank 10', () => {
    const vector = Array.from({ length: 10 }, (_, i) => vHit(`v${i}`, i));
    const smallK = fuseResults(vector, [], { k: 1 });
    const largeK = fuseResults(vector, [], { k: 1000 });
    const gap = (fused: ReturnType<typeof fuseResults>) => fused[0].rrfScore - fused[9].rrfScore;
    expect(gap(largeK)).toBeLessThan(gap(smallK));
  });
});
