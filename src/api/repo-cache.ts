import type { Chunk } from '../core/types.ts';

/**
 * Which chunks belong to a repoId, kept in memory for /api/ask to hand to
 * Expand's symbol graph. Not persisted — a server restart loses this even
 * though the actual vector/lexical index on disk survives. Fine for a
 * single-process demo server; a production version would reconstruct this
 * from the index instead (see 04-index/vector-store.ts's `getVectorsByIds`
 * for the pattern — scanning + reversing the `''`-sentinel convention back
 * to `undefined`).
 */
export const repoChunks = new Map<string, Chunk[]>();
