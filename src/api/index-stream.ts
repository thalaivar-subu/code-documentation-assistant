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
import { AppError, CloneError, IndexError } from '../core/errors.ts';
import type { EmitFn } from './sse.ts';

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

/**
 * Serializes just the "how many repos are indexed, do we need to evict"
 * decision — cloning/chunking/embedding for different repos still run fully
 * concurrently. Without this, two concurrent `/index` calls for two
 * DIFFERENT new repos could both read the same under-the-limit count and
 * both decide to evict, each picking (and possibly evicting) a repoId the
 * other request needed. A simple promise-chain mutex: only one link of the
 * chain runs at a time, and the chain continues regardless of whether the
 * previous link threw.
 */
let evictionLock: Promise<unknown> = Promise.resolve();
function withEvictionLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = evictionLock.then(fn, fn);
  evictionLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

interface IndexOutcome {
  repoId: string;
  chunksIndexed: number;
  vectorCount: number;
  lexicalCount: number;
}

/**
 * Two concurrent `/index` calls for the SAME repoId used to both `git clone`
 * into the same destination directory — this makes the second caller join
 * the first's in-flight work instead. The joiner doesn't see live step-by-step
 * progress (that already streamed to whichever request started the work) —
 * it gets the final outcome once the shared work finishes. An honest
 * trade-off, not a full duplicate-request cache: a THIRD, later `/index` call
 * after this one has already completed starts fresh, same as before.
 */
const inFlightIndexing = new Map<string, Promise<IndexOutcome>>();

async function doIndex(
  repo: string,
  repoId: string,
  fresh: boolean | undefined,
  emit: EmitFn,
): Promise<IndexOutcome> {
  // repoId is derivable without cloning, so the limit check (and any eviction
  // it triggers) happens before any expensive work — re-indexing an
  // already-indexed repo never evicts anything (it doesn't grow the count).
  await withEvictionLock(async () => {
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
  });

  const clone = await cloneRepo(repo, {
    fresh,
    onStep: (message) => emit('step', { stage: 'clone', message }),
  }).catch((err: unknown) => {
    throw new CloneError(errMessage(err));
  });

  emit('step', { stage: 'chunk', message: 'parsing files…' });
  const { chunks } = await chunkRepo(clone).catch((err: unknown) => {
    throw new IndexError(`chunking failed: ${errMessage(err)}`);
  });
  emit('step', { stage: 'chunk', message: `${chunks.length} chunks` });

  emit('step', { stage: 'embed', message: 'embedding chunks…' });
  const { embeddings, embedded, cached } = await embedChunks(chunks).catch((err: unknown) => {
    throw new IndexError(`embedding failed: ${errMessage(err)}`);
  });
  emit('step', { stage: 'embed', message: `embedded ${embedded}, cached ${cached}` });

  emit('step', { stage: 'index', message: 'writing to the vector + lexical stores…' });
  const indexResult = await indexRepo(clone.repoId, chunks, embeddings).catch((err: unknown) => {
    throw new IndexError(`writing the index failed: ${errMessage(err)}`);
  });

  // Retrieve caches the loaded lexical index across query hops for speed
  // (see lexical-store.ts's getCachedLexicalIndex) — bust it now so the next
  // question against this repoId sees what was just written, not a stale copy.
  invalidateCachedLexicalIndex(indexPath(clone.repoId));
  // Same reasoning for cached /ask answers (see ask-stream.ts's askCache) —
  // a re-index means old cached answers no longer reflect the real content.
  invalidateAskCache(clone.repoId);

  repoChunks.set(clone.repoId, Promise.resolve(chunks));

  return {
    repoId: clone.repoId,
    chunksIndexed: indexResult.chunksIndexed,
    vectorCount: indexResult.vectorCount,
    lexicalCount: indexResult.lexicalCount,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runIndexStream(
  repo: string,
  fresh: boolean | undefined,
  emit: EmitFn,
): Promise<void> {
  const repoId = toRepoId(parseSource(repo));
  const joining = inFlightIndexing.get(repoId);

  try {
    if (joining) {
      emit('step', {
        stage: 'clone',
        message: `already indexing ${repoId} in another request — waiting for it to finish`,
      });
      emit('done', await joining);
      return;
    }

    const promise = doIndex(repo, repoId, fresh, emit);
    inFlightIndexing.set(repoId, promise);
    try {
      emit('done', await promise);
    } finally {
      inFlightIndexing.delete(repoId);
    }
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'INDEX_FAILED';
    emit('error', { code, message: errMessage(err) });
  }
}
