/**
 * The cross-encoder model itself — Stage 4's only ML dependency.  →  docs: ./README.md
 *
 * A bi-encoder (Stage 3's embedder) encodes the query and each chunk
 * SEPARATELY and compares vectors — fast, but it never sees them together. A
 * cross-encoder takes `(query, chunk)` as ONE input and outputs a relevance
 * score, so it models their interaction directly. That's only affordable on a
 * small shortlist (Fuse's output), not the whole corpus — see docs/DECISIONS.md #0005.
 *
 * ── MANAGED SWAP ─────────────────────────────────────────────────────────────
 * Default: in-process (this file), CPU ONNX. To use a managed reranking
 * service instead, add an adapter behind the same `scorePairs` signature and
 * wire it in `rerank.ts` via `opts.scoreFn` — no change needed anywhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  env,
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';

export const RERANK_MODEL = 'Xenova/bge-reranker-base';

/**
 * Token budget per (query, doc) pair. MEASURED (not guessed) on a real 34-candidate
 * batch, avg doc 1,275 chars but max 5,131: unpadded/untruncated (model max, 512)
 * took 9,732ms; capping to 256 took 4,397ms (2.2x) — see docs/REFACTOR-PLAN.md and
 * this stage's own README for the full measured table, including the quality
 * check against real questions before this was picked. `padding: true` alone (no
 * max_length) pads every pair in the batch to the LONGEST pair, so one oversized
 * chunk inflates every other pair's cost too — that's the actual bug, not just
 * "512 is slow".
 */
export const RERANK_MAX_TOKENS = 256;

env.cacheDir = '.cache/models';

let tokenizerPromise: Promise<PreTrainedTokenizer> | undefined;
let modelPromise: Promise<PreTrainedModel> | undefined;

function getTokenizer(): Promise<PreTrainedTokenizer> {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(RERANK_MODEL);
  return tokenizerPromise;
}

function getModel(): Promise<PreTrainedModel> {
  modelPromise ??= AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL);
  return modelPromise;
}

/**
 * Score `(query, doc)` for every doc in one batched forward pass.
 *
 * Deliberately bypasses Transformers.js's `text-classification` pipeline: this
 * model has a single output logit (a regression head, not a real multi-class
 * classifier), and the pipeline's default softmax over one logit always
 * collapses to 1.0 — discovered by actually calling it and seeing every score
 * come back identical. Going through the tokenizer/model directly and reading
 * the raw logit (then applying sigmoid ourselves, for an interpretable 0–1
 * score) is the only way to get real relevance numbers out of this model.
 */
export async function scorePairs(query: string, docs: string[]): Promise<number[]> {
  if (docs.length === 0) return [];
  const [tokenizer, model] = await Promise.all([getTokenizer(), getModel()]);
  const queries = docs.map(() => query);
  const inputs = await tokenizer(queries, {
    text_pair: docs,
    padding: 'max_length',
    truncation: true,
    max_length: RERANK_MAX_TOKENS,
  });
  const { logits } = await model(inputs);
  return Array.from(logits.data as Float32Array, (logit) => 1 / (1 + Math.exp(-logit)));
}
