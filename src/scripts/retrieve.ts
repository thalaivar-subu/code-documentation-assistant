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

import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';
import { ingestRepo } from './_shared/ingest.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--k']);
  const [input, question] = args.positional;

  if (!input || !question) {
    usageError('npm run retrieve -- <repo-url-or-local-path> "<question>" [--k N]');
  }
  return { input, question, k: Number(args.getFlag('--k') ?? 8) };
}

async function main(): Promise<void> {
  const { input, question, k } = parseArgs(process.argv);

  console.log('\n── Query · Stage 2: Retrieve ───────────────────────────────────');

  const { clone } = await ingestRepo(input);

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
