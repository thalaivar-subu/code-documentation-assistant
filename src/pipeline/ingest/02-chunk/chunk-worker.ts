/**
 * Worker-thread entrypoint for parallel chunking. Spawned by chunk-pool.ts via the
 * chunk-worker-boot.mjs bootstrap (which registers tsx's TS loader for this thread
 * before importing this file — a worker cannot load `.ts` directly otherwise).
 *
 * Protocol: receives one `{ index, repoId, entry, commitSha }` message at a time
 * (pull-based — the pool sends the next file only after this one's result comes
 * back), chunks that single file with the exact same `chunkFile` used by the
 * sequential path, and posts `{ index, chunks }` (or `{ index, error }`) back.
 */

import { parentPort } from 'node:worker_threads';

import type { Chunk, FileEntry } from '../../../core/types.ts';
import { chunkFile } from './chunk-file.ts';

interface WorkRequest {
  index: number;
  repoId: string;
  entry: FileEntry;
  commitSha?: string;
}

type WorkResult = { index: number; chunks: Chunk[] } | { index: number; error: string };

if (!parentPort) {
  throw new Error('chunk-worker.ts must be run inside a worker_thread');
}

parentPort.on('message', (msg: WorkRequest) => {
  chunkFile(msg.repoId, msg.entry, msg.commitSha)
    .then((chunks) => {
      const result: WorkResult = { index: msg.index, chunks };
      parentPort!.postMessage(result);
    })
    .catch((err: unknown) => {
      const result: WorkResult = {
        index: msg.index,
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort!.postMessage(result);
    });
});
