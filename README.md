# code-documentation-assistant

> Ask any codebase questions in plain English. Get answers with **`file:line` citations**.

Point it at a Git repository, ask _"how does authentication work?"_ or _"where is rate limiting
implemented?"_, and get an answer grounded in the actual source — every claim traced back to real
lines. Built on **AST-aware chunking**, **hybrid retrieval + reranking**, and a **multi-hop agent**
that keeps retrieving until it has enough to answer. Node.js/TypeScript, open-source models, runs
locally.

---

## Why this is more than "chat with your docs"

Naive RAG (split → embed → top-k → stuff into a prompt) gets you ~85% of the way on prose. On
**code** it falls apart, and fixing that is the whole point of this project:

| Naive RAG fails because…                                             | What this repo does instead                                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed-size splitting cuts functions in half                          | **AST-aware chunking** with tree-sitter — a function/class stays whole, with file, line-range and symbol metadata attached                                                 |
| Nobody asks "where is auth" using the code's identifiers             | **Hybrid retrieval** — dense embeddings _and_ BM25 keyword search, fused with Reciprocal Rank Fusion                                                                       |
| Embedding scores never see the query                                 | **Cross-encoder reranking** — retrieve 50 cheaply, rerank to 8 accurately                                                                                                  |
| "How does login work?" needs endpoint → controller → service → model | **Multi-hop agent** — retrieves, asks "is this enough?", and loops back if not (see [`docs/DECISIONS.md`](./docs/DECISIONS.md) #0006 for why this couldn't be a plain DAG) |
| "The answer looks good" is not a metric                              | **Citation verification** — every cited `file:line` is checked against the exact context the model was actually given, not the full repo index                             |

---

## Quickstart — zero infrastructure, no Docker, no API keys

```bash
git clone https://github.com/thalaivar-subu/code-documentation-assistant
cd code-documentation-assistant
npm install
npm run serve      # API on :8080
```

In a second terminal:

```bash
npm run web:dev     # UI on :5173
```

Open `http://localhost:5173`. **Ask a repo** — point it at any Git repo (or your own), index it, ask
a question, and watch all 12 pipeline stages (4 ingest + 8 query) run live. **Understand the RAG
pipeline** — a second tab with real, pre-captured output for every stage, no indexing required,
useful for learning the pipeline without waiting on a model. See [`web/README.md`](./web/README.md).

There is **no separate CLI** — the UI is the product surface. A handful of `npm run <stage>` scripts
(`clone`, `chunk`, `embed`, `index`, `route`, `retrieve`, `fuse`, `rerank`, `expand`, `grade`,
`generate`, `ask`) exist purely as dev tooling, one per pipeline stage, each documented in its own
stage README with a real example run.

---

## How it works

Two pipelines: **ingest** (offline, once per repo, then incremental) and **query** (online, per
question):

```
INGEST:  clone → chunk (AST) → embed → index
QUERY:   route → retrieve → fuse → rerank → expand → grade ─→ generate → verify
                                                        ↺
                                          loops back to retrieve if not enough
```

Full diagrams and the data model are in **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

---

## The design decisions (read these — the reasoning is the deliverable)

Every major tool choice, its rejected alternatives, and when to revisit it lives in one table:
**[docs/DECISIONS.md](./docs/DECISIONS.md)** — Node.js over Python, tree-sitter chunking, LanceDB,
hybrid retrieval + RRF, cross-encoder reranking, why a stateful loop over a plain LangChain DAG,
local embeddings, the local-LLM default vs. the managed-service swap, and how eval/tracing work.

New to this space? Start with **[docs/LEARNING-PATH.md](./docs/LEARNING-PATH.md)**.
Prepping for the discussion? **[docs/INTERVIEW-QA.md](./docs/INTERVIEW-QA.md)**.
Curious what building this actually cost in tokens? **[docs/COST.md](./docs/COST.md)** — generated
from real Claude Code session transcripts, not estimated.
How did this actually get built, day by day? **[docs/DEVELOPMENT-LOG.md](./docs/DEVELOPMENT-LOG.md)**.
How would this run on AWS/GCP/Azure/Cloudflare for real? **[docs/PRODUCTIONIZE.md](./docs/PRODUCTIONIZE.md)**.
What engineering standards did this actually follow (and skip)? **[docs/ENGINEERING.md](./docs/ENGINEERING.md)**.
What does it actually answer well — and where does it fail? **[docs/EXAMPLE-QUESTIONS.md](./docs/EXAMPLE-QUESTIONS.md)** — 8 real runs across every intent, including 3 real failure modes kept in on purpose.

---

## Tech stack at a glance

| Layer        | Default (in-process, this repo)                                               |
| ------------ | ----------------------------------------------------------------------------- |
| Clone        | simple-git                                                                    |
| Chunk        | web-tree-sitter (WASM grammars)                                               |
| Embeddings   | Transformers.js (ONNX, in-process)                                            |
| Vector store | LanceDB (files on disk)                                                       |
| Lexical      | MiniSearch                                                                    |
| Rerank       | bge-reranker (ONNX)                                                           |
| Query loop   | hand-rolled hop loop (see DECISIONS #0006 for why LangGraph wasn't pulled in) |
| LLM          | node-llama-cpp, local GGUF (Vulkan)                                           |
| API          | Fastify + SSE                                                                 |
| UI           | Vite + React                                                                  |

Every adapter that has a credible managed-service swap (embeddings, vector store, LLM) carries a
short header comment showing exactly how to point it at one — see `docs/DECISIONS.md` for the
specifics per layer.

---

## Project status

Built in gated phases — see [docs/PLAN.md](./docs/PLAN.md) for the phase-by-phase working agreement.

- [x] Docs & architecture
- [x] Ingest pipeline — clone → chunk → embed → index
- [x] Retrieval pipeline — route → retrieve → fuse → rerank → expand
- [x] Agent + API — grade loop → generate → verify, Fastify + SSE
- [x] UI — two-tab streaming pipeline (Ask a repo · Understand the RAG pipeline)
- [ ] Optional: managed-service swap demo (Qdrant, hosted LLM) — the product is complete without it

Every stage's own README has a real, captured example run against the standard test repo
(`https://github.com/thalaivar-subu/telemetry-go`) rather than a synthetic one.

---

## License

MIT (to be added).
