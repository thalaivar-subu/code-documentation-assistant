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
import { getOrReconstructChunks } from './repo-cache.ts';
import { listIndexedRepoIds } from '../pipeline/ingest/04-index/lexical-store.ts';
import { ALL_STAGES } from '../pipeline/stages.manifest.ts';
import { countVectors, getSharedVectorStore } from '../pipeline/ingest/04-index/vector-store.ts';
import { openSse } from './sse.ts';

export function buildServer() {
  const app = Fastify({ logger: false });

  app.register(cors, { origin: true });

  app.get('/health', async () => ({ ok: true }));

  app.get('/stages', async () => ALL_STAGES);

  // Disk-backed, not the in-memory repoChunks cache — survives a server
  // restart, so the UI can list a repo you indexed in an earlier session.
  app.get('/repos', async () => {
    const repoIds = await listIndexedRepoIds();
    const db = await getSharedVectorStore();
    return Promise.all(
      repoIds.map(async (repoId) => ({
        repoId,
        chunksIndexed: await countVectors(db, repoId),
      })),
    );
  });

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
      const chunks = await getOrReconstructChunks(repoId);
      if (!chunks) {
        reply.code(404);
        return { error: `repoId ${repoId} was never indexed — call /index first` };
      }

      const sse = openSse(reply);
      await runAskStream(repoId, question, chunks, { maxHops, k, limit, maxTokens }, sse.send);
      sse.close();
    },
  );

  return app;
}
