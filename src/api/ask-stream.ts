/**
 * The full query pipeline (Route → … → Verify), wired to emit SSE-shaped
 * events as it runs. Framework-agnostic, same split as index-stream.ts.
 * →  docs: ./README.md
 */

import { answerQuestion, type AnswerResult } from '../pipeline/query/08-verify/answer.ts';
import type { Chunk } from '../core/types.ts';
import type { EmitFn } from './index-stream.ts';

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
const askCache = new Map<string, Promise<AnswerResult>>();

function cacheKey(repoId: string, question: string, opts: AskStreamOptions): string {
  return JSON.stringify({ repoId, question, ...opts });
}

export function invalidateAskCache(repoId: string): void {
  for (const key of askCache.keys()) {
    if (JSON.parse(key).repoId === repoId) askCache.delete(key);
  }
}

export async function runAskStream(
  repoId: string,
  question: string,
  chunks: Chunk[],
  opts: AskStreamOptions,
  emit: EmitFn,
): Promise<void> {
  try {
    const key = cacheKey(repoId, question, opts);
    const cached = askCache.get(key);

    if (cached) {
      // Replay from cache: no live tokens to stream, so the whole cached
      // answer goes out as one token event — the UI just concatenates
      // onToken results, so this renders instantly instead of streaming.
      const result = await cached;
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
      onRoute: (route) => emit('route', route),
      onHop: (hop) => emit('hop', hop),
      onToken: (token) => emit('token', { token }),
    });
    // Cache only on success — a failed run is never memoized as if it worked.
    askCache.set(
      key,
      resultPromise.catch((err: unknown) => {
        askCache.delete(key);
        throw err;
      }),
    );
    const result = await resultPromise;

    emit('done', {
      answer: result.answer,
      citations: result.citations,
      verify: result.verify,
      expanded: result.expanded,
    });
  } catch (err) {
    emit('error', { message: err instanceof Error ? err.message : String(err) });
  }
}
