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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import MiniSearch from 'minisearch';

import type { Chunk } from '../../../core/types.ts';

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

export async function loadLexicalIndex(path: string): Promise<MiniSearch<LexicalDoc>> {
  try {
    const raw = await readFile(path, 'utf8');
    return MiniSearch.loadJSON<LexicalDoc>(raw, MINISEARCH_OPTIONS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new MiniSearch<LexicalDoc>(MINISEARCH_OPTIONS);
    }
    throw err;
  }
}

export async function saveLexicalIndex(path: string, index: MiniSearch<LexicalDoc>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index), 'utf8');
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
