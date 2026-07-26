# Productionizing on a hyperscaler

> What actually changes to run this for real, on AWS (primary target below), with GCP/Azure/
> Cloudflare equivalents noted per component. This is a deployment plan, not a rewrite — every
> swap below replaces one adapter behind an existing seam (see [DECISIONS.md](./DECISIONS.md)),
> or is a small, scoped addition. What genuinely can't move as-is is called out explicitly.

## Why "as built" can't just be deployed to a hyperscaler's serverless tier

The local defaults are deliberately zero-infrastructure: `node-llama-cpp` loads a GGUF model
in-process with native GPU bindings, and LanceDB/MiniSearch are files on local disk. Neither
survives a stateless serverless function (AWS Lambda, Cloudflare Workers, Vercel Functions) —
no persistent local disk, no native-binary GPU inference, and a cold start would reload a
multi-hundred-MB model on every invocation. **This is a real constraint, not a gap**: this
project's own architecture already accounts for it — every model/store sits behind a narrow
interface specifically so the _managed_ side of each swap is a config change, not a rewrite.

## Component-by-component: what moves where

| Component                                   | Local default                                      | AWS                                                                                                                                                                                                                             | GCP equivalent                                                        | Azure equivalent                                                 |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **API (Fastify)**                           | One Node process on a dev machine                  | **ECS Fargate** (or EKS) behind an **ALB** — a real process, not Lambda, so the SSE connections and any in-memory state stay alive for the request's duration                                                                   | Cloud Run (min-instances ≥ 1 to avoid cold starts killing SSE) or GKE | Azure Container Apps or AKS                                      |
| **LLM**                                     | `node-llama-cpp`, in-process GGUF                  | Swap to the `openai-compatible` adapter already in this codebase, pointed at **Amazon Bedrock** (Anthropic/Llama/Mistral models) or a **self-hosted vLLM** on a `g5`/`g6` GPU EC2 instance if a specific open model is required | Vertex AI, or self-hosted vLLM on an A2/G2 GPU instance               | Azure OpenAI Service, or self-hosted vLLM on an NC-series GPU VM |
| **Vector store**                            | LanceDB, files on disk                             | **Qdrant** on ECS/EKS with an EBS-backed volume, or **Qdrant Cloud** (managed); OpenSearch's vector engine is a same-ecosystem alternative if avoiding a new vendor matters more than Qdrant's filtering ergonomics             | Qdrant on GKE, or a Vertex AI Vector Search index                     | Qdrant on AKS, or Azure AI Search's vector support               |
| **Lexical index**                           | MiniSearch, one JSON file per repo                 | Same Qdrant instance's sparse-vector support (keeps one store instead of two), or OpenSearch's native BM25                                                                                                                      | Same pattern                                                          | Same pattern                                                     |
| **Repo clones** (`.cache/repos/`)           | Local disk, reused across re-indexes               | Ephemeral container-local disk is fine per-task (clone → chunk → discard); if scaling ingestion horizontally, an **EFS** mount shared across tasks avoids re-cloning per replica                                                | Filestore                                                             | Azure Files                                                      |
| **Static UI (Vite build)**                  | `vite dev` on `:5173`                              | Built as static assets → **S3 + CloudFront** — fully decoupled from the API, cheapest possible hosting for this piece                                                                                                           | Cloud Storage + Cloud CDN                                             | Blob Storage + Azure CDN/Front Door                              |
| **Secrets** (`GITHUB_TOKEN`, `LLM_API_KEY`) | `.env` file, gitignored                            | **AWS Secrets Manager**, injected as container env vars at task launch                                                                                                                                                          | Secret Manager                                                        | Key Vault                                                        |
| **Tracing/observability**                   | None (see `docs/ENGINEERING.md`'s honest gap list) | CloudWatch Logs/Metrics for infra-level signals; **Langfuse** (already named as the intended swap in `docs/ARCHITECTURE.md`) for per-query LLM tracing                                                                          | Cloud Logging/Monitoring + Langfuse                                   | Azure Monitor + Langfuse                                         |

**Cloudflare** is the one case worth calling out directly: Workers can run the static UI (Pages)
but cannot run this API at all — no native Node addons, no persistent local disk, no long-lived
process for SSE. Cloudflare only fits here as a CDN/edge cache in front of an API that's actually
hosted somewhere else (one of the above), not as the compute layer itself.

## The two paths that scale differently, and shouldn't share a process

Already named in `docs/INTERVIEW-QA.md`'s productionisation answer, concretely mapped to AWS
primitives here: **ingestion** is bursty and CPU/GPU-bound (a big repo's chunk+embed run spikes
hard, then goes idle) — a good fit for an **SQS-triggered Fargate task** or **Step Functions**
workflow that scales to zero between indexing jobs. **Querying** is steady, latency-sensitive
traffic — an always-on Fargate service behind the ALB, scaled by request count/CPU, is the better
fit. Running both in the same process (as this project does locally, for simplicity) means a big
indexing job can starve query latency — exactly the coupling worth removing first.

## What would need to change in the code itself

Almost nothing, by design — this is the point of building behind narrow interfaces from the
start:

1. Point `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` at Bedrock/vLLM/Azure OpenAI instead of leaving
   them unset (the `openai-compatible` adapter already exists — see `DECISIONS.md #0008`).
2. Write a `VectorStore`/`LexicalIndex` adapter for Qdrant (the port shape already exists in
   `vector-store.ts`/`lexical-store.ts`; today only the LanceDB/MiniSearch implementation does).
   This is the one genuinely new piece of code this plan requires — everything else above is
   infrastructure and configuration, not application code.
3. Split `src/api/server.ts`'s `/index` and `/ask` handlers into two deployable units instead of
   one process, so they can scale independently as described above.

Everything else — the 4-stage ingest pipeline, the 8-stage query pipeline, Route/Grade/Verify's
heuristics, the UI — is infrastructure-agnostic already and doesn't change.
