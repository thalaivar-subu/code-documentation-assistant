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

import { answerQuestion } from '../pipeline/query/08-verify/answer.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';
import { ingestRepo } from './_shared/ingest.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--max-hops', '--max-tokens', '--k', '--limit']);
  const [input, question] = args.positional;

  if (!input || !question) {
    usageError(
      'npm run ask -- <repo-url-or-local-path> "<question>" [--max-hops N] [--max-tokens N] [--k N] [--limit N]',
    );
  }
  const k = args.getFlag('--k');
  const limit = args.getFlag('--limit');
  return {
    input,
    question,
    maxHops: Number(args.getFlag('--max-hops') ?? 3),
    maxTokens: Number(args.getFlag('--max-tokens') ?? 300),
    k: k ? Number(k) : undefined,
    limit: limit ? Number(limit) : undefined,
  };
}

async function main(): Promise<void> {
  const { input, question, maxHops, maxTokens, k, limit } = parseArgs(process.argv);

  console.log('\n── Query · Stage 8: Verify (full pipeline) ─────────────────────');

  const { clone, chunks } = await ingestRepo(input);

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
