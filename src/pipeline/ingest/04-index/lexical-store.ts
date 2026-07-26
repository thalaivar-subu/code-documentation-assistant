/**
 * Lexical (keyword/BM25-style) index — Stage 4's MiniSearch adapter.  →  docs: ./README.md
 *
 * Complements the vector store: exact identifiers, error strings, and rare
 * tokens that a dense embedding can blur together are exactly what keyword
 * search is good at. Persisted as one JSON file per repo — MiniSearch has no
 * native disk backing, so we serialize/deserialize around it.
 *
 * ── MANAGED SWAP ─────────────────────────────────────────────────────────────
 * Default: MiniSearch, embedded (JSON file, this file). To use a managed
 * lexical service instead, add an adapter with the same upsert/search shape
 * and wire it in `index.ts`. No code change elsewhere.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import MiniSearch from 'minisearch';

import type { Chunk } from '../../../core/types.ts';
import { createAsyncCache } from '../../../core/async-cache.ts';

export const DEFAULT_INDEX_DIR = '.cache/index/lexical';

export interface LexicalDoc {
  id: string;
  repoId: string;
  filePath: string;
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
}

const MINISEARCH_OPTIONS = {
  idField: 'id',
  fields: ['content', 'symbolName', 'filePath'],
  storeFields: ['id', 'repoId', 'filePath', 'symbolName', 'symbolType', 'startLine', 'endLine'],
};

export function toLexicalDoc(chunk: Chunk): LexicalDoc {
  return {
    id: chunk.id,
    repoId: chunk.repoId,
    filePath: chunk.filePath,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
  };
}

export function indexPath(repoId: string, dir: string = DEFAULT_INDEX_DIR): string {
  return `${dir}/${repoId}.json`;
}

/**
 * Every `indexRepo` call unconditionally writes `<dir>/<repoId>.json` (see
 * `index.ts`), so the filenames in this directory are a complete, disk-backed
 * list of every repo ever indexed — independent of what's in `repoChunks`'
 * in-memory cache, which is lost on a server restart.
 */
export async function listIndexedRepoIds(dir: string = DEFAULT_INDEX_DIR): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The repoId whose index file was written longest ago — used as an LRU proxy
 * to evict when MAX_INDEXED_REPOS is reached. Not a perfect "last used" (asking
 * a repo doesn't touch this file, only indexing it does), but re-indexing bumps
 * it, and the common pattern — index a repo, ask it a few things, move on to
 * the next — makes "oldest indexed" a reasonable stand-in without adding a
 * separate access-tracking store. Returns `undefined` for an empty directory.
 */
export async function findLeastRecentlyIndexedRepoId(
  dir: string = DEFAULT_INDEX_DIR,
): Promise<string | undefined> {
  const repoIds = await listIndexedRepoIds(dir);
  if (repoIds.length === 0) return undefined;

  const withMtimes = await Promise.all(
    repoIds.map(async (repoId) => ({
      repoId,
      mtimeMs: (await stat(indexPath(repoId, dir))).mtimeMs,
    })),
  );
  return withMtimes.reduce((oldest, cur) => (cur.mtimeMs < oldest.mtimeMs ? cur : oldest)).repoId;
}

export async function loadLexicalIndex(path: string): Promise<MiniSearch<LexicalDoc>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new MiniSearch<LexicalDoc>(MINISEARCH_OPTIONS);
    }
    throw err;
  }

  try {
    return MiniSearch.loadJSON<LexicalDoc>(raw, MINISEARCH_OPTIONS);
  } catch {
    // A corrupt/malformed file (e.g. a crash mid-write, before the atomic
    // prepareLexicalSave/commit split this stage now uses) degrades to an
    // empty index instead of throwing on every subsequent query against this
    // repo — lexical search just returns nothing for it until the next
    // `indexRepo` call rebuilds a valid file from the real chunks. Vector
    // search is unaffected either way.
    return new MiniSearch<LexicalDoc>(MINISEARCH_OPTIONS);
  }
}

const lexicalCache = createAsyncCache<string, MiniSearch<LexicalDoc>>();

/**
 * Read-path callers (Retrieve) call this instead of `loadLexicalIndex` — every
 * hop of a query loop was re-reading and re-deserializing the same JSON file
 * from disk. `indexRepo`'s write path still calls `loadLexicalIndex` directly
 * (it needs a guaranteed-fresh copy to merge new chunks into and persist), and
 * calls `invalidateCachedLexicalIndex` once it's written, so the next query
 * against that repo reloads the updated file instead of serving a stale copy.
 */
export function getCachedLexicalIndex(path: string): Promise<MiniSearch<LexicalDoc>> {
  return lexicalCache.getOrCreate(path, () => loadLexicalIndex(path));
}

export function invalidateCachedLexicalIndex(path: string): void {
  lexicalCache.invalidate(path);
}

/** Removes a repo's lexical index file — see `deleteVectorsByRepoId`'s doc comment for why. */
export async function deleteLexicalIndexFile(path: string): Promise<void> {
  invalidateCachedLexicalIndex(path);
  await rm(path, { force: true });
}

export interface PendingLexicalSave {
  /** Atomically makes the write visible at `path` — a same-volume `rename` can't leave a half-written file. */
  commit(): Promise<void>;
}

/**
 * Serializes `index` to a temp file NOW, but doesn't make it visible at
 * `path` until `commit()` renames it into place. Splitting write-from-commit
 * (rather than one `saveLexicalIndex` call) is what lets `index.ts`'s
 * `indexRepo` upsert vectors in between: the lexical file only becomes real
 * (and only then does `listIndexedRepoIds` — and therefore `/repos` — see this
 * repo as indexed) after the vector store write has already succeeded. A
 * crash after the temp write but before `commit()` just abandons an orphaned
 * `.tmp-*` file; it never corrupts or half-writes the real path.
 */
export async function prepareLexicalSave(
  path: string,
  index: MiniSearch<LexicalDoc>,
): Promise<PendingLexicalSave> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, JSON.stringify(index), 'utf8');
  return { commit: () => rename(tmpPath, path) };
}

/** Convenience for callers that don't need to interleave other work between write and commit. */
export async function saveLexicalIndex(path: string, index: MiniSearch<LexicalDoc>): Promise<void> {
  const pending = await prepareLexicalSave(path, index);
  await pending.commit();
}

/**
 * Idempotent upsert keyed by `id`: `replace` removes-then-adds when the id
 * already exists, so re-indexing unchanged chunks converges instead of
 * duplicating (MiniSearch throws on `add` of a duplicate id).
 */
export function upsertLexical(index: MiniSearch<LexicalDoc>, docs: LexicalDoc[]): void {
  for (const doc of docs) {
    if (index.has(doc.id)) index.replace(doc);
    else index.add(doc);
  }
}

export interface LexicalHit {
  id: string;
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  score: number;
}

export function searchLexical(
  index: MiniSearch<LexicalDoc>,
  query: string,
  opts: { k?: number; repoId?: string } = {},
): LexicalHit[] {
  const results = index.search(query, {
    filter: opts.repoId ? (doc) => doc.repoId === opts.repoId : undefined,
  });
  return results.slice(0, opts.k ?? 10).map((r) => ({
    id: r.id,
    filePath: r.filePath as string,
    symbolName: r.symbolName as string,
    startLine: r.startLine as number,
    endLine: r.endLine as number,
    score: r.score,
  }));
}
