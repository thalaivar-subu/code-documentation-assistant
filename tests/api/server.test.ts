import { describe, expect, it } from 'vitest';

import {
  deleteLexicalIndexFile,
  indexPath,
} from '../../src/pipeline/ingest/04-index/lexical-store.ts';
import {
  deleteVectorsByRepoId,
  getSharedVectorStore,
} from '../../src/pipeline/ingest/04-index/vector-store.ts';
import { invalidateAskCache } from '../../src/api/ask-stream.ts';
import { repoChunks } from '../../src/api/repo-cache.ts';
import { buildServer } from '../../src/api/server.ts';

function parseSse(body: string): { event: string; data: unknown }[] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      return {
        event: eventLine?.slice('event: '.length) ?? '',
        data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : undefined,
      };
    });
}

describe('GET /health', () => {
  it('reports ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('GET /stages', () => {
  it('returns all 12 stages', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/stages' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(12);
  });
});

describe('POST /index', () => {
  it('400s when repo is missing', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'POST', url: '/index', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /ask', () => {
  it('400s when question is missing', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/ask',
      payload: { repoId: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for an unindexed repoId', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/ask',
      payload: { repoId: 'nonexistent-repo-id', question: 'anything?' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /index → POST /ask — full real pipeline over HTTP', () => {
  it('indexes this repo, then answers a question with live SSE progress', async () => {
    const app = buildServer();

    // '.' (this repo), not the standard telemetry-go fixture — deliberately, so
    // this suite has no network dependency; the real-network path is already
    // covered by 01-clone/clone.test.ts's remote-clone tests.
    const indexRes = await app.inject({
      method: 'POST',
      url: '/index',
      payload: { repo: '.' },
    });
    const indexEvents = parseSse(indexRes.body);
    expect(indexEvents.some((e) => e.event === 'step')).toBe(true);
    const done = indexEvents.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    const { repoId } = done!.data as { repoId: string };
    expect(repoId).toBeTruthy();

    try {
      const askRes = await app.inject({
        method: 'POST',
        url: '/ask',
        payload: { repoId, question: 'what does chunkRepo do?', maxTokens: 100 },
      });
      const askEvents = parseSse(askRes.body);
      expect(askEvents.some((e) => e.event === 'route')).toBe(true);
      expect(askEvents.some((e) => e.event === 'hop')).toBe(true);
      expect(askEvents.some((e) => e.event === 'token')).toBe(true);
      const askDone = askEvents.find((e) => e.event === 'done');
      expect(askDone).toBeDefined();
      const data = askDone!.data as { answer: string; citations: unknown[] };
      expect(typeof data.answer).toBe('string');
      expect(Array.isArray(data.citations)).toBe(true);

      // GET /repos is disk-backed (lexical-store's directory listing), so the
      // repo just indexed above should show up without needing repoChunks.
      const reposRes = await app.inject({ method: 'GET', url: '/repos' });
      expect(reposRes.statusCode).toBe(200);
      const repos = reposRes.json() as { repoId: string; chunksIndexed: number }[];
      expect(repos.some((r) => r.repoId === repoId && r.chunksIndexed > 0)).toBe(true);

      // Simulate a server restart losing the in-memory repoChunks cache — /ask
      // should reconstruct chunks from the vector store instead of 404ing.
      repoChunks.delete(repoId);
      const askAfterRestartRes = await app.inject({
        method: 'POST',
        url: '/ask',
        payload: { repoId, question: 'what does chunkRepo do?', maxTokens: 20 },
      });
      expect(askAfterRestartRes.statusCode).toBe(200);
      const reconstructedDone = parseSse(askAfterRestartRes.body).find((e) => e.event === 'done');
      expect(reconstructedDone).toBeDefined();
    } finally {
      // This test indexes "." (this repo) into the SAME shared .cache/ a real
      // dev server also reads from — without this cleanup, every `npm test`
      // run would leave a permanent, real-looking "code-documentation-assistant"
      // entry in GET /repos for an actual user to be confused by.
      const db = await getSharedVectorStore();
      await deleteVectorsByRepoId(db, repoId);
      await deleteLexicalIndexFile(indexPath(repoId));
      invalidateAskCache(repoId);
      repoChunks.delete(repoId);
    }
  }, 120_000);
});
