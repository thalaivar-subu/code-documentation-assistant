# Query · Stage 3 — Fuse

> Merge Stage 2's two independently-ranked candidate lists (dense, lexical) into one, using
> Reciprocal Rank Fusion. Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`fuseResults(vector, lexical, opts)` → `FusedHit[] { id, filePath, symbolName, startLine, endLine, rrfScore, sources }`.

## Why rank position, not raw score

|         |                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem | A vector hit's distance (e.g. `0.51`, lower = better) and a lexical hit's score (e.g. `13.8`, higher = better, unbounded) live on incomparable scales — there's no principled way to average them directly |
| Fix     | Reciprocal Rank Fusion scores by **position in each list**, not the raw number: `score(doc) = Σ 1 / (k + rank_i(doc))`, summed over every list the doc appears in                                          |
| `k`     | `60` (this stage's default) — a larger `k` flattens the gap between rank 1 and rank 10; proven in `fuse.test.ts`                                                                                           |

No tunable weights, ~15 lines, nothing to overfit. Full reasoning: [`docs/DECISIONS.md`](../../../../docs/DECISIONS.md) #0004.

## What a fused hit actually looks like

A chunk that appears in **both** lists — even at a modest rank in each — outranks a chunk that's
`#1` in only one list. This is the entire point of hybrid retrieval, made visible via `sources`:

```
rank 1 in vector AND lexical  →  1/(60+1) + 1/(60+1) = 2/61 ≈ 0.03279
rank 1 in vector ONLY         →  1/(60+1)             = 1/61 ≈ 0.01639
```

Proven with the exact numbers in `fuse.test.ts`, and for real below.

## Example output

Against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)):

```bash
npm run fuse -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 5
```

```
  question   "who calls RecordTaskDuration?"
  intent     trace
  candidates vector=5  lexical=2

  fused ranking (top 5)
    0.03279  [vector+lexical]  RecordTaskDuration       telemetry/metrics.go:81-90
    0.01613  [vector      ]  IncTaskCounter           telemetry/metrics.go:70-79
    0.01613  [lexical     ]  InitializeOTEL           telemetry/otel.go:62-112
    0.01587  [vector      ]  InstrumentProcessor      telemetry/common.go:12-44
    0.01563  [vector      ]  InitLogger               telemetry/utils.go:16-26
```

`RecordTaskDuration` is rank 1 in **both** input lists (see Stage 2's own README), so its fused
score is exactly `2/61 ≈ 0.03279` — matching the hand-computed case above, not a coincidence.

## Verify

```bash
npm test -- 03-fuse                                                                                      # RRF math, tie-breaking, sort correctness, empty inputs, k behavior
npm run fuse -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 5     # real repo, real fused ranking
```

## Output feeds → Stage 4 (Rerank)

`FusedHit[]` (still missing `content` for lexical-only hits — Fuse only ranks, it doesn't hydrate)
is the candidate set Stage "Rerank" (`src/pipeline/query/04-rerank`, not built yet) will score with
a cross-encoder before shortlisting to the final ~8 chunks that reach the LLM.
