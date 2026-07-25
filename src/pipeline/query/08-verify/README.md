# Query · Stage 8 — Verify

> Resolve every citation the model produced against the context it was actually given —
> pure code, no ML, the last stage in the query pipeline.
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`verifyCitations(citations, context)` → `{ checks, resolvedCount, totalCount, resolutionRate, hasCitations }`.
`answerQuestion(repoId, question, allChunks, opts)` → the **whole query pipeline**, Route through
Verify, in one call — `{ route, expanded, hops, answer, citations, verify }`.

## What "resolve" actually means

Not "is this a real `file:line` somewhere in the repo" — a model can plausibly guess a real symbol
name it was never shown, which would pass that check while still being ungrounded. The real
faithfulness test, per [`docs/DECISIONS.md`](../../../../docs/DECISIONS.md) #0010, is: **did the
model cite something it was actually handed** — resolved against `loop.expanded` (the exact context
in the prompt), not the full repo index. A citation whose line range _overlaps_ (not necessarily
matches exactly) a context chunk's real range counts — the model transcribing `82-85` for a chunk
that's actually `81-90` is imprecision, not hallucination; a citation for a file/range that was
never in context is the real signal.

## The real demonstration: Verify catching the exact gap Stage 7 documented

Stage 7's README was explicit: this small local model frequently gives factually-correct answers
with **zero** citations, and said this is exactly what Verify exists to catch. Running the full
pipeline end-to-end confirms it, twice — once with a large (18-chunk) context, once with a
deliberately small, focused (4-chunk) one. Neither produced a parseable citation. **Verify doesn't
paper over this — it surfaces it:**

```bash
npm run ask -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --max-tokens 200
```

```
  question   "who calls RecordTaskDuration?"
  ── answer (streaming) ──

The function `RecordTaskDuration` is called by the `InstrumentProcessor` function.

  intent      trace
  hops        1
  citations   0 found, 0 resolved
  ⚠ the answer cited nothing — nothing to verify, treat with more skepticism
```

The answer is factually correct (confirmed against the real source in Stage 7's README) — but
without Verify, a UI would have no principled way to distinguish this from a confident-sounding
hallucination. `hasCitations: false` is a real, actionable signal a caller can act on (show a
"unverified" badge, trigger a stricter regeneration, fall back to showing raw retrieved chunks
instead of prose) — silently trusting fluent-sounding prose is exactly what this stage exists to
prevent.

## Proving the resolve/hallucination distinction itself

Since this model doesn't reliably produce parseable citations to demonstrate against on a real
repo, the actual resolution _mechanism_ — the part Stage 8 is really responsible for — is proven
directly in `verify.test.ts` and `answer.test.ts` with constructed citations:

| Case                                                                | Result                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Citation exactly matches a context chunk                            | resolved                                                         |
| Citation's range overlaps but isn't identical (model imprecision)   | resolved                                                         |
| Real file, but a line range nowhere in the given context            | **not** resolved                                                 |
| A file that was never in context at all (a plausible-looking guess) | **not** resolved                                                 |
| Answer cites nothing                                                | `hasCitations: false` — a distinct signal from "resolved 0 of 0" |

`answer.test.ts`'s hallucination test is the sharpest one: a fake `generateFn` returns a citation
for a file (`b.ts:99-105`) that was never part of the indexed/retrieved context at all —
`resolvedCount` correctly comes back `0`, proving the check isn't just "does this look like a
citation," it's "was this actually shown to the model."

## Verify

```bash
npm test -- 08-verify                                                                              # resolution logic (7 cases) + full pipeline wiring incl. the hallucination case
npm run ask -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --max-tokens 200
```

## This closes the query pipeline

`answerQuestion` is Route → Retrieve → Fuse → Rerank → Expand → Grade → Generate → Verify, all 8
stages, in one function call. Combined with the ingest pipeline (Clone → Chunk → Embed → Index),
this is the full RAG system described in the original architecture — everything except a UI, which
was always the last piece per the project's own working agreement.
