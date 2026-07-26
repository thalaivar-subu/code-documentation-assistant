/**
 * Dev script — verify Query Stage 5 (Expand) from the terminal.
 *
 * Runs the full chain (clone → chunk → embed → index → route → retrieve →
 * fuse → rerank → expand) and prints the expanded result set, tagging each
 * hit with why it's there: a real result (`rerank`) or pulled in via the
 * name-based symbol graph (`caller`/`callee`).
 *
 * Usage:
 *   npm run expand -- <repo-url-or-local-path> "<question>" [--k N] [--limit N]
 *
 * Examples:
 *   npm run expand -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?"
 */

import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';
import { fuseResults } from '../pipeline/query/03-fuse/fuse.ts';
import { rerankResults } from '../pipeline/query/04-rerank/rerank.ts';
import { expandResults } from '../pipeline/query/05-expand/expand.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';
import { ingestRepo } from './_shared/ingest.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--k', '--limit']);
  const [input, question] = args.positional;

  if (!input || !question) {
    usageError('npm run expand -- <repo-url-or-local-path> "<question>" [--k N] [--limit N]');
  }
  return {
    input,
    question,
    k: Number(args.getFlag('--k') ?? 20),
    limit: Number(args.getFlag('--limit') ?? 8),
  };
}

async function main(): Promise<void> {
  const { input, question, k, limit } = parseArgs(process.argv);

  console.log('\n── Query · Stage 5: Expand ─────────────────────────────────────');

  const { clone, chunks } = await ingestRepo(input);

  const route = routeQuery(question);
  const { vector, lexical } = await retrieveCandidates(clone.repoId, question, route, { k });
  const fused = fuseResults(vector, lexical);
  const reranked = await rerankResults(clone.repoId, question, fused, { limit });
  console.log(`\n  question   "${question}"`);
  console.log(`  intent     ${route.intent}`);
  console.log(`  reranked   ${reranked.length} hits`);

  const expanded = expandResults(chunks, reranked, { intent: route.intent });
  const graphAdded = expanded.length - reranked.length;
  console.log(`  expand     +${graphAdded} chunk(s) via the symbol graph\n`);

  for (const h of expanded) {
    console.log(
      `  [${h.via.padEnd(8)}] ${h.symbolName.padEnd(24)} ${h.filePath}:${h.startLine}-${h.endLine}`,
    );
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 5 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
