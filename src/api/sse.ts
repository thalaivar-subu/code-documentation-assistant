import type { FastifyReply } from 'fastify';

export interface SseWriter {
  send: (event: string, data: unknown) => void;
  close: () => void;
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

  return {
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
