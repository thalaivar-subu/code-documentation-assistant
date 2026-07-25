# Query · Stage 2 — Retrieve

> Run dense (vector) and lexical (keyword) search in parallel against the stores Ingest Stage 4
> populated, using Stage 1's classification to sharpen the lexical side.
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`retrieveCandidates(repoId, question, route, opts)` → `{ vector: VectorHit[], lexical: LexicalHit[], ms }`.

**Deliberately does not merge the two lists.** Reciprocal Rank Fusion is Stage 3 (Fuse, not built
yet) — this stage's job ends at "here are two independently-ranked candidate lists."

## Where Route's output actually gets used

Dense search always embeds the full question — an embedding model needs sentence context, handing it
just the extracted symbol wouldn't help. Lexical search is different: MiniSearch scores a short,
precise query far better than the same word buried in a full sentence. So when Stage 1 (Route) found
identifier-like tokens (`symbols`/`files`), Retrieve runs **two** lexical queries — the full question,
and just those tokens — and merges them (best score per chunk id wins):

```
questionHits = searchLexical(fullQuestion)
tokenHits    = searchLexical(route.symbols + route.files)   // only if Route found any
lexical      = merge(questionHits, tokenHits, keepBestScorePerId)
```

This is the concrete payoff of keeping Stage 1 instead of dropping it (see the discussion that led
here — Route earns its keep specifically through this token-boost, not through pretending to replace
what rerank already does well). Proven in `retrieve.test.ts`: a chunk that shares **no real words**
with the question text — only its exact symbol name matches — is invisible to a plain lexical search
on the question, but surfaces once Route's extracted symbol drives a second query.

## Example output

Against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)):

```bash
npm run retrieve -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 5
```

```
  question   "who calls RecordTaskDuration?"
  intent     trace  (symbols=[RecordTaskDuration] files=[])
  retrieved in 355 ms

  vector candidates (nearest first)
    0.5165  RecordTaskDuration       telemetry/metrics.go:81-90
    0.9198  IncTaskCounter           telemetry/metrics.go:70-79
    1.0024  InstrumentProcessor      telemetry/common.go:12-44
    1.0121  InitLogger               telemetry/utils.go:16-26
    1.0299  RegisterMetrics          telemetry/metrics.go:29-68

  lexical candidates (highest score first)
    13.8483  RecordTaskDuration       telemetry/metrics.go:81-90
    7.3326  InitializeOTEL           telemetry/otel.go:62-112
```

Compare this to Stage 4's own example (before Route/Retrieve existed): a full-sentence lexical query
alone ranked `RegisterMetrics` first for a similar question. Here, Route extracting
`RecordTaskDuration` as a symbol drives the token-boost query, and lexical now ranks the actual
target function first too — a real, measurable difference, not a hypothetical one.

The honest gap this exposes: `who calls RecordTaskDuration?` is asking about **callers**, and nothing
here actually walks the call graph — that's Stage 5 (Expand, not built yet). Retrieve found the
function _itself_; finding who calls _it_ needs the symbol graph.

## Verify

```bash
npm test -- 02-retrieve                                                                                     # symbol-boost proof, empty-repo safety, k, dedup, real-embedder smoke test
npm run retrieve -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --k 5    # real repo, real candidates
```

## Output feeds → Stage 3 (Fuse)

The two independent ranked lists (`vector`, `lexical`) are exactly what Reciprocal Rank Fusion (Stage
"Fuse", `src/pipeline/query/03-fuse`, not built yet) needs as input to produce one merged ranking.
