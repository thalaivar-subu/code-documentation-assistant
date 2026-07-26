/**
 * Dense (vector) index — Stage 4's LanceDB adapter.  →  docs: ./README.md
 *
 * One embedded LanceDB database on disk, one shared `chunks` table across all
 * indexed repos (filtered by `repoId` at query time), so indexing a second repo
 * never means re-creating a store.
 *
 * ── MANAGED SWAP ─────────────────────────────────────────────────────────────
 * Default: LanceDB, embedded (files on disk, this file). To use a managed vector
 * service instead (e.g. Qdrant), add an adapter with the same
 * upsert/search/count shape and wire it in `index.ts`. No code change elsewhere.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as lancedb from '@lancedb/lancedb';

import type { Chunk } from '../../../core/types.ts';
import { createAsyncCache } from '../../../core/async-cache.ts';
import type { EmbeddedChunk } from '../03-embed/embed.ts';

export const DEFAULT_DB_PATH = '.cache/index/lancedb';
const TABLE = 'chunks';

/**
 * What actually lands in LanceDB. Optional Chunk fields become `''`, NOT `null` —
 * LanceDB's schema inference reads row 0 to decide each column's Arrow type, and
 * a `null` first value gives it nothing to infer from ("Failed to infer data
 * type for field X at row 0"). An empty string is still unambiguously Utf8.
 */
export interface VectorRow {
  id: string;
  repoId: string;
  filePath: string;
  kind: string;
  language: string;
  configFormat: string;
  symbolName: string;
  symbolType: string;
  parentSymbol: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  commitSha: string;
  vector: number[];
}

/**
 * The reverse of `toVectorRow` — reconstructs a `Chunk` from a stored row,
 * turning the `''`-sentinel back into `undefined` for fields that are
 * genuinely optional on `Chunk` (see `toVectorRow`'s own doc comment for why
 * the sentinel exists in the first place). Used to rebuild `repoChunks` for a
 * repoId the API process doesn't have in memory (e.g. after a restart) without
 * re-cloning/re-chunking/re-embedding — the index on disk already has
 * everything Expand's symbol graph needs.
 */
export function vectorRowToChunk(row: VectorRow): Chunk {
  return {
    id: row.id,
    repoId: row.repoId,
    filePath: row.filePath,
    kind: row.kind as Chunk['kind'],
    language: row.language ? (row.language as Chunk['language']) : undefined,
    configFormat: row.configFormat || undefined,
    symbolName: row.symbolName,
    symbolType: row.symbolType as Chunk['symbolType'],
    parentSymbol: row.parentSymbol || undefined,
    startLine: row.startLine,
    endLine: row.endLine,
    content: row.content,
    contentHash: row.contentHash,
    commitSha: row.commitSha || undefined,
  };
}

export function toVectorRow(chunk: Chunk, embedding: EmbeddedChunk): VectorRow {
  return {
    id: chunk.id,
    repoId: chunk.repoId,
    filePath: chunk.filePath,
    kind: chunk.kind,
    language: chunk.language ?? '',
    configFormat: chunk.configFormat ?? '',
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    parentSymbol: chunk.parentSymbol ?? '',
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    contentHash: chunk.contentHash,
    commitSha: chunk.commitSha ?? '',
    vector: embedding.vector,
  };
}

export function openVectorStore(dbPath: string = DEFAULT_DB_PATH): Promise<lancedb.Connection> {
  return lancedb.connect(dbPath);
}

/**
 * Every read/write path below used to repeat `db.tableNames()` then
 * `db.openTable(TABLE)` — two round-trips before doing any real work, six
 * times over. Returns `undefined` when the table doesn't exist yet (a repo
 * that's never been indexed), which every caller already treated as "empty
 * result" — this just gives that check one place to live.
 */
async function openChunksTable(db: lancedb.Connection): Promise<lancedb.Table | undefined> {
  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE)) return undefined;
  return db.openTable(TABLE);
}

const connectionCache = createAsyncCache<string, lancedb.Connection>();

/**
 * Read-path callers (Retrieve, Rerank) call this instead of `openVectorStore` —
 * every hop of a query loop was reopening a fresh connection for no reason,
 * since `searchVectors`/`getVectorsByIds` always `openTable()` fresh anyway (so
 * they see current data regardless of when the connection was made). Write
 * callers (`indexRepo`) still use `openVectorStore` directly, unaffected.
 * A failed connect is never cached — the next call retries instead of
 * repeating the same rejection forever (see `createAsyncCache`).
 */
export function getSharedVectorStore(
  dbPath: string = DEFAULT_DB_PATH,
): Promise<lancedb.Connection> {
  return connectionCache.getOrCreate(dbPath, () => openVectorStore(dbPath));
}

/**
 * Idempotent upsert keyed by `id` (Stage 2's deterministic content-hash id): a
 * chunk whose content hasn't changed re-upserts to the same row, so re-indexing
 * never duplicates. First call creates the table; later calls merge into it.
 */
export async function upsertVectors(db: lancedb.Connection, rows: VectorRow[]): Promise<void> {
  if (rows.length === 0) return;
  const tbl = await openChunksTable(db);
  if (!tbl) {
    await db.createTable(TABLE, rows);
    return;
  }
  await tbl.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
}

/**
 * Removes every row for a repoId — used by tests that index a throwaway repo
 * into the shared store (`server.test.ts` indexes "." for a network-free
 * end-to-end run) so they don't leave permanent, real-looking entries behind
 * for `/repos` to list to an actual user.
 */
export async function deleteVectorsByRepoId(db: lancedb.Connection, repoId: string): Promise<void> {
  const tbl = await openChunksTable(db);
  if (!tbl) return;
  await tbl.delete(repoIdFilter(repoId));
}

export async function countVectors(db: lancedb.Connection, repoId?: string): Promise<number> {
  const tbl = await openChunksTable(db);
  if (!tbl) return 0;
  if (!repoId) return tbl.countRows();
  return tbl.countRows(repoIdFilter(repoId));
}

/**
 * Counts every indexed repo's rows in ONE scan — `select(['repoId'])` pulls just
 * that column (not full chunk content/vectors), then groups client-side. `/repos`
 * used to call `countVectors` once per repoId (a `tableNames()` + `openTable()` +
 * `countRows()` round trip each — 3×N calls for N repos, and growing with every
 * repo indexed); this is the same information in one table scan regardless of N.
 */
export async function countVectorsByRepo(db: lancedb.Connection): Promise<Map<string, number>> {
  const tbl = await openChunksTable(db);
  if (!tbl) return new Map();
  const rows = await tbl.query().select(['repoId']).toArray();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const repoId = row.repoId as string;
    counts.set(repoId, (counts.get(repoId) ?? 0) + 1);
  }
  return counts;
}

export interface VectorHit {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  content: string;
  /** '' means no commit was recorded at index time (see Chunk.commitSha). */
  commitSha: string;
  /** L2 distance on unit-normalized vectors — lower is more similar (0 = identical). */
  distance: number;
}

export async function searchVectors(
  db: lancedb.Connection,
  queryVector: number[],
  opts: { k?: number; repoId?: string } = {},
): Promise<VectorHit[]> {
  const tbl = await openChunksTable(db);
  if (!tbl) return [];
  let query = tbl.search(queryVector).limit(opts.k ?? 10);
  if (opts.repoId) query = query.where(repoIdFilter(opts.repoId));
  const rows = await query.toArray();
  return rows.map((r) => ({
    id: r.id,
    filePath: r.filePath,
    symbolName: r.symbolName,
    startLine: r.startLine,
    endLine: r.endLine,
    content: r.content,
    commitSha: r.commitSha,
    distance: r._distance,
  }));
}

/**
 * Raw stored rows — a plain table scan (no vector search, no ranking), for
 * actually inspecting what landed in the store rather than trusting a count.
 * `vector` comes back from LanceDB as an Arrow `Vector` wrapper, not a plain
 * array, so it's converted here for anything downstream (e.g. JSON.stringify).
 */
export async function listVectors(
  db: lancedb.Connection,
  opts: { repoId?: string; limit?: number } = {},
): Promise<VectorRow[]> {
  // Short-circuit rather than passing limit: 0 to LanceDB — combined with a
  // `.where()` filter, `.limit(0)` is silently ignored by the SDK (verified:
  // it returns every matching row, not zero), so relying on it here would
  // have swapped one falsy-zero-shaped bug for another, harder-to-spot one.
  if (opts.limit === 0) return [];

  const tbl = await openChunksTable(db);
  if (!tbl) return [];
  let query = tbl.query();
  if (opts.repoId) query = query.where(repoIdFilter(opts.repoId));
  if (opts.limit !== undefined) query = query.limit(opts.limit);
  const rows = await query.toArray();
  return rows.map((r) => ({ ...r, vector: Array.from(r.vector as Iterable<number>) }) as VectorRow);
}

/**
 * Raw stored rows for a SPECIFIC set of ids — the primitive Rerank needs to
 * hydrate a small shortlist's content, as opposed to `listVectors`'s full
 * table scan (which is for debug/inspection, not per-query production use).
 * Returns fewer rows than `ids.length` if some ids are no longer indexed.
 */
export async function getVectorsByIds(
  db: lancedb.Connection,
  repoId: string,
  ids: string[],
): Promise<VectorRow[]> {
  if (ids.length === 0) return [];
  const tbl = await openChunksTable(db);
  if (!tbl) return [];
  const rows = await tbl
    .query()
    .where(`${repoIdFilter(repoId)} AND id IN (${ids.map(idFilterValue).join(', ')})`)
    .toArray();
  return rows.map((r) => ({ ...r, vector: Array.from(r.vector as Iterable<number>) }) as VectorRow);
}

/** repoId is always our own generated slug ([a-z0-9-]+ — see clone.ts's toRepoId), but validate anyway before it goes into a filter string. */
function repoIdFilter(repoId: string): string {
  if (!/^[a-z0-9-]+$/i.test(repoId)) throw new Error(`invalid repoId for filter: ${repoId}`);
  return `repoId = '${repoId}'`;
}

/**
 * Chunk ids are normally our own 32-char lowercase hex hash (see chunk-file.ts's
 * chunkId), but tests across this codebase also use short human-readable ids
 * (e.g. 'ghost', 'rrf-winner') — so this validates the same safe charset as
 * `repoIdFilter` (alphanumeric + hyphen) rather than hex-only, while still
 * rejecting anything that could break out of the quoted SQL literal.
 */
function idFilterValue(id: string): string {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`invalid id for filter: ${id}`);
  return `'${id}'`;
}
