/**
 * Talks to the API server (src/api/server.ts). Two endpoints are SSE
 * (streaming pipeline progress); the rest are plain JSON.
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

export interface StageMeta {
  order: number;
  id: string;
  pipeline: 'ingest' | 'query';
  title: string;
  summary: string;
  dir: string;
  doc: string;
  tool?: { name: string; pkg?: string };
  status: 'done' | 'in-progress' | 'planned';
}

export async function fetchStages(): Promise<StageMeta[]> {
  const res = await fetch(`${API_BASE}/stages`);
  if (!res.ok) throw new Error(`GET /stages failed: ${res.status}`);
  return res.json();
}

export interface IndexedRepo {
  repoId: string;
  chunksIndexed: number;
}

/** Disk-backed list of every repo indexed so far — survives a server restart. */
export async function fetchRepos(): Promise<IndexedRepo[]> {
  const res = await fetch(`${API_BASE}/repos`);
  if (!res.ok) throw new Error(`GET /repos failed: ${res.status}`);
  return res.json();
}

/**
 * Read an SSE response body (from a POST, so the native EventSource API
 * doesn't apply — it's GET-only) and call `onEvent` for each `event: X`
 * block as it arrives, live, as the stream produces it.
 */
async function streamSse(
  url: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${url} failed (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      onEvent(eventLine.slice('event: '.length), JSON.parse(dataLine.slice('data: '.length)));
    }
  }
}

export interface IndexStepEvent {
  stage: 'clone' | 'chunk' | 'embed' | 'index';
  message: string;
}
export interface IndexDoneEvent {
  repoId: string;
  chunksIndexed: number;
  vectorCount: number;
  lexicalCount: number;
}

export function indexRepo(
  repo: string,
  handlers: {
    onStep?: (e: IndexStepEvent) => void;
    onDone?: (e: IndexDoneEvent) => void;
    onError?: (message: string) => void;
  },
): Promise<void> {
  return streamSse(`${API_BASE}/index`, { repo }, (event, data) => {
    if (event === 'step') handlers.onStep?.(data as IndexStepEvent);
    else if (event === 'done') handlers.onDone?.(data as IndexDoneEvent);
    else if (event === 'error') handlers.onError?.((data as { message: string }).message);
  });
}

export interface RouteEvent {
  intent: 'symbol' | 'trace' | 'concept';
  symbols: string[];
  files: string[];
  reason: string;
}
export interface HopEvent {
  hop: number;
  query: string;
  grade: { sufficient: boolean; reason: string };
}
export interface ExpandedHitDto {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  content: string;
  rerankScore: number;
  rrfScore: number;
  sources: ('vector' | 'lexical')[];
  via: 'rerank' | 'caller' | 'callee';
}
export interface AskDoneEvent {
  answer: string;
  citations: { filePath: string; startLine: number; endLine: number }[];
  verify: {
    resolvedCount: number;
    totalCount: number;
    resolutionRate: number;
    hasCitations: boolean;
    checks: {
      citation: { filePath: string; startLine: number; endLine: number };
      resolved: boolean;
      matchedSymbol?: string;
    }[];
  };
  expanded: ExpandedHitDto[];
}

export function askQuestion(
  payload: {
    repoId: string;
    question: string;
    maxHops?: number;
    k?: number;
    limit?: number;
    maxTokens?: number;
  },
  handlers: {
    onRoute?: (e: RouteEvent) => void;
    onHop?: (e: HopEvent) => void;
    onToken?: (token: string) => void;
    onDone?: (e: AskDoneEvent) => void;
    onError?: (message: string) => void;
  },
): Promise<void> {
  return streamSse(`${API_BASE}/ask`, payload, (event, data) => {
    if (event === 'route') handlers.onRoute?.(data as RouteEvent);
    else if (event === 'hop') handlers.onHop?.(data as HopEvent);
    else if (event === 'token') handlers.onToken?.((data as { token: string }).token);
    else if (event === 'done') handlers.onDone?.(data as AskDoneEvent);
    else if (event === 'error') handlers.onError?.((data as { message: string }).message);
  });
}
