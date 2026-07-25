/**
 * Parallel chunking pool — Stage 2 performance layer.  →  docs: ./README.md
 *
 * WHY chunking (and not embedding) gets a worker pool: tree-sitter parsing is
 * synchronous, CPU-bound WASM work with no internal threading — one big repo's
 * files parse one at a time on a single core unless we do something about it.
 * ONNX Runtime (Stage 3, embedding) already multi-threads matrix ops internally
 * per inference call, so a worker pool there would mostly just duplicate model
 * weights in memory across threads for little gain — see 03-embed/README.md.
 *
 * Design:
 *  - Pool size = logical CPUs − 1 (leave a core for the main thread/event loop),
 *    capped at MAX_WORKERS so we don't over-subscribe on very large machines
 *    (each worker independently loads tree-sitter's WASM runtime + grammars).
 *  - Below PARALLEL_THRESHOLD files, sequential in-process chunking is used.
 *    MEASURED (not guessed): pool startup (thread creation + tsx's loader +
 *    per-worker WASM init) is a ~500ms FIXED cost, so at typical repo sizes
 *    (dozens to ~150 files) sequential is equal or faster — the pool only pays
 *    off once total sequential work clears that fixed cost by a real margin.
 *    See 02-chunk/README.md for the full measured table (148/444/888/1480 files).
 *  - Work is distributed PULL-based (a worker gets its next file only after
 *    finishing the last one), not statically batched, so one huge file doesn't
 *    leave a worker idle while others are still busy on small ones.
 *  - Results are placed back into their ORIGINAL index, so output order is
 *    identical to the sequential path regardless of which worker finished when —
 *    parallelism doesn't cost determinism.
 */

import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Chunk, FileEntry } from '../../../core/types.ts';
import { chunkFile } from './chunk-file.ts';

const WORKER_BOOT_URL = new URL('./chunk-worker-boot.mjs', import.meta.url);

/**
 * Measured crossover (see module doc): 148 files ≈ a wash, 444 files ≈ 16% faster
 * parallel, 888+ files ≈ 2x+ faster. 300 sits just past where the win becomes real
 * rather than noise.
 */
const DEFAULT_PARALLEL_THRESHOLD = 300;
const MAX_WORKERS = 12;

/** Logical CPUs − 1, clamped to [1, MAX_WORKERS]. */
export function poolSize(): number {
  const cpus = os.cpus().length;
  return Math.max(1, Math.min(cpus - 1, MAX_WORKERS));
}

export interface ChunkEntriesOptions {
  /** File count at/above which the worker pool is used. Default 16. */
  parallelThreshold?: number;
  /** Override the computed pool size (mainly for tests). */
  workers?: number;
}

export interface ChunkEntriesResult {
  chunks: Chunk[];
  /** Whether the worker pool was used (false = sequential, small file count). */
  parallel: boolean;
  /** Number of worker threads used (1 when sequential). */
  workers: number;
}

type WorkResult = { index: number; chunks: Chunk[] } | { index: number; error: string };

function chunkWithPool(
  repoId: string,
  entries: FileEntry[],
  commitSha: string | undefined,
  workerCount: number,
): Promise<Chunk[][]> {
  return new Promise((resolvePromise, reject) => {
    const results: Chunk[][] = new Array(entries.length);
    const pool: Worker[] = [];
    let nextIndex = 0;
    let completed = 0;
    let settled = false;

    const terminateAll = () => {
      for (const w of pool) void w.terminate();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      terminateAll();
      reject(err);
    };

    const dispatchNext = (worker: Worker) => {
      if (nextIndex >= entries.length) return;
      const index = nextIndex++;
      worker.postMessage({ index, repoId, entry: entries[index], commitSha });
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(fileURLToPath(WORKER_BOOT_URL));
      pool.push(worker);

      worker.on('message', (msg: WorkResult) => {
        if (settled) return;
        if ('error' in msg) {
          fail(new Error(`chunking failed for ${entries[msg.index].relPath}: ${msg.error}`));
          return;
        }
        results[msg.index] = msg.chunks;
        completed++;
        if (completed === entries.length) {
          settled = true;
          terminateAll();
          resolvePromise(results);
        } else {
          dispatchNext(worker);
        }
      });
      worker.on('error', fail);

      dispatchNext(worker);
    }

    // Fewer files than workers: some workers never get dispatched to. Nothing to
    // do for them; the loop above only calls dispatchNext once per worker at
    // startup, and `completed === entries.length` still fires correctly.
  });
}

/**
 * Chunk all entries — sequentially in-process for small file counts, or across a
 * worker pool for larger ones. Output order always matches input order.
 */
export async function chunkEntries(
  repoId: string,
  entries: FileEntry[],
  commitSha: string | undefined,
  opts: ChunkEntriesOptions = {},
): Promise<ChunkEntriesResult> {
  // Zero files: nothing to dispatch, so nothing would ever trigger the pool's
  // completion check — return immediately rather than falling into the pool
  // path on a pathological threshold (e.g. `parallelThreshold: 0`), where it
  // would spawn a worker that never receives a message and hang forever.
  if (entries.length === 0) return { chunks: [], parallel: false, workers: 1 };

  const threshold = opts.parallelThreshold ?? DEFAULT_PARALLEL_THRESHOLD;

  if (entries.length < threshold) {
    const chunks: Chunk[] = [];
    for (const entry of entries) chunks.push(...(await chunkFile(repoId, entry, commitSha)));
    return { chunks, parallel: false, workers: 1 };
  }

  const workerCount = Math.max(1, Math.min(opts.workers ?? poolSize(), entries.length));
  const perFile = await chunkWithPool(repoId, entries, commitSha, workerCount);
  return { chunks: perFile.flat(), parallel: true, workers: workerCount };
}
