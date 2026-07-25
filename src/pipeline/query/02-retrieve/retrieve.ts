/**
 * Query · Stage 2 — Retrieve. Runs dense (vector) and lexical (keyword) search
 * in parallel against the stores Ingest Stage 4 populated. →  docs: ./README.md
 *
 * Deliberately does NOT merge the two ranked lists — that's Stage 3 (Fuse,
 * Reciprocal Rank Fusion, not built yet). This stage's job ends at "here are
 * two independently-ranked candidate lists."
 */

import { embedBatch } from '../../ingest/03-embed/embedder.ts';
import {
  getCachedLexicalIndex,
  indexPath,
  searchLexical,
  type LexicalHit,
} from '../../ingest/04-index/lexical-store.ts';
import {
  getSharedVectorStore,
  searchVectors,
  type VectorHit,
} from '../../ingest/04-index/vector-store.ts';
import type { RouteResult } from '../01-route/route.ts';

export interface RetrieveOptions {
  /** Candidates per side (before Fuse merges them). */
  k?: number;
  dbPath?: string;
  lexicalDir?: string;
  /** Swap the embedding function — tests inject a fake to skip loading the real model. */
  embedFn?: (texts: string[]) => Promise<number[][]>;
}

export interface RetrieveResult {
  vector: VectorHit[];
  lexical: LexicalHit[];
  ms: number;
}

const DEFAULT_K = 20;

/**
 * Dense search always runs against the full question (embeddings don't
 * benefit from being handed just the extracted symbols — they need the
 * sentence for context). Lexical search runs twice when Route found
 * identifier-like tokens: once against the full question, once against just
 * those tokens — a raw "chunkRepo" query scores far more precisely in
 * MiniSearch than the same word buried in a full sentence — then the two
 * result sets are merged by taking the best score per chunk id. This is the
 * concrete payoff of keeping Stage 1 (Route): its `symbols`/`files` output
 * measurably changes what Retrieve finds, not just how later stages weight it.
 */
export async function retrieveCandidates(
  repoId: string,
  question: string,
  route: RouteResult,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const started = Date.now();
  const k = opts.k ?? DEFAULT_K;
  const embedFn = opts.embedFn ?? embedBatch;

  const [db, lexIndex, [queryVector]] = await Promise.all([
    getSharedVectorStore(opts.dbPath),
    getCachedLexicalIndex(indexPath(repoId, opts.lexicalDir)),
    embedFn([question]),
  ]);

  const vector = await searchVectors(db, queryVector, { k, repoId });

  const questionHits = searchLexical(lexIndex, question, { k, repoId });
  const tokenHints = [...route.symbols, ...route.files];
  const tokenHits =
    tokenHints.length > 0 ? searchLexical(lexIndex, tokenHints.join(' '), { k, repoId }) : [];
  const lexical = mergeLexicalHits(questionHits, tokenHits, k);

  return { vector, lexical, ms: Date.now() - started };
}

function mergeLexicalHits(a: LexicalHit[], b: LexicalHit[], k: number): LexicalHit[] {
  const byId = new Map<string, LexicalHit>();
  for (const hit of [...a, ...b]) {
    const existing = byId.get(hit.id);
    if (!existing || hit.score > existing.score) byId.set(hit.id, hit);
  }
  return [...byId.values()].sort((x, y) => y.score - x.score).slice(0, k);
}
