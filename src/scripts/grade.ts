/**
 * Dev script — verify Query Stage 6 (Grade + the query loop) from the terminal.
 *
 * Runs the full chain (clone → chunk → embed → index) then the query loop
 * (route → {retrieve → fuse → rerank → expand → grade}×hops), printing every
 * hop's grade decision so the loop is actually visible, not just asserted.
 *
 * Usage:
 *   npm run grade -- <repo-url-or-local-path> "<question>" [--max-hops N] [--k N] [--limit N]
 *
 * Examples:
 *   npm run grade -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?"
 */

import { runQueryLoop } from '../pipeline/query/06-grade/query-loop.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';
import { ingestRepo } from './_shared/ingest.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--max-hops', '--k', '--limit']);
  const [input, question] = args.positional;

  if (!input || !question) {
    usageError(
      'npm run grade -- <repo-url-or-local-path> "<question>" [--max-hops N] [--k N] [--limit N]',
    );
  }
  return {
    input,
    question,
    maxHops: Number(args.getFlag('--max-hops') ?? 3),
    k: Number(args.getFlag('--k') ?? 20),
    limit: Number(args.getFlag('--limit') ?? 8),
  };
}

async function main(): Promise<void> {
  const { input, question, maxHops, k, limit } = parseArgs(process.argv);

  console.log('\n── Query · Stage 6: Grade (+ query loop) ───────────────────────');

  const { clone, chunks } = await ingestRepo(input);

  const result = await runQueryLoop(clone.repoId, question, chunks, { maxHops, k, limit });

  console.log(`\n  question   "${question}"`);
  console.log(`  intent     ${result.route.intent}\n`);

  for (const h of result.hops) {
    const verdict = h.grade.sufficient ? 'sufficient' : 'insufficient — looping';
    console.log(`  hop ${h.hop}  query="${h.query}"`);
    console.log(`         ${verdict} — ${h.grade.reason}`);
  }

  console.log(`\n  final context (${result.expanded.length} chunks):`);
  for (const c of result.expanded) {
    console.log(
      `    [${c.via.padEnd(7)}] ${c.symbolName.padEnd(24)} ${c.filePath}:${c.startLine}-${c.endLine}`,
    );
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 6 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
