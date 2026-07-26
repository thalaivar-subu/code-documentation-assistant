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

import { routeQuery } from '../pipeline/query/01-route/route.ts';
import { retrieveCandidates } from '../pipeline/query/02-retrieve/retrieve.ts';
import { fuseResults } from '../pipeline/query/03-fuse/fuse.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';
import { ingestRepo } from './_shared/ingest.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--k']);
  const [input, question] = args.positional;

  if (!input || !question) {
    usageError('npm run fuse -- <repo-url-or-local-path> "<question>" [--k N]');
  }
  return { input, question, k: Number(args.getFlag('--k') ?? 8) };
}

async function main(): Promise<void> {
  const { input, question, k } = parseArgs(process.argv);

  console.log('\n── Query · Stage 3: Fuse ───────────────────────────────────────');

  const { clone } = await ingestRepo(input);

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
