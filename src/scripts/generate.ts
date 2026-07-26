/**
 * Dev script — verify Query Stage 7 (Generate) from the terminal.
 *
 * Runs the full ingest chain, then the full query loop (Route through
 * Grade), then streams a cited answer from the real local LLM — the first
 * script in this project that actually generates prose, not just ranks or
 * classifies.
 *
 * Usage:
 *   npm run generate -- <repo-url-or-local-path> "<question>" [--max-hops N] [--max-tokens N]
 *
 * Examples:
 *   npm run generate -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?"
 */

import { generate } from '../pipeline/query/07-generate/generate.ts';
import { runQueryLoop } from '../pipeline/query/06-grade/query-loop.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';
import { ingestRepo } from './_shared/ingest.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--max-hops', '--max-tokens']);
  const [input, question] = args.positional;

  if (!input || !question) {
    usageError(
      'npm run generate -- <repo-url-or-local-path> "<question>" [--max-hops N] [--max-tokens N]',
    );
  }
  return {
    input,
    question,
    maxHops: Number(args.getFlag('--max-hops') ?? 3),
    maxTokens: Number(args.getFlag('--max-tokens') ?? 300),
  };
}

async function main(): Promise<void> {
  const { input, question, maxHops, maxTokens } = parseArgs(process.argv);

  console.log('\n── Query · Stage 7: Generate ───────────────────────────────────');

  const { clone, chunks } = await ingestRepo(input);

  const loop = await runQueryLoop(clone.repoId, question, chunks, { maxHops });
  console.log(`\n  question   "${question}"`);
  console.log(`  intent     ${loop.route.intent}`);
  console.log(
    `  hops       ${loop.hops.length}  (${loop.expanded.length} chunks in final context)`,
  );

  console.log(`\n  ── answer (streaming) ──\n`);
  const started = Date.now();
  const result = await generate(question, loop.expanded, {
    maxTokens,
    onToken: (chunk) => process.stdout.write(chunk),
  });
  const ms = Date.now() - started;

  console.log(`\n\n  generated in ${ms} ms`);
  console.log(`  citations resolved from text: ${result.citations.length}`);
  for (const c of result.citations) {
    console.log(`    ${c.filePath}:${c.startLine}-${c.endLine}`);
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 7 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
