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
 */
export const repoChunks = new Map<string, Chunk[]>();

/**
 * Returns the cached chunks for `repoId`, reconstructing them from the vector
 * store on a cache miss. Returns `undefined` only if the repo was genuinely
 * never indexed (no rows for it in the store either).
 */
export async function getOrReconstructChunks(repoId: string): Promise<Chunk[] | undefined> {
  const cached = repoChunks.get(repoId);
  if (cached) return cached;

  const db = await getSharedVectorStore();
  const rows = await listVectors(db, { repoId });
  if (rows.length === 0) return undefined;

  const chunks = rows.map(vectorRowToChunk);
  repoChunks.set(repoId, chunks);
  return chunks;
}
