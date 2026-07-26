/**
 * Tests for Ingest · Stage 4 (Index) orchestrator — joining Stage 2 chunks with
 * Stage 3 embeddings and writing both stores.
 *
 * The Gate-3-style property under test: re-running index on the exact same
 * chunks/embeddings must NOT grow either store — deterministic ids make
 * indexing idempotent, which is what makes safe re-indexing possible.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Chunk } from '../../../../src/core/types.ts';
import type { EmbeddedChunk } from '../../../../src/pipeline/ingest/03-embed/embed.ts';
import { indexRepo, peekIndex } from '../../../../src/pipeline/ingest/04-index/index.ts';

let tmpDirs: string[] = [];
function tmpStorePaths() {
  const dir = mkdtempSync(join(tmpdir(), 'cda-index-test-'));
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

describe('indexRepo', () => {
  it('writes matching chunks/embeddings into both stores', async () => {
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

    const result = await indexRepo('r1', chunks, embeddings, tmpStorePaths());

    expect(result.chunksIndexed).toBe(2);
    expect(result.vectorCount).toBe(2);
    expect(result.lexicalCount).toBe(2);
  });

  it('re-indexing the same chunks/embeddings does not duplicate (idempotent)', async () => {
    const chunks = [makeChunk({ id: 'a' })];
    const embeddings = [makeEmbedding(chunks[0], [1, 0, 0, 0])];
    const paths = tmpStorePaths();

    const first = await indexRepo('r1', chunks, embeddings, paths);
    const second = await indexRepo('r1', chunks, embeddings, paths);

    expect(first.vectorCount).toBe(1);
    expect(second.vectorCount).toBe(1);
    expect(first.lexicalCount).toBe(1);
    expect(second.lexicalCount).toBe(1);
  });

  it('throws if a chunk has no matching embedding (join safety)', async () => {
    const chunks = [makeChunk({ id: 'a' }), makeChunk({ id: 'b' })];
    const embeddings = [makeEmbedding(chunks[0], [1, 0, 0, 0])]; // missing 'b'

    await expect(indexRepo('r1', chunks, embeddings, tmpStorePaths())).rejects.toThrow(
      /no embedding/,
    );
  });
});

describe('peekIndex', () => {
  it('returns the raw stored rows for a repo, full vector included — no ranking, just a scan', async () => {
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

    const rows = await peekIndex('r1', paths);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(rows.find((r) => r.id === 'a')?.vector).toEqual([1, 0, 0, 0]);
  });

  it('respects limit', async () => {
    const chunks = [makeChunk({ id: 'a' }), makeChunk({ id: 'b' })];
    const embeddings = [
      makeEmbedding(chunks[0], [1, 0, 0, 0]),
      makeEmbedding(chunks[1], [0, 1, 0, 0]),
    ];
    const paths = tmpStorePaths();
    await indexRepo('r1', chunks, embeddings, paths);

    const rows = await peekIndex('r1', { ...paths, limit: 1 });
    expect(rows).toHaveLength(1);
  });
});
