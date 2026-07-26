import type { Chunk } from '../core/types.ts';
import {
  getSharedVectorStore,
  listVectors,
  vectorRowToChunk,
} from '../pipeline/ingest/04-index/vector-store.ts';

/**
 * Which chunks belong to a repoId, kept in memory for /ask to hand to
 * Expand's symbol graph. Populated directly by /index; for a repoId this
 * process hasn't indexed itself (e.g. after a restart, or a repo indexed by
 * an earlier server process), `getOrReconstructChunks` rebuilds it from the
 * on-disk vector store instead of requiring a full re-clone/re-chunk/re-embed.
 *
 * Caches the PROMISE, not the resolved array — two concurrent `/ask` calls for
 * the same not-yet-cached repoId used to both race into a full `listVectors`
 * scan (a stampede) before either had set the cache. Matches the same
 * cache-the-promise pattern already used by `getSharedVectorStore` and
 * `getCachedLexicalIndex`: a failed reconstruction is never cached, so the
 * next call retries instead of repeating the same rejection forever.
 */
export const repoChunks = new Map<string, Promise<Chunk[] | undefined>>();

/**
 * Returns the cached chunks for `repoId`, reconstructing them from the vector
 * store on a cache miss. Resolves `undefined` only if the repo was genuinely
 * never indexed (no rows for it in the store either) — that "not indexed"
 * result is still cached, since it's a real, stable fact until the next
 * `/index` call invalidates it, not a failure.
 */
export function getOrReconstructChunks(repoId: string): Promise<Chunk[] | undefined> {
  const cached = repoChunks.get(repoId);
  if (cached) return cached;

  const promise = (async () => {
    const db = await getSharedVectorStore();
    const rows = await listVectors(db, { repoId });
    if (rows.length === 0) return undefined;
    return rows.map(vectorRowToChunk);
  })().catch((err: unknown) => {
    repoChunks.delete(repoId);
    throw err;
  });

  repoChunks.set(repoId, promise);
  return promise;
}
