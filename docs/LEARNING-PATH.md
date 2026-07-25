# Learning Path — RAG from scratch, using this repo

New to AI/RAG? This repo is built to be read, not just run. Follow this order and you'll
understand not only _what_ a production-shaped RAG system looks like, but _why_ each piece
exists. Every concept links to the code or the decision record that implements it.

> **The one mental model:** RAG = **Retrieval** (find the right context) + **Augmented
> Generation** (put that context in front of an LLM). 90% of quality is the _retrieval_
> half. This repo spends its effort there — which is the whole lesson.

---

## 0. The problem RAG solves (5 min)

An LLM only knows its training data. Ask it about _your_ codebase and it guesses. RAG fixes
this by **retrieving** relevant snippets from your data and **putting them in the prompt** so
the model answers from facts, with citations, instead of from memory.

Naive RAG: `split text → embed → find top-k similar → stuff into prompt`. It works on prose
and falls apart on code. **Why it falls apart, and how to fix it, is this entire repo.** See
the comparison table in the [README](../README.md).

---

## 1. Ingestion: turning a repo into searchable pieces

Read [ARCHITECTURE §2](./ARCHITECTURE.md) (the ingest pipeline), then:

| Concept        | What to understand                                                                     | Where                                |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| **Chunking**   | Why you can't just cut every 500 characters — you'd split functions in half            | [ADR-0002](./DECISIONS.md)           |
| **AST**        | A syntax tree lets you chunk at function/class boundaries instead of blindly           | [ADR-0002](./DECISIONS.md)           |
| **Metadata**   | Each chunk remembers its file, line range, and symbol name → that's how citations work | [ARCHITECTURE §5](./ARCHITECTURE.md) |
| **Embeddings** | Turning text into a vector so "similar meaning" becomes "nearby in space"              | [ADR-0007](./DECISIONS.md)           |

**Aha moment:** a citation isn't magic — it's just the `startLine`/`endLine` the parser
recorded when it made the chunk.

---

## 2. Storage: where vectors live

| Concept                 | What to understand                                                          | Where                      |
| ----------------------- | --------------------------------------------------------------------------- | -------------------------- |
| **Vector database**     | A store that finds the nearest vectors fast (approximate nearest neighbour) | [ADR-0003](./DECISIONS.md) |
| **Embedded vs service** | Why the same job can be a library on your laptop or a server in production  | [ADR-0009](./DECISIONS.md) |

---

## 3. Retrieval: finding the _right_ pieces (the heart of RAG)

This is where naive RAG loses and where most of the learning is.

| Concept                     | What to understand                                                     | Where                      |
| --------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| **Dense (semantic) search** | Great for meaning, bad for exact names                                 | [ADR-0004](./DECISIONS.md) |
| **Lexical (BM25) search**   | Great for exact names (`getUserById`), bad for paraphrases             | [ADR-0004](./DECISIONS.md) |
| **Hybrid + RRF**            | Run both, merge by rank — the combination beats either alone           | [ADR-0004](./DECISIONS.md) |
| **Reranking**               | A second, smarter model that reads query+chunk _together_ and reorders | [ADR-0005](./DECISIONS.md) |

**Aha moment:** "bi-encoder vs cross-encoder." The embedder scores chunks _before_ seeing
your question (fast, coarse). The reranker scores them _with_ your question (slow, precise).
So you retrieve 50 cheaply, then rerank to 8 precisely.

---

## 4. Orchestration: when one retrieval isn't enough

| Concept                      | What to understand                                                                                                                                                                               | Where                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| **Single-shot vs multi-hop** | "How does login work?" needs to follow calls across files — one retrieval can't                                                                                                                  | [ADR-0006](./DECISIONS.md) |
| **DAG vs state machine**     | A chain flows one way; an agent can loop back and retrieve again                                                                                                                                 | [ADR-0006](./DECISIONS.md) |
| **Why not LangGraph, then**  | The cycle argument for it is real — but the loop rarely exceeds 1–2 hops, so a hand-rolled loop was enough; LangGraph's checkpointing machinery would be over-engineering for a cycle this small | [ADR-0006](./DECISIONS.md) |

**Aha moment:** an "agent" here isn't mystical — it's a `grade` function that decides "do I have
enough?" and either answers or loops back to retrieve, in a plain `while` loop. That decision is
the whole agent — no framework required to have this idea.

---

## 5. Generation & trust

| Concept                   | What to understand                                                                           | Where                      |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------- |
| **Grounded generation**   | The LLM answers _only_ from retrieved chunks, and must cite them                             | [ADR-0008](./DECISIONS.md) |
| **Citation verification** | Programmatically check every cited `file:line` was really in context → catches hallucination | [ADR-0010](./DECISIONS.md) |

---

## 6. Knowing it works: evaluation & tracing

| Concept          | What to understand                                                               | Where                      |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------- |
| **Eval**         | Measuring quality on a fixed question set (recall@k, MRR, nDCG) instead of vibes | [ADR-0010](./DECISIONS.md) |
| **Tracing**      | Recording what happened in a single query so you can debug it                    | [ADR-0010](./DECISIONS.md) |
| **The flywheel** | Real failures → added to the eval set → never regress again                      | [ADR-0010](./DECISIONS.md) |

---

## 7. Production thinking

Once the pipeline works, [ADR-0009](./DECISIONS.md) and the
"productionisation" answers in [INTERVIEW-QA.md](./INTERVIEW-QA.md) cover incremental
indexing, scaling ingestion separately from queries, caching, and multi-tenancy.

---

## Glossary (the terms that trip people up)

- **Embedding** — a list of numbers representing meaning; similar things get similar numbers.
- **Vector / vector space** — the coordinate system embeddings live in.
- **ANN (approximate nearest neighbour)** — finding "closest" vectors without checking all.
- **Chunk** — one searchable unit of the source (here, usually one function).
- **Bi-encoder** — embeds query and document separately (fast, for retrieval).
- **Cross-encoder** — scores query and document together (accurate, for reranking).
- **BM25** — a classic keyword-relevance scoring formula.
- **RRF (Reciprocal Rank Fusion)** — merges ranked lists by position, not raw score.
- **Multi-hop** — needing several retrieval rounds to gather enough context.
- **Grounding** — forcing the answer to come from retrieved facts, not model memory.
- **recall@k / MRR / nDCG** — standard retrieval-quality metrics.
