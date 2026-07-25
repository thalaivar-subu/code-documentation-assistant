/**
 * The Ingest pipeline (Clone → Chunk → Embed → Index), wired to emit SSE-shaped
 * events as it runs, framework-agnostic — server.ts/sse.ts are the only things
 * that know about HTTP/SSE formatting. →  docs: ./README.md
 */

import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import {
  indexPath,
  invalidateCachedLexicalIndex,
} from '../pipeline/ingest/04-index/lexical-store.ts';
import { invalidateAskCache } from './ask-stream.ts';
import { repoChunks } from './repo-cache.ts';

export type EmitFn = (event: string, data: unknown) => void;

export async function runIndexStream(
  repo: string,
  fresh: boolean | undefined,
  emit: EmitFn,
): Promise<void> {
  try {
    const clone = await cloneRepo(repo, {
      fresh,
      onStep: (message) => emit('step', { stage: 'clone', message }),
    });
    emit('step', { stage: 'chunk', message: 'parsing files…' });
    const { chunks } = await chunkRepo(clone);
    emit('step', { stage: 'chunk', message: `${chunks.length} chunks` });

    emit('step', { stage: 'embed', message: 'embedding chunks…' });
    const { embeddings, embedded, cached } = await embedChunks(chunks);
    emit('step', { stage: 'embed', message: `embedded ${embedded}, cached ${cached}` });

    emit('step', { stage: 'index', message: 'writing to the vector + lexical stores…' });
    const indexResult = await indexRepo(clone.repoId, chunks, embeddings);

    // Retrieve caches the loaded lexical index across query hops for speed
    // (see lexical-store.ts's getCachedLexicalIndex) — bust it now so the next
    // question against this repoId sees what was just written, not a stale copy.
    invalidateCachedLexicalIndex(indexPath(clone.repoId));
    // Same reasoning for cached /ask answers (see ask-stream.ts's askCache) —
    // a re-index means old cached answers no longer reflect the real content.
    invalidateAskCache(clone.repoId);

    repoChunks.set(clone.repoId, chunks);

    emit('done', {
      repoId: clone.repoId,
      chunksIndexed: indexResult.chunksIndexed,
      vectorCount: indexResult.vectorCount,
      lexicalCount: indexResult.lexicalCount,
    });
  } catch (err) {
    emit('error', { message: err instanceof Error ? err.message : String(err) });
  }
}
