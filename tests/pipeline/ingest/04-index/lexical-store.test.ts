/**
 * Tests for the MiniSearch lexical-store adapter (Stage 4).
 *
 * Key properties under test: upsert is idempotent (re-adding an existing id
 * replaces instead of throwing/duplicating), repoId filtering isolates repos,
 * and the JSON persistence round-trip preserves search behavior.
 */

import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import MiniSearch from 'minisearch';
import {
  findLeastRecentlyIndexedRepoId,
  indexPath,
  loadLexicalIndex,
  saveLexicalIndex,
  searchLexical,
  upsertLexical,
  type LexicalDoc,
} from '../../../../src/pipeline/ingest/04-index/lexical-store.ts';

let tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cda-lexstore-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

function doc(overrides: Partial<LexicalDoc>): LexicalDoc {
  return {
    id: 'id',
    repoId: 'r1',
    filePath: 'a.ts',
    symbolName: 'f',
    symbolType: 'function',
    startLine: 1,
    endLine: 2,
    content: 'function f() { return 1; }',
    ...overrides,
  };
}

describe('upsertLexical', () => {
  it('re-upserting the same id replaces instead of throwing or duplicating', () => {
    const index = new MiniSearch<LexicalDoc>({
      idField: 'id',
      fields: ['content', 'symbolName', 'filePath'],
      storeFields: ['id', 'repoId', 'filePath', 'symbolName', 'symbolType', 'startLine', 'endLine'],
    });
    upsertLexical(index, [doc({ id: 'a', content: 'function add(a, b) { return a + b; }' })]);
    upsertLexical(index, [
      doc({ id: 'a', content: 'function add(a, b, c) { return a + b + c; }' }),
    ]);

    expect(index.documentCount).toBe(1);
    expect(searchLexical(index, 'add')).toHaveLength(1);
  });
});

describe('searchLexical', () => {
  const setup = () => {
    const index = new MiniSearch<LexicalDoc>({
      idField: 'id',
      fields: ['content', 'symbolName', 'filePath'],
      storeFields: ['id', 'repoId', 'filePath', 'symbolName', 'symbolType', 'startLine', 'endLine'],
    });
    upsertLexical(index, [
      doc({ id: 'a', repoId: 'repo-one', symbolName: 'add', content: 'function add(a, b) {}' }),
      doc({ id: 'b', repoId: 'repo-two', symbolName: 'add', content: 'function add(x, y) {}' }),
      doc({
        id: 'c',
        repoId: 'repo-one',
        symbolName: 'subtract',
        content: 'function subtract(a, b) {}',
      }),
    ]);
    return index;
  };

  it('finds a chunk by symbol/content keyword', () => {
    const hits = searchLexical(setup(), 'subtract');
    expect(hits.map((h) => h.id)).toEqual(['c']);
  });

  it('filters by repoId so repos sharing one index stay isolated', () => {
    const hits = searchLexical(setup(), 'add', { repoId: 'repo-one' });
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('respects k', () => {
    const hits = searchLexical(setup(), 'add', { k: 1 });
    expect(hits).toHaveLength(1);
  });
});

describe('save/load round-trip', () => {
  it('persists to JSON and search still works after reload', async () => {
    const dir = tmpDir();
    const path = indexPath('repo-one', dir);

    const index = await loadLexicalIndex(path); // no file yet -> fresh index
    upsertLexical(index, [doc({ id: 'a', symbolName: 'greet', content: 'function greet() {}' })]);
    await saveLexicalIndex(path, index);

    const reloaded = await loadLexicalIndex(path);
    expect(searchLexical(reloaded, 'greet').map((h) => h.id)).toEqual(['a']);
  });

  it('indexPath is stable per repoId (idempotent location)', () => {
    expect(indexPath('repo-one', '.cache/index/lexical')).toBe(
      '.cache/index/lexical/repo-one.json',
    );
  });
});

describe('findLeastRecentlyIndexedRepoId', () => {
  // Deliberately tested against an isolated temp dir, not the real shared
  // .cache/index/lexical/ a running server reads from — this function's
  // result is what MAX_INDEXED_REPOS eviction deletes, so getting the "oldest"
  // pick wrong here (real dir) would mean deleting a real user's real repo as
  // a side effect of `npm test`, not just a wrong assertion.
  it('picks the repo whose index file was written longest ago', async () => {
    const dir = tmpDir();
    const now = Date.parse('2026-01-01T00:00:00Z') / 1000;
    writeFileSync(join(dir, 'newest.json'), '{}');
    utimesSync(join(dir, 'newest.json'), now, now);
    writeFileSync(join(dir, 'oldest.json'), '{}');
    utimesSync(join(dir, 'oldest.json'), now - 1000, now - 1000);
    writeFileSync(join(dir, 'middle.json'), '{}');
    utimesSync(join(dir, 'middle.json'), now - 500, now - 500);

    expect(await findLeastRecentlyIndexedRepoId(dir)).toBe('oldest');
  });

  it('returns undefined for an empty/nonexistent directory', async () => {
    expect(await findLeastRecentlyIndexedRepoId(tmpDir())).toBeUndefined();
  });
});
