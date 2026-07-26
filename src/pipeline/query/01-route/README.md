# Query · Stage 1 — Route

> Classify a question into one of four intents before any retrieval happens, so later stages know
> how to weight themselves. Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`routeQuery(question)` → `{ intent, symbols, files, reason }`.

## Rule-based, not LLM-based

|              | Chosen                                                     | Why                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approach     | Regexes over the question text                             | No LLM is wired into this project yet (Phase 5) — routing is cheap enough to not need one, and doing it this way makes the stage free, instant (<1ms), and testable without a model |
| Revisit when | Real questions need judgment the regexes can't approximate | e.g. ambiguous phrasing a human would classify differently than the heuristics — cross that bridge with data, not speculation                                                       |

## The four intents

| Intent     | Meaning                                          | Trigger                                                                                                                                                      | Feeds into (later stages)                                                                                                             |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `trace`    | Question is about call/dependency flow           | A trace phrase (`who calls`, `used by`, `depends on`, `call chain`, …)                                                                                       | Stage "Expand" should pull in the symbol graph aggressively                                                                           |
| `manifest` | Question is about the project's own package deps | A manifest phrase (`dependencies`, `what packages`, `go.mod`, `package.json`, …) — checked after `trace`, so "dependencies **of** X" still routes to `trace` | Stage "Expand" guarantees `go.mod`/`package.json`/etc. are in context; Stage "Grade" is satisfied by finding one, not by rerank score |
| `symbol`   | Question names a specific identifier or file     | An identifier-looking token (camelCase/PascalCase/snake_case/backtick-quoted) or a filename, and no trace/manifest phrase                                    | Stage "Retrieve" can boost/prefer exact lexical matches over pure semantic search                                                     |
| `concept`  | Everything else — general/architectural          | No trace phrase, no manifest phrase, no identifier, no filename                                                                                              | Stage "Retrieve" leans on dense (semantic) search                                                                                     |

`trace` takes priority over both `manifest` and `symbol` — "what calls `RecordTaskDuration`?" still
extracts the symbol (so Retrieve can use it), but the _intent_ is `trace` because that's the signal
that actually changes downstream behavior (graph expansion). Similarly "what are the dependencies
**of** the embed stage" matches trace's `dependencies of` phrase before `manifest`'s bare
`dependencies` gets a chance — code-level tracing wins when the phrasing is specific enough to mean it.

`manifest` exists because "what does this project depend on" (external packages) is a genuinely
different question from "what does this function depend on" (code-level tracing, already covered by
`trace`) — see [`05-expand/README.md`](../05-expand/README.md) for why Retrieve/Rerank alone can't be
trusted to surface `go.mod` for a casually-phrased dependency question.

`symbols`/`files` are always populated regardless of intent, not just when `intent === 'symbol'` —
Retrieve can use them as exact-match hints on a `trace` or even a `concept` question too.

## Known heuristic limitation (accepted, not a bug)

Compound-capitalized product/library names (`LanceDB`, `GitHub`) match the same two-hump PascalCase
pattern as a real code symbol (`RecordTaskDuration`) — there's no way to distinguish "a symbol in
this codebase" from "a proper noun that happens to look like one" without checking against the actual
index. Accepted: worst case, a question like "why was LanceDB chosen?" routes as `symbol` instead of
`concept`. Retrieve still works fine either way (dense search runs regardless of intent) — this only
affects a boost/weighting choice, not correctness. Test: `route.test.ts`'s `LanceDB` case documents
this rather than treating it as a failure.

## Example output

```bash
npm run route -- "Who calls RecordTaskDuration?"
```

```
  question   "Who calls RecordTaskDuration?"
  intent     trace
  symbols    [RecordTaskDuration]
  files      []
  reason     matched trace phrase "who calls" — needs call/dependency graph expansion
```

```bash
npm run route -- "How does authentication work in this system?"
```

```
  question   "How does authentication work in this system?"
  intent     concept
  symbols    []
  files      []
  reason     no specific symbol, file, or trace phrase found — treated as a conceptual question
```

```bash
npm run route -- "Give me the dependencies bro"
```

```
  question   "Give me the dependencies bro"
  intent     manifest
  symbols    []
  files      []
  reason     matched manifest phrase "dependencies" — needs the project's dependency manifest(s), not code symbols
```

## Verify

```bash
npm test -- 01-route                                      # all four intents, priority order, dedupe, the LanceDB edge case
npm run route -- "What does clone.ts do?"                 # try your own question, no repo/index needed
```

## Output feeds → Stage 2 (Retrieve)

`intent` and the extracted `symbols`/`files` are inputs to how Stage "Retrieve"
(`src/pipeline/query/02-retrieve`, not built yet) weights dense vs. lexical search — this stage
itself never touches the index.
