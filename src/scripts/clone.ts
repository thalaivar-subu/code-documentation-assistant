/**
 * Dev script — verify ingest Stage 1 (Clone) from the terminal.
 *
 * This is build/verification tooling, not a shipped product feature (the product
 * surface is the UI). It exists so each pipeline stage can be exercised and
 * eyeballed in isolation before the next stage is built.
 *
 * Usage:
 *   npm run clone -- <repo-url-or-local-path> [--fresh]
 *
 * Examples:
 *   npm run clone -- https://github.com/octocat/Hello-World
 *   npm run clone -- .                       # index this very repo (local source)
 *   npm run clone -- ../some-project --fresh # force a re-fetch
 */

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';

function parseArgs(argv: string[]): { input: string; fresh: boolean } {
  const args = argv.slice(2);
  const fresh = args.includes('--fresh');
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('Usage: npm run clone -- <repo-url-or-local-path> [--fresh]');
    process.exit(1);
  }
  return { input, fresh };
}

async function main(): Promise<void> {
  const { input, fresh } = parseArgs(process.argv);

  console.log('\n── Ingest · Stage 1: Clone ─────────────────────────────────────');
  const startedAt = Date.now();

  const result = await cloneRepo(input, {
    fresh,
    onStep: (msg) => console.log(`  → ${msg}`),
  });

  const ms = Date.now() - startedAt;

  console.log('\n  Result');
  console.log('  ------');
  console.log(`  repoId        ${result.repoId}`);
  console.log(`  path          ${result.repoPath}`);
  console.log(`  source        ${result.source.kind}`);
  console.log(
    `  commit        ${result.commitSha ? result.commitSha.slice(0, 12) : '(none — not a git repo)'}`,
  );
  console.log(`  branch        ${result.branch || '(n/a)'}`);
  console.log(`  trackedFiles  ${result.trackedFiles}`);
  console.log(`  reused        ${result.reused}`);
  console.log(`  took          ${ms} ms`);
  console.log('────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Stage 1 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
