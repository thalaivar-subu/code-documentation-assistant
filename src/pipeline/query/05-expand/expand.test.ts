/**
 * Tests for Query · Stage 5 (Expand) — name-based symbol graph + expansion.
 */

import { describe, expect, it } from 'vitest';
import type { Chunk } from '../../../core/types.ts';
import type { RerankedHit } from '../04-rerank/rerank.ts';
import { buildSymbolGraph, expandResults } from './expand.ts';

function chunk(overrides: Partial<Chunk>): Chunk {
  return {
    id: overrides.id ?? 'id',
    repoId: 'r1',
    filePath: `${overrides.symbolName ?? 'x'}.ts`,
    kind: 'code',
    language: 'ts',
    symbolName: 'x',
    symbolType: 'function',
    startLine: 1,
    endLine: 2,
    content: 'function x() {}',
    contentHash: 'hash',
    ...overrides,
  };
}

function rerankedHit(chunk: Chunk, overrides: Partial<RerankedHit> = {}): RerankedHit {
  return {
    id: chunk.id,
    filePath: chunk.filePath,
    symbolName: chunk.symbolName,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    commitSha: '',
    rerankScore: 0.9,
    rrfScore: 0.05,
    sources: ['vector'],
    ...overrides,
  };
}

describe('buildSymbolGraph', () => {
  it('links a caller to a callee it textually references by name', () => {
    const callee = chunk({
      id: 'callee',
      symbolName: 'recordTaskDuration',
      content: 'function recordTaskDuration() { return 1; }',
    });
    const caller = chunk({
      id: 'caller',
      symbolName: 'handleRequest',
      content: 'function handleRequest() { recordTaskDuration(); }',
    });

    const graph = buildSymbolGraph([callee, caller]);

    expect(graph.callees.get('caller')?.has('callee')).toBe(true);
    expect(graph.callers.get('callee')?.has('caller')).toBe(true);
  });

  it('does not create a self-reference edge from a chunk mentioning its own name', () => {
    const c = chunk({
      id: 'a',
      symbolName: 'recurse',
      content: 'function recurse(n) { return n <= 0 ? 0 : recurse(n - 1); }',
    });
    const graph = buildSymbolGraph([c]);
    expect(graph.callees.get('a')?.has('a')).toBeFalsy();
  });

  it('honestly reflects the name-based limitation: two chunks sharing a symbolName both match a reference to it', () => {
    // This is a documented false-positive case, not a bug — real semantic
    // resolution would disambiguate by import/scope, which this doesn't do.
    const defA = chunk({
      id: 'a',
      symbolName: 'run',
      filePath: 'a.ts',
      content: 'function run() {}',
    });
    const defB = chunk({
      id: 'b',
      symbolName: 'run',
      filePath: 'b.ts',
      content: 'function run() {}',
    });
    const caller = chunk({ id: 'c', symbolName: 'main', content: 'function main() { run(); }' });

    const graph = buildSymbolGraph([defA, defB, caller]);
    expect(graph.callees.get('c')).toEqual(new Set(['a', 'b']));
  });

  it('finds no edges for chunks that reference nothing else', () => {
    const c = chunk({
      id: 'a',
      symbolName: 'isolated',
      content: 'function isolated() { return 42; }',
    });
    const graph = buildSymbolGraph([c]);
    expect(graph.callees.get('a')?.size ?? 0).toBe(0);
    expect(graph.callers.get('a')?.size ?? 0).toBe(0);
  });
});

describe('expandResults', () => {
  it('answers "who calls X" — the concrete gap Retrieve/Rerank left open', () => {
    const callee = chunk({
      id: 'callee',
      symbolName: 'recordTaskDuration',
      content: 'function recordTaskDuration() { return 1; }',
    });
    const caller = chunk({
      id: 'caller',
      symbolName: 'handleRequest',
      content: 'function handleRequest() { recordTaskDuration(); }',
    });
    const unrelated = chunk({
      id: 'unrelated',
      symbolName: 'noise',
      content: 'function noise() {}',
    });

    // Only `callee` made it through Retrieve/Fuse/Rerank (it's what the query matched) —
    // `caller` never scored well on its own, but Expand should still surface it.
    const reranked = [rerankedHit(callee)];

    const expanded = expandResults([callee, caller, unrelated], reranked, {});

    expect(expanded.some((h) => h.id === 'callee' && h.via === 'rerank')).toBe(true);
    expect(expanded.some((h) => h.id === 'caller' && h.via === 'caller')).toBe(true);
    expect(expanded.some((h) => h.id === 'unrelated')).toBe(false);
  });

  it('also pulls in callees of a reranked hit, not just callers', () => {
    const callee = chunk({ id: 'callee', symbolName: 'helper', content: 'function helper() {}' });
    const caller = chunk({
      id: 'caller',
      symbolName: 'main',
      content: 'function main() { helper(); }',
    });
    const reranked = [rerankedHit(caller)];

    const expanded = expandResults([callee, caller], reranked, {});
    expect(expanded.some((h) => h.id === 'callee' && h.via === 'callee')).toBe(true);
  });

  it('does not duplicate a chunk that is already a reranked hit', () => {
    const a = chunk({ id: 'a', symbolName: 'a', content: 'function a() { b(); }' });
    const b = chunk({ id: 'b', symbolName: 'b', content: 'function b() { a(); }' });
    // Both are already reranked hits (e.g. both matched the query independently).
    const reranked = [rerankedHit(a), rerankedHit(b)];

    const expanded = expandResults([a, b], reranked, {});
    expect(expanded).toHaveLength(2);
    expect(expanded.every((h) => h.via === 'rerank')).toBe(true);
  });

  it('respects maxPerHit', () => {
    const target = chunk({ id: 'target', symbolName: 'shared', content: 'function shared() {}' });
    const callers = Array.from({ length: 5 }, (_, i) =>
      chunk({
        id: `caller${i}`,
        symbolName: `caller${i}`,
        content: `function caller${i}() { shared(); }`,
      }),
    );
    const reranked = [rerankedHit(target)];

    const expanded = expandResults([target, ...callers], reranked, { maxPerHit: 2, maxTotal: 100 });
    const expandedCallers = expanded.filter((h) => h.via === 'caller');
    expect(expandedCallers.length).toBeLessThanOrEqual(2);
  });

  it('respects maxTotal across multiple reranked hits', () => {
    const targets = Array.from({ length: 3 }, (_, i) =>
      chunk({ id: `target${i}`, symbolName: `target${i}`, content: `function target${i}() {}` }),
    );
    const callers = targets.flatMap((t, i) =>
      Array.from({ length: 3 }, (_, j) =>
        chunk({
          id: `caller${i}-${j}`,
          symbolName: `caller${i}-${j}`,
          content: `function caller${i}_${j}() { ${t.symbolName}(); }`,
        }),
      ),
    );
    const reranked = targets.map((t) => rerankedHit(t));

    const expanded = expandResults([...targets, ...callers], reranked, { maxTotal: 4 });
    const graphAdded = expanded.filter((h) => h.via !== 'rerank');
    expect(graphAdded.length).toBeLessThanOrEqual(4);
  });

  it('handles a rerank list with no callers/callees gracefully', () => {
    const isolated = chunk({ id: 'a', symbolName: 'isolated', content: 'function isolated() {}' });
    const expanded = expandResults([isolated], [rerankedHit(isolated)], {});
    expect(expanded).toEqual([{ ...rerankedHit(isolated), via: 'rerank' }]);
  });
});
