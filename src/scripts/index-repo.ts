/**
 * Dev script — verify ingest Stage 4 (Index) from the terminal.
 *
 * Runs the full ingest pipeline (clone → chunk → embed → index) and reports
 * what landed in each store. Deliberately does NOT query/search — that's the
 * query pipeline's job (Stage "Retrieve", not built yet), not ingestion's.
 * Named `index-repo` (not `index`) so it doesn't shadow Node's module
 * resolution of an `index.ts` barrel file.
 *
 * Usage:
 *   npm run index -- <repo-url-or-local-path> [options]
 *
 * Options:
 *   --dump N   print N RAW rows straight from the vector store (full stored
 *              object incl. the 384-number vector) — proof of what's actually
 *              persisted, not just a count
 *
 * Examples:
 *   npm run index -- https://github.com/thalaivar-subu/telemetry-go
 *   npm run index -- https://github.com/thalaivar-subu/telemetry-go --dump 2
 */

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { indexRepo, peekIndex } from '../pipeline/ingest/04-index/index.ts';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const flagValue = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined);
  const input = a.find((x) => !x.startsWith('--') && !a[a.indexOf(x) - 1]?.startsWith('--'));
  const dump = Number(flagValue('--dump') ?? 0);

  if (!input) {
    console.error('Usage: npm run index -- <repo-url-or-local-path> [--dump N]');
    process.exit(1);
  }
  return { input, dump };
}

async function main(): Promise<void> {
  const { input, dump } = parseArgs(process.argv);

  console.log('\n── Ingest · Stage 4: Index ─────────────────────────────────────');

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  console.log(`  chunked ${chunks.length} chunks`);

  const { embeddings } = await embedChunks(chunks);
  console.log(`  embedded (dims ${embeddings[0]?.vector.length ?? 0})`);

  const result = await indexRepo(clone.repoId, chunks, embeddings);
  console.log(
    `\n  repoId ${result.repoId}  |  chunksIndexed ${result.chunksIndexed}  |  ` +
      `vectorCount ${result.vectorCount}  |  lexicalCount ${result.lexicalCount}  |  ${result.ms} ms`,
  );

  if (dump > 0) {
    const rows = await peekIndex(clone.repoId, { limit: dump });
    console.log(`\n  ── raw vector-store rows (${rows.length}) ──`);
    for (const row of rows) console.log(JSON.stringify(row, null, 2));
  }

  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Stage 4 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
