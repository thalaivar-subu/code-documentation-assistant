/**
 * Tests for Ingest · Stage 2, part A (Discover). Runs against this repo itself.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyPath, discoverFiles } from '../../../../src/pipeline/ingest/02-chunk/discover.ts';

describe('classifyPath', () => {
  it('routes code by extension (incl. Go)', () => {
    expect(classifyPath('a/clone.ts')).toEqual({ kind: 'code', language: 'ts' });
    expect(classifyPath('main.go')).toEqual({ kind: 'code', language: 'go' });
    expect(classifyPath('x.py')).toEqual({ kind: 'code', language: 'python' });
    expect(classifyPath('Y.java')).toEqual({ kind: 'code', language: 'java' });
  });

  it('routes build/deploy/config files', () => {
    expect(classifyPath('Dockerfile')).toEqual({ kind: 'config', configFormat: 'dockerfile' });
    expect(classifyPath('Dockerfile.prod')).toEqual({ kind: 'config', configFormat: 'dockerfile' });
    expect(classifyPath('deploy/values.yaml').kind).toBe('config');
    expect(classifyPath('.gitlab-ci.yml')).toEqual({ kind: 'config', configFormat: 'yaml' });
    expect(classifyPath('package.json')).toEqual({ kind: 'config', configFormat: 'json' });
    expect(classifyPath('go.mod')).toEqual({ kind: 'config', configFormat: 'gomod' });
    expect(classifyPath('infra/main.tf')).toEqual({ kind: 'config', configFormat: 'hcl' });
    expect(classifyPath('Makefile')).toEqual({ kind: 'config', configFormat: 'make' });
  });

  it('routes everything else to text', () => {
    expect(classifyPath('README.md')).toEqual({ kind: 'text' });
    expect(classifyPath('run.sh')).toEqual({ kind: 'text' });
  });
});

describe('discoverFiles — lockfile exclusion', () => {
  it('excludes go.sum, same as package-lock.json/yarn.lock — a checksum lockfile has no documentation value', async () => {
    // Regression: go.sum was indexed as a 'gomod' config chunk and measured to
    // be over half the content of a real LLM prompt by itself (14.7KB of pure
    // hashes) — pure noise for a question-answering context.
    const dir = mkdtempSync(join(tmpdir(), 'cda-discover-lockfile-test-'));
    writeFileSync(join(dir, 'go.mod'), 'module example.com/foo\n\ngo 1.21\n', 'utf8');
    writeFileSync(join(dir, 'go.sum'), 'example.com/bar v1.0.0 h1:abc123...\n', 'utf8');

    const entries = await discoverFiles(dir);
    const paths = entries.map((e) => e.relPath);

    expect(paths).toContain('go.mod'); // the real dependency declaration stays indexable
    expect(paths).not.toContain('go.sum'); // the checksum lockfile does not
  });
});

describe('discoverFiles (this repo)', () => {
  it('indexes code + config, skips noise and prose by default', async () => {
    const entries = await discoverFiles('.');
    const byPath = new Map(entries.map((e) => [e.relPath, e]));

    // code
    expect(byPath.get('src/pipeline/ingest/01-clone/clone.ts')?.kind).toBe('code');
    expect(byPath.get('src/pipeline/ingest/01-clone/clone.ts')?.language).toBe('ts');
    // config (deploy/build files)
    expect(byPath.get('package.json')?.kind).toBe('config');
    expect(byPath.get('tsconfig.json')?.kind).toBe('config');
    // skips: dependencies, VCS internals, and prose (markdown) by default
    const rels = [...byPath.keys()];
    expect(rels.some((r) => r.includes('node_modules'))).toBe(false);
    expect(rels.some((r) => r.includes('.git/'))).toBe(false);
    expect(rels.some((r) => r.endsWith('.md'))).toBe(false);
    // every entry fully described
    for (const e of entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.relPath).not.toContain('\\');
      if (e.kind === 'code') expect(e.language).toBeDefined();
      if (e.kind === 'config') expect(e.configFormat).toBeDefined();
    }
    // stable, sorted order — matches discoverFiles' own localeCompare, not ASCII sort
    // (locale collation is case-insensitive-first, so e.g. "api.ts" sorts before "App.tsx")
    expect(rels).toEqual([...rels].sort((a, b) => a.localeCompare(b)));
  });

  it('includes prose text when asked', async () => {
    const withText = await discoverFiles('.', { includeText: true });
    expect(withText.some((e) => e.relPath.endsWith('.md') && e.kind === 'text')).toBe(true);
  });

  it("sha256 is stable across CRLF vs LF line endings (matches contentHash's normalization)", async () => {
    // Regression: sha256 used to be hashed from the raw, non-normalized buffer,
    // unlike chunk-file.ts's contentHash — so the same file checked out with
    // different line endings got a different sha256, defeating its documented
    // purpose as a stable "has this file changed" incremental-indexing key.
    const lfDir = mkdtempSync(join(tmpdir(), 'cda-discover-lf-'));
    const crlfDir = mkdtempSync(join(tmpdir(), 'cda-discover-crlf-'));
    writeFileSync(join(lfDir, 'a.ts'), 'function f() {\n  return 1;\n}\n', 'utf8');
    writeFileSync(join(crlfDir, 'a.ts'), 'function f() {\r\n  return 1;\r\n}\r\n', 'utf8');

    const [lfEntries, crlfEntries] = await Promise.all([
      discoverFiles(lfDir),
      discoverFiles(crlfDir),
    ]);

    expect(lfEntries).toHaveLength(1);
    expect(crlfEntries).toHaveLength(1);
    expect(crlfEntries[0].sha256).toBe(lfEntries[0].sha256);
  });
});
