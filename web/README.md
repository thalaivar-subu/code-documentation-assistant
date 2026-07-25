# Web UI

> The product surface — "UI is our CLI." Vite + React, talking to [`../src/api`](../src/api/README.md)
> over SSE. Two tabs: **Ask a repo** (the real, live pipeline) and **Understand the RAG pipeline**
> (a fixed teaching walkthrough, so a stranger can see what every stage produces without indexing
> anything themselves).

## Run it

```bash
npm run serve      # API on :8080
npm run web:dev     # Vite dev server on :5173, in a second terminal
```

Open `http://localhost:5173`. `web/src/api.ts`'s `API_BASE` defaults to `http://localhost:8080`;
override with a `VITE_API_BASE` env var if the API runs elsewhere.

## Tab 1 — Ask a repo

Index any repo, then ask it a question, watching both pipelines run live:

- **Ingest bar** (Clone → Chunk → Embed → Index) — driven by `/index`'s SSE `step` events.
- **Query bar** (Route → Retrieve → Fuse → Rerank → Expand → Grade → Generate → Verify) — driven by
  `/ask`'s `route`/`hop`/`token`/`done` events. Retrieve/Fuse/Rerank/Expand render as one block (the
  API doesn't emit fine-grained sub-events for them); Grade shows an `insufficient` state with a hop
  count when the loop re-enters Retrieve — the same loop `06-grade/README.md` documents, made visible.

Real run captured live through the browser, indexing and asking against the standard test repo:

```
1. Index a repo
[clone] source: remote → https://github.com/thalaivar-subu/telemetry-go
[clone] cached clone found — reusing
[clone] HEAD a5d74d13 on main — 25 tracked files
[chunk] 82 chunks
[embed] embedded 0, cached 82
[index] writing to the vector + lexical stores…
Indexed 82 chunks · repoId: thalaivar-subu-telemetry-go-7c354319

2. Ask a question
intent: trace · symbols: RecordTaskDuration — matched trace phrase "who calls" — needs
call/dependency graph expansion

The function `RecordTaskDuration` is called by the `InstrumentProcessor` function.

⚠ answer cited nothing — treat with more skepticism
```

That warning badge is `verify.hasCitations === false` rendered directly — the exact case
[`08-verify/README.md`](../src/pipeline/query/08-verify/README.md) documents as this local model's
known limitation. The UI doesn't hide it; it's the whole point of shipping Verify as a stage.

## Tab 2 — Understand the RAG pipeline

No backend calls at all — `web/src/demo-data.ts` holds real, previously-captured output from this
project's own build (copy-pasted from each stage's own README "Example output" section, not
fabricated), so the teaching tab works instantly with no repo indexed and no model loaded. Click any
stage in either pipeline bar to see its actual command and output, including the Grade stage's real
2-hop loop example.

## Structure

```
web/src/
  api.ts                    # fetch + SSE client for /index, /ask, /stages
  demo-data.ts               # static captured output for the Understand tab
  components/
    PipelineBar.tsx          # the stage-bar component, reused by both tabs, both pipelines
    AskTab.tsx                # Tab 1
    UnderstandTab.tsx         # Tab 2
  App.tsx                    # tab switcher
```

## Verify

No dedicated frontend test suite yet (no `@testing-library/react`/jsdom installed) — verified by
running both dev servers and driving the actual browser: `npm run serve` + `npm run web:dev`, then
exercise both tabs. `npx eslint .` and `npx prettier --check .` cover the TS/TSX source; `npx tsc -p
web/tsconfig.json --noEmit` type-checks the browser build separately from the root `tsconfig.json`
(which only covers `src`/`eval`).
