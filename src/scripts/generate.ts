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

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import { generate } from '../pipeline/query/07-generate/generate.ts';
import { runQueryLoop } from '../pipeline/query/06-grade/query-loop.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const positional = a.filter((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
  const [input, question] = positional;
  const maxHops = Number(flagValue('--max-hops') ?? 3);
  const maxTokens = Number(flagValue('--max-tokens') ?? 300);

  if (!input || !question) {
    console.error(
      'Usage: npm run generate -- <repo-url-or-local-path> "<question>" [--max-hops N] [--max-tokens N]',
    );
    process.exit(1);
  }
  return { input, question, maxHops, maxTokens };
}

async function main(): Promise<void> {
  const { input, question, maxHops, maxTokens } = parseArgs(process.argv);

  console.log('\n── Query · Stage 7: Generate ───────────────────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);

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
