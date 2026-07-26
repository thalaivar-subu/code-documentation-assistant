# code-documentation-assistant — Build Plan

> This is the approved implementation plan, committed to the repo as the source of
> truth for scope, sequencing, and the phase-gate working agreement. It is the
> "why we built it this way" companion to [ARCHITECTURE.md](./ARCHITECTURE.md).

## Context

**Why this exists.** This is an interview assignment ("Option 2: Code Documentation
Assistant"). The brief asks for a system that ingests a codebase and answers questions
about how it works, where functionality lives, its API surface and dependencies.

**What it must prove.** The interview grades _understanding_, not polish. Expect
questions like "how would you productionise this?", "why this database and not that
one?", "why LangGraph when LangChain exists?". So the deliverable is not just a working
RAG pipeline — it is a repo where every tool choice is written down with its rejected
alternatives, and where the deployment topology is demonstrably a config decision
rather than an architectural one.

**Three audiences, one artifact.**

1. **The interviewer** — must run it easily and find the reasoning already written down.
2. **The author** — revision material for interview prep (LangChain/LangGraph is the
   identified gap to close).
3. **Anyone new to AI** — the repo should teach RAG, not just perform it. Hence a
   visible pipeline UI where each stage explains itself on hover.

**Naming.** The project is `code-documentation-assistant` throughout — repo, README,
and UI. No separate product brand. **No CLI as a product feature** (superseded from an
earlier draft that planned a `codedocs` binary) — the UI is the only product surface;
a few thin `npm run` scripts under `src/scripts/` exist purely as dev/verification
tooling. Local artifacts live under `.cache/`.

---

## Verified environment (scanned 2026-07-23)

| Item        | Value                                   | Consequence                                                                              |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Node / npm  | v20.14.0 / 10.7.0                       | fine                                                                                     |
| pnpm        | absent                                  | Use **npm**, single `package.json`, no monorepo                                          |
| git         | 2.45.1                                  | `simple-git` works                                                                       |
| CPU / RAM   | Ryzen 7 5700G, 16 threads / 29.8 GB     | great for CPU embeddings + reranker                                                      |
| GPU         | AMD Ryzen 5700G iGPU, shared system RAM | `node-llama-cpp`'s Vulkan backend can offload a small GGUF model here — modest, but real |
| Docker      | being enabled (virtualization)          | Compose is the primary path once available                                               |
| Transcripts | `~/.claude/projects/.../*.jsonl`        | Carry per-turn token usage → **cost tracking is derived, never hand-logged**             |

---

## Locked decisions

| Decision          | Choice                                                                                       | Rationale                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Node.js + TypeScript                                                                         | Author comfort                                                                                                                                                                     |
| Build order       | **Docs & architecture first**, then code                                                     | Docs become the spec; cheapest way to avoid rework                                                                                                                                 |
| LLM               | **`node-llama-cpp` in-process** (GGUF, Vulkan/APU) is the default — zero services            | `openai-compatible` adapter is the managed swap: change `LLM_BASE_URL` + `LLM_MODEL`                                                                                               |
| Chunker languages | **JS/TS, Python, Java**                                                                      | Proves generality without an unverifiable long tail                                                                                                                                |
| Study material    | **Single source** — `stages.manifest.ts` feeds the `/stages` API route and this doc's tables | Docs cannot drift from code                                                                                                                                                        |
| Skills            | **`docs-sync`** and **`cost-report`** only                                                   | Deliberately minimal — `cost-report` shipped as a plain `npm run cost:report` dev script (`src/scripts/cost-report.ts`) rather than a formal Claude Code skill; see `docs/COST.md` |
| Interface         | Web UI only, streaming stage pipeline — **no CLI as a product feature**                      | Superseded an earlier draft that planned a `codedocs` CLI binary; see Naming above                                                                                                 |

---

## Working agreement — phase gates (non-negotiable)

**One phase at a time. Each phase is verified in isolation before the next one opens.**

1. **Implement** only what the phase names — nothing from a later phase, no speculative stubs.
2. **Verify** against the Gate criteria, showing actual output — never a claim that it works.
3. **STOP.** Report what passed, what did not, and anything that changes later phases.
4. **Stay in the phase** — refactor, fix, review, test — as long as needed.
5. **Only advance on an explicit "proceed"** — not a passing test, not silence, not "looks good".

Corollaries: later-phase work is never started opportunistically; design changes are
reported at a Gate, not acted on; commits are proposed then wait for go-ahead.

---

## Implementation phases & gates

| Phase                 | Deliverable                                                                             | Gate (evidence required)                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 — Docs**          | All docs, ADRs, README, config, folder skeleton. No runtime code.                       | Mermaid renders on GitHub; every ADR has ≥2 rejected alternatives; quickstart is copy-pasteable                                                        |
| **2 — Contracts**     | `ports.ts`, `types.ts`, `container.ts`, `stages.ts`, `gen-docs.ts`, conformance harness | `tsc --noEmit` clean; `gen:docs` produces `PIPELINE.md` matching `stages.ts`; harness runs with zero adapters                                          |
| **3 — Ingest**        | clone → manifest → tree-sitter chunk → symbols → embed+cache → LanceDB+MiniSearch       | `index --dry-run` prints chunks with correct `file:line`; no function split mid-body; re-index → zero duplicate ids; edit one file → only it re-embeds |
| **4 — Retrieval**     | router · hybrid · RRF · rerank · expand; golden set + metrics                           | `eval:retrieval` prints recall@5/@10, MRR, nDCG + an ablation (dense/lexical/hybrid/+rerank). No LLM yet                                               |
| **5 — Agent + API**   | LangGraph grade-loop; `openai-compatible` LLM; Fastify SSE; citation verify             | `ask` streams a cited answer; 100% citations resolve; multi-hop re-enters retrieve; hop limit holds                                                    |
| **6 — UI**            | Vite+React; PipelineBar, StagePopover, AnswerStream, CitationCard; `/architecture`      | Browser-pane verified: 8 stages render/transition; hovers show what/why/withoutIt; SSE incremental; console clean                                      |
| **7 — Prod topology** | `docker-compose.yml` (Qdrant+Ollama); Qdrant adapter; skills; README eval table         | Same conformance suite green for **both** LanceDB and Qdrant, shown side by side                                                                       |

Phases 1–2 are cheap and unblock everything. Phases 3–6 need no Docker. **Phase 7 is
the only one that requires Docker**, so nothing is blocked while that is being set up.

### What actually happened vs. this table

This table is kept as the original plan for provenance — several phases were built
differently once real engineering tradeoffs showed up, all documented honestly rather
than silently:

- **Phase 2** (`ports.ts`, `container.ts`, `gen-docs.ts`, conformance harness) was **never
  built** — every stage imports its concrete tool directly instead. See
  [ARCHITECTURE.md §4](./ARCHITECTURE.md#4-ports--adapters--planned-not-built) and
  [DECISIONS.md](./DECISIONS.md)'s drift note (`#0009`).
- **Phase 4**'s golden set + `eval:retrieval` metrics were **never built** — the placeholder
  `eval/` directory sat empty and has since been removed. See
  [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-cost--observability--mostly-planned-not-built).
- **Phase 5** used a hand-rolled hop loop instead of LangGraph — a deliberate call, not
  an oversight; see [DECISIONS #0006](./DECISIONS.md) and
  [INTERVIEW-QA.md](./INTERVIEW-QA.md)'s "why LangGraph" answer for the honest version.
- **Phase 6**'s UI shipped as two tabs (Ask a repo · Understand the RAG pipeline) rather
  than the originally sketched `StagePopover`/`CitationCard`/`/architecture` page —
  simpler, but covers the same "teach the pipeline" goal. See
  [`web/README.md`](../web/README.md).
- **Phase 7** (Docker, Qdrant, managed-swap proof) was **not attempted** — the product is
  complete without it; DECISIONS.md documents what each managed swap would be even
  though none are wired up.

---

## Cost & trajectory tracking

- **Build cost (Claude Code).** Built as planned, with two differences: it's a plain
  `npm run cost:report` script rather than a formal skill, and it deliberately reports
  raw token counts only, no dollar figure — this environment doesn't distinguish
  metered API billing from subscription-plan usage, and getting that distinction wrong
  would be worse than not reporting it. No `.cache/trajectory/` raw dumps; the script
  re-derives everything from Claude Code's own transcripts on each run instead of
  keeping a separate copy.
- **Runtime cost (the app).** Not built — `gpt-tokenizer` per-stage counting, trace
  spans in `.cache/traces/*.jsonl`, and a UI footer showing tokens + cost per query all
  remain planned only (see [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-cost--observability--cost-is-real-tracing-isnt)).

## MCPs — none needed

Built-in tools (file ops, shell, web, Browser pane for UI verification) cover the whole
build. Adding an MCP server would cost context every turn for capability already present.
Recorded as a deliberate choice in [INTERVIEW-QA.md](./INTERVIEW-QA.md).

---

## Definition of done

A stranger clones the repo, runs two commands, gets a cited answer with a visible
pipeline, and can find the written reasoning behind every tool in
[`docs/DECISIONS.md`](./DECISIONS.md).
