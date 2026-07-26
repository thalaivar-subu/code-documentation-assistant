# Development log

> A factual timeline of how this project actually got built, for reference — not a
> finished answer to the assignment's "how you used AI tools" / "what you'd do
> differently" questions. Those need **your own thoughts, in your own voice** (the
> assignment says this explicitly); this doc is raw material to draw from, not a draft
> to copy. For token/time/cost data, see [COST.md](./COST.md) (generated from real
> session transcripts, not estimated).

## Timeline

**Day 1 — 2026-07-23: choosing the project, scaffolding.**
Started from the assignment's four options (chat-with-docs, code documentation
assistant, meeting intelligence, career intelligence) and picked Option 2. Wrote
[PLAN.md](./PLAN.md) and [ARCHITECTURE.md](./ARCHITECTURE.md) before touching code —
the phase-gate working agreement in [CLAUDE.md](../CLAUDE.md) (one pipeline stage at a
time, checklist per stage, no commit without explicit go-ahead) was set up on day 1 and
held for the rest of the build.

**Day 2 — 2026-07-24: the ingest pipeline.**
Clone → Chunk (tree-sitter AST) → Embed → Index. This is also where the chunking
worker-pool decision got made (measured, not assumed — see
`02-chunk/chunk-pool.ts`'s doc comment on the 300-file crossover) and where the
LanceDB/MiniSearch pairing was chosen over alternatives (see
[DECISIONS.md](./DECISIONS.md)).

**Day 3 — 2026-07-25: the query pipeline, API, and UI.**
Route → Retrieve → Fuse → Rerank → Expand → Grade → Generate → Verify, then the
Fastify + SSE API and the two-tab Vite/React UI (Ask a repo · Understand the RAG
pipeline). The Grade→Retrieve loop (the one intentional cycle in the whole system) and
the decision to hand-roll it instead of reaching for LangGraph both landed this day —
see [DECISIONS.md](./DECISIONS.md) #0006. Also: the `manifest` query intent (a real,
user-reported gap — "give me the dependencies" wasn't answerable until this existed),
several UX passes on the UI (repo picker, pipeline-trace disclosure, the palette now in
use), and the doc set aimed at the assignment's explicit requirements (ARCHITECTURE,
DECISIONS, PRODUCTIONIZE, ENGINEERING, INTERVIEW-QA).

**Day 4 — 2026-07-26: submission polish, then a full refactor pass.**
Static explainer site, [EXAMPLE-QUESTIONS.md](./EXAMPLE-QUESTIONS.md) (8 real captured
runs across every route intent, including 3 real failure modes kept in deliberately —
see that doc's own intro for why). Then a structured review against SOLID/DRY/KISS,
performance, error handling, and file structure produced
[REFACTOR-PLAN.md](./REFACTOR-PLAN.md), which was then fully implemented and verified
in the same day: the rerank performance fix (measured ~2× speedup, not assumed), a
4-type error taxonomy, client-disconnect cancellation, atomic dual-store writes, and a
CLI-scripts DRY cleanup that incidentally fixed a real latent argument-parsing bug.

## Working pattern, if it's useful context

- **Phase gates, not one long unstructured session.** Each pipeline stage had its own
  completion checklist (format, lint, full test suite, a real captured README example,
  explicit go-ahead before the next stage) — see [CLAUDE.md](../CLAUDE.md). This is
  also why [PLAN.md](./PLAN.md) can honestly list what was skipped (Phase 2's
  ports/adapters layer, Phase 4's eval harness, Phase 7's managed-swap demo) instead of
  quietly pretending they exist.
- **Measure before claiming a fix.** The rerank performance work is the clearest
  example — two of three initial hypotheses about where time was going turned out to
  be wrong once actually measured (see [REFACTOR-PLAN.md](./REFACTOR-PLAN.md)'s own
  framing of this).
- **Real repos, not synthetic examples.** Every stage README, [EXAMPLE-QUESTIONS.md](./EXAMPLE-QUESTIONS.md),
  and this log's own claims are checked against actual runs against
  [`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go), the
  standing test fixture — never hand-typed output.
- **Never commit without an explicit go-ahead in that turn**, even when a
  commit-per-stage plan had already been agreed. Held throughout.

## What this log doesn't do

- It doesn't claim to reconstruct every individual prompt — that's neither accurate
  (session transcripts exist but weren't parsed for verbatim prompt text) nor useful
  for an interview write-up.
- It isn't the assignment's "how did you use AI tools" answer. That answer needs to say
  something a transcript can't: what you'd trust the tool with again, what you had to
  push back on or fix yourself, and what surprised you. Use [COST.md](./COST.md)'s real
  numbers and this timeline as source material, not as the submission itself.
