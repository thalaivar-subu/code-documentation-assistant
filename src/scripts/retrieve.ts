/**
 * Dev script — verify Query Stage 2 (Retrieve) from the terminal.
 *
 * Runs the full ingest chain (clone → chunk → embed → index — cheap to repeat,
 * everything upserts/caches) so there's always something to retrieve against,
 * then Route → Retrieve on the given question. No fusion/reranking here —
 * this is the raw "here are two independently-ranked candidate lists" view.
 *
 * Usage:
 *   npm run retrieve -- <repo-url-or-local-path> "<question>" [--k N]
 *
 * Examples:
 *   npm run retrieve -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?"
 *   npm run retrieve -- https://github.com/thalaivar-subu/telemetry-go "how does gin instrumentation work?" --k 3
 */

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const positional = a.filter((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
  const [input, question] = positional;
  const k = Number(flagValue('--k') ?? 8);

  if (!input || !question) {
    console.error('Usage: npm run retrieve -- <repo-url-or-local-path> "<question>" [--k N]');
    process.exit(1);
  }
  return { input, question, k };
}

async function main(): Promise<void> {
  const { input, question, k } = parseArgs(process.argv);

  console.log('\n── Query · Stage 2: Retrieve ───────────────────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);

  const route = routeQuery(question);
  console.log(`\n  question   "${question}"`);
  console.log(`  intent     ${route.intent}  (symbols=[${route.symbols}] files=[${route.files}])`);

  const { vector, lexical, ms } = await retrieveCandidates(clone.repoId, question, route, { k });
  console.log(`  retrieved in ${ms} ms\n`);

  console.log(`  vector candidates (nearest first)`);
  for (const h of vector) {
    console.log(
      `    ${h.distance.toFixed(4)}  ${h.symbolName.padEnd(24)} ${h.filePath}:${h.startLine}-${h.endLine}`,
    );
  }
  console.log(`\n  lexical candidates (highest score first)`);
  for (const h of lexical) {
    console.log(
      `    ${h.score.toFixed(4)}  ${h.symbolName.padEnd(24)} ${h.filePath}:${h.startLine}-${h.endLine}`,
    );
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 2 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
