# Interview Q&A

Anticipated questions, with answers grounded in this repo's decisions. Each links to the
ADR that argues it in full. The pattern for every answer: **state the choice → give the
reason → name the rejected alternative → admit the trade-off.**

---

## Architecture & design

**Q: Walk me through the system.**
Two pipelines. _Ingest_ (offline): clone → discover → AST-chunk → symbol graph → embed →
index. _Query_ (online): route → hybrid retrieve → RRF fuse → rerank → expand → grade → (loop
if needed) → generate → verify citations. Diagrams in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Q: How would you productionise this?**
Four moves. (1) **Incremental indexing** — `git diff` since the last indexed SHA, re-chunk
only changed files, triggered by a webhook. (2) **Separate the paths** — ingestion is
bursty and CPU-bound (queue of workers); queries are steady and latency-sensitive (stateless
API pods). They scale on different signals and must not share a process. (3) **Caching** —
embedding cache by content hash, semantic query cache in Redis, prompt-prefix caching on
hosted models. (4) **Swap embedded adapters for services** — LanceDB→Qdrant, in-process
embed→TEI, in-process queue→BullMQ. All config, no core change ([ADR-0009](./DECISIONS.md)).

**Q: How is dev the same code as prod?**
Honestly — right now, it isn't, and I'd say that directly rather than oversell it. The plan
called for ports & adapters (six interfaces, embedded/service pairs, chosen by env var, proven
with a conformance suite run against every adapter). None of that layer got built — every stage
imports its concrete tool directly (LanceDB, MiniSearch, `node-llama-cpp`, etc.). Swapping to a
managed service today means editing the file that owns that tool, not flipping an env var. I'd
frame this as a real, known gap and the first thing I'd build if I kept going, not something to
paper over ([ADR-0009](./DECISIONS.md) documents it as drift, explicitly).

**Q: Where would this abstraction break down, if you built it?**
Four places I'd want to handle up front rather than discover later: queue durability is semantic
not config (an in-process queue loses jobs on crash — mitigate with idempotent, resumable
indexing, which the deterministic chunk ids already give you for free); filter expressiveness
differs across vector stores (Qdrant's filter JSON vs LanceDB's SQL `WHERE` aren't the same
language — you'd need a deliberately narrow, neutral DSL); no cross-store transaction between the
vector index, lexical index, and (if built) a symbol graph; and model parity isn't guaranteed
across embedding providers, so the embedder's id needs to be part of the cache key to force a
re-index on mismatch instead of silently mixing vector spaces.

---

## The pointed "why not X" questions

**Q: Why LangGraph and not just LangChain?**
The control flow genuinely has a **cycle** — LCEL composes a DAG (forward only), and multi-hop
code questions ("how does login work?" → endpoint → service → store) can't know hop 2 until hop
1 returns, so the loop has to go back to retrieve. A DAG can't express that part of the reasoning
holds. But I actually ended up **not** using LangGraph — the loop rarely runs more than 1–2 hops
in practice, so it's a hand-rolled `while`/recursive loop instead
(`06-grade/query-loop.ts`). Pulling in LangGraph's typed-state/checkpointing machinery for a loop
this small would have been the over-engineering the original decision record explicitly warned
against ([ADR-0006](./DECISIONS.md)) — so the honest answer is "the cycle argument is real, and
it's also why a _hand-rolled_ cycle was enough."

**Q: Why not just semantic search?**
Semantic search ranks by meaning, which is wrong for identifiers — `getUserPermissions`
returns everything permission-ish by vibes. So hybrid: dense + BM25 lexical, fused with RRF.
Dense catches concepts, lexical catches exact symbols ([ADR-0004](./DECISIONS.md)).

**Q: Why this vector DB?**
LanceDB — embedded, files on disk, zero infrastructure to run this. Not Chroma (weak filtering
at scale), not FAISS (no metadata/persistence), not pgvector (needs Postgres), not Milvus
(etcd+MinIO+Pulsar overkill) ([ADR-0003](./DECISIONS.md)). Qdrant is documented as the production
swap for when multi-node scale is needed, but — honestly — there's no ports/adapter layer or
`container.ts` behind it the way the plan originally called for; every stage imports LanceDB
directly, so swapping to Qdrant today would mean editing `vector-store.ts`, not flipping an env
var. That's a real gap between plan and code, not a hidden one.

**Q: Why not fixed-size chunking? It's simpler.**
It splits functions mid-body, so neither half is retrievable or citable. AST chunking keeps
functions whole and gives line numbers + symbol names for free — which is where citations
come from ([ADR-0002](./DECISIONS.md)).

**Q: Why local models instead of OpenAI?**
Cost, privacy, offline. Embeddings re-run on every re-index — per-token API cost adds up and
source code would leave the machine. Everything's behind a port, so a hosted model is a
one-env-var swap when quality justifies it ([ADR-0007](./DECISIONS.md),
[ADR-0008](./DECISIONS.md)).

**Q: Why Node, not Python?**
The whole pipeline has first-class JS packages, and one language end-to-end (ingest, API, UI)
means shared types and no runtime bridge. Cost paid: RAGAS is Python-only, so I wrote the
retrieval metrics myself (~100 lines, no LLM needed) ([ADR-0001](./DECISIONS.md)).

---

## Retrieval quality

**Q: How do you know retrieval is any good?**
Today, honestly, from real captured example runs per stage rather than a formal eval suite — the
plan called for a golden set of ~40 labelled `question → {files}` pairs scored with recall@k /
MRR / nDCG plus a dense/lexical/hybrid/+rerank ablation, and `eval/` exists as a directory for it,
but it was never actually written (empty except a `.gitkeep`). That's the honest gap, and it's
the first thing I'd build for real confidence beyond "I read the outputs and they look right"
([ADR-0010](./DECISIONS.md) documents the intended design).

**Q: How do you prevent hallucinated citations?**
The prompt requires a `file:line` per claim, then code **verifies** each cited location was
actually in the retrieved context; unresolvable citations are dropped/flagged. Hallucination
becomes a measured metric, not a hope ([ADR-0010](./DECISIONS.md)).

**Q: What's the reranker actually doing?**
The embedder scores chunks before it sees the query (bi-encoder — fast, coarse). The reranker
is a cross-encoder that reads query+chunk together (precise, slow), so we retrieve 50 cheaply
and rerank to 8 precisely. Biggest quality-per-line win in the system ([ADR-0005](./DECISIONS.md)).

---

## Scale & operations

**Q: A 500k-LOC monorepo — what breaks?**
Naive top-k dilutes across too many files. Fix with **hierarchical routing**: a file-level
summary index selects candidate files, then chunk-level search within them. Ingestion moves
to a worker fleet; embedding moves to a batched TEI service. All behind existing ports.

**Q: Re-indexing on every commit — full rescan?**
Today, yes, honestly — it's a full rescan every time; `discoverFiles` walks every file again
rather than diffing against the last indexed commit. It's cheap in practice only because
deterministic chunk ids make re-upserts idempotent and the embed cache skips unchanged chunks —
not because of real incremental diffing. The design I'd build instead: persist the indexed
commit SHA + a `{path→sha256}` manifest, `git diff --name-status` on re-index, and act only on
changed files. That's real, scoped future work, not something I'd claim is already there
([ARCHITECTURE.md §2](./ARCHITECTURE.md#incremental-re-indexing--planned-not-implemented)).

**Q: Multi-tenancy / access control?**
Collection per repo; ACL enforced as a store-side payload filter **before** retrieval, never
as a post-filter (post-filtering leaks result counts and latency signals).

**Q: What would you monitor in production?**
p50/p95 latency split by pipeline stage, retrieval recall on a shadow eval set, cost per
query, thumbs-up rate, and the % of answers with fully verified citations.

---

## Meta

**Q: Why no MCP servers / why not more frameworks?**
I evaluated them and the built-in toolset was sufficient; adding an MCP server would cost
context every turn for capability already present. Choosing _not_ to add a dependency is a
design decision too. Same discipline as [ADR-0009](./DECISIONS.md): an
abstraction with a single implementation is cost without benefit.

**Q: What would you do differently with more time?**
Larger golden set mined from real traces; the hierarchical router for big repos; a proper
evaluation of hosted vs local generation quality on my own eval set to quantify the trade-off
rather than assert it.
