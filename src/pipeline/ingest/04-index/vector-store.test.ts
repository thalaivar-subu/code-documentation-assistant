/**
 * Tests for the LanceDB vector-store adapter (Stage 4).
 *
 * Key property under test: upserts are idempotent (re-indexing the same id
 * never duplicates a row — that's what makes re-running the whole pipeline
 * safe) and repoId filtering actually isolates repos sharing one table.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  countVectors,
  getVectorsByIds,
  listVectors,
  openVectorStore,
  searchVectors,
  upsertVectors,
  type VectorRow,
} from './vector-store.ts';

let tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cda-vecstore-test-'));
  tmpDirs.push(dir);
  return join(dir, 'lancedb');
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

function row(overrides: Partial<VectorRow>): VectorRow {
  return {
    id: 'id',
    repoId: 'r1',
    filePath: 'a.ts',
    kind: 'code',
    language: 'ts',
    configFormat: '',
    symbolName: 'f',
    symbolType: 'function',
    parentSymbol: '',
    startLine: 1,
    endLine: 2,
    content: 'content',
    contentHash: 'hash',
    commitSha: '',
    vector: [1, 0, 0, 0],
    ...overrides,
  };
}

describe('upsertVectors / countVectors', () => {
  it('creates the table on first write and counts rows', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [row({ id: 'a' }), row({ id: 'b' })]);
    expect(await countVectors(db)).toBe(2);
  });

  it('creates the table when the very first row has empty optional fields (regression: LanceDB cannot infer a column type from `null`, so these must be `""` not `null`)', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [
      row({ id: 'no-parent', parentSymbol: '', commitSha: '' }), // e.g. a top-level function
      row({ id: 'has-parent', parentSymbol: 'MyClass', commitSha: 'abc123' }), // e.g. a method
    ]);
    expect(await countVectors(db)).toBe(2);
  });

  it('re-upserting the same id updates the row instead of duplicating it', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [row({ id: 'a', content: 'v1' })]);
    await upsertVectors(db, [row({ id: 'a', content: 'v2' })]);

    expect(await countVectors(db)).toBe(1);
    const [hit] = await searchVectors(db, [1, 0, 0, 0], { k: 1 });
    expect(hit.content).toBe('v2');
  });

  it('countVectors is 0 for a database with no table yet', async () => {
    const db = await openVectorStore(tmpDbPath());
    expect(await countVectors(db)).toBe(0);
  });
});

describe('searchVectors', () => {
  it('ranks the nearest vector first', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [
      row({ id: 'close', vector: [1, 0, 0, 0] }),
      row({ id: 'far', vector: [0, 0, 0, 1] }),
    ]);

    const hits = await searchVectors(db, [1, 0, 0, 0], { k: 2 });
    expect(hits[0].id).toBe('close');
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
  });

  it('filters by repoId so repos sharing one table stay isolated', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [
      row({ id: 'a', repoId: 'repo-one', vector: [1, 0, 0, 0] }),
      row({ id: 'b', repoId: 'repo-two', vector: [1, 0, 0, 0] }),
    ]);

    const hits = await searchVectors(db, [1, 0, 0, 0], { k: 10, repoId: 'repo-one' });
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('rejects a repoId that does not look like our generated slug', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [row({ id: 'a' })]);
    await expect(
      searchVectors(db, [1, 0, 0, 0], { repoId: "x'; drop table chunks; --" }),
    ).rejects.toThrow(/invalid repoId/);
  });

  it('carries commitSha through (regression: it used to be persisted but never selected back out)', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [row({ id: 'a', commitSha: 'abc123', vector: [1, 0, 0, 0] })]);
    const [hit] = await searchVectors(db, [1, 0, 0, 0], { k: 1 });
    expect(hit.commitSha).toBe('abc123');
  });
});

describe('listVectors — limit', () => {
  it('limit: 0 returns zero rows, not every row (regression: falsy-zero check treated 0 as "no limit")', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [row({ id: 'a' }), row({ id: 'b' })]);

    const rows = await listVectors(db, { repoId: 'r1', limit: 0 });
    expect(rows).toEqual([]);
  });
});

describe('getVectorsByIds', () => {
  it('returns rows for exactly the requested ids, scoped to repoId', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [
      row({ id: 'a', repoId: 'r1', content: 'content-a' }),
      row({ id: 'b', repoId: 'r1', content: 'content-b' }),
      row({ id: 'c', repoId: 'r1', content: 'content-c' }),
      row({ id: 'a', repoId: 'r2', content: 'other-repo-a' }), // same id, different repo
    ]);

    const rows = await getVectorsByIds(db, 'r1', ['a', 'c']);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(rows.find((r) => r.id === 'a')?.content).toBe('content-a');
  });

  it('silently omits ids that are not indexed, rather than throwing', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [row({ id: 'a', repoId: 'r1' })]);

    const rows = await getVectorsByIds(db, 'r1', ['a', 'never-indexed']);
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('returns [] for an empty id list without querying the store', async () => {
    const db = await openVectorStore(tmpDbPath());
    expect(await getVectorsByIds(db, 'r1', [])).toEqual([]);
  });

  it('returns [] when the table does not exist yet', async () => {
    const db = await openVectorStore(tmpDbPath());
    expect(await getVectorsByIds(db, 'r1', ['a'])).toEqual([]);
  });
});

describe('toVectorRow — configFormat', () => {
  it('persists configFormat through a real write+read round trip (regression: it was silently dropped)', async () => {
    const db = await openVectorStore(tmpDbPath());
    await upsertVectors(db, [row({ id: 'a', repoId: 'r1', configFormat: 'dockerfile' })]);
    const [stored] = await getVectorsByIds(db, 'r1', ['a']);
    expect(stored.configFormat).toBe('dockerfile');
  });
});
