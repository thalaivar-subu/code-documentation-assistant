# Query · Stage 6 — Grade

> "Do I have enough to answer?" If not, loop back to Retrieve with what this hop learned —
> the cycle that's the entire justification for LangGraph over a plain DAG chain.
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`gradeContext(expanded, route, hopCount, opts)` → `{ sufficient, reason }`.
`runQueryLoop(repoId, question, allChunks, opts)` → `{ route, expanded, hops }` — the actual
Route → {Retrieve → Fuse → Rerank → Expand → Grade}×hops orchestration.

## No LLM, same reason as Route

Generate (Stage 7) is what will need an LLM — it doesn't exist in this project yet. So, like
Route, Grade is a handful of cheap, explainable heuristics instead of an LLM-as-judge call:

1. **Hop limit** — a hard stop (default 3) so the loop can never run forever.
2. **Nothing found** — zero candidates is never sufficient.
3. **Confidence** — the best rerank score must clear a threshold (default `0.01`).
4. **`trace` questions specifically need graph edges** — finding the named function isn't enough
   if the question was about its callers; Stage 5 (Expand) must have found at least one edge.

Revisit once Generate's LLM adapter exists — an LLM judging its own upcoming context is a natural
place to actually spend a model call, once one is available.

## The loop is hand-rolled, not LangGraph — for now

[`docs/DECISIONS.md`](../../../../docs/DECISIONS.md) #0006 justifies LangGraph.js specifically
because this control flow is a **cycle**, which a plain DAG/chain can't express — and it also
states the honest caveat: reaching for LangGraph on a genuinely single-shot flow would be
over-engineering. With no Generate stage yet to consume this loop's output (no token streaming,
no checkpointing need), `runQueryLoop` is a plain `for`/`await` loop instead. Swapping it for a
real LangGraph state machine is the natural next step once Generate needs those things too — same
"smallest tool for the current need" judgment call Route made about not using an LLM yet.

## What makes hop 2 different from hop 1

The loop doesn't just retry the same query — it folds newly-discovered caller/callee symbol names
(from Stage 5's `via: 'caller' | 'callee'` hits) into the next hop's query text. This is the
concrete version of the "you don't know hop 2 until hop 1 returns" argument: hop 2 searches for
something hop 1 had no way to know about in advance.

## Example output — a real 2-hop run

Against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)), a deliberately
under-specified question (small `--k`/`--limit` to weaken hop 0's initial coverage):

```bash
npm run grade -- https://github.com/thalaivar-subu/telemetry-go "who triggers newPropagator internally?" --max-hops 3 --k 2 --limit 1
```

```
  question   "who triggers newPropagator internally?"
  intent     symbol

  hop 0  query="who triggers newPropagator internally?"
         insufficient — looping — best rerank score (0.0055) is below the confidence threshold (0.01)
  hop 1  query="who triggers newPropagator internally? initSdk newResource newPropagator"
         sufficient — confident top match

  final context (4 chunks):
    [rerank ] InitializeOTEL           telemetry/otel.go:62-112
    [caller ] initSdk                  telemetry/otel.go:49-58
    [callee ] newResource              telemetry/otel.go:114-124
    [callee ] newPropagator            telemetry/otel.go:126-131
```

Hop 0's low-confidence match still ran Expand, which found `initSdk`/`newResource`/`newPropagator`
as related symbols — those get folded into hop 1's query, which then retrieves `InitializeOTEL`
(the function that actually ties them together) with real confidence. Note also: on typical,
well-specified questions (e.g. `"who calls RecordTaskDuration?"` with default `--k`/`--limit`),
the loop resolves in a **single** hop — that's the common, correct case, not a failure to loop;
see `query-loop.test.ts` for a synthetic scenario that forces and proves the multi-hop path
deterministically (rather than depending on a real repo's specific embedding scores).

## Verify

```bash
npm test -- 06-grade                                                                                            # grading heuristics (8 cases) + real 2-store multi-hop termination proof
npm run grade -- https://github.com/thalaivar-subu/telemetry-go "who triggers newPropagator internally?" --max-hops 3 --k 2 --limit 1
```

## Output feeds → Stage 7 (Generate)

`QueryLoopResult.expanded` is the final context set Stage "Generate"
(`src/pipeline/query/07-generate`, not built yet — needs an LLM adapter that doesn't exist in this
project yet either) will turn into a cited answer.
