# Ingest · Stage 3 — Embed

> Turn each chunk's `content` into a vector so it becomes searchable by meaning, not just keywords.
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`embedChunks(chunks)` → `EmbeddedChunk[] { chunkId, contentHash, vector }` + run stats
(`total`, `embedded`, `cached`, `dims`, `model`, `ms`).

## Model

|            | Chosen                                                     | Why                                                                                                                                                                      | Rejected                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model      | `Xenova/bge-small-en-v1.5` via Transformers.js (ONNX, CPU) | Trained specifically for retrieval (query/passage contrastive learning) — consistently beats general sentence-similarity models on retrieval benchmarks at the same size | `all-MiniLM-L6-v2` — general similarity, not retrieval-tuned. Also smoke-tested and works; swap by changing `EMBED_MODEL` in `embedder.ts` if reranking quality ever calls for it |
| Dimensions | 384                                                        | Fixed by the model                                                                                                                                                       | —                                                                                                                                                                                 |
| Pooling    | mean + L2-normalize (pipeline option)                      | Cosine similarity reduces to a plain dot product downstream, in Stage 4/retrieval                                                                                        | Max-pooling — loses signal for multi-sentence chunks                                                                                                                              |

Runs in-process, CPU-only — no GPU/service required. On this machine (Ryzen 7 5700G) that's plenty
fast for a demo-scale repo; see [Verify](#verify) for real numbers.

## Content-hash cache

The whole point of keying by `contentHash` (not by chunk id): **identical content is embedded
exactly once**, no matter how many chunks reference it or how many times the repo is re-indexed.

| Case                                                                | What happens                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Same file, unchanged, re-indexed later                              | `contentHash` unchanged → served from cache, zero model calls                                                            |
| Boilerplate repeated across files (license headers, generated code) | Same `contentHash` → embedded once, vector shared                                                                        |
| An oversized function split into parts (Stage 2's `splitOversized`) | Each part has genuinely different content → different hash → each embedded independently, correctly                      |
| Model changes                                                       | Cache is keyed **per model** (`embed-cache.ts`'s `defaultCachePath`) — switching models never mixes incompatible vectors |

The cache is a flat JSON file (`.cache/embeddings/<model>.json`), loaded once per run and written once
at the end — not a database. Stage 4 (Index) owns the real, queryable vector store; this cache exists
purely to make embedding idempotent and cheap.

## Why no worker pool (unlike Stage 2)

Stage 2's tree-sitter parsing is synchronous WASM with no internal threading, so a `worker_threads`
pool gave a real, measured speedup on large repos. Embedding is different: ONNX Runtime already
multi-threads matrix ops **internally**, within one model call. A worker pool here would mean N
threads each loading a full copy of the model's weights into memory, competing for the same CPU cores
ONNX is already using — added memory cost for no real parallelism gain. Batching (`batchSize`, default 16) is the actual lever: one forward pass over many texts is more efficient than many single-text
calls.

## Known vulnerability (accepted, documented)

`npm audit` reports 2 high-severity, **no-fix-available** transitive vulnerabilities pulled in by
`@huggingface/transformers` → `onnxruntime-node`:

| Package   | Issue                                                                                                          | Risk here                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adm-zip` | crafted ZIP → 4GB memory allocation ([GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)) | Used only by `onnxruntime-node`'s own installer against its own release artifacts — not exposed to any untrusted input in this app's runtime path |
| `sharp`   | inherited `libvips` CVEs                                                                                       | Pulled in transitively; this pipeline never decodes images at runtime — nothing here calls into `sharp`                                           |

Accepted rather than blocked: neither package processes attacker-controlled input anywhere this
system runs. Revisit if a future stage adds image/zip handling on untrusted input, or when upstream
ships a fix.

## Example output

Full chain — clone, inspect the chunks feeding in, then embed — against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)):

```bash
npm run clone -- https://github.com/thalaivar-subu/telemetry-go
npm run chunk -- https://github.com/thalaivar-subu/telemetry-go --sample 0 --json
npm run embed -- https://github.com/thalaivar-subu/telemetry-go --sample 0
```

```
  total 83  |  embedded 83  |  cached 0  |  dims 384  |  7776 ms

  52fcefe8cbf8ec58ff95d5c3516d2f8e  hash=4183b036ac92…  vector[0..3]=-0.0742,-0.0373,0.0232,-0.0539
```

Every one of the 83 chunks was a first-time embed (`cached 0`) since this was a fresh repo. Re-run the
same `embed` command a second time and `embedded` drops to `0` while `cached` picks up all 83 — proof
the content-hash cache works, not just a claim (see [Verify](#verify)). Add `--json` to see a full
`EmbeddedChunk` object (`chunkId`, `contentHash`, the entire 384-number `vector`) instead of the
truncated one-liner above.

## Verify

```bash
npm test -- 03-embed                                                          # caching/dedup (fake embedder) + real-model sanity check
npm run embed -- https://github.com/thalaivar-subu/telemetry-go --sample 0    # embed a real repo, see total/embedded/cached/dims/ms
npm run embed -- https://github.com/thalaivar-subu/telemetry-go --sample 0    # run again — "embedded" drops to 0, "cached" covers everything
```

## Output feeds → Stage 4 (Index)

`EmbeddedChunk[]` (`chunkId` + `vector`) joins back with Stage 2's `Chunk[]` (by `chunkId === id`) to
be written into the vector store + lexical index.
