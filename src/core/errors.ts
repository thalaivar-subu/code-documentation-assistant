/**
 * A small error taxonomy for the SSE boundary — before this, every failure
 * (clone auth, OOM during embedding, a corrupt lexical index, the LLM running
 * out of context) flattened to the same opaque `{ message: string }` the UI
 * had no way to react to differently. Four codes, not a hierarchy — see
 * docs/REFACTOR-PLAN.md #13. Add a fifth only when a real UI need shows up
 * for it, not speculatively.
 */

export type ErrorCode = 'NOT_INDEXED' | 'CLONE_FAILED' | 'INDEX_FAILED' | 'GENERATION_FAILED';

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export class NotIndexedError extends AppError {
  constructor(repoId: string) {
    super('NOT_INDEXED', `repoId ${repoId} was never indexed — call /index first`);
  }
}

export class CloneError extends AppError {
  constructor(message: string) {
    super('CLONE_FAILED', message);
  }
}

export class IndexError extends AppError {
  constructor(message: string) {
    super('INDEX_FAILED', message);
  }
}

/**
 * Covers any failure in the `/ask` pipeline (Route through Verify), not just
 * the Generate stage narrowly — a coarse classification for the UI to key
 * off, not a claim that the LLM call specifically is what failed.
 */
export class GenerationError extends AppError {
  constructor(message: string) {
    super('GENERATION_FAILED', message);
  }
}

/**
 * Runs `fn`, re-throwing any non-`AppError` failure tagged with `code` so the
 * SSE boundary (ask-stream.ts / index-stream.ts) can always emit a `code`
 * alongside the message. An `AppError` that's already more specific (thrown
 * deeper in the call stack) passes through unchanged rather than being
 * re-tagged with this stage's coarser code.
 */
export async function withErrorCode<T>(code: ErrorCode, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(code, err instanceof Error ? err.message : String(err));
  }
}
