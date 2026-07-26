/**
 * The Ingest pipeline (Clone → Chunk → Embed → Index), wired to emit SSE-shaped
 * events as it runs, framework-agnostic — server.ts/sse.ts are the only things
 * that know about HTTP/SSE formatting. →  docs: ./README.md
 */

import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { cloneRepo, parseSource, toRepoId } from '../pipeline/ingest/01-clone/clone.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import {
  deleteLexicalIndexFile,
  findLeastRecentlyIndexedRepoId,
  indexPath,
  invalidateCachedLexicalIndex,
  listIndexedRepoIds,
} from '../pipeline/ingest/04-index/lexical-store.ts';
import {
  deleteVectorsByRepoId,
  getSharedVectorStore,
} from '../pipeline/ingest/04-index/vector-store.ts';
import { invalidateAskCache } from './ask-stream.ts';
import { repoChunks } from './repo-cache.ts';

export type EmitFn = (event: string, data: unknown) => void;

/**
 * A demo server with no auth and no per-user quota — without a ceiling, an
 * open `/index` endpoint accumulates unbounded clones on disk (`.cache/repos/`)
 * and unbounded vector/lexical index growth, from anyone (or any repeated
 * click) hitting it. Override with MAX_INDEXED_REPOS for a bigger box.
 */
const MAX_INDEXED_REPOS = Number(process.env.MAX_INDEXED_REPOS) || 20;

async function evictRepo(repoId: string): Promise<void> {
  const db = await getSharedVectorStore();
  await deleteVectorsByRepoId(db, repoId);
  await deleteLexicalIndexFile(indexPath(repoId));
  invalidateAskCache(repoId);
  repoChunks.delete(repoId);
}

export async function runIndexStream(
  repo: string,
  fresh: boolean | undefined,
  emit: EmitFn,
): Promise<void> {
  try {
    // repoId is derivable without cloning, so the limit check (and any
    // eviction it triggers) happens before any expensive work — re-indexing an
    // already-indexed repo never evicts anything (it doesn't grow the count).
    const repoId = toRepoId(parseSource(repo));
    const existingRepoIds = await listIndexedRepoIds();
    if (!existingRepoIds.includes(repoId) && existingRepoIds.length >= MAX_INDEXED_REPOS) {
      const evictedRepoId = await findLeastRecentlyIndexedRepoId();
      if (evictedRepoId) {
        await evictRepo(evictedRepoId);
        emit('step', {
          stage: 'clone',
          message: `at the ${MAX_INDEXED_REPOS}-repo limit — evicted least-recently-used ${evictedRepoId} to make room`,
        });
      }
    }

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
