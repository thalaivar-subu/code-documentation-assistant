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

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';
import { fuseResults } from '../pipeline/query/03-fuse/fuse.ts';
import { rerankResults } from '../pipeline/query/04-rerank/rerank.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const positional = a.filter((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
  const [input, question] = positional;
  const k = Number(flagValue('--k') ?? 20);
  const limit = Number(flagValue('--limit') ?? 8);

  if (!input || !question) {
    console.error(
      'Usage: npm run rerank -- <repo-url-or-local-path> "<question>" [--k N] [--limit N]',
    );
    process.exit(1);
  }
  return { input, question, k, limit };
}

async function main(): Promise<void> {
  const { input, question, k, limit } = parseArgs(process.argv);

  console.log('\n── Query · Stage 4: Rerank ─────────────────────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);

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
