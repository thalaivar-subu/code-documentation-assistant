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

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';
import { fuseResults } from '../pipeline/query/03-fuse/fuse.ts';
import { rerankResults } from '../pipeline/query/04-rerank/rerank.ts';
import { expandResults } from '../pipeline/query/05-expand/expand.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const positional = a.filter((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
  const [input, question] = positional;
  const k = Number(flagValue('--k') ?? 20);
  const limit = Number(flagValue('--limit') ?? 8);

  if (!input || !question) {
    console.error(
      'Usage: npm run expand -- <repo-url-or-local-path> "<question>" [--k N] [--limit N]',
    );
    process.exit(1);
  }
  return { input, question, k, limit };
}

async function main(): Promise<void> {
  const { input, question, k, limit } = parseArgs(process.argv);

  console.log('\n── Query · Stage 5: Expand ─────────────────────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);

  const route = routeQuery(question);
  const { vector, lexical } = await retrieveCandidates(clone.repoId, question, route, { k });
  const fused = fuseResults(vector, lexical);
  const reranked = await rerankResults(clone.repoId, question, fused, { limit });
  console.log(`\n  question   "${question}"`);
  console.log(`  intent     ${route.intent}`);
  console.log(`  reranked   ${reranked.length} hits`);

  const expanded = expandResults(chunks, reranked);
  const graphAdded = expanded.length - reranked.length;
  console.log(`  expand     +${graphAdded} chunk(s) via the symbol graph\n`);

  for (const h of expanded) {
    console.log(
      `  [${h.via.padEnd(7)}] ${h.symbolName.padEnd(24)} ${h.filePath}:${h.startLine}-${h.endLine}`,
    );
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 5 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
