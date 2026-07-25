/**
 * The UI's only backend — everything else in this project is a package, but a
 * browser needs something to talk to over HTTP. Two SSE endpoints (index,
 * ask) so the UI can show live pipeline progress, plus one plain JSON
 * endpoint for stage metadata (hover explanations). →  docs: ./README.md
 *
 * Route handlers are thin — the actual pipeline wiring lives in
 * index-stream.ts/ask-stream.ts (framework-agnostic; they only know how to
 * `emit(event, data)`), so this file's only job is HTTP/SSE plumbing.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';

import { runAskStream } from './ask-stream.ts';
import { runIndexStream } from './index-stream.ts';
import { repoChunks } from './repo-cache.ts';
import { ALL_STAGES } from '../pipeline/stages.manifest.ts';
import { openSse } from './sse.ts';

export function buildServer() {
  const app = Fastify({ logger: false });

  app.register(cors, { origin: true });

  app.get('/health', async () => ({ ok: true }));

  app.get('/stages', async () => ALL_STAGES);

  app.post<{ Body: { repo: string; fresh?: boolean } }>(
    '/index',
    {
      schema: {
        body: {
          type: 'object',
          required: ['repo'],
          properties: { repo: { type: 'string', minLength: 1 }, fresh: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const { repo, fresh } = request.body;
      const sse = openSse(reply);
      await runIndexStream(repo, fresh, sse.send);
      sse.close();
    },
  );

  app.post<{
    Body: {
      repoId: string;
      question: string;
      maxHops?: number;
      k?: number;
      limit?: number;
      maxTokens?: number;
    };
  }>(
    '/ask',
    {
      schema: {
        body: {
          type: 'object',
          required: ['repoId', 'question'],
          properties: {
            repoId: { type: 'string', minLength: 1 },
            question: { type: 'string', minLength: 1 },
            maxHops: { type: 'number' },
            k: { type: 'number' },
            limit: { type: 'number' },
            maxTokens: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const { repoId, question, maxHops, k, limit, maxTokens } = request.body;
      const chunks = repoChunks.get(repoId);
      if (!chunks) {
        reply.code(404);
        return {
          error: `repoId ${repoId} was not indexed by this server process — call /index first`,
        };
      }

      const sse = openSse(reply);
      await runAskStream(repoId, question, chunks, { maxHops, k, limit, maxTokens }, sse.send);
      sse.close();
    },
  );

  return app;
}
