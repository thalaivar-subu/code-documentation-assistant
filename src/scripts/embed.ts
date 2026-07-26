/**
 * Dev script — verify ingest Stage 3 (Embed) from the terminal.
 *
 * Clones, chunks, and embeds a source, then prints cache/model stats plus a
 * sample of embeddings. Build/verification tooling, not a product feature.
 *
 * Usage:
 *   npm run embed -- <repo-url-or-local-path> [options]
 *
 * Options:
 *   --sample N   how many embeddings to show (default 5; use 0 for all)
 *   --json       print each shown embedding as full JSON (chunkId, contentHash, vector)
 *
 * Run it twice on the same repo to see the cache in action — the second run's
 * "embedded" count drops to 0 and "cached" covers everything.
 *
 * Examples:
 *   npm run embed -- .                          # embed this repo, see the stats
 *   npm run embed -- . --sample 0                # then run again — watch cached: N
 *   npm run embed -- . --sample 3 --json          # inspect real vectors
 */

import { cloneRepo } from '../pipeline/ingest/01-clone/clone.ts';
import { chunkRepo } from '../pipeline/ingest/02-chunk/chunk.ts';
import { embedChunks } from '../pipeline/ingest/03-embed/embed.ts';
import { EMBED_MODEL } from '../pipeline/ingest/03-embed/embedder.ts';
import { parseCliArgs, usageError } from './_shared/cli.ts';

function parseArgs(argv: string[]) {
  const args = parseCliArgs(argv, ['--sample']);
  const [input] = args.positional;

  if (!input) usageError('npm run embed -- <repo-url-or-local-path> [--sample N] [--json]');
  return { input, sample: Number(args.getFlag('--sample') ?? 5), json: args.hasFlag('--json') };
}

async function main(): Promise<void> {
  const { input, sample, json } = parseArgs(process.argv);

  console.log('\n── Ingest · Stage 3: Embed ─────────────────────────────────────');
  console.log(`  model: ${EMBED_MODEL}`);

  const clone = await cloneRepo(input, { onStep: (m) => console.log(`  clone → ${m}`) });
  const { chunks } = await chunkRepo(clone);
  console.log(`  chunked ${chunks.length} chunks from ${clone.repoPath}`);

  const { embeddings, total, embedded, cached, dims, ms } = await embedChunks(chunks);

  console.log(
    `\n  total ${total}  |  embedded ${embedded}  |  cached ${cached}  |  dims ${dims}  |  ${ms} ms\n`,
  );

  const shown = sample === 0 ? embeddings : embeddings.slice(0, sample);
  for (const e of shown) {
    if (json) {
      console.log(JSON.stringify(e, null, 2));
      continue;
    }
    console.log(
      `  ${e.chunkId}  hash=${e.contentHash.slice(0, 12)}…  vector[0..3]=${e.vector.slice(0, 4).map((v) => v.toFixed(4))}`,
    );
  }
  console.log('\n────────────────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n  ✗ Stage 3 failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
