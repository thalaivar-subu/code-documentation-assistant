/**
 * Tests for the query loop (Query Stage 6's orchestrator) — real store
 * operations, real embedder, real reranker (same pattern as rerank.test.ts's
 * integration test), because the property under test is control flow
 * (does it terminate, does it loop) rather than scoring math.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Chunk } from '../../../core/types.ts';
import { embedBatch } from '../../ingest/03-embed/embedder.ts';
import { indexRepo } from '../../ingest/04-index/index.ts';
import { indexAndRunQueryLoop, runQueryLoop } from './query-loop.ts';

let tmpDirs: string[] = [];
function tmpStorePaths() {
  const dir = mkdtempSync(join(tmpdir(), 'cda-query-loop-test-'));
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

describe('runQueryLoop', () => {
  it('resolves in a single hop for a clear concept question with a strong match', async () => {
    const chunks = [
      makeChunk({
        id: 'add',
        symbolName: 'add',
        content: 'function add(a, b) { return a + b; }',
      }),
      makeChunk({
        id: 'unrelated',
        symbolName: 'unrelated',
        content: 'the quick brown fox jumps over the lazy dog',
      }),
    ];
    const paths = tmpStorePaths();
    const [addVec, unrelatedVec] = await embedBatch(chunks.map((c) => c.content));
    const embeddings = [
      { chunkId: 'add', contentHash: 'hash', vector: addVec },
      { chunkId: 'unrelated', contentHash: 'hash', vector: unrelatedVec },
    ];

    const result = await indexAndRunQueryLoop(
      'r1',
      chunks,
      embeddings,
      'a function that adds two numbers',
      paths,
    );

    expect(result.hops).toHaveLength(1);
    expect(result.hops[0].grade.sufficient).toBe(true);
    expect(result.expanded.some((h) => h.id === 'add')).toBe(true);
  }, 30_000);

  it('terminates at maxHops (never hangs) when a trace question can never find a graph edge', async () => {
    // Every chunk here is isolated — no chunk's content references any other
    // chunk's symbolName — so Expand can never find a caller/callee, and
    // Grade can never call a trace question sufficient before the hop cap.
    const chunks = [
      makeChunk({ id: 'a', symbolName: 'alpha', content: 'function alpha() { return 1; }' }),
      makeChunk({ id: 'b', symbolName: 'beta', content: 'function beta() { return 2; }' }),
    ];
    const paths = tmpStorePaths();
    const [aVec, bVec] = await embedBatch(chunks.map((c) => c.content));
    const embeddings = [
      { chunkId: 'a', contentHash: 'hash', vector: aVec },
      { chunkId: 'b', contentHash: 'hash', vector: bVec },
    ];

    const result = await indexAndRunQueryLoop('r1', chunks, embeddings, 'who calls alpha?', {
      ...paths,
      maxHops: 2,
    });

    expect(result.route.intent).toBe('trace');
    expect(result.hops).toHaveLength(2); // ran to the cap, did not resolve early
    expect(result.hops[0].grade.sufficient).toBe(false);
    expect(result.hops[1].grade.sufficient).toBe(true); // forced by the hop limit
    expect(result.hops[1].grade.reason).toMatch(/hop limit/);
    // No graph edges were ever found, so there were no new symbols to fold
    // into the query — it should be identical across both hops.
    expect(result.hops[1].query).toBe(result.hops[0].query);
  }, 30_000);

  it('runQueryLoop (without indexing) works against an already-indexed repo', async () => {
    const chunk = makeChunk({
      id: 'x',
      symbolName: 'greet',
      content: 'function greet() { return "hi"; }',
    });
    const paths = tmpStorePaths();
    const [vec] = await embedBatch([chunk.content]);
    await indexRepo('r1', [chunk], [{ chunkId: 'x', contentHash: 'hash', vector: vec }], paths);

    const result = await runQueryLoop('r1', 'a function that greets', [chunk], paths);
    expect(result.expanded.some((h) => h.id === 'x')).toBe(true);
  }, 30_000);

  it('fires onRoute once and onHop per hop — the live-progress hooks a UI needs', async () => {
    const chunk = makeChunk({
      id: 'x',
      symbolName: 'greet',
      content: 'function greet() { return "hi"; }',
    });
    const paths = tmpStorePaths();
    const [vec] = await embedBatch([chunk.content]);
    await indexRepo('r1', [chunk], [{ chunkId: 'x', contentHash: 'hash', vector: vec }], paths);

    const routeCalls: string[] = [];
    const hopCalls: number[] = [];
    const result = await runQueryLoop('r1', 'a function that greets', [chunk], {
      ...paths,
      onRoute: (route) => routeCalls.push(route.intent),
      onHop: (hop) => hopCalls.push(hop.hop),
    });

    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]).toBe(result.route.intent);
    expect(hopCalls).toEqual(result.hops.map((h) => h.hop));
  }, 30_000);
});
