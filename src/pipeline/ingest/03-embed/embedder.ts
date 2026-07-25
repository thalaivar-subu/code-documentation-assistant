/**
 * The embedding model itself — Stage 3's only ML dependency.  →  docs: ./README.md
 *
 * Package, not a service: Transformers.js runs the ONNX model in-process on CPU.
 * ONNX Runtime already multi-threads matrix ops internally per call, so — unlike
 * Stage 2's tree-sitter parsing — this does NOT get a worker_threads pool; see
 * ../02-chunk/README.md § "Parallel chunking" for why that tradeoff differs here.
 *
 * ── MANAGED SWAP ─────────────────────────────────────────────────────────────
 * Default: in-process (this file), CPU ONNX. To use a managed embedding service
 * instead, add an adapter behind the same `embedBatch` signature and wire it in
 * `embed.ts` via `opts.embedFn` — no change needed anywhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * bge-small-en-v1.5: trained specifically for retrieval (contrastive learning on
 * query/passage pairs), consistently beats MiniLM on retrieval benchmarks at the
 * same size. Rejected: all-MiniLM-L6-v2 (general sentence similarity, not
 * retrieval-tuned — also smoke-tested, works fine, kept as the fallback below).
 */
export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIMS = 384;

env.cacheDir = '.cache/models';

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline('feature-extraction', EMBED_MODEL);
  return extractorPromise;
}

/**
 * Embed a batch of texts in one forward pass. Mean-pooled + L2-normalized, so
 * cosine similarity reduces to a plain dot product downstream (Stage 4/retrieval).
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const dims = output.dims[output.dims.length - 1];
  const data = output.data as Float32Array;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(data.slice(i * dims, (i + 1) * dims)));
  }
  return vectors;
}
