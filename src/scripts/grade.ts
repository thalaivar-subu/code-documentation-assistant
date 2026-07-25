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

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import { runQueryLoop } from '../pipeline/query/06-grade/query-loop.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const positional = a.filter((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
  const [input, question] = positional;
  const maxHops = Number(flagValue('--max-hops') ?? 3);
  const k = Number(flagValue('--k') ?? 20);
  const limit = Number(flagValue('--limit') ?? 8);

  if (!input || !question) {
    console.error(
      'Usage: npm run grade -- <repo-url-or-local-path> "<question>" [--max-hops N] [--k N] [--limit N]',
    );
    process.exit(1);
  }
  return { input, question, maxHops, k, limit };
}

async function main(): Promise<void> {
  const { input, question, maxHops, k, limit } = parseArgs(process.argv);

  console.log('\n── Query · Stage 6: Grade (+ query loop) ───────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);

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
