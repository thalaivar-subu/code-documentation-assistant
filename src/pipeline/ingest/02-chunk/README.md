# Ingest · Stage 2 — Chunk

> Turn a repo's files into retrievable, citable units. Two parts:
> **A. Discover** (which files) → **B. Chunk** (split each into AST nodes).
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

## Part A — Discover ✅

`discoverFiles(repoPath)` → `FileEntry[] { absPath, relPath, kind, language?, configFormat?, sizeBytes, sha256 }`.

| Concern         | How                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which files     | globby with `gitignore: true` (+ `dot: true`) — honours `.gitignore` for cloned _and_ local sources                                                                                               |
| Skip noise      | `node_modules`, `dist`/`build`/`out`, `vendor`, `*.min.*`, `*.map`, lockfiles, `.git`                                                                                                             |
| Classification  | **code** (`.ts .js .py .java .go` → AST) · **config** (Dockerfile, compose, CI, k8s/Helm, Terraform `.tf`, `Makefile`, `package.json`/`go.mod`/`pom.xml`, `*.yml/.toml/.json`) · **text** (prose) |
| Default scope   | `code` + `config` (config explains build & deploy). `text` is opt-in via `includeText`                                                                                                            |
| Size guard      | files > 1 MB skipped (generated/blob noise)                                                                                                                                                       |
| Incremental key | per-file `sha256` → re-index skips unchanged files                                                                                                                                                |
| Determinism     | entries sorted by `relPath` → reproducible chunk ids and tests                                                                                                                                    |

## Part B — Chunk ✅

Routes by `kind`, producing `Chunk`s (`id`, `filePath`, `startLine`/`endLine`, `symbolName`,
`symbolType`, `parentSymbol?`, `content`, `contentHash`).

- **code** → `web-tree-sitter` + `tree-sitter-wasms` AST. Emits at function / method / class /
  interface / type / enum granularity for **JS/TS, Python, Java, Go**, plus JS/TS arrow-function
  assignments (`const f = () => …`). Methods carry `parentSymbol` = their class. A function is
  captured **whole** (line range = the node), which is exactly what makes citations precise. A
  code file with no definitions falls back to a single whole-file chunk (nothing dropped).
- **config** → `chunkFlat`: small files (≤200 lines) stay one citable whole-file chunk; large
  files split into overlapping line windows. Answers "how is this built & deployed?".
- **oversized functions** (> 100 lines — a simple proxy for ADR-0002's "~1500 tokens") → split
  into fixed 40-line parts via `splitOversized`, each with the original signature line repeated
  at the top for context. Parts are named `<symbol> [part i/N]`; line ranges are contiguous and
  non-overlapping, and each part gets its own `contentHash` (different content → different hash,
  proven in `chunk.test.ts`). Ordinary functions never hit this — nothing in this repo does.

**Version pin:** `web-tree-sitter@0.20.x` — its wasm ABI matches the grammars in
`tree-sitter-wasms` (built with tree-sitter CLI 0.20). Newer runtimes fail to load them.

**Line-ending safety:** source is normalized to `\n` before chunking (`normalizeNewlines` in
`chunk.ts`), so `content`/`contentHash` are identical whether the repo was checked out with LF or
CRLF — otherwise the same file on Windows vs. Linux would silently bust the embedding cache.

**Not yet (future stages/enhancements):** `imports[]` extraction + symbol graph (feeds query-time
expansion).

See [ADR-0002](../../../../docs/DECISIONS.md).

## Parallel chunking (worker pool)

Tree-sitter parsing is synchronous, CPU-bound WASM work with no internal threading — a
big repo's files parse one at a time on a single core unless something changes that. So
Stage 2 chunks across a `worker_threads` pool for large repos (`chunk-pool.ts`).

Pool size = logical CPUs − 1 (`os.cpus().length`), capped at 12. Work is distributed
**pull-based** (a worker gets its next file only after finishing the last one), and
results are placed back at their **original index**, so parallel output is byte-identical
to sequential output — same chunks, same order — proven in `chunk-pool.test.ts`.

**Why embedding (Stage 3) does _not_ get this treatment:** ONNX Runtime already
multi-threads matrix ops internally per inference call; a worker pool there would just
duplicate model weights across threads' memory for little gain. Different bottleneck,
different fix — see `03-embed/README.md`.

**The threshold is measured, not guessed.** First attempt used 16 files as the cutoff —
wrong. Pool startup (thread creation + tsx's TS loader + per-worker tree-sitter WASM
init) is a real fixed cost, and at everyday repo sizes it isn't worth paying:

| Files | Sequential | Parallel (12 workers) | Result            |
| ----- | ---------- | --------------------- | ----------------- |
| 148   | 549 ms     | 530 ms                | a wash            |
| 444   | 729 ms     | 613 ms                | 16% faster        |
| 888   | 1,379 ms   | 708 ms                | 49% faster        |
| 1,480 | 2,315 ms   | 844 ms                | 64% faster (2.7×) |

Sequential scales roughly linearly with file count; parallel's marginal cost barely
grows (530→844 ms across a 10× file-count increase) because the ~500 ms is a **one-time**
cost, not per-file. `DEFAULT_PARALLEL_THRESHOLD = 300` sits just past where the win
becomes real. Below it, sequential runs — simpler, and provably not slower.

Force either path to compare on your own machine/repo:

```bash
npm run chunk -- <repo> --sequential   # force single-threaded
npm run chunk -- <repo>                # default (pool kicks in ≥ 300 files)
```

## Example output

One real chunk (`--json`) from indexing a Go repo — this is the _entire_ shape a chunk carries
through the rest of the pipeline:

```json
{
  "id": "247397eb33fc50636c7895c7da03fb56",
  "repoId": "thalaivar-subu-telemetry-go-7c354319",
  "filePath": "telemetry/common.go",
  "kind": "code",
  "language": "go",
  "symbolName": "InstrumentProcessor",
  "symbolType": "function",
  "startLine": 12,
  "endLine": 44,
  "content": "func InstrumentProcessor(ctx context.Context, processorMethod string, startTime time.Time, span trace.Span, attribMap map[string]interface{}, hasError bool) context.Context {\n\tdefer Recover(\"Recovered in InstrumentProcessor \" + processorMethod)\n\tif ENABLED {\n\t\tattributes := make([]attribute.KeyValue, 0)\n\t\tif len(attribMap) > 0 {\n\t\t\tattributes = TransformAttributes(attribMap)\n\t\t}\n\t\tattributes = append(\n\t\t\tattributes,\n\t\t\tattribute.String(\"processor.method\", processorMethod),\n\t\t\tattribute.String(\"has.error\", strconv.FormatBool(hasError)),\n\t\t)\n\t\tif !DISABLE_METRICS {\n\t\t\tIncTaskCounter(ctx, 1, attributes...)\n\t\t\tRecordTaskDuration(ctx, startTime, attributes...)\n\t\t}\n\t\tif !DISABLE_TRACES {\n\t\t\tAttachSpanAttributes(\n\t\t\t\tctx,\n\t\t\t\tspan,\n\t\t\t\tattributes...,\n\t\t\t)\n\t\t\tif span != nil {\n\t\t\t\tspan.End()\n\t\t\t}\n\t\t\treturn BaggageContext(ctx, attributes)\n\t\t}\n\t}\n\tif span != nil {\n\t\tspan.End()\n\t}\n\treturn ctx\n}",
  "contentHash": "04a808f53eb7667db87894becf21b64695a99ec7dabebc676e27e808e09a0288",
  "commitSha": "a5d74d13629cc6aa1a7536508c0eb74c56ed528d"
}
```

Reproduce it yourself:

```bash
npm run chunk -- <repo-url> --file "<path-substr>" --symbol "<name-substr>" --json
```

## Verify

```bash
npm test -- 02-chunk        # discovery + AST (all langs) + config + oversized-split hashing
npm run chunk -- . --content --sample 5   # eyeball real chunks in the terminal
```

## Output feeds → Stage 3 (Embed)

`Chunk[]` (with `contentHash` as the embedding cache key) and `FileEntry.sha256` for
skip-if-unchanged incremental re-indexing.
