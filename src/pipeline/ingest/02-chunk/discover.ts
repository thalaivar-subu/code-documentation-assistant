/**
 * Ingest · Stage 2, part A: Discover.  →  docs: ./README.md
 *
 * Walk a working tree and decide WHICH files to index and WHAT each one is.
 * Produces `FileEntry[]` that part B (the chunker) consumes. Three jobs:
 *   1. Filtering — respect `.gitignore`, skip vendored/binary/generated noise.
 *   2. Classification — code (AST-parseable) vs config/infra vs prose text.
 *   3. Hashing — a `sha256` per file so re-indexing can skip unchanged files.
 *
 * By default we index `code` + `config` (config/infra files explain how a project is
 * built and deployed). Prose `text` (markdown, scripts) is opt-in via `includeText`.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, relative } from 'node:path';
import { globby } from 'globby';

import type { CodeLanguage, FileEntry, FileKind } from '../../../core/types.ts';
import { normalizeNewlines } from './chunk-file.ts';

/** Extension → AST language. */
const CODE_EXT: Record<string, CodeLanguage> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
};

/** Extension → config format (build/deploy/infra files). */
const CONFIG_EXT: Record<string, string> = {
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.properties': 'properties',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
  '.json': 'json',
  '.xml': 'xml',
  '.gradle': 'gradle',
  '.dockerfile': 'dockerfile',
};

/** Exact filename (lowercased) → config format. Covers files with no telling extension. */
const CONFIG_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  'docker-compose.yml': 'compose',
  'docker-compose.yaml': 'compose',
  'compose.yml': 'compose',
  'compose.yaml': 'compose',
  makefile: 'make',
  gnumakefile: 'make',
  jenkinsfile: 'jenkins',
  'go.mod': 'gomod',
  gemfile: 'ruby',
  pipfile: 'toml',
  'requirements.txt': 'pip',
  procfile: 'procfile',
};

const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/*.min.*',
  '**/*.map',
  '**/*-lock.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  // Pure generated checksum lockfiles — like the JS ones above, real dependency
  // *declarations* (go.mod, Pipfile, requirements.txt) stay indexable, but a
  // hash-per-transitive-dependency file has zero documentation value and, on a
  // real repo, was measured to be over half of an entire LLM prompt's content
  // by itself (see 07-generate/README.md).
  '**/go.sum',
];

const DEFAULT_MAX_BYTES = 1_000_000;

export interface DiscoverOptions {
  /** Also index prose 'text' files (markdown, scripts). Default false (code + config only). */
  includeText?: boolean;
  /** Max file size to index, in bytes. Default 1 MB. */
  maxBytes?: number;
}

export interface FileClass {
  kind: FileKind;
  language?: CodeLanguage;
  configFormat?: string;
}

/** Classify a path as code / config / text (pure, no I/O). */
export function classifyPath(path: string): FileClass {
  const base = basename(path).toLowerCase();
  const ext = extname(path).toLowerCase();

  // Filename-driven config (Dockerfile, Makefile, go.mod, …) and Dockerfile.<variant>.
  if (base in CONFIG_NAMES) return { kind: 'config', configFormat: CONFIG_NAMES[base] };
  if (base.startsWith('dockerfile')) return { kind: 'config', configFormat: 'dockerfile' };

  if (ext in CODE_EXT) return { kind: 'code', language: CODE_EXT[ext] };
  if (ext in CONFIG_EXT) return { kind: 'config', configFormat: CONFIG_EXT[ext] };
  return { kind: 'text' };
}

/**
 * Discover indexable files under `repoPath`. Honours `.gitignore` (via globby) for
 * both cloned repos and plain local folders.
 */
export async function discoverFiles(
  repoPath: string,
  opts: DiscoverOptions = {},
): Promise<FileEntry[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const paths = await globby(['**/*'], {
    cwd: repoPath,
    gitignore: true,
    ignore: DEFAULT_IGNORES,
    onlyFiles: true,
    absolute: true,
    dot: true, // include .gitlab-ci.yml, .github/workflows, etc.
  });

  const entries: FileEntry[] = [];
  for (const absPath of paths) {
    const cls = classifyPath(absPath);
    if (cls.kind === 'text' && !opts.includeText) continue;

    const { size } = await stat(absPath);
    if (size > maxBytes) continue;

    // Normalize CRLF→LF before hashing — same as chunk-file.ts's contentHash —
    // so this "has the file changed" signal doesn't differ for the identical
    // file checked out with different line endings across environments.
    const text = normalizeNewlines(await readFile(absPath, 'utf8'));
    entries.push({
      absPath,
      relPath: relative(repoPath, absPath).split('\\').join('/'),
      kind: cls.kind,
      language: cls.language,
      configFormat: cls.configFormat,
      sizeBytes: size,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }

  // Stable ordering → deterministic downstream chunk ids and reproducible tests.
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return entries;
}
