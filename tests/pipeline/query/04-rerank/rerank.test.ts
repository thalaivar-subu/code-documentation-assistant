/**
 * Tests for Query · Stage 4 (Rerank).
 *
 * Key property under test: reranking can and does change the order Fuse
 * produced — a fake scorer proves the mechanism reorders by its own score,
 * not RRF's — plus hydration (content lookup) and its failure mode.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Chunk } from '../../../../src/core/types.ts';
import type { EmbeddedChunk } from '../../../../src/pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../../../../src/pipeline/ingest/04-index/index.ts';
import type { FusedHit } from '../../../../src/pipeline/query/03-fuse/fuse.ts';
import { rerankResults } from '../../../../src/pipeline/query/04-rerank/rerank.ts';
import { scorePairs } from '../../../../src/pipeline/query/04-rerank/reranker.ts';

let tmpDirs: string[] = [];
function tmpStorePaths() {
  const dir = mkdtempSync(join(tmpdir(), 'cda-rerank-test-'));
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

function fusedHit(id: string, rrfScore: number, overrides: Partial<FusedHit> = {}): FusedHit {
  return {
    id,
    filePath: `${id}.ts`,
    symbolName: id,
    startLine: 1,
    endLine: 2,
    rrfScore,
    sources: ['vector'],
    ...overrides,
  };
}

describe('rerankResults', () => {
  it('reorders candidates by rerank score, not by the RRF score Fuse gave them', async () => {
    const chunks = [
      makeChunk({ id: 'rrf-winner', content: 'irrelevant content' }),
      makeChunk({ id: 'rerank-winner', content: 'the actually relevant content' }),
    ];
    const paths = tmpStorePaths();
    await indexRepo(
      'r1',
      chunks,
      [makeEmbedding(chunks[0], [1, 0, 0, 0]), makeEmbedding(chunks[1], [0, 1, 0, 0])],
      paths,
    );

    const fused = [fusedHit('rrf-winner', 0.9), fusedHit('rerank-winner', 0.1)];
    const scoreFn = async (_q: string, docs: string[]) =>
      docs.map((d) => (d.includes('actually relevant') ? 0.95 : 0.05));

    const result = await rerankResults('r1', 'find the relevant thing', fused, {
      ...paths,
      scoreFn,
    });

    expect(result[0].id).toBe('rerank-winner');
    expect(result[0].rerankScore).toBe(0.95);
    expect(result[1].id).toBe('rrf-winner');
    // rrfScore is carried through unchanged for comparison, even though it no longer decides order
    expect(result[0].rrfScore).toBe(0.1);
  });

  it('respects limit', async () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ id: `c${i}`, content: `content ${i}` }),
    );
    const paths = tmpStorePaths();
    await indexRepo(
      'r1',
      chunks,
      chunks.map((c) => makeEmbedding(c, [1, 0, 0, 0])),
      paths,
    );

    const fused = chunks.map((c, i) => fusedHit(c.id, 1 / (i + 1)));
    const scoreFn = async (_q: string, docs: string[]) => docs.map(() => 0.5);

    const result = await rerankResults('r1', 'q', fused, { ...paths, limit: 2, scoreFn });
    expect(result).toHaveLength(2);
  });

  it('empty input returns empty output without calling the scorer', async () => {
    let called = false;
    const scoreFn = async (_q: string, docs: string[]) => {
      called = true;
      return docs.map(() => 0);
    };
    const result = await rerankResults('r1', 'q', [], { ...tmpStorePaths(), scoreFn });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('drops a fused hit whose chunk is no longer in the index instead of crashing', async () => {
    const chunk = makeChunk({ id: 'real', content: 'real content' });
    const paths = tmpStorePaths();
    await indexRepo('r1', [chunk], [makeEmbedding(chunk, [1, 0, 0, 0])], paths);

    const fused = [fusedHit('real', 0.5), fusedHit('ghost', 0.9)]; // 'ghost' was never indexed
    const scoreFn = async (_q: string, docs: string[]) => docs.map(() => 0.5);

    const result = await rerankResults('r1', 'q', fused, { ...paths, scoreFn });
    expect(result.map((r) => r.id)).toEqual(['real']);
  });
});

describe('scorePairs — real cross-encoder', () => {
  it('scores an actually-relevant chunk higher than an unrelated one', async () => {
    const scores = await scorePairs('who calls RecordTaskDuration?', [
      'func RecordTaskDuration(ctx context.Context, startTime time.Time) {}',
      'the quick brown fox jumps over the lazy dog',
    ]);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[0]).toBeLessThanOrEqual(1);
  }, 30_000);
});
