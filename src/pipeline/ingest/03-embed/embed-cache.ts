/**
 * Content-hash-keyed vector cache — persisted to disk so re-indexing (and repos
 * that share boilerplate) never re-embed the same content twice.  →  docs: ./README.md
 *
 * Deliberately a flat JSON file, not a database: one file per model, loaded once
 * per run, written once at the end. Stage 4 (Index) owns the real vector store;
 * this cache only exists to make embedding idempotent and cheap.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type EmbeddingCache = Map<string, number[]>;

/** One cache file per model — swapping models never mixes incompatible vectors. */
export function defaultCachePath(model: string): string {
  return `.cache/embeddings/${model.replace(/[^a-z0-9-]+/gi, '_')}.json`;
}

export async function loadCache(path: string): Promise<EmbeddingCache> {
  try {
    const raw = await readFile(path, 'utf8');
    return new Map(Object.entries(JSON.parse(raw) as Record<string, number[]>));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
}

export async function saveCache(path: string, cache: EmbeddingCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(Object.fromEntries(cache)), 'utf8');
}
