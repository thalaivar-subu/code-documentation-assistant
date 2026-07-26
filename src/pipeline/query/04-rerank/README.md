# Query · Stage 4 — Rerank

> Score Stage 3's fused candidates with a cross-encoder that reads `(query, chunk)` together,
> and keep only the shortlist that would actually reach an LLM.
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`rerankResults(repoId, query, fused, opts)` → `RerankedHit[] { ..., content, rerankScore, rrfScore, sources }`,
sorted by `rerankScore` descending, sliced to `limit` (default 8).

## Bi-encoder vs cross-encoder

|                       | Stage 3's embedder (bi-encoder)                                | This stage (cross-encoder)                                                    |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Model                 | `bge-small-en-v1.5`                                            | `bge-reranker-base`                                                           |
| Encodes               | Query and chunk **separately**, then compares vectors          | Query and chunk **together**, as one input                                    |
| Sees the interaction? | No — the vectors were computed before the query existed        | Yes — that's the whole point                                                  |
| Cost                  | Cheap enough to run over the entire corpus once, at index time | Too expensive for the whole corpus; only affordable on Fuse's small shortlist |

Full reasoning: [`docs/DECISIONS.md`](../../../../docs/DECISIONS.md) #0005.

## A real bug this stage caught: the pipeline's softmax silently breaks single-logit models

`bge-reranker-base` has **one** output logit (a regression head, not a real multi-class
classifier — it wasn't trained with distinct classes). Transformers.js's `text-classification`
pipeline applies softmax over the output dimension by default; softmax over a single value is
**always exactly 1.0**, regardless of the actual logit. Called through the normal pipeline API,
every single document — relevant or not — came back with `score: 1`. Silent, not an error.

Fixed by bypassing the pipeline: load the tokenizer + model directly
(`AutoTokenizer`/`AutoModelForSequenceClassification`), read the raw logit, and apply `sigmoid`
ourselves for an interpretable 0–1 score. Verified against real content in `reranker.ts`'s doc
comment and `rerank.test.ts`'s real-cross-encoder test.

## Content hydration

Fuse's output has no chunk `content` — it only ranks ids. This stage fetches the real text (and
`commitSha`, for future citation permalinks) for every candidate via
`vector-store.ts`'s `getVectorsByIds(db, repoId, ids)` — an id-scoped `WHERE id IN (...)` lookup,
**not** a full-table scan. A candidate whose chunk vanished from the index between Fuse and Rerank
running is dropped rather than scored on nothing — tested directly, not just assumed safe.

(Earlier versions of this stage hydrated via `04-index`'s `peekIndex` — a debug/dump-all utility
with no id filter — reused as production plumbing. Cost scaled with the _whole indexed corpus_,
not the shortlist actually needed. Fixed by adding a proper id-scoped primitive instead of
special-casing the debug utility further; `peekIndex` is back to being CLI-inspection-only.)

## Performance: the cross-encoder forward pass dominates this stage's cost

MEASURED (not guessed), on a real 34-candidate batch against this project's own indexed repo,
average doc 1,275 chars but max 5,131: with no token budget, `tokenizer(..., { padding: true,
truncation: true })` pads every pair in the batch to the **longest** pair and truncates only at
the model max (512 tokens) — one oversized chunk inflates every other pair's cost too. That one
call was **9,732ms**. Retrieve, Fuse and Expand combined cost under 50ms in the same run — Rerank
was over 99% of the pipeline's non-LLM time, and `runQueryLoop` calls it every hop.

| Variant                                  | Shape  | Time         | Speedup  |
| ---------------------------------------- | ------ | ------------ | -------- |
| No budget (previous default)             | 34×512 | 9,732 ms     | —        |
| `max_length: 256`                        | 34×256 | 4,397 ms     | 2.2×     |
| `max_length: 128`                        | 34×128 | 2,036 ms     | 4.8×     |
| Top-16 candidates, no budget             | 16×512 | 4,757 ms     | 2.0×     |
| **Top-16 + `max_length: 256`** (current) | 16×256 | **2,232 ms** | **4.4×** |

Fixed two ways, both in this stage: `reranker.ts`'s `RERANK_MAX_TOKENS` (256) bounds the token
budget per pair, and `RerankOptions.maxCandidates` (default 16) bounds how many of Fuse's
candidates reach the cross-encoder at all — cut by `rrfScore`, Fuse's own ranking, before
hydration even happens. `limit` (default 8) still controls the OUTPUT size; `maxCandidates`
controls the INPUT — different knobs, both needed, since capping only the output still pays the
full forward-pass cost on everything Fuse handed over.

Quality check before shipping this: re-ran the real question below before and after — same top
result, same relative ordering (`InstrumentProcessor` still ranks above `InitializeOTEL` despite a
lower `rrfScore`, the property the section below calls out), ~2× faster end to end.

## Example output

Against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)):

```bash
npm run rerank -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 10 --limit 6
```

```
  question   "who calls RecordTaskDuration?"
  fused candidates: 11
  reranked in 3139 ms → top 6

  rerankScore  rrfScore   symbol                    location
  0.0273       0.0328     RecordTaskDuration        telemetry/metrics.go:81-90
  0.0107       0.0159     InstrumentProcessor       telemetry/common.go:12-44
  0.0005       0.0154     RegisterMetrics           telemetry/metrics.go:29-68
  0.0001       0.0161     InitializeOTEL            telemetry/otel.go:62-112
  0.0000       0.0152     constants.go              telemetry/constants.go:1-22
  0.0000       0.0143     OtelMuxWithLogging        telemetry/middleware.go:37-43
```

The evidence that this stage does real, independent work: **`InstrumentProcessor` had a _lower_
`rrfScore` than `InitializeOTEL` (0.0159 vs 0.0161) but ends up far above it after reranking**
(0.0107 vs 0.0001) — the cross-encoder disagreed with Fuse's rank-based ordering because it
actually read the chunk content against the query, not just its retrieval rank. That's not
possible if this stage were just re-sorting Fuse's list by a different label — the scores
genuinely reflect a second, independent read of relevance. (Reranked in 3,139ms here, down from
6,480ms before the token-budget fix above — same real repo, same real question.)

## Verify

```bash
npm test -- 04-rerank                                                                                          # reordering proof, hydration, missing-chunk safety, real cross-encoder sanity check
npm run rerank -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 10 --limit 6
```

## Output feeds → Stage 5 (Expand)

`RerankedHit[]` (with real `content`) is the shortlist Stage "Expand" (`src/pipeline/query/05-expand`)
adds callers/callees to via the symbol graph — directly relevant here, since this example's actual
question ("who calls...") isn't fully answerable from reranking alone; Expand is what actually
resolves it.
