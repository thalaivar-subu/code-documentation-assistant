/**
 * Tests for Ingest · Stage 1 (Clone).
 *
 * Two layers:
 *  - Pure unit tests (offline, instant): source parsing + deterministic ids.
 *  - Integration test (network): clone a minimal public repo and assert the metadata,
 *    then prove idempotent reuse on a second call.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, describe, expect, it } from 'vitest';

import {
  cloneRepo,
  explainFailure,
  parseSource,
  toRepoId,
} from '../../../../src/pipeline/ingest/01-clone/clone.ts';

describe('parseSource', () => {
  it('classifies https URLs as remote', () => {
    expect(parseSource('https://github.com/octocat/Hello-World')).toEqual({
      kind: 'remote',
      url: 'https://github.com/octocat/Hello-World',
    });
  });

  it('classifies *.git and git@ as remote', () => {
    expect(parseSource('git@github.com:octocat/Hello-World.git').kind).toBe('remote');
    expect(parseSource('https://x/y.git').kind).toBe('remote');
  });

  it('treats anything else as a local absolute path', () => {
    const s = parseSource('.');
    expect(s.kind).toBe('local');
    if (s.kind === 'local') expect(resolve(s.path)).toBe(resolve('.'));
  });
});

describe('toRepoId', () => {
  it('is deterministic for the same source', () => {
    const src = parseSource('https://github.com/expressjs/express.git');
    expect(toRepoId(src)).toBe(toRepoId(src));
  });

  it('produces a readable slug + short hash and differs by source', () => {
    const a = toRepoId(parseSource('https://github.com/expressjs/express.git'));
    const b = toRepoId(parseSource('https://github.com/expressjs/body-parser.git'));
    expect(a).toMatch(/^expressjs-express-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('cloneRepo (local source)', () => {
  it('reads HEAD metadata from the current git repo', async () => {
    const result = await cloneRepo('.');
    expect(result.source.kind).toBe('local');
    expect(result.reused).toBe(true);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('degrades gracefully (does not throw) for a git-init-ed repo with zero commits', async () => {
    // Regression: readRepoMeta used to call revparse(['HEAD']) unconditionally,
    // which throws on an unborn HEAD (a valid repo with no commits yet) — unlike
    // the sibling "not a git repo at all" case, which already handled this.
    const dir = mkdtempSync(join(tmpdir(), 'cda-clone-nocommit-test-'));
    try {
      await simpleGit(dir).init();
      const result = await cloneRepo(dir);
      expect(result.commitSha).toBe('');
      expect(result.trackedFiles).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('explainFailure', () => {
  it('blames the token for an HTTPS auth failure when a token was provided', () => {
    const err = explainFailure('https://github.com/org/repo', 'remote: Forbidden', 'ghp_faketoken');
    expect(err.message).toMatch(/token was rejected/);
  });

  it('suggests setting a token for an HTTPS auth failure with no token', () => {
    const err = explainFailure('https://github.com/org/repo', 'remote: Forbidden', undefined);
    expect(err.message).toMatch(/provide a token/);
    expect(err.message).toMatch(/GITHUB_TOKEN/);
  });

  it('does NOT blame the token for an SSH auth failure, even when a token is present', () => {
    // Regression: withToken() only ever applies to https:// URLs, so a token
    // being "rejected" is never actually true for an SSH remote.
    const err = explainFailure(
      'git@github.com:org/repo.git',
      'Permission denied (publickey)',
      'ghp_faketoken',
    );
    expect(err.message).not.toMatch(/token was rejected/);
    expect(err.message).toMatch(/SSH/);
  });

  it('does not blame the token for an SSH auth failure with no token either', () => {
    const err = explainFailure(
      'ssh://git@github.com/org/repo.git',
      'Permission denied (publickey)',
      undefined,
    );
    expect(err.message).toMatch(/SSH/);
  });

  it('passes non-auth errors through unchanged, regardless of scheme', () => {
    const err = explainFailure(
      'https://github.com/org/repo',
      'fatal: repository not found',
      undefined,
    );
    expect(err.message).toMatch(/Clone failed/);
  });
});

describe('cloneRepo (remote minimal repo)', () => {
  const REPO = 'https://github.com/octocat/Hello-World';
  const repoId = toRepoId(parseSource(REPO));

  afterAll(async () => {
    await rm(resolve('.cache', 'repos', repoId), { recursive: true, force: true });
  });

  it('partial-clones then reuses on a second call', async () => {
    const first = await cloneRepo(REPO, { fresh: true });
    expect(first.reused).toBe(false);
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.trackedFiles).toBeGreaterThan(0);

    const second = await cloneRepo(REPO);
    expect(second.reused).toBe(true);
    expect(second.repoId).toBe(first.repoId);
    expect(second.commitSha).toBe(first.commitSha);
  }, 60_000);
});
