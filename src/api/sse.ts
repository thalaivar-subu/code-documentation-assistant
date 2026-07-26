import type { FastifyReply } from 'fastify';

/** What `runIndexStream`/`runAskStream` call to report progress — a transport-agnostic shape matching `SseWriter.send`, so the pipeline runners never import Fastify or know they're talking SSE at all. */
export type EmitFn = (event: string, data: unknown) => void;

export interface SseWriter {
  send: EmitFn;
  close: () => void;
  /**
   * Aborts when the client disconnects (closes the tab, navigates away) —
   * `/ask` threads this down to the actual LLM call (`node-llama-cpp`'s
   * `session.prompt()` accepts a `signal` natively) so a ~15-20s generation
   * doesn't keep running for nobody. Not threaded into `/index`: that work
   * populates a store every future request benefits from, so finishing it
   * isn't wasted just because the caller who triggered it left.
   */
  signal: AbortSignal;
}

/**
 * `reply.hijack()` is required here — without it, Fastify still tries to manage
 * the reply lifecycle after our handler returns and a real browser's `fetch()`
 * fails with `net::ERR_FAILED`, even though `curl` and Fastify's own `.inject()`
 * both look fine (they're more lenient than an actual browser). Discovered by
 * testing against a real browser, not `.inject()`.
 *
 * Hijacking also skips Fastify's `onSend` hooks, which is where `@fastify/cors`
 * normally injects `Access-Control-Allow-Origin` — so a hijacked response needs
 * that header added manually below, or the browser silently blocks it with no
 * console-visible CORS error at all. Also discovered via a real browser only.
 */
export function openSse(reply: FastifyReply): SseWriter {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Fires on a real client disconnect AND on our own normal `close()` below —
  // harmless in the latter case, since by then the pipeline's async work has
  // already finished and nothing is still checking the signal.
  const controller = new AbortController();
  reply.raw.on('close', () => controller.abort());

  return {
    signal: controller.signal,
    // Guarded: if the client already disconnected (closed tab mid-stream), the
    // underlying socket write throws — including on the error-reporting path
    // itself (index-stream.ts/ask-stream.ts's catch blocks call send('error', ...)),
    // which would otherwise become an unhandled rejection instead of a no-op.
    send(event, data) {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // client is gone; nothing to report to
      }
    },
    close() {
      try {
        reply.raw.end();
      } catch {
        // already closed
      }
    },
  };
}
