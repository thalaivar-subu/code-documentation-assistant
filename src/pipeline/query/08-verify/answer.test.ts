/**
 * Tests for the end-to-end query pipeline (Route through Verify). Real
 * store/retrieve/rerank (same pattern as query-loop.test.ts), fake
 * generateFn (the wiring is what's under test here, not the LLM itself —
 * generate.ts's own real-model test already covers that).
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Chunk } from '../../../core/types.ts';
import { embedBatch } from '../../ingest/03-embed/embedder.ts';
import { indexRepo } from '../../ingest/04-index/index.ts';
import { answerQuestion } from './answer.ts';

let tmpDirs: string[] = [];
function tmpStorePaths() {
  const dir = mkdtempSync(join(tmpdir(), 'cda-answer-test-'));
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

async function indexOneChunk(chunk: Chunk, paths: { dbPath: string; lexicalDir: string }) {
  const [vec] = await embedBatch([chunk.content]);
  await indexRepo(
    'r1',
    [chunk],
    [{ chunkId: chunk.id, contentHash: chunk.contentHash, vector: vec }],
    paths,
  );
}

describe('answerQuestion', () => {
  it('wires the full pipeline: a faithful, cited answer resolves fully', async () => {
    const chunk = makeChunk({
      id: 'x',
      symbolName: 'add',
      filePath: 'a.ts',
      startLine: 1,
      endLine: 2,
      content: 'function add(a, b) { return a + b; }',
    });
    const paths = tmpStorePaths();
    await indexOneChunk(chunk, paths);

    const generateFn = async () => 'It adds two numbers (a.ts:1-2).';
    const result = await answerQuestion('r1', 'what does add do?', [chunk], {
      ...paths,
      generateFn,
    });

    expect(result.answer).toContain('adds two numbers');
    expect(result.citations).toEqual([{ filePath: 'a.ts', startLine: 1, endLine: 2 }]);
    expect(result.verify.hasCitations).toBe(true);
    expect(result.verify.resolvedCount).toBe(1);
    expect(result.verify.resolutionRate).toBe(1);
    // The full loop's own fields (route, expanded, hops) are still present.
    expect(result.route.intent).toBeDefined();
    expect(result.expanded.length).toBeGreaterThan(0);
  }, 30_000);

  it('flags an uncited answer as hasCitations: false, not as a false "fully resolved"', async () => {
    const chunk = makeChunk({
      id: 'x',
      symbolName: 'add',
      content: 'function add(a, b) { return a + b; }',
    });
    const paths = tmpStorePaths();
    await indexOneChunk(chunk, paths);

    const generateFn = async () => 'It adds two numbers.'; // no citation at all
    const result = await answerQuestion('r1', 'what does add do?', [chunk], {
      ...paths,
      generateFn,
    });

    expect(result.verify.hasCitations).toBe(false);
    expect(result.verify.totalCount).toBe(0);
  }, 30_000);

  it('flags a hallucinated citation (real-looking, but not in the given context) as unresolved', async () => {
    const chunk = makeChunk({
      id: 'x',
      symbolName: 'add',
      filePath: 'a.ts',
      content: 'function add(a, b) { return a + b; }',
    });
    const paths = tmpStorePaths();
    await indexOneChunk(chunk, paths);

    const generateFn = async () => 'It adds two numbers (b.ts:99-105).'; // never in context
    const result = await answerQuestion('r1', 'what does add do?', [chunk], {
      ...paths,
      generateFn,
    });

    expect(result.verify.hasCitations).toBe(true);
    expect(result.verify.resolvedCount).toBe(0);
    expect(result.verify.resolutionRate).toBe(0);
  }, 30_000);
});
