# Query · Stage 5 — Expand

> Pull in a reranked hit's likely callers/callees via a symbol graph, before generation —
> the stage that finally answers "who calls X?" instead of just finding X itself.
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`expandResults(allChunks, reranked, opts)` → `ExpandedHit[]` — every reranked hit (`via: 'rerank'`)
plus up to `maxTotal` (default 10) chunks pulled in via the graph (`via: 'caller' | 'callee'`),
capped at `maxPerHit` (default 3) per reranked hit. When `opts.intent === 'manifest'` (Route's
4th intent — see [`01-route/README.md`](../01-route/README.md)), also adds every dependency-manifest
chunk found (`go.mod`, `package.json`, …; `via: 'manifest'`), uncapped.

## Why manifest questions need a special case

"What are this project's dependencies?" has nothing to do with the call graph, and Retrieve/Rerank
can't be trusted to rank a manifest file highly for a casually-phrased question — a raw sentence's
embedding doesn't resemble a `require`/`dependencies` block, and BM25 has no reason to favor
`go.mod` over any other file containing the word "dependency". Without this, the LLM would
correctly (and unhelpfully) answer "the dependencies aren't in the provided context" — a real,
confirmed failure mode this stage fixes by guaranteeing the manifest is in context regardless of
how it scores. Matched by exact basename (`go.mod`, `package.json`, `requirements.txt`, `Cargo.toml`,
`pom.xml`, `build.gradle`, …), not by `configFormat` — `configFormat` groups by file _type_
(json/toml/yaml), which is too broad (a `tsconfig.json` is also configFormat `json` but isn't a
dependency list).

A manifest file can still legitimately score well enough to be a genuine `via: 'rerank'` hit on its
own — Stage 6 (Grade)'s manifest check looks for the file by name, not by `via` tag, so either path
satisfies it. See [`06-grade/README.md`](../06-grade/README.md).

## Honest scope: name-based, not semantic

This is **not** a real call graph. `buildSymbolGraph` scans every chunk's raw content for
identifier tokens and matches them against every other chunk's `symbolName` in the repo — no type
resolution, no import-aware disambiguation, no scoping analysis. That means:

|                            |                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **False positives**        | A token that happens to match an unrelated symbol of the same name in a different file (two functions both named `run`) — both get linked, honestly, not silently disambiguated. Proven in `expand.test.ts`. |
| **False negatives**        | A call hidden behind an alias, a method invoked via `this.`, dynamic dispatch, or a renamed import — none of these produce a matching identifier token, so the edge is simply never found.                   |
| **What it DOES get right** | The common case: a uniquely-named function called by its own name. That's most real code, and it's exactly what "who calls X" usually means in practice.                                                     |

A real call graph needs per-language semantic analysis (a language server, or a typed AST walk
with import resolution) — genuinely out of scope for this stage. The honest tradeoff: zero extra
infrastructure, instant, and correct often enough to be useful — not "correct."

## Why this stage exists at all

Stage 2 (Chunk), Stage 2/Retrieve, and Stage 4/Rerank's own READMEs all flagged the same gap
independently: asking "who calls `RecordTaskDuration`?" found the function _itself_ very
confidently, but nothing walked the call graph to find its _callers_. This stage closes that gap —
see [Example output](#example-output) below for the same question, now actually answered.

## Example output

Against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)):

```bash
npm run expand -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 20 --limit 8
```

```
  question   "who calls RecordTaskDuration?"
  intent     trace
  reranked   8 hits
  expand     +10 chunk(s) via the symbol graph

  [rerank ] RecordTaskDuration       telemetry/metrics.go:81-90
  [rerank ] InstrumentProcessor      telemetry/common.go:12-44
  [rerank ] RegisterMetrics          telemetry/metrics.go:29-68
  [rerank ] Config                   telemetry/config.go:23-35
  [rerank ] InitializeOTEL           telemetry/otel.go:62-112
  [rerank ] performRequest           telemetry/gin_test.go:79-84
  [rerank ] go.sum                   go.sum:1-159
  [rerank ] constants.go             telemetry/constants.go:1-22
  [callee ] Recover                  telemetry/utils.go:68-81
  [caller ] TestInstrumentProcessor  telemetry/common_test.go:14-76
  [callee ] TransformAttributes      telemetry/utils.go:45-65
  [caller ] logError                 telemetry/metrics.go:92-96
  [caller ] InitializeTelemetry      telemetry/otel.go:19-35
  [caller ] TestTelemetryInitializationWithCustomConfig telemetry/config_test.go:9-35
  [caller ] InitEnvWithConfig        telemetry/config.go:54-73
  [caller ] DefaultConfig            telemetry/config.go:74-88
  [caller ] initSdk                  telemetry/otel.go:49-58
  [callee ] newResource              telemetry/otel.go:114-124
```

`logError` (`telemetry/metrics.go:92-96`, immediately after `RecordTaskDuration` in the same file)
surfaces as a `[caller]` — a genuinely correct answer to the original question, and something
nothing earlier in this pipeline could produce. The other `[caller]`/`[callee]` entries relate to
the _other_ 7 reranked hits, not necessarily to `RecordTaskDuration` specifically — expansion runs
per reranked hit across the whole set, and this output doesn't (yet) label which hit each edge
came from.

### Manifest injection — `go.mod` guaranteed in, even outside the rerank cutoff

```bash
npm run expand -- https://github.com/thalaivar-subu/telemetry-go "Give me the dependencies bro" --k 20 --limit 3
```

```
  question   "Give me the dependencies bro"
  intent     manifest
  reranked   3 hits
  expand     +8 chunk(s) via the symbol graph

  [rerank  ] constants.go             telemetry/constants.go:1-22
  [rerank  ] TestGinInstrumentationMiddlewares telemetry/middleware_test.go:64-116
  [rerank  ] TestInstrumentationMiddlewares telemetry/middleware_test.go:10-62
  [manifest] go.mod                   go.mod:1-68
  [callee  ] TelemetryEnabled         telemetry/initializer.go:13-15
  [callee  ] GinInstrumentationMiddlewares telemetry/middleware.go:25-35
  [callee  ] GinInstrumentationHandler telemetry/gin.go:14-30
  [callee  ] OtelginWithLogging       telemetry/middleware.go:45-51
  [callee  ] InstrumentationMiddlewares telemetry/middleware.go:13-23
  [callee  ] InstrumentationHandler   telemetry/mux.go:41-58
  [callee  ] OtelMuxWithLogging       telemetry/middleware.go:37-43
```

With `--limit 3`, `go.mod` didn't make Rerank's cut on its own merit — none of the 3 reranked hits
are it. It's in context anyway, tagged `[manifest]`, because Route classified this question's
intent as `manifest`. Without this stage's special case, the LLM would receive zero mention of
`go.mod` and correctly report "the dependencies aren't in the provided context" — a real, previously
confirmed failure mode (see `06-grade/README.md`'s example of the same question resolving in one
hop once this was fixed).

## Verify

```bash
npm test -- 05-expand                                                                                          # graph construction, dedup, per-hit/total caps, the false-positive case documented above
npm run expand -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 20 --limit 8
```

## Output feeds → Stage 6 (Grade)

`ExpandedHit[]` is the context set Stage "Grade" (`src/pipeline/query/06-grade`, not built yet)
will judge as sufficient (or not, triggering another retrieve hop) before Stage "Generate" ever
sees it.
