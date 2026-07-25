/**
 * Dev script — verify Query Stage 8 (Verify), and the WHOLE query pipeline
 * end to end: Route → Retrieve → Fuse → Rerank → Expand → Grade → Generate
 * → Verify. Named `ask` (not `verify`, to avoid confusion with `npm test`) —
 * this is the closest thing this project has to "ask it a question."
 *
 * Usage:
 *   npm run ask -- <repo-url-or-local-path> "<question>" [--max-hops N] [--max-tokens N]
 *
 * Examples:
 *   npm run ask -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?"
 */

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo } from '../pipeline/ingest/04-index/index.ts';
import { answerQuestion } from '../pipeline/query/08-verify/answer.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const positional = a.filter((x, i) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
  const [input, question] = positional;
  const maxHops = Number(flagValue('--max-hops') ?? 3);
  const maxTokens = Number(flagValue('--max-tokens') ?? 300);
  const k = flagValue('--k') ? Number(flagValue('--k')) : undefined;
  const limit = flagValue('--limit') ? Number(flagValue('--limit')) : undefined;

  if (!input || !question) {
    console.error(
      'Usage: npm run ask -- <repo-url-or-local-path> "<question>" [--max-hops N] [--max-tokens N] [--k N] [--limit N]',
    );
    process.exit(1);
  }
  return { input, question, maxHops, maxTokens, k, limit };
}

async function main(): Promise<void> {
  const { input, question, maxHops, maxTokens, k, limit } = parseArgs(process.argv);

  console.log('\n── Query · Stage 8: Verify (full pipeline) ─────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  const { embeddings } = await embedChunks(chunks);
  await indexRepo(clone.repoId, chunks, embeddings);
  console.log(`  indexed ${chunks.length} chunks from ${clone.repoId}`);

  console.log(`\n  question   "${question}"`);
  console.log(`  ── answer (streaming) ──\n`);

  const result = await answerQuestion(clone.repoId, question, chunks, {
    maxHops,
    maxTokens,
    k,
    limit,
    onToken: (chunk) => process.stdout.write(chunk),
  });

  console.log(`\n\n  intent      ${result.route.intent}`);
  console.log(`  hops        ${result.hops.length}`);
  console.log(
    `  citations   ${result.verify.totalCount} found, ${result.verify.resolvedCount} resolved`,
  );

  if (!result.verify.hasCitations) {
    console.log(`  ⚠ the answer cited nothing — nothing to verify, treat with more skepticism`);
  } else {
    for (const c of result.verify.checks) {
      const mark = c.resolved ? '✓' : '✗ UNRESOLVED (possible hallucination)';
      console.log(
        `    ${mark}  ${c.citation.filePath}:${c.citation.startLine}-${c.citation.endLine}`,
      );
    }
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Query Stage 8 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
