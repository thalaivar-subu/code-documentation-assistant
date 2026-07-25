/**
 * The full query pipeline (Route → … → Verify), wired to emit SSE-shaped
 * events as it runs. Framework-agnostic, same split as index-stream.ts.
 * →  docs: ./README.md
 */

import { answerQuestion } from '../pipeline/query/08-verify/answer.ts';
import type { Chunk } from '../core/types.ts';
import type { EmitFn } from './index-stream.ts';

export interface AskStreamOptions {
  maxHops?: number;
  k?: number;
  limit?: number;
  maxTokens?: number;
}

export async function runAskStream(
  repoId: string,
  question: string,
  chunks: Chunk[],
  opts: AskStreamOptions,
  emit: EmitFn,
): Promise<void> {
  try {
    const result = await answerQuestion(repoId, question, chunks, {
      ...opts,
      onRoute: (route) => emit('route', route),
      onHop: (hop) => emit('hop', hop),
      onToken: (token) => emit('token', { token }),
    });

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
