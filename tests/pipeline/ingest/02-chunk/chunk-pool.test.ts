/**
 * Tests for the Stage 2 worker-thread chunking pool (chunk-pool.ts).
 *
 * The key property under test: parallel execution must be INVISIBLE in the
 * output — same chunks, same order, as the sequential path — regardless of
 * which worker finishes first. We force the parallel path with a low
 * `parallelThreshold` so this doesn't require 16 real files to exercise.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { FileEntry } from '../../../../src/core/types.ts';
import { chunkEntries, poolSize } from '../../../../src/pipeline/ingest/02-chunk/chunk-pool.ts';

/** N small, distinct TS files in a fresh temp dir, as discoverFiles would describe them. */
function makeEntries(n: number): FileEntry[] {
  const dir = mkdtempSync(join(tmpdir(), 'cda-pool-test-'));
  return Array.from({ length: n }, (_, i) => {
    const relPath = `file${i}.ts`;
    writeFileSync(join(dir, relPath), `export function fn${i}() {\n  return ${i};\n}\n`, 'utf8');
    return {
      absPath: join(dir, relPath),
      relPath,
      kind: 'code' as const,
      language: 'ts' as const,
      sizeBytes: 0,
      sha256: '',
    };
  });
}

describe('poolSize', () => {
  it('returns a value between 1 and the CPU count', () => {
    const n = poolSize();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(cpus().length);
  });
});

describe('chunkEntries — sequential path (below threshold)', () => {
  it('chunks correctly and reports parallel: false', async () => {
    const entries = makeEntries(3);
    const result = await chunkEntries('r', entries, 'sha1', { parallelThreshold: 16 });
    expect(result.parallel).toBe(false);
    expect(result.workers).toBe(1);
    expect(result.chunks.map((c) => c.symbolName)).toEqual(['fn0', 'fn1', 'fn2']);
  });
});

describe('chunkEntries — parallel path (worker pool)', () => {
  it('produces IDENTICAL results to the sequential path, in original order', async () => {
    const entries = makeEntries(10);

    const sequential = await chunkEntries('r', entries, 'sha1', { parallelThreshold: 9999 });
    const parallel = await chunkEntries('r', entries, 'sha1', {
      parallelThreshold: 1, // force pool even for this small set
      workers: 4,
    });

    expect(parallel.parallel).toBe(true);
    expect(parallel.workers).toBe(4);

    // Same chunks, same order — parallelism must be invisible in the output.
    expect(parallel.chunks.map((c) => c.symbolName)).toEqual(
      sequential.chunks.map((c) => c.symbolName),
    );
    expect(parallel.chunks.map((c) => c.id)).toEqual(sequential.chunks.map((c) => c.id));
    expect(parallel.chunks.map((c) => c.contentHash)).toEqual(
      sequential.chunks.map((c) => c.contentHash),
    );
  }, 30_000);

  it('handles more workers than files without hanging', async () => {
    const entries = makeEntries(2);
    const result = await chunkEntries('r', entries, undefined, {
      parallelThreshold: 1,
      workers: 8, // 8 workers, only 2 files — most workers get no work
    });
    expect(result.chunks).toHaveLength(2);
  }, 30_000);
});

describe('chunkEntries — empty input', () => {
  it('resolves immediately for zero entries, even with a pathological threshold', async () => {
    // Regression: entries.length < threshold is `0 < 0` = false for
    // parallelThreshold 0, which used to fall into the pool path — a worker
    // was spawned but never dispatched to (0 files), so completed ===
    // entries.length never became true and the promise hung forever. A short
    // per-test timeout means a real regression here fails fast, not silently.
    const result = await chunkEntries('r', [], 'sha1', { parallelThreshold: 0 });
    expect(result).toEqual({ chunks: [], parallel: false, workers: 1 });
  }, 5_000);

  it('resolves immediately for zero entries with the default threshold too', async () => {
    const result = await chunkEntries('r', [], 'sha1');
    expect(result).toEqual({ chunks: [], parallel: false, workers: 1 });
  }, 5_000);
});
