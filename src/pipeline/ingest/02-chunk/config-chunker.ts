/**
 * Ingest · Stage 2, part B: config / text chunker.
 *
 * Config and prose files have no AST worth walking, so we keep it simple and honest:
 *  - Small files (≤ MAX_WHOLE_LINES) → one whole-file chunk. A Dockerfile or CI file
 *    is most useful retrieved in full, and it's directly citable.
 *  - Large files → fixed line windows with a little overlap, so a big YAML/manifest
 *    still gets indexed without one giant chunk dominating retrieval.
 */

import { basename } from 'node:path';

import type { RawChunk } from './code-chunker.ts';

const MAX_WHOLE_LINES = 200;
const WINDOW_LINES = 120;
const OVERLAP_LINES = 15;

/** Split source into overlapping line windows (used for large config/text files). */
function windowChunks(source: string, relPath: string): RawChunk[] {
  const lines = source.split('\n');
  const out: RawChunk[] = [];
  const step = WINDOW_LINES - OVERLAP_LINES;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    out.push({
      symbolName: `${basename(relPath)}:${start + 1}-${end}`,
      symbolType: 'block',
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join('\n'),
    });
    if (end === lines.length) break;
  }
  return out;
}

/** Chunk a config or prose-text file. */
export function chunkFlat(source: string, relPath: string): RawChunk[] {
  const lineCount = source.split('\n').length;
  if (lineCount <= MAX_WHOLE_LINES) {
    return [
      {
        symbolName: basename(relPath),
        symbolType: 'file',
        startLine: 1,
        endLine: lineCount,
        content: source,
      },
    ];
  }
  return windowChunks(source, relPath);
}
