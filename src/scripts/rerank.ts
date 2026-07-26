/**
 * Dev script — verify Query Stage 4 (Rerank) from the terminal.
 *
 * Runs the full chain (clone → chunk → embed → index → route → retrieve →
 * fuse → rerank) and prints the reranked shortlist next to Fuse's original
 * rrfScore, so the reordering is visible, not just asserted.
 *
 * Usage:
 *   npm run rerank -- <repo-url-or-local-path> "<question>" [--k N] [--limit N]
 *
 * Examples:
 *   npm run rerank -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?"
 */

import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';
import { fuseResults } from '../pipeline/query/03-fuse/fuse.ts';
import { rerankResults } from '../pipeline/query/04-rerank/rerank.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';
import { ingestRepo } from './_shared/ingest.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--k', '--limit']);
  const [input, question] = args.positional;

  if (!input || !question) {
    usageError('npm run rerank -- <repo-url-or-local-path> "<question>" [--k N] [--limit N]');
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

  console.log('\n── Query · Stage 4: Rerank ─────────────────────────────────────');

  const { clone } = await ingestRepo(input);

  const route = routeQuery(question);
  const { vector, lexical } = await retrieveCandidates(clone.repoId, question, route, { k });
  const fused = fuseResults(vector, lexical);
  console.log(`\n  question   "${question}"`);
  console.log(`  fused candidates: ${fused.length}`);

  const started = Date.now();
  const reranked = await rerankResults(clone.repoId, question, fused, { limit });
  const ms = Date.now() - started;

  console.log(`  reranked in ${ms} ms → top ${reranked.length}\n`);
  console.log('  rerankScore  rrfScore   symbol                    location');
  for (const r of reranked) {
    console.log(
      `  ${r.rerankScore.toFixed(4)}       ${r.rrfScore.toFixed(4)}     ${r.symbolName.padEnd(24)}  ${r.filePath}:${r.startLine}-${r.endLine}`,
    );
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 4 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
