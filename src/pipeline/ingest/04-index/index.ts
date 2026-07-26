/**
 * Ingest · Stage 4 — Index. Writes Stage 2's chunks + Stage 3's vectors into the
 * dense (LanceDB) and lexical (MiniSearch) stores, keyed by Stage 2's
 * deterministic chunk id so re-indexing upserts instead of duplicating.
 *
 * Deliberately write-only: querying the stores is the query pipeline's job
 * (Stage "Retrieve"), not ingestion's. `vector-store.ts`/`lexical-store.ts`
 * each still expose their own `search*` primitive for Retrieve to call
 * directly — this orchestrator just doesn't wrap or expose one.
 * →  docs: ./README.md
 */

import type { Chunk } from '../../../core/types.ts';
import type { EmbeddedChunk } from '../03-embed/embed.ts';
import {
  indexPath,
  loadLexicalIndex,
  prepareLexicalSave,
  toLexicalDoc,
  upsertLexical,
} from './lexical-store.ts';
import {
  countVectors,
  listVectors,
  openVectorStore,
  toVectorRow,
  upsertVectors,
  type VectorRow,
} from './vector-store.ts';

export interface IndexRepoOptions {
  dbPath?: string;
  lexicalDir?: string;
}

export interface IndexRepoResult {
  repoId: string;
  chunksIndexed: number;
  vectorCount: number;
  lexicalCount: number;
  ms: number;
}

/** Join Stage 2 chunks with Stage 3 embeddings (by id) and write both stores. */
export async function indexRepo(
  repoId: string,
  chunks: Chunk[],
  embeddings: EmbeddedChunk[],
  opts: IndexRepoOptions = {},
): Promise<IndexRepoResult> {
  const started = Date.now();
  const vectorsById = new Map(embeddings.map((e) => [e.chunkId, e]));

  const vectorRows = chunks.map((c) => {
    const embedding = vectorsById.get(c.id);
    if (!embedding) throw new Error(`no embedding for chunk ${c.id} (${c.filePath})`);
    return toVectorRow(c, embedding);
  });

  // Lexical is written to a TEMP file and vectors are upserted before the
  // lexical write is committed (renamed into place) — not the other way
  // around. `listIndexedRepoIds` (and therefore `/repos`) discovers repos by
  // the lexical file's real name, so a crash between the two stores leaves
  // either "neither store written yet" or "both written" as the only visible
  // states — never "vectors exist but the repo doesn't appear indexed", which
  // had no compensating action to recover from. See docs/REFACTOR-PLAN.md #10.
  const lexPath = indexPath(repoId, opts.lexicalDir);
  const lexIndex = await loadLexicalIndex(lexPath);
  upsertLexical(lexIndex, chunks.map(toLexicalDoc));
  const pendingLexicalSave = await prepareLexicalSave(lexPath, lexIndex);

  const db = await openVectorStore(opts.dbPath);
  await upsertVectors(db, vectorRows);

  await pendingLexicalSave.commit();

  return {
    repoId,
    chunksIndexed: chunks.length,
    vectorCount: await countVectors(db, repoId),
    lexicalCount: lexIndex.documentCount,
    ms: Date.now() - started,
  };
}

/**
 * Raw stored rows for one repo — the "prove it's really in the database" view.
 * Still not a search: no ranking, just a scan. Includes the full 384-number
 * `vector`, exactly what's persisted on disk.
 */
export async function peekIndex(
  repoId: string,
  opts: { limit?: number; dbPath?: string } = {},
): Promise<VectorRow[]> {
  const db = await openVectorStore(opts.dbPath);
  return listVectors(db, { repoId, limit: opts.limit });
}
