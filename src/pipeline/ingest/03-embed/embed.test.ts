/**
 * Tests for Ingest · Stage 3 (Embed).
 *
 *  - Caching/dedup logic against a fake `embedFn` (fast, no model load).
 *  - One real-model test confirming the actual Transformers.js pipeline shape
 *    and that semantically similar code embeds closer than unrelated code.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Chunk } from '../../../core/types.ts';
import { embedChunks } from './embed.ts';
import { EMBED_DIMS, embedBatch } from './embedder.ts';

function makeChunk(overrides: Partial<Chunk>): Chunk {
  return {
    id: overrides.contentHash ?? 'id',
    repoId: 'r',
    filePath: 'a.ts',
    kind: 'code',
    language: 'ts',
    symbolName: 'f',
    symbolType: 'function',
    startLine: 1,
    endLine: 2,
    content: 'content',
    contentHash: 'hash',
    ...overrides,
  };
}

/** Deterministic fake: one distinct vector per distinct input text, tracks call count. */
function fakeEmbedder() {
  const calls: string[][] = [];
  const embedFn = vi.fn(async (texts: string[]) => {
    calls.push(texts);
    return texts.map((t) => Array.from({ length: 4 }, (_, i) => t.charCodeAt(0) + i));
  });
  return { embedFn, calls };
}

let tmpDirs: string[] = [];
function tmpCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cda-embed-test-'));
  tmpDirs.push(dir);
  return join(dir, 'cache.json');
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

describe('embedChunks — caching and dedup', () => {
  it('embeds each distinct content hash exactly once', async () => {
    const { embedFn } = fakeEmbedder();
    const chunks = [
      makeChunk({ contentHash: 'h1', content: 'a', id: '1' }),
      makeChunk({ contentHash: 'h2', content: 'b', id: '2' }),
      makeChunk({ contentHash: 'h1', content: 'a', id: '3' }), // duplicate hash, different chunk
    ];

    const result = await embedChunks(chunks, { cachePath: tmpCachePath(), embedFn });

    expect(result.total).toBe(3);
    expect(result.embedded).toBe(2); // only h1, h2 sent through the model
    expect(result.cached).toBe(0); // nothing was already cached
    expect(embedFn).toHaveBeenCalledTimes(1); // one batch, deduped before the call
    expect(embedFn).toHaveBeenCalledWith(['a', 'b']);

    // duplicate-hash chunks share the identical vector
    expect(result.embeddings[0].vector).toEqual(result.embeddings[2].vector);
    expect(result.embeddings.map((e) => e.chunkId)).toEqual(['1', '2', '3']);
  });

  it('reuses a persisted cache across separate calls (no re-embedding)', async () => {
    const cachePath = tmpCachePath();
    const { embedFn: firstFn } = fakeEmbedder();
    const chunk = makeChunk({ contentHash: 'stable', content: 'x', id: '1' });

    const first = await embedChunks([chunk], { cachePath, embedFn: firstFn });
    expect(first.embedded).toBe(1);
    expect(first.cached).toBe(0);

    const { embedFn: secondFn } = fakeEmbedder();
    const second = await embedChunks([chunk], { cachePath, embedFn: secondFn });

    expect(second.embedded).toBe(0); // fully served from the persisted cache
    expect(second.cached).toBe(1);
    expect(secondFn).not.toHaveBeenCalled();
    expect(second.embeddings[0].vector).toEqual(first.embeddings[0].vector);
  });

  it('batches uncached hashes at the given batchSize', async () => {
    const { embedFn } = fakeEmbedder();
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ contentHash: `h${i}`, content: `c${i}`, id: String(i) }),
    );

    await embedChunks(chunks, { cachePath: tmpCachePath(), embedFn, batchSize: 2 });

    // 5 unique hashes / batchSize 2 → 3 calls (2, 2, 1)
    expect(embedFn).toHaveBeenCalledTimes(3);
  });

  it('handles zero chunks without calling the embedder', async () => {
    const { embedFn } = fakeEmbedder();
    const result = await embedChunks([], { cachePath: tmpCachePath(), embedFn });
    expect(result.total).toBe(0);
    expect(embedFn).not.toHaveBeenCalled();
  });
});

describe('embedBatch — real model', () => {
  it('produces 384-dim normalized vectors, similar code closer than unrelated code', async () => {
    const [a, aVariant, unrelated] = await embedBatch([
      'function add(a, b) { return a + b; }',
      'function sum(x, y) { return x + y; }',
      'the quick brown fox jumps over the lazy dog',
    ]);

    expect(a).toHaveLength(EMBED_DIMS);

    // normalized → magnitude ≈ 1
    const magnitude = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);

    const dot = (u: number[], v: number[]) => u.reduce((s, x, i) => s + x * v[i], 0);
    const simToVariant = dot(a, aVariant);
    const simToUnrelated = dot(a, unrelated);
    expect(simToVariant).toBeGreaterThan(simToUnrelated);
  }, 30_000);
});
