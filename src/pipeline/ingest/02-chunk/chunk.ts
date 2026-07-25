/**
 * Ingest · Stage 2 orchestrator: Chunk.  →  docs: ./README.md
 *
 * Discover (part A) → chunk each file (part B, parallelized for large repos via
 * chunk-pool.ts) → a flat list of `Chunk`s ready for Stage 3 (Embed). Routes by
 * `FileEntry.kind`: code → AST, config/text → flat.
 */

import type { Chunk, CloneResult } from '../../../core/types.ts';
import { chunkEntries, type ChunkEntriesOptions } from './chunk-pool.ts';
import { discoverFiles, type DiscoverOptions } from './discover.ts';

// Re-exported so existing single-file call sites (and tests) don't need to know
// this now lives in a separate leaf module (see chunk-file.ts for why).
export { chunkFile } from './chunk-file.ts';

export interface ChunkRepoResult {
  chunks: Chunk[];
  fileCount: number;
  chunkCount: number;
  /** Whether chunking ran across the worker pool (false = sequential, small repo). */
  parallel: boolean;
  /** Number of worker threads used (1 when sequential). */
  workers: number;
}

/** Discover + chunk an entire cloned repo. */
export async function chunkRepo(
  clone: Pick<CloneResult, 'repoId' | 'repoPath' | 'commitSha'>,
  opts: DiscoverOptions & ChunkEntriesOptions = {},
): Promise<ChunkRepoResult> {
  const entries = await discoverFiles(clone.repoPath, opts);
  const { chunks, parallel, workers } = await chunkEntries(
    clone.repoId,
    entries,
    clone.commitSha,
    opts,
  );
  return { chunks, fileCount: entries.length, chunkCount: chunks.length, parallel, workers };
}
