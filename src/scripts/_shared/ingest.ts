/**
 * The clone → chunk → embed → index preamble, byte-for-byte identical across
 * every query-stage dev script (retrieve/fuse/rerank/expand/grade/generate/ask)
 * plus index-repo.ts itself — see docs/REFACTOR-PLAN.md #17. `clone.ts`,
 * `chunk.ts`, and `embed.ts` deliberately do NOT use this: their whole purpose
 * is to stop partway through and inspect that one stage, so forcing them
 * through the full chain would change what they actually test.
 */

import { cloneRepo } from '../../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../../pipeline/ingest/03-embed/embed.ts';
import { indexRepo, type IndexRepoResult } from '../../pipeline/ingest/04-index/index.ts';
import type { Chunk, CloneResult } from '../../core/types.ts';
import type { EmbeddedChunk } from '../../pipeline/ingest/03-embed/embed.ts';

export interface IngestedRepo {
  clone: CloneResult;
  chunks: Chunk[];
  embeddings: EmbeddedChunk[];
  indexResult: IndexRepoResult;
}

/** clone → chunk → embed → index, logging each step the same way every script did by hand. */
export async function ingestRepo(input: string): Promise<IngestedRepo> {
  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  const indexResult = await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);
  return { clone, chunks, embeddings, indexResult };
}
