/**
 * Dev script — verify ingest Stage 2 (Chunk) from the terminal.
 *
 * Clones/reads a source, then discovers + chunks it and prints a summary plus a
 * sample of chunks. Build/verification tooling, not a product feature.
 *
 * Usage:
 *   npm run chunk -- <repo-url-or-local-path> [options]
 *
 * Options:
 *   --sample N        how many chunks to show (default 12; use 0 for all)
 *   --file <substr>   only chunks whose filePath contains this substring
 *   --symbol <substr> only chunks whose symbolName contains this substring
 *   --content         print each shown chunk's full source text
 *   --json            print each shown chunk as a full JSON object
 *                      (id, contentHash, commitSha, kind, language, parentSymbol, …)
 *   --out <path>      write ALL chunks as JSON to this file (full objects)
 *   --sequential      force single-threaded chunking (for comparing against the
 *                      worker pool — see the "parallel" line in the summary)
 *
 * Examples:
 *   npm run chunk -- . --file "clone.ts" --content              # see the code
 *   npm run chunk -- . --file "common.go" --symbol Instrument --json   # see ONE full chunk
 *   npm run chunk -- . --out .cache/chunks.json                 # dump everything
 *   npm run chunk -- <big-repo> --sequential                    # compare vs the pool
 */

import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { poolSize } from '../pipeline/ingest/02-chunk/chunk-pool.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);

  const input = a.find((x) => !x.startsWith('--') && !a[a.indexOf(x) - 1]?.startsWith('--'));
  const sample = Number(flagValue('--sample') ?? 12);
  const file = flagValue('--file');
  const symbol = flagValue('--symbol');
  const out = flagValue('--out');
  const content = a.includes('--content');
  const json = a.includes('--json');
  const sequential = a.includes('--sequential');

  if (!input) {
    console.error(
      'Usage: npm run chunk -- <repo-url-or-local-path> [--sample N] [--file <substr>] [--symbol <substr>] [--content] [--json] [--out <path>] [--sequential]',
    );
    process.exit(1);
  }
  return { input, sample, file, symbol, content, json, out, sequential };
}

async function main(): Promise<void> {
  const { input, sample, file, symbol, content, json, out, sequential } = parseArgs(process.argv);

  console.log('\n── Ingest · Stage 2: Chunk ─────────────────────────────────────');
  console.log(`  logical CPUs: ${cpus().length}  |  chunking pool size: ${poolSize()}`);
  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const started = Date.now();
  const { chunks, fileCount, chunkCount, parallel, workers } = await chunkRepo(
    clone,
    sequential ? { parallelThreshold: Infinity } : {},
  );
  const ms = Date.now() - started;

  const code = chunks.filter((c) => c.kind === 'code').length;
  const configN = chunks.filter((c) => c.kind === 'config').length;

  console.log(
    `\n  files ${fileCount}  |  chunks ${chunkCount}  (code ${code}, config ${configN})  |  ` +
      `${ms} ms  |  ${parallel ? `parallel (${workers} workers)` : 'sequential'}\n`,
  );

  if (out) {
    await writeFile(out, JSON.stringify(chunks, null, 2), 'utf8');
    console.log(`  wrote all ${chunks.length} chunks (with full content) → ${out}\n`);
  }

  let matched = file ? chunks.filter((c) => c.filePath.includes(file)) : chunks;
  if (symbol) matched = matched.filter((c) => c.symbolName.includes(symbol));
  const shown = sample === 0 ? matched : matched.slice(0, sample);

  if (matched.length > shown.length) {
    console.log(
      `  showing ${shown.length} of ${matched.length} matching chunks (--sample 0 for all)\n`,
    );
  }

  for (const c of shown) {
    if (json) {
      console.log(JSON.stringify(c, null, 2));
      continue;
    }
    const where = `${c.filePath}:${c.startLine}-${c.endLine}`;
    const parent = c.parentSymbol ? ` <${c.parentSymbol}` : '';
    console.log(`  ${c.symbolType.padEnd(8)} ${c.symbolName.padEnd(20)} ${where}${parent}`);
    if (content) {
      console.log('  ┌' + '─'.repeat(64));
      for (const line of c.content.split('\n')) console.log('  │ ' + line);
      console.log('  └' + '─'.repeat(64) + '\n');
    }
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Stage 2 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
