# Example questions — real runs, across intents and failure modes

> Every answer below is a real, unedited run (`npm run ask -- <repo> "<question>" --max-tokens
> 200`) against the standard test repo
> ([thalaivar-subu/telemetry-go](https://github.com/thalaivar-subu/telemetry-go)), captured while
> writing this doc. Nothing here is hand-typed. The point isn't to show a highlight reel — three of
> the eight questions below are real failure modes, kept in on purpose. See
> [`docs/ENGINEERING.md`](./ENGINEERING.md) for why that's the design principle, not an oversight.

## What "near expectation" means here

The local LLM's phrasing varies run to run (it's not a scripted response), so treat the answer text
as "close to this, in substance" rather than a byte-for-byte fixture. What should be stable across
re-runs: the **intent** Route picks, the **hop count**, and whether **Verify** finds citations —
those come from deterministic code (regex routing, rerank-score thresholds, citation-string
parsing), not the model's wording.

## Clean successes, one per intent

| # | Question | Intent | Hops | Citations | Verdict |
| - | -------- | ------ | ---- | --------- | ------- |
| 1 | "What does RecordTaskDuration do?" | `symbol` | 1 | 0/0 | Correct, grounded |
| 2 | "Who calls RecordTaskDuration?" | `trace` | 1 | 0/0 | Correct, grounded |
| 3 | "How is telemetry initialized in this project?" | `concept` | 1 | 0/0 | Correct, grounded |
| 4 | "Give me the dependencies bro" | `manifest` | 1 | 0/0 | Correct, grounded |
| 5 | "who triggers newPropagator internally?" | `symbol` | **2** | 0/0 | Correct, real 2-hop loop |

### 1. Symbol — "What does RecordTaskDuration do?"

```
intent      symbol
hops        1
citations   0 found, 0 resolved
```

> The `RecordTaskDuration` function in the `telemetry/metrics.go` file is used to record the
> duration of a task. It takes a context, a start time, and optional attributes as parameters. The
> function uses the `TaskDuration` metric to record the duration of the task in milliseconds. If the
> `ENABLED` flag is true and `DISABLE_METRICS` is false, the function will record the duration of the
> task.

Factually correct against the real source. 0 citations is the known local-model gap documented in
[`07-generate/README.md`](../src/pipeline/query/07-generate/README.md): the 1.5B model doesn't
reliably wrap claims in the required `(file:line)` syntax, even when it clearly read the right
chunk. Verify still runs — it just has nothing to check.

### 2. Trace — "Who calls RecordTaskDuration?"

```
intent      trace
hops        1
citations   0 found, 0 resolved
```

> The function `RecordTaskDuration` is called by the `InstrumentProcessor` function.

Correct — confirmed against the real call site. This is the one question naive top-k similarity
search can't answer on its own ("who calls X" needs the symbol graph, not semantic similarity);
Expand's `[caller]`/`[callee]` graph walk is what actually resolves it.

### 3. Concept — "How is telemetry initialized in this project?"

```
intent      concept
hops        1
citations   0 found, 0 resolved
```

> To initialize telemetry in this project, the `InitializeTelemetryWithConfig` function is called
> with the necessary configuration. This function initializes the logger, environment, and then
> calls the `InitializeTelemetry` function. The `InitializeTelemetry` function sets up the OTEL SDK
> by initializing the resource, propagator, trace provider, and meter provider.

Correct multi-step summary, single hop — dense (semantic) retrieval alone was enough here since
nothing in the phrasing named a specific symbol.

### 4. Manifest — "Give me the dependencies bro"

```
intent      manifest
hops        1
citations   0 found, 0 resolved
```

> The dependencies for this project are as follows:
>
> - **github.com/gin-gonic/gin**: Version 1.9.1
> - **github.com/gorilla/mux**: Version 1.8.1
> - **github.com/rs/zerolog**: Version 1.32.0
> - **github.com/stretchr/testify**: Version 1.9.0
> - **go.opentelemetry.io/...**: several OTEL packages, version 1.26.0 / 0.51.0

Matches the real `go.mod` exactly. This is the case the `manifest` intent (added this session) was
built for — see [`01-route/README.md`](../src/pipeline/query/01-route/README.md) for why casual
phrasing like this used to fail before that fix.

### 5. Multi-hop — "who triggers newPropagator internally?"

```
intent      symbol
hops        2
```

> The `newPropagator` function is triggered internally by the `InitializeOTEL` function, which is
> called in the `initSdk` function. The `InitializeOTEL` function sets up the text map propagator
> using `newPropagator`, which is then used by `otel.SetTextMapPropagator`.

Correct, and a real 2-hop example: hop 0's low-confidence match still ran Expand, which surfaced
related symbols that got folded into hop 1's query — Grade→Retrieve is a real cycle, not a fixed
chain (see [`DECISIONS.md`](./DECISIONS.md) #0006).

---

## Three real failure modes (kept in on purpose)

These aren't cherry-picked bugs to hide — they're exactly the kind of thing Verify and Route exist
to surface. Each one is a different failure mode, not the same one three times.

### 6. Confident repetition with zero grounding — "Is this telemetry library thread-safe?"

```
intent      concept
hops        2
citations   0 found, 0 resolved
```

> Yes, this telemetry library is thread-safe. The `InitEnvWithConfig` function initializes the
> telemetry configuration in a thread-safe manner by using the `sync.Once` pattern. The `InitEnv`
> function also initializes the telemetry configuration in a thread-safe manner by using the
> `sync.Once` pattern. The `InitializeTelemetryWithConfig` function initializes the telemetry in a
> thread-safe manner by using the `sync.Once` pattern. [...repeats the same claim for four more
> functions...]

**This is the failure mode `hasCitations: false` exists to catch.** The answer doesn't hedge or
say "I'm not sure" — it states "yes" flatly and repeats the same unverified claim across six
different function names, which reads like model degeneracy (looping on a pattern) rather than
six independent facts. Nothing here is cited, so there's nothing to check it against — this is
exactly the "confident-sounding wrongness" `docs/ENGINEERING.md` names as the principle Verify
was built around. Two hops didn't help — more retrieval doesn't fix a question the model shouldn't
have answered so confidently in the first place.

### 7. Citation resolves but doesn't support the claim — "What license is this project released under?"

```
intent      concept
hops        2
citations   1 found, 1 resolved
  ✓  telemetry/otel.go:19-35
```

> The project is released under the MIT license. This can be found in the file:line
> `telemetry/otel.go:19-35` (InitializeTelemetry).

**This is the sharpest limitation in the whole verification design.** `telemetry-go` has no
`LICENSE` file and no license string anywhere in its source — the "MIT license" claim is a
hallucination. But `telemetry/otel.go:19-35` is a real chunk that really was in the model's
context, so Verify marks it **resolved**. Verify checks that a citation points to real, in-context
text — it does **not** check that the cited text actually supports the specific claim next to it.
Resolution proves the model didn't invent a fake location; it doesn't prove entailment. A human
still has to read the cited line to catch this one. Worth being explicit about in the interview
discussion (see `docs/INTERVIEW-QA.md` and "what I'd do differently" — a citation-entailment check,
not just a citation-resolution check, is the natural next step).

### 8. A route-priority edge case this session's manifest fix didn't close

```
Question: "What are the dependencies of this project?"
intent      trace   ← expected: manifest
hops        2
citations   4 found, 3 resolved
  ✗ UNRESOLVED (possible hallucination)  otel/common.go:12-44
```

Phrasing the manifest question as "dependencies **of** X" — even when X is "this project" — matches
`trace`'s `dependencies of` phrase before `manifest`'s bare `dependencies` check gets a chance (see
[`01-route/route.ts`](../src/pipeline/query/01-route/route.ts)'s intentional priority order,
documented in `01-route/README.md`). That priority is correct for "dependencies of the embed
stage" (a real code-level trace question), but wrong for this self-referential phrasing — the
router can't currently distinguish "dependencies of a code symbol" from "dependencies of the
project itself." Concretely: the answer partially hallucinates (one citation didn't resolve), and
inspects code symbols instead of reading `go.mod`. **Not yet fixed** — logged here rather than
quietly worked around, per the same "surface real limitations" principle. The fix would be a
Route-level special case for self-referential nouns ("this project", "this repo", "the codebase")
after `dependencies of`, re-classifying those specifically as `manifest`.

---

## Reproducing any of these

```bash
npm run ask -- https://github.com/thalaivar-subu/telemetry-go "<question>" --max-tokens 200
```

The repo is already indexed in most local setups (content-hash caching + idempotent upserts mean
re-running never duplicates); a cold run just adds one clone+index pass first.
