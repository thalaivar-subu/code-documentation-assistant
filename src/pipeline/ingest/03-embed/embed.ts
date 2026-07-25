/**
 * Ingest · Stage 3 — Embed. Turns chunks into vectors, deduped and cached by
 * `contentHash` so unchanged/duplicate content is never re-embedded.  →  docs: ./README.md
 */

import type { Chunk } from '../../../core/types.ts';
import { defaultCachePath, loadCache, saveCache } from './embed-cache.ts';
import { EMBED_DIMS, EMBED_MODEL, embedBatch } from './embedder.ts';

export interface EmbeddedChunk {
  chunkId: string;
  contentHash: string;
  vector: number[];
}

export interface EmbedChunksOptions {
  /** Where the persistent content-hash → vector cache lives. Default: one file per model. */
  cachePath?: string;
  /** How many unique texts go into one model forward-pass. */
  batchSize?: number;
  /** Swap the embedding function — tests inject a fake to skip loading the real model. */
  embedFn?: (texts: string[]) => Promise<number[][]>;
}

export interface EmbedChunksResult {
  embeddings: EmbeddedChunk[];
  /** Total chunks in, one embedding out per chunk (duplicates share a vector). */
  total: number;
  /** Distinct content hashes actually sent through the model this run. */
  embedded: number;
  /** Distinct content hashes served from the cache (disk or in-run duplicates). */
  cached: number;
  dims: number;
  model: string;
  ms: number;
}

const DEFAULT_BATCH_SIZE = 16;

/**
 * Embed every chunk. Two things are deduped by `contentHash` before any model
 * call happens: identical content across files/runs (boilerplate, re-index of
 * unchanged code) and the multiple parts an oversized function may have split
 * into (each part already has distinct content/hash, so this doesn't collapse
 * them — see Stage 2's `splitOversized`).
 */
export async function embedChunks(
  chunks: Chunk[],
  opts: EmbedChunksOptions = {},
): Promise<EmbedChunksResult> {
  const started = Date.now();
  const cachePath = opts.cachePath ?? defaultCachePath(EMBED_MODEL);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const embedFn = opts.embedFn ?? embedBatch;

  const cache = await loadCache(cachePath);

  const toCompute = new Map<string, string>();
  for (const c of chunks) {
    if (!cache.has(c.contentHash) && !toCompute.has(c.contentHash)) {
      toCompute.set(c.contentHash, c.content);
    }
  }

  const hashes = [...toCompute.keys()];
  for (let i = 0; i < hashes.length; i += batchSize) {
    const batchHashes = hashes.slice(i, i + batchSize);
    const vectors = await embedFn(batchHashes.map((h) => toCompute.get(h)!));
    batchHashes.forEach((h, j) => cache.set(h, vectors[j]));
  }

  if (hashes.length > 0) await saveCache(cachePath, cache);

  const embeddings: EmbeddedChunk[] = chunks.map((c) => ({
    chunkId: c.id,
    contentHash: c.contentHash,
    vector: cache.get(c.contentHash)!,
  }));

  const uniqueHashes = new Set(chunks.map((c) => c.contentHash)).size;

  return {
    embeddings,
    total: chunks.length,
    embedded: hashes.length,
    cached: uniqueHashes - hashes.length,
    dims: embeddings[0]?.vector.length ?? EMBED_DIMS,
    model: EMBED_MODEL,
    ms: Date.now() - started,
  };
}

export { EMBED_DIMS, EMBED_MODEL } from './embedder.ts';
