/**
 * The full query pipeline (Route → … → Verify), wired to emit SSE-shaped
 * events as it runs. Framework-agnostic, same split as index-stream.ts.
 * →  docs: ./README.md
 */

import { answerQuestion, type AnswerResult } from '../pipeline/query/08-verify/answer.ts';
import type { Chunk } from '../core/types.ts';
import type { EmitFn } from './sse.ts';
import { AppError, GenerationError } from '../core/errors.ts';

export interface AskStreamOptions {
  maxHops?: number;
  k?: number;
  limit?: number;
  maxTokens?: number;
}

/**
 * Retrieve → Fuse → Rerank → Expand → Grade → Generate → Verify is
 * deterministic for the same (repoId, question, options) — Generate is the
 * one LLM call in the mix, and re-running it for an identical repeat question
 * buys nothing but ~15-20s of wall clock. Cached per-repo so a re-index (see
 * `invalidateAskCache`) can't serve a stale answer from before the content
 * changed. Unbounded for now — fine for a demo server asking a handful of
 * repos; a real deployment would want an LRU/TTL bound.
 */
interface AskCacheEntry {
  repoId: string;
  promise: Promise<AnswerResult>;
}
const askCache = new Map<string, AskCacheEntry>();

// A fixed-position ARRAY, not `JSON.stringify({ repoId, question, ...opts })` —
// object key insertion order isn't a contract either caller is guaranteed to
// preserve, so two logically-identical option objects built in a different
// order used to silently miss the cache instead of hitting it. An array's
// serialization is positional, not order-of-insertion, and JSON.stringify
// still safely escapes whatever the question text contains (a plain
// delimiter-joined string couldn't: a question containing what looks like an
// option value could collide with a different, shorter question).
function cacheKey(repoId: string, question: string, opts: AskStreamOptions): string {
  return JSON.stringify([repoId, question, opts.maxHops, opts.k, opts.limit, opts.maxTokens]);
}

export function invalidateAskCache(repoId: string): void {
  // repoId is stored on the entry, not re-derived by parsing every key back
  // out of its serialized form.
  for (const [key, entry] of askCache) {
    if (entry.repoId === repoId) askCache.delete(key);
  }
}

export async function runAskStream(
  repoId: string,
  question: string,
  chunks: Chunk[],
  opts: AskStreamOptions,
  emit: EmitFn,
  // Kept OUT of AskStreamOptions deliberately — it flows into the cache key via
  // cacheKey()'s JSON.stringify(opts), and a signal object serializes to '{}'
  // regardless of which request it belongs to, which would be a silent,
  // confusing near-collision in the cache key rather than a real distinguisher.
  signal?: AbortSignal,
): Promise<void> {
  try {
    const key = cacheKey(repoId, question, opts);
    const cached = askCache.get(key);

    if (cached) {
      // Replay from cache: no live tokens to stream, so the whole cached
      // answer goes out as one token event — the UI just concatenates
      // onToken results, so this renders instantly instead of streaming.
      const result = await cached.promise;
      emit('route', result.route);
      for (const hop of result.hops) emit('hop', hop);
      emit('token', { token: result.answer });
      emit('done', {
        answer: result.answer,
        citations: result.citations,
        verify: result.verify,
        expanded: result.expanded,
      });
      return;
    }

    const resultPromise = answerQuestion(repoId, question, chunks, {
      ...opts,
      signal,
      onRoute: (route) => emit('route', route),
      onHop: (hop) => emit('hop', hop),
      onToken: (token) => emit('token', { token }),
    }).catch((err: unknown) => {
      // Covers the whole Route→Verify pipeline, not just the Generate stage
      // narrowly — see GenerationError's doc comment.
      throw err instanceof AppError ? err : new GenerationError(errMessage(err));
    });
    // Cache only on success — a failed run is never memoized as if it worked.
    askCache.set(key, {
      repoId,
      promise: resultPromise.catch((err: unknown) => {
        askCache.delete(key);
        throw err;
      }),
    });
    const result = await resultPromise;

    emit('done', {
      answer: result.answer,
      citations: result.citations,
      verify: result.verify,
      expanded: result.expanded,
    });
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'GENERATION_FAILED';
    emit('error', { code, message: errMessage(err) });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
