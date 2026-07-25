/**
 * Query · Stage 4 — Rerank. Scores Stage 3's fused candidates with a
 * cross-encoder and keeps the top few — the shortlist that would go to an
 * LLM. →  docs: ./README.md
 */

import { getSharedVectorStore, getVectorsByIds } from '../../ingest/04-index/vector-store.ts';
import type { FusedHit } from '../03-fuse/fuse.ts';
import { scorePairs } from './reranker.ts';

export interface RerankedHit {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  content: string;
  /** '' means no commit was recorded at index time (see Chunk.commitSha). */
  commitSha: string;
  rerankScore: number;
  /** Carried through from Fuse, for comparison — see how much rerank actually moved things. */
  rrfScore: number;
  sources: ('vector' | 'lexical')[];
}

export interface RerankOptions {
  /** Final shortlist size. */
  limit?: number;
  dbPath?: string;
  /** Swap the scoring function — tests inject a fake to skip loading the real model. */
  scoreFn?: (query: string, docs: string[]) => Promise<number[]>;
}

const DEFAULT_LIMIT = 8;

/**
 * Fuse's output has no `content` for lexical-only hits (it only ranks, never
 * reads chunk text) — this stage needs the real text to score, so it hydrates
 * every candidate's content (and commitSha) from the index first, scoped to
 * exactly the ids Fuse shortlisted (`getVectorsByIds`) rather than scanning
 * every indexed row for the repo. Chunks the index no longer has (rare — a
 * desync between Fuse's ranking and a since-changed index) are dropped rather
 * than scored on missing content.
 */
export async function rerankResults(
  repoId: string,
  query: string,
  fused: FusedHit[],
  opts: RerankOptions = {},
): Promise<RerankedHit[]> {
  if (fused.length === 0) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const scoreFn = opts.scoreFn ?? scorePairs;

  const db = await getSharedVectorStore(opts.dbPath);
  const rows = await getVectorsByIds(
    db,
    repoId,
    fused.map((f) => f.id),
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const candidates = fused
    .map((f) => ({ ...f, row: rowById.get(f.id) }))
    .filter((f): f is FusedHit & { row: (typeof rows)[number] } => f.row !== undefined);

  const scores = await scoreFn(
    query,
    candidates.map((c) => c.row.content),
  );

  const reranked: RerankedHit[] = candidates.map((c, i) => ({
    id: c.id,
    filePath: c.filePath,
    symbolName: c.symbolName,
    startLine: c.startLine,
    endLine: c.endLine,
    content: c.row.content,
    commitSha: c.row.commitSha,
    rerankScore: scores[i],
    rrfScore: c.rrfScore,
    sources: c.sources,
  }));

  reranked.sort((a, b) => b.rerankScore - a.rerankScore);
  return reranked.slice(0, limit);
}
