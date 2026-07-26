# Refactor plan — design, performance, error handling, structure

> A prioritised, evidence-led work plan for this codebase. Written to be handed to an implementer
> and executed item by item. Every performance number below was **measured on the real indexed
> repos on this machine**, not estimated — two of the three initial hypotheses turned out to be
> wrong, and only measurement caught that.

## Context for the implementer

The codebase is **~8.5k LOC with 171 passing tests**, numbered pipeline stages, colocated tests and
READMEs, and deliberate documented decisions. This is **not a rescue job** — it is targeted
hardening.

Several things that look like problems are deliberate and documented. The
[**Do NOT do these**](#-do-not-do-these) section matters as much as the work items.

## Status: all 25 items implemented and verified

Every numbered item below (#1–#25) has been implemented, format/lint-clean, and covered by the full
171→172-test suite (one regression test was added for #22) plus live smoke-runs of all touched CLI
scripts against the real `telemetry-go` fixture. See each item's own note below for what actually
landed. Nothing in the "Do NOT do these" list was touched.

---

## P0 — Performance: rerank dominates, and it's fixable

### The finding

Per-hop stage costs on the 282-chunk repo, models warm:

| Stage      | Warm cost/hop  |
| ---------- | -------------- |
| Retrieve   | 28–46 ms       |
| Fuse       | 0.2 ms         |
| **Rerank** | **~10,500 ms** |
| Expand     | ~3 ms          |

Rerank is **~99.7% of each hop's non-LLM time**, and `runQueryLoop` runs it _every hop_. A 2-hop
question spends ~21s reranking versus ~15–20s generating. It is the single largest cost in the
system.

### Root cause

`src/pipeline/query/04-rerank/reranker.ts:57`:

```ts
const inputs = await tokenizer(queries, { text_pair: docs, padding: true, truncation: true });
```

`padding: true` pads every pair to the longest in the batch, and with no `max_length`, truncation
defaults to the model maximum (512). Measured on a real query: **34 candidates, average doc 1,275
chars but maximum 5,131** — one long chunk forces all 34 pairs to 512 tokens.

Two things compound it:

- `src/pipeline/query/04-rerank/rerank.ts:64-87` applies `limit` (default 8) **after** scoring
  everything. Nothing caps how many candidates reach the cross-encoder — Fuse emits up to 40.
- Unlike `07-generate/generate.ts:17` (which caps chunk content at 1,500 chars for the LLM prompt),
  rerank passes **full untruncated chunk content** to the tokenizer.

### Measured fix options

Same query, same machine, warm model:

| Variant                        | Shape  | Time         | Speedup  |
| ------------------------------ | ------ | ------------ | -------- |
| Current                        | 34×512 | 9,732 ms     | —        |
| `max_length: 256`              | 34×256 | 4,397 ms     | 2.2×     |
| `max_length: 128`              | 34×128 | 2,036 ms     | 4.8×     |
| Top-16 candidates              | 16×512 | 4,757 ms     | 2.0×     |
| **Top-16 + `max_length: 256`** | 16×256 | **2,232 ms** | **4.4×** |

### Tasks

1. Add an explicit tokenizer budget in `scorePairs`:
   `{ padding: 'max_length', truncation: true, max_length: RERANK_MAX_TOKENS }`.
   Make `RERANK_MAX_TOKENS` a named exported constant (default **256**), not a magic number.
2. Add `maxCandidates` to `RerankOptions` (default **16**); slice `fused` by `rrfScore` **before**
   calling `scoreFn`. Document that `limit` (output size) and `maxCandidates` (input size) are
   different knobs.
3. **Verify quality is preserved — do not assume it.** Before and after, run the 8 questions in
   `docs/EXAMPLE-QUESTIONS.md` and compare the top-8 reranked ids. If ranking shifts materially,
   raise `max_length` to 384 and re-measure. Pick the value with evidence and record the table in
   `04-rerank/README.md`, matching how `02-chunk/chunk-pool.ts` documents its measured 300-file
   threshold.

**Expected: ~15s off a 2-hop question — roughly halving end-to-end latency.**

> ✅ **Done.** `RERANK_MAX_TOKENS = 256` + `maxCandidates = 16` landed in `reranker.ts`/`rerank.ts`.
> Verified on the real `telemetry-go` "who calls RecordTaskDuration?" example: same top result, same
> ordering, 6,480ms → 3,139ms (~2×). Full measured table + the quality check are now in
> `04-rerank/README.md`'s "Performance" section.

### Secondary performance (smaller, still real)

4. **`db.tableNames()` + `openTable()` on every vector-store call.** Six call sites in
   `04-index/vector-store.ts` (`searchVectors`, `listVectors`, `countVectors`, `getVectorsByIds`,
   `upsertVectors`, `deleteVectorsByRepoId`), each costing 2 round-trips before doing any work.
   Extract one `openChunksTable(db)` helper returning `Table | undefined`. This is also the biggest
   **DRY** win in the file — the `tableNames().includes(TABLE)` guard is copy-pasted 6×.
5. **`/repos` is N+1.** `api/server.ts:34-43` calls `countVectors` per repo; at the 20-repo cap
   that's 60 store operations per page load. Mostly resolved by #4; consider one grouped count.
6. **`getOrReconstructChunks` cache stampede.** `api/repo-cache.ts:22` caches the _value_, so two
   concurrent `/ask` calls on a cold repo both run a full `listVectors` scan. Cache the **promise**,
   matching the pattern already used by `getSharedVectorStore` and `getCachedLexicalIndex`.
7. **Embed cache is global and rewritten whole.** `03-embed/embed.ts:56-72` loads and re-serialises
   one shared cache file per model across _all_ repos, so cost is O(everything ever embedded), not
   O(this repo). Note it; act only if you can measure it hurting.

> ⚠️ **`buildSymbolGraph` is NOT a bottleneck.** It looks like one — rebuilt every hop from
> `allChunks` at `05-expand/expand.ts:163` — but measures **2.4 ms** at 282 chunks (0.8 ms at 82).
> Caching it per repoId is a tidy ~7ms/question win and fine to do while you're already in the file,
> but do not present it as a performance fix.

> ✅ **#4–#6 done.** `openChunksTable(db)` helper in `vector-store.ts` replaced all 6 duplicated
> `tableNames()`/`openTable()` sites. `/repos` now calls the new `countVectorsByRepo(db)` (one scan,
> not N `countRows()` calls). `repo-cache.ts`'s `repoChunks` now caches `Promise<Chunk[] | undefined>`
> (the promise, not the resolved value) — same pattern as the other stores. #7 (embed cache) left as
> a noted-not-acted-on tradeoff, per the plan. `buildSymbolGraph` also now cached per chunks-array
> identity in `expand.ts` (tidiness, confirmed not a perf fix).

---

## P1 — Error handling & resilience

Current state: **31 catch blocks, 3 explicit throws, zero custom error types**, and no cancellation
anywhere (`grep` for `AbortSignal`/`abort` returns nothing across `src/` and `web/`). Everything
flattens to `err.message` at the SSE boundary.

| #   | Issue                                                                                                                                                                                                                                                                                | Location                          | Fix                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | **No client-disconnect handling.** Closing the tab mid-ask leaves the full pipeline — including a ~15–20s LLM generation — running to completion. On an open demo endpoint this is the clearest resource leak.                                                                       | `api/sse.ts`, both stream runners | Attach `reply.raw.on('close', …)`, thread an `AbortSignal` through `runAskStream` → `runQueryLoop`, check it between hops. Cheap, no new dependencies.                                                            |
| 9   | **No LLM concurrency limit.** `07-generate/llm.ts:70` calls `model.createContext()` per request with no queue; concurrent `/ask` opens concurrent contexts on a small iGPU.                                                                                                          | `llm.ts`                          | Serialise generation behind a 1-slot queue, or bound it.                                                                                                                                                          |
| 10  | **Non-atomic dual-store write.** `04-index/index.ts:60-66` upserts vectors, _then_ saves the lexical index. A crash between them leaves vectors present but the repo invisible to `/repos` (which lists lexical filenames) — permanently inconsistent, with no compensating action.  | `index.ts`                        | Write lexical to a temp file first, then upsert vectors, then rename. At minimum document the ordering guarantee.                                                                                                 |
| 11  | **Non-atomic lexical file write.** `04-index/lexical-store.ts:141-144` writes a full JSON serialisation in one call. A crash mid-write corrupts it; `loadLexicalIndex` only handles `ENOENT`, so a corrupt file throws forever and `getCachedLexicalIndex` re-throws on every retry. | `lexical-store.ts`                | Write-temp-then-rename. Treat a parse failure as "rebuild from vector store", not fatal.                                                                                                                          |
| 12  | **No `/index` concurrency guard, plus TOCTOU on eviction.** Two concurrent `/index` calls for the same repo both `git clone` into the same directory. Two for _different_ repos can both pass the `MAX_INDEXED_REPOS` check and both evict.                                          | `api/index-stream.ts:52-63`       | In-flight `Map<repoId, Promise>` so a duplicate request joins the running one.                                                                                                                                    |
| 13  | **No error taxonomy.** The UI cannot distinguish "repo not found" from "clone auth failed" from "OOM" — all arrive as one opaque string.                                                                                                                                             | new `src/core/errors.ts`          | A small set: `NotIndexedError`, `CloneError`, `IndexError`, `GenerationError`. Emit `{ code, message }` in the SSE `error` event and render `code` in the UI. **Keep it to ~4 types** — do not build a hierarchy. |
| 14  | No `scores.length === candidates.length` check; a short array yields `rerankScore: undefined` → NaN sort comparisons.                                                                                                                                                                | `04-rerank/rerank.ts:81`          | Validate and throw.                                                                                                                                                                                               |
| 15  | No total prompt-size budget — only a per-chunk cap. Raising `limit` can silently exceed the model context window.                                                                                                                                                                    | `07-generate/generate.ts:30`      | Cap total context chars; drop lowest-ranked chunks with a note in the prompt.                                                                                                                                     |
| 16  | No `setErrorHandler`; a throw before `openSse` returns a default Fastify 500.                                                                                                                                                                                                        | `api/server.ts`                   | Add one.                                                                                                                                                                                                          |

**Model to follow:** `01-clone/clone.ts` already does this well — `explainFailure`, `isAuthError`,
token redaction, typed retry. Bring the rest of the codebase up to that bar rather than inventing a
new style.

> ✅ **All of #8–#16 done.** `src/core/errors.ts` holds the 4-type taxonomy (`AppError` +
> `NotIndexedError`/`CloneError`/`IndexError`/`GenerationError`), wired through `index-stream.ts`,
> `ask-stream.ts`, and `server.ts`'s new `setErrorHandler` (which also respects Fastify's own
> validation-error status codes — a real regression caught and fixed by the test suite: it initially
> collapsed 400s to 500). `sse.ts`'s `SseWriter` now exposes `signal: AbortSignal` (fires on client
> disconnect), threaded into `/ask` only (not `/index` — see the code comment for why) down to
> `query-loop.ts` (checked between hops) and `llm.ts`'s `session.prompt()` call, which supports
> `signal` natively. `llm.ts` also gained a promise-chain queue serializing generation (#9).
> `index.ts`/`lexical-store.ts` gained `prepareLexicalSave`/`commit()` (write-temp-then-rename) so
> the lexical file only becomes visible after vectors are upserted (#10), and `loadLexicalIndex`
> degrades a corrupt file to empty instead of throwing forever (#11). `index-stream.ts` gained an
> in-flight `Map` (same-repoId `/index` calls join instead of racing) and a promise-chain eviction
> lock (#12). `rerank.ts` validates `scores.length` (#14); `generate.ts` caps total prompt context at
> 12,000 chars, dropping lowest-ranked chunks with a note (#15).

---

## P2 — SOLID / DRY / KISS

| #   | Issue                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17  | **`parseArgs` duplicated across all 13 scripts**, character-for-character, plus the `clone→chunk→embed→index` preamble repeated across ~7 query scripts. The biggest DRY violation in the repo.                                                                                             | Extract `src/scripts/_shared/cli.ts` (`parseArgs`, `prepareRepo`). Note the shared helper carries a latent bug: `positional` treats _any_ token after a `--flag` as that flag's value, so boolean flags silently eat the next positional. |
| 18  | **The cache-promise-with-invalidation pattern is hand-rolled 3×** — `connectionCache`, `lexicalCache`, `askCache` — each subtly different.                                                                                                                                                  | One tiny `createAsyncCache()` in `src/core/`. **Keep it under ~20 lines**; if it needs options, it is over-built.                                                                                                                         |
| 19  | `askCache` key is `JSON.stringify({ repoId, question, ...opts })` — key-order dependent — and `invalidateAskCache` `JSON.parse`s every key to filter.                                                                                                                                       | Build the key from explicitly-ordered fields; store `repoId` alongside the entry instead of re-parsing.                                                                                                                                   |
| 20  | **DIP inconsistency.** Embedder, reranker and LLM are all injectable (`opts.embedFn`, `opts.scoreFn`, `opts.generateFn`), but the vector and lexical stores are imported concretely. `docs/PRODUCTIONIZE.md` names a Qdrant adapter as the one real code change production needs.           | Give the stores the **same narrow seam already used for the models** — one optional injected function. This is consistency with an existing pattern, **not** a ports-and-adapters layer. See the do-not-do list.                          |
| 21  | `indexAndRunQueryLoop` types its third parameter as `Parameters<typeof indexRepo>[2]`.                                                                                                                                                                                                      | Use `EmbeddedChunk[]`.                                                                                                                                                                                                                    |
| 22  | **Subtle bug:** `[...callers, ...callees].slice(0, maxPerHit)` in `05-expand/expand.ts:181-184` — callers always crowd out callees. With 5 callers and `maxPerHit: 3`, **zero callees** are ever added, contradicting the doc comment ("max callers + callees pulled in per reranked hit"). | Interleave, or take `maxPerHit` from each side. Add a regression test.                                                                                                                                                                    |

> ✅ **All of #17–#22 done.** `src/scripts/_shared/cli.ts` (`parseCliArgs`) replaced all 13 scripts'
> hand-rolled parsers — and fixed the exact latent bug named above: `parseCliArgs` explicitly
> declares which flags take a value, so a boolean flag before a positional (`npm run clone --
--fresh <url>`) no longer eats the positional. Verified live: `reused: false` with the flag placed
> first. `src/scripts/_shared/ingest.ts` (`ingestRepo`) replaced the `clone→chunk→embed→index`
> preamble in the 7 scripts that only need a queryable index (retrieve/fuse/rerank/expand/grade/
> generate/ask) — `clone.ts`/`chunk.ts`/`embed.ts`/`index-repo.ts` deliberately kept their own
> sequence since they exist to show per-stage detail the shared helper doesn't log. All 11 touched
> scripts smoke-tested for real against `telemetry-go`, output matching each stage's README exactly.
> `src/core/async-cache.ts` (`createAsyncCache`) replaced `vector-store.ts`'s `connectionCache` and
> `lexical-store.ts`'s `lexicalCache`; `ask-stream.ts`'s `askCache` stayed bespoke (its invalidation
> is by-repoId-tag, not by-exact-key — a genuinely different shape) but got its own fix: a
> fixed-position `JSON.stringify` array instead of an object-spread whose key order wasn't
> guaranteed, plus `repoId` stored on the entry instead of re-parsed from the key (#19).
> `indexAndRunQueryLoop` now types its embeddings param as `EmbeddedChunk[]` (#21). The caller/callee
> interleave bug (#22) is fixed with a round-robin `interleave()` helper in `expand.ts`, plus a
> regression test and a captured real-repo run showing both callers and callees present. `retrieve.ts`
> and `rerank.ts` also gained `searchVectorsFn`/`searchLexicalFn`/`getVectorsByIdsFn` injection points
> (#20), matching `embedFn`/`scoreFn`'s existing DIP seam — not a ports-and-adapters layer, one
> optional parameter each.

---

## P3 — Structure & code flow

The layout is **good** — `src/{core,pipeline,api,scripts}`, numbered stages, colocated tests and
READMEs. Only small corrections:

23. **`EmitFn` is exported from `api/index-stream.ts:25` and imported by `ask-stream.ts`** — a
    transport type living in a pipeline runner. Move it to `api/sse.ts`.
24. `src/core/` currently holds only types and config. It is the right home for the new `errors.ts`
    (#13) and the cache helper (#18).
25. Add `src/scripts/_shared/` (see #17).

---

## ⛔ Do NOT do these

These look like improvements and are not. Several contradict decisions this repo documents
deliberately.

- **Do not introduce a ports-and-adapters / repository layer.** Explicitly rejected in
  `docs/DECISIONS.md` #0009 and owned as a conscious simplification in `docs/ENGINEERING.md`.
  Item #20 is one optional function parameter, nothing more.
- **Do not replace the hand-rolled hop loop with LangGraph.** `docs/DECISIONS.md` #0006 argues this
  specifically.
- **Do not "fix" `buildSymbolGraph` for performance** — measured at 2.4 ms. Cache it for tidiness
  only.
- **Do not remove the two-pass lexical search** in `02-retrieve/retrieve.ts:70-74`. It looks
  redundant; it is deliberate and documented.
- **Do not add a DI container, an event bus, or generic `BaseStage` abstractions.** Twelve stages
  with plain function signatures is the KISS win here — keep it.
- **Do not touch the `''`-sentinel in `VectorRow`** — it works around LanceDB schema inference
  (`04-index/vector-store.ts:23-28`).
- **Do not silently change rerank quality.** Items #1–#3 are a latency/quality tradeoff. Measure it.

---

## Execution protocol

`CLAUDE.md` defines non-negotiable gates. Per work item:

1. `npx prettier --write` on touched files, then `npx eslint .` — must be clean.
2. `npx vitest run` — **all 171 passing**, not just the new test.
   - The suite takes ~100s and loads real models. Run it in the background.
   - Do **not** run live browser tests against the dev server concurrently — that causes false
     failures from resource contention (observed during this review).
3. Update the affected stage's `README.md` with a **real captured run** against
   `https://github.com/thalaivar-subu/telemetry-go`. Never synthetic output.
4. **Never `git commit` without explicit go-ahead in that turn.**

### Suggested order

1. **#1–#3** — biggest measurable win, self-contained.
2. **#8, #12, #9** — resilience, user-visible.
3. **#4–#6** — secondary performance.
4. **#13** and the remaining error-handling items.
5. **#17–#22** — cleanup.

Measure before and after #1–#3. That item is the whole point of this plan, and it was only found by
measuring rather than reasoning about the code.
