/**
 * Tests for Query · Stage 2 (Retrieve).
 *
 * Key property under test: Route's `symbols`/`files` output measurably changes
 * what Retrieve finds on the lexical side (the whole reason Route was kept
 * instead of dropped) — not just a claim, a chunk that scores weakly against
 * the full question text but exactly matches an extracted symbol must still
 * surface via the token-boost query.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Chunk } from '../../../../src/core/types.ts';
import type { EmbeddedChunk } from '../../../../src/pipeline/ingest/03-embed/embed.ts';
import { embedBatch } from '../../../../src/pipeline/ingest/03-embed/embedder.ts';
import { indexRepo } from '../../../../src/pipeline/ingest/04-index/index.ts';
import type { RouteResult } from '../../../../src/pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../../../../src/pipeline/query/02-retrieve/retrieve.ts';

let tmpDirs: string[] = [];
function tmpStorePaths() {
  const dir = mkdtempSync(join(tmpdir(), 'cda-retrieve-test-'));
  tmpDirs.push(dir);
  return { dbPath: join(dir, 'lancedb'), lexicalDir: join(dir, 'lexical') };
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

function makeChunk(overrides: Partial<Chunk>): Chunk {
  return {
    id: overrides.id ?? 'id',
    repoId: 'r1',
    filePath: 'a.ts',
    kind: 'code',
    language: 'ts',
    symbolName: 'f',
    symbolType: 'function',
    startLine: 1,
    endLine: 2,
    content: 'function f() { return 1; }',
    contentHash: 'hash',
    ...overrides,
  };
}

function makeEmbedding(chunk: Chunk, vector: number[]): EmbeddedChunk {
  return { chunkId: chunk.id, contentHash: chunk.contentHash, vector };
}

function noRoute(): RouteResult {
  return { intent: 'concept', symbols: [], files: [], reason: 'test default' };
}

async function fakeEmbedFn(texts: string[]): Promise<number[][]> {
  return texts.map(() => [1, 0, 0, 0]);
}

describe('retrieveCandidates', () => {
  it('returns both vector and lexical candidates', async () => {
    const chunks = [
      makeChunk({ id: 'a', symbolName: 'add', content: 'function add(a, b) { return a + b; }' }),
      makeChunk({
        id: 'b',
        symbolName: 'subtract',
        content: 'function subtract(a, b) { return a - b; }',
      }),
    ];
    const embeddings = [
      makeEmbedding(chunks[0], [1, 0, 0, 0]),
      makeEmbedding(chunks[1], [0, 1, 0, 0]),
    ];
    const paths = tmpStorePaths();
    await indexRepo('r1', chunks, embeddings, paths);

    const result = await retrieveCandidates('r1', 'add two numbers', noRoute(), {
      ...paths,
      embedFn: fakeEmbedFn,
    });

    expect(result.vector[0].id).toBe('a');
    expect(result.lexical.some((h) => h.id === 'a')).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('empty repo (nothing indexed) returns empty arrays, not an error', async () => {
    const result = await retrieveCandidates('never-indexed', 'anything', noRoute(), {
      ...tmpStorePaths(),
      embedFn: fakeEmbedFn,
    });
    expect(result.vector).toEqual([]);
    expect(result.lexical).toEqual([]);
  });

  it('respects k', async () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ id: String(i), symbolName: `fn${i}`, content: `function fn${i}() {}` }),
    );
    const embeddings = chunks.map((c) => makeEmbedding(c, [1, 0, 0, 0]));
    const paths = tmpStorePaths();
    await indexRepo('r1', chunks, embeddings, paths);

    const result = await retrieveCandidates('r1', 'fn', noRoute(), {
      ...paths,
      k: 2,
      embedFn: fakeEmbedFn,
    });
    expect(result.vector).toHaveLength(2);
  });

  describe('Route symbol/file boost', () => {
    it('surfaces a chunk via an extracted symbol even when it scores weakly on the full question', async () => {
      const chunks = [
        // Exact symbol match, but its content shares almost no words with the question below.
        makeChunk({
          id: 'target',
          symbolName: 'RecordTaskDuration',
          content: 'func RecordTaskDuration(ctx context.Context, startTime time.Time) {}',
        }),
        // Lots of lexical overlap with the question, but it's not the symbol being asked about.
        makeChunk({
          id: 'decoy',
          symbolName: 'unrelatedMetricHelper',
          content:
            'function metricHelper() { return "please tell me about the metric duration recording thing"; }',
        }),
      ];
      const embeddings = [
        makeEmbedding(chunks[0], [1, 0, 0, 0]),
        makeEmbedding(chunks[1], [0, 1, 0, 0]),
      ];
      const paths = tmpStorePaths();
      await indexRepo('r1', chunks, embeddings, paths);

      const question = 'please tell me about the metric duration recording thing';
      const route: RouteResult = {
        intent: 'symbol',
        symbols: ['RecordTaskDuration'],
        files: [],
        reason: 'test',
      };

      const withRoute = await retrieveCandidates('r1', question, route, {
        ...paths,
        embedFn: fakeEmbedFn,
      });
      const withoutRoute = await retrieveCandidates('r1', question, noRoute(), {
        ...paths,
        embedFn: fakeEmbedFn,
      });

      expect(withRoute.lexical.some((h) => h.id === 'target')).toBe(true);
      // Without the symbol hint, plain-text search on the question alone should NOT
      // find the target (it shares no real words with the question — only the decoy does).
      expect(withoutRoute.lexical.some((h) => h.id === 'target')).toBe(false);
    });

    it('does not duplicate a hit that scores well on both the question and the token query', async () => {
      const chunk = makeChunk({
        id: 'a',
        symbolName: 'add',
        content: 'function add(a, b) { return a + b; }',
      });
      const paths = tmpStorePaths();
      await indexRepo('r1', [chunk], [makeEmbedding(chunk, [1, 0, 0, 0])], paths);

      const route: RouteResult = { intent: 'symbol', symbols: ['add'], files: [], reason: 'test' };
      const result = await retrieveCandidates('r1', 'add', route, {
        ...paths,
        embedFn: fakeEmbedFn,
      });

      expect(result.lexical.filter((h) => h.id === 'a')).toHaveLength(1);
    });
  });
});

describe('retrieveCandidates — real embedder (default embedFn wiring)', () => {
  it('finds the semantically closest chunk when embedFn is not overridden', async () => {
    const chunks = [
      makeChunk({
        id: 'a',
        symbolName: 'add',
        content: 'function add(a, b) { return a + b; }',
      }),
      makeChunk({
        id: 'b',
        symbolName: 'unrelated',
        content: 'the quick brown fox jumps over the lazy dog',
      }),
    ];
    const paths = tmpStorePaths();
    // Real embeddings for the indexed chunks too, so the comparison is meaningful.
    const [addVec, unrelatedVec] = await embedBatch(chunks.map((c) => c.content));
    await indexRepo(
      'r1',
      chunks,
      [makeEmbedding(chunks[0], addVec), makeEmbedding(chunks[1], unrelatedVec)],
      paths,
    );

    const result = await retrieveCandidates(
      'r1',
      'a function that sums two numbers',
      noRoute(),
      paths,
    );
    expect(result.vector[0]?.id).toBe('a');
  }, 30_000);
});
