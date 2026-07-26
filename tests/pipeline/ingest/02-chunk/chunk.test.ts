/**
 * Tests for Ingest · Stage 2, part B (Chunk).
 *
 *  - AST chunking across all supported languages, asserting symbols, kinds, parents,
 *    and — critically — that a function is captured WHOLE (start<end, body included).
 *  - Config chunking (whole-file vs windowed).
 *  - The chunkRepo orchestrator against this repo.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { chunkFile, chunkRepo } from '../../../../src/pipeline/ingest/02-chunk/chunk.ts';
import {
  chunkCode,
  splitOversized,
} from '../../../../src/pipeline/ingest/02-chunk/code-chunker.ts';
import { chunkFlat } from '../../../../src/pipeline/ingest/02-chunk/config-chunker.ts';

const find = (cs: { symbolName: string }[], name: string) => cs.find((c) => c.symbolName === name);

/** Write `content` to a fresh temp file and return its path (for chunkFile tests). */
function makeTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cda-chunk-test-'));
  const path = join(dir, 'a.ts');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('chunkCode — languages', () => {
  it('TypeScript: functions + methods with parent, whole bodies', async () => {
    const src = [
      'export function greet(name: string): string {',
      '  return `hi ${name}`;',
      '}',
      'class Service {',
      '  run(): number {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n');
    const cs = await chunkCode(src, 'ts', '.ts');
    const greet = find(cs, 'greet')!;
    expect(greet.symbolType).toBe('function');
    expect([greet.startLine, greet.endLine]).toEqual([1, 3]); // whole body, not split
    const run = find(cs, 'run')!;
    expect(run.symbolType).toBe('method');
    expect(run.parentSymbol).toBe('Service');
    expect(run.content).toContain('return 1');
  });

  it('Python: class methods and module functions', async () => {
    const src = [
      'class Animal:',
      '    def speak(self):',
      '        return "..."',
      'def helper(x):',
      '    return x * 2',
    ].join('\n');
    const cs = await chunkCode(src, 'python', '.py');
    expect(find(cs, 'speak')?.parentSymbol).toBe('Animal');
    expect(find(cs, 'helper')?.symbolType).toBe('function');
  });

  it('Java: methods inside a class', async () => {
    const src = [
      'public class Calc {',
      '  int add(int a, int b) {',
      '    return a + b;',
      '  }',
      '}',
    ].join('\n');
    const cs = await chunkCode(src, 'java', '.java');
    const add = find(cs, 'add')!;
    expect(add.symbolType).toBe('method');
    expect(add.parentSymbol).toBe('Calc');
  });

  it('Go: func, method (receiver), and struct type', async () => {
    const src = [
      'package main',
      'type Server struct { port int }',
      'func (s *Server) Start() error { return nil }',
      'func main() {}',
    ].join('\n');
    const cs = await chunkCode(src, 'go', '.go');
    expect(find(cs, 'Server')?.symbolType).toBe('type');
    expect(find(cs, 'Start')?.symbolType).toBe('method');
    expect(find(cs, 'main')?.symbolType).toBe('function');
  });
});

describe('splitOversized — oversized functions', () => {
  const baseRaw = (lineCount: number) => {
    // line 0 = signature ("header"), last line = closing brace, body lines in between —
    // each body line is unique text so we can tell parts apart by content.
    const lines = [
      'function bigFn() {',
      ...Array.from({ length: lineCount - 2 }, (_, i) => `  const v${i} = ${i};`),
      '}',
    ];
    return {
      symbolName: 'bigFn',
      symbolType: 'function' as const,
      startLine: 1,
      endLine: lineCount,
      content: lines.join('\n'),
    };
  };

  it('does not split a chunk at or under the threshold', () => {
    const raw = baseRaw(100); // MAX_FUNCTION_LINES
    expect(splitOversized(raw)).toEqual([raw]);
  });

  it('splits a chunk over the threshold into fixed-size, non-overlapping parts', () => {
    const raw = baseRaw(105); // → ceil(105/40) = 3 parts: 40 + 40 + 25
    const parts = splitOversized(raw);

    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.symbolName)).toEqual([
      'bigFn [part 1/3]',
      'bigFn [part 2/3]',
      'bigFn [part 3/3]',
    ]);

    // contiguous, non-overlapping coverage of the original range
    expect(parts[0].startLine).toBe(raw.startLine);
    expect(parts[2].endLine).toBe(raw.endLine);
    expect(parts[0].endLine + 1).toBe(parts[1].startLine);
    expect(parts[1].endLine + 1).toBe(parts[2].startLine);

    // parts after the first repeat the original signature line for context
    expect(parts[0].content.startsWith('function bigFn() {')).toBe(true);
    expect(parts[1].content.startsWith('function bigFn() {')).toBe(true);
    expect(parts[2].content.startsWith('function bigFn() {')).toBe(true);

    // every part's content is genuinely different (no accidental duplication)
    expect(new Set(parts.map((p) => p.content)).size).toBe(3);
  });
});

describe('chunkFile — oversized function hashing (end to end)', () => {
  it('produces 3 chunks with distinct ids AND distinct contentHash for one big function', async () => {
    const lines = [
      'function bigFn() {',
      ...Array.from({ length: 103 }, (_, i) => `  const v${i} = ${i};`),
      '}',
    ]; // 105 lines total → splits into parts of 40 + 40 + 25
    const source = lines.join('\n') + '\n';

    const chunks = await chunkFile('r', {
      absPath: makeTempFile(source),
      relPath: 'a.ts',
      kind: 'code',
      language: 'ts',
      sizeBytes: 0,
      sha256: '',
    });

    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.symbolName).toMatch(/^bigFn \[part \d\/3\]$/);
      expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }

    // the whole point of hashing per part: each part is a genuinely distinct chunk
    expect(new Set(chunks.map((c) => c.contentHash)).size).toBe(3);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(3);

    // line ranges are contiguous and cover the original function exactly
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[2].endLine).toBe(105);
    expect(chunks[0].endLine + 1).toBe(chunks[1].startLine);
    expect(chunks[1].endLine + 1).toBe(chunks[2].startLine);
  });
});

describe('chunkFlat — config', () => {
  it('keeps a small file as one whole-file chunk', () => {
    const cs = chunkFlat('FROM node:20\nRUN npm ci\n', 'Dockerfile');
    expect(cs).toHaveLength(1);
    expect(cs[0].symbolType).toBe('file');
    expect(cs[0].symbolName).toBe('Dockerfile');
  });

  it('windows a large file into overlapping blocks', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const cs = chunkFlat(big, 'values.yaml');
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.symbolType === 'block')).toBe(true);
  });
});

describe('chunkRepo — this repo', () => {
  it('produces code + config chunks with stable ids and valid line ranges', async () => {
    const { chunks, fileCount, chunkCount, parallel, workers } = await chunkRepo({
      repoId: 'self',
      repoPath: '.',
    });
    expect(fileCount).toBeGreaterThan(0);
    expect(chunkCount).toBeGreaterThanOrEqual(fileCount);
    expect(workers).toBeGreaterThanOrEqual(1);
    expect(typeof parallel).toBe('boolean');

    // a known symbol from our own source is present
    expect(chunks.some((c) => c.symbolName === 'cloneRepo' && c.kind === 'code')).toBe(true);
    // config files are chunked too
    expect(chunks.some((c) => c.filePath === 'package.json' && c.kind === 'config')).toBe(true);

    for (const c of chunks) {
      expect(c.id).toMatch(/^[0-9a-f]{32}$/);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // ids are unique (deterministic + collision-free on this repo)
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it('normalizes CRLF so content/contentHash are stable across line-ending styles', async () => {
    const lf = await chunkFile('r', {
      absPath: makeTempFile('function f() {\n  return 1;\n}\n'),
      relPath: 'a.ts',
      kind: 'code',
      language: 'ts',
      sizeBytes: 0,
      sha256: '',
    });
    const crlf = await chunkFile('r', {
      absPath: makeTempFile('function f() {\r\n  return 1;\r\n}\r\n'),
      relPath: 'a.ts',
      kind: 'code',
      language: 'ts',
      sizeBytes: 0,
      sha256: '',
    });
    expect(crlf[0].content).not.toContain('\r');
    expect(crlf[0].contentHash).toBe(lf[0].contentHash);
    expect(crlf[0].id).toBe(lf[0].id);
  });
});
