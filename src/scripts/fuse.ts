/**
 * Dev script — verify Query Stage 3 (Fuse) from the terminal.
 *
 * Runs the full chain (clone → chunk → embed → index → route → retrieve →
 * fuse) and prints the merged ranking, annotated with which list(s) each hit
 * came from — the direct payoff of hybrid retrieval, made visible.
 *
 * Usage:
 *   npm run fuse -- <repo-url-or-local-path> "<question>" [--k N]
 *
 * Examples:
 *   npm run fuse -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?"
 */

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';
import { fuseResults } from '../pipeline/query/03-fuse/fuse.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const positional = a.filter((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
  const [input, question] = positional;
  const k = Number(flagValue('--k') ?? 8);

  if (!input || !question) {
    console.error('Usage: npm run fuse -- <repo-url-or-local-path> "<question>" [--k N]');
    process.exit(1);
  }
  return { input, question, k };
}

async function main(): Promise<void> {
  const { input, question, k } = parseArgs(process.argv);

  console.log('\n── Query · Stage 3: Fuse ───────────────────────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);

  const route = routeQuery(question);
  const { vector, lexical } = await retrieveCandidates(clone.repoId, question, route, { k });
  console.log(`\n  question   "${question}"`);
  console.log(`  intent     ${route.intent}`);
  console.log(`  candidates vector=${vector.length}  lexical=${lexical.length}`);

  const fused = fuseResults(vector, lexical, { limit: k });

  console.log(`\n  fused ranking (top ${fused.length})`);
  for (const f of fused) {
    console.log(
      `    ${f.rrfScore.toFixed(5)}  [${f.sources.join('+').padEnd(12)}]  ${f.symbolName.padEnd(24)} ${f.filePath}:${f.startLine}-${f.endLine}`,
    );
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 3 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
