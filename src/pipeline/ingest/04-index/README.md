# Ingest · Stage 4 — Index

> Write Stage 2's chunks + Stage 3's vectors into two stores — dense (vector) and lexical (keyword)
> — keyed by Stage 2's deterministic chunk id, so re-indexing upserts instead of duplicating.
> Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`indexRepo(repoId, chunks, embeddings)` → `{ repoId, chunksIndexed, vectorCount, lexicalCount, ms }`.
`peekIndex(repoId)` → raw stored rows (a scan, not a search) — proof of what actually landed.

**This stage is write-only, on purpose.** No query/search API — that's the query pipeline's job
(Stage "Retrieve", not built yet). See [Write-only, deliberately](#write-only-deliberately) below.

## Two stores, one purpose each

|                   | Chosen                                       | Why                                                               | Rejected                                                                                         |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Dense (vector)    | `@lancedb/lancedb`, embedded (files on disk) | Files-on-disk, no service; native upsert (`mergeInsert`) built in | Chroma (weaker filters), FAISS/hnswlib (no metadata/persistence), pgvector (needs Postgres)      |
| Lexical (keyword) | `minisearch`, embedded (JSON file per repo)  | Pure JS, no native deps, `.replace()` gives upsert for free       | flexsearch (less relevance tuning), Postgres FTS / Elasticsearch (a whole service for one index) |

One shared LanceDB table (`chunks`) holds every indexed repo, filtered by `repoId` — indexing a
second repo never means standing up a new store. Lexical gets one JSON file **per** repo
(`.cache/index/lexical/<repoId>.json`) since MiniSearch has no native multi-tenant filtering as
cheap as a SQL `WHERE`.

## Idempotent by construction

Both stores upsert on Stage 2's deterministic chunk `id` (content-hash-derived):

| Store      | Upsert mechanism                                                         | Effect                                                |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| LanceDB    | `tbl.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll()` | existing id → row updated in place; new id → inserted |
| MiniSearch | `index.has(id) ? index.replace(doc) : index.add(doc)`                    | existing id → removed + re-added; new id → added      |

Re-running `indexRepo` on the same chunks is a no-op on row/document counts — proven in
`index.test.ts` and, for real, in [Example output](#example-output) below (run the same command
twice).

## Write-only, deliberately

Earlier versions of this stage's dev script took a `--query` flag and ran a live search after
indexing, to prove the data was queryable. That mixed concerns: **ingestion writes, retrieval
reads**, and a pipeline stage named "Index" growing a query surface makes the phase boundary fuzzy.
It's been removed — `indexRepo` and the CLI now only write and report counts/raw rows.

The underlying per-store primitives (`searchVectors` in `vector-store.ts`, `searchLexical` in
`lexical-store.ts`) still exist and are still tested — they're adapter capabilities, not ingestion
ones — but nothing in this stage's own orchestrator (`index.ts`) or CLI calls them anymore. Stage
"Retrieve" (`src/pipeline/query/02-retrieve`) is where they get called and merged (Reciprocal Rank
Fusion, in Stage "Fuse").

## A real bug this stage caught: `null` breaks LanceDB's schema inference

`Chunk.parentSymbol`/`language`/`commitSha` are optional — the natural instinct is to write `null`
for "not applicable". LanceDB infers each column's Arrow type from the **first row**, and `null`
gives it nothing to infer from: `Failed to infer data type for field parentSymbol at row 0.` Fixed by
using `''` (empty string) as the sentinel instead — still unambiguously a `Utf8` column. Regression
test: `vector-store.test.ts` writes a batch whose first row has empty optional fields.

## Two more real bugs a later review caught

- **`configFormat` was silently dropped.** `toVectorRow` mapped `language`/`parentSymbol`/`commitSha`
  but forgot `configFormat` entirely — every config-kind chunk's format (`dockerfile`, `yaml`,
  `gomod`, …) was computed upstream and then discarded at write time. Fixed; see the real example
  below (`"configFormat": "gomod"`).
- **`commitSha` was written but never read back out.** `VectorHit` (what `searchVectors` actually
  returns) omitted `commitSha`, so it couldn't survive into Stage "Fuse"/"Rerank" output even though
  the field exists specifically for citation permalinks. Fixed — `VectorHit` and `getVectorsByIds`
  (below) both carry it now.
- **LanceDB's own schema is fixed at table creation** — adding a field to `VectorRow` isn't a
  backward-compatible change for an existing on-disk table (`Found field not in schema`). Since
  `.cache/index/` is gitignored, ephemeral, rebuild cache, this just means clearing it
  (`rm -rf .cache/index`) after a schema change during development, not a runtime concern for a
  real deployment (which starts from an empty store).

## Lookup primitives on the vector store

Beyond `searchVectors` (nearest-neighbor) and `listVectors`/`peekIndex` (full scan, debug/CLI use),
`vector-store.ts` also exposes `getVectorsByIds(db, repoId, ids)` — an id-scoped `WHERE id IN (...)`
lookup. This is what Stage "Rerank" uses to hydrate a small shortlist's content, instead of
reusing the debug-only full-scan utility as production plumbing (an earlier version did exactly
that; see `04-rerank/README.md`'s "Content hydration" section).

## Example output

Full chain against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)), dumping one raw
stored row to prove it's really in the database:

```bash
npm run index -- https://github.com/thalaivar-subu/telemetry-go --dump 1
```

```
  repoId thalaivar-subu-telemetry-go-7c354319  |  chunksIndexed 83  |  vectorCount 83  |  lexicalCount 83  |  99 ms

  ── raw vector-store rows (1) ──
{
  "id": "52fcefe8cbf8ec58ff95d5c3516d2f8e",
  "repoId": "thalaivar-subu-telemetry-go-7c354319",
  "filePath": "go.mod",
  "kind": "config",
  "language": "",
  "configFormat": "gomod",
  "symbolName": "go.mod",
  "symbolType": "file",
  "parentSymbol": "",
  "startLine": 1,
  "endLine": 68,
  "content": "module github.com/thalaivar-subu/telemetry-go\n\ngo 1.21\n...",
  "contentHash": "4183b036ac92dc429bc7ddb3ca818460480f59d8e346dceb1c8fee735d7ef83c",
  "commitSha": "a5d74d13629cc6aa1a7536508c0eb74c56ed528d",
  "vector": [-0.0742, -0.0373, 0.0232, "... 384 numbers total"]
}
```

Run the same command again (without `--dump`, to keep the output short) and
`chunksIndexed`/`vectorCount`/`lexicalCount` stay at `83` — proof the upsert is idempotent, not a
claim.

## Verify

```bash
npm test -- 04-index                                                        # upsert idempotency, repoId isolation, join safety, real store round-trips
npm run index -- https://github.com/thalaivar-subu/telemetry-go --dump 2    # index a real repo, inspect raw rows
npm run index -- https://github.com/thalaivar-subu/telemetry-go            # run again — counts don't grow
```

## Output feeds → Query pipeline

Stage "Retrieve" (`src/pipeline/query/02-retrieve`) calls `vector-store.ts`'s `searchVectors` and
`lexical-store.ts`'s `searchLexical` directly against the stores this stage populated, before Stage
"Fuse" merges the two ranked lists with Reciprocal Rank Fusion.
