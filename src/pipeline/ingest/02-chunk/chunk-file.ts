/**
 * Ingest · Stage 2: single-file chunking (leaf module).
 *
 * Pulled out of chunk.ts so both the main thread (chunk.ts, sequential/small repos)
 * and the worker pool (chunk-pool.ts / chunk-worker.ts, large repos) can import
 * `chunkFile` without a circular dependency between the orchestrator and the pool.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import type { Chunk, FileEntry } from '../../../core/types.ts';
import { chunkCode, type RawChunk } from './code-chunker.ts';
import { chunkFlat } from './config-chunker.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Normalize line endings to `\n`. Without this, a CRLF-checked-out repo (common on
 * Windows / some Go/Java repos) produces different `content`/`contentHash` than the
 * same file checked out with LF — silently busting the embedding cache and making
 * `startLine`/`endLine` line counts inconsistent across environments.
 */
export function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

/** Deterministic chunk id → re-indexing upserts instead of duplicating. */
function chunkId(repoId: string, relPath: string, symbolName: string, startLine: number): string {
  return sha256(`${repoId}\0${relPath}\0${symbolName}\0${startLine}`).slice(0, 32);
}

/** Chunk a single already-discovered file into domain `Chunk`s. */
export async function chunkFile(
  repoId: string,
  entry: FileEntry,
  commitSha?: string,
): Promise<Chunk[]> {
  const source = normalizeNewlines(await readFile(entry.absPath, 'utf8'));

  let raw: RawChunk[];
  if (entry.kind === 'code' && entry.language) {
    raw = await chunkCode(source, entry.language, extname(entry.absPath));
    // A code file with no definitions (top-level script) → keep it as one chunk.
    if (raw.length === 0 && source.trim() !== '') {
      raw = [
        {
          symbolName: basename(entry.relPath),
          symbolType: 'file',
          startLine: 1,
          endLine: source.split('\n').length,
          content: source,
        },
      ];
    }
  } else {
    raw = chunkFlat(source, entry.relPath);
  }

  return raw.map((r) => ({
    id: chunkId(repoId, entry.relPath, r.symbolName, r.startLine),
    repoId,
    filePath: entry.relPath,
    kind: entry.kind,
    language: entry.language,
    configFormat: entry.configFormat,
    symbolName: r.symbolName,
    symbolType: r.symbolType,
    parentSymbol: r.parentSymbol,
    startLine: r.startLine,
    endLine: r.endLine,
    content: r.content,
    contentHash: sha256(r.content),
    commitSha,
  }));
}
