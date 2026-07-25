# Ingest · Stage 1 — Clone

> Turn a source (Git URL or local folder) into a working tree + the metadata every
> later stage needs. Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

## What it does

`cloneRepo(input)` → `CloneResult { repoId, repoPath, commitSha, branch, trackedFiles, reused }`.

| Input                           | Handling                                                     |
| ------------------------------- | ------------------------------------------------------------ |
| `https://…` / `git@…` / `*.git` | Partial clone into `.cache/repos/<repoId>`                   |
| Local folder                    | Used in place (no copy); reads HEAD if it's a git repo       |
| Private remote                  | Token from `GITHUB_TOKEN` / `GIT_TOKEN` / `{ token }` option |

## Why these choices

| Choice                                                   | Reason                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Partial clone** `--filter=blob:none`                   | Full history (needed for `git diff` incremental indexing) without downloading every blob. Not `--depth 1`, which discards that history                                                                                                               |
| **Deterministic `repoId`** = `slug + sha256(source)[:8]` | Same source → same id → re-runs are **idempotent**, not duplicated                                                                                                                                                                                   |
| **Reuse cached clone** (fetch, don't re-clone)           | Cheap updates; second run just fetches — **known gap:** `fetchLatest` updates remote-tracking refs only, never the checked-out working tree, so a re-index today can silently chunk stale file content even after a successful fetch. Not yet fixed. |
| **Local folders first-class**                            | Supports uploaded zips / existing checkouts; falls back to a file manifest when there's no git history                                                                                                                                               |
| **Token, prompts disabled** (`GIT_TERMINAL_PROMPT=0`)    | Private repos work; a missing credential fails fast instead of hanging on a prompt                                                                                                                                                                   |

## Guardrails

- Token is **never logged or persisted**: cloned with a tokenised URL, then the stored
  remote is reset to the clean URL; any token substring is redacted from error text.
- Auth failures produce an actionable message telling you to set `GITHUB_TOKEN`.

## Example output

Against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)):

```bash
npm run clone -- https://github.com/thalaivar-subu/telemetry-go
```

```
── Ingest · Stage 1: Clone ─────────────────────────────────────
  → source: remote → https://github.com/thalaivar-subu/telemetry-go
  → repoId: thalaivar-subu-telemetry-go-7c354319
  → cached clone found — reusing
  → fetching latest (partial)…
  → HEAD a5d74d13 on main — 25 tracked files

  Result
  ------
  repoId        thalaivar-subu-telemetry-go-7c354319
  path          .../.cache/repos/thalaivar-subu-telemetry-go-7c354319
  source        remote
  commit        a5d74d13629c
  branch        main
  trackedFiles  25
  reused        true
  took          1174 ms
────────────────────────────────────────────────────────────────
```

`reused: true` because this repo was already cloned earlier in the pipeline (Stage 2+ scripts
all clone before chunking) — run against a fresh repo to see `reused: false` on the first call.

## Verify

```bash
npm run clone -- https://github.com/thalaivar-subu/telemetry-go   # remote partial clone (run twice → reused=true)
npm test -- 01-clone                                              # unit + integration tests
```

## Alternatives (rejected)

| Option                    | Why not                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `isomorphic-git`          | Pure JS, no binary needed, but slower on large repos         |
| raw `child_process` git   | Manual output parsing + escaping                             |
| `--depth 1` shallow clone | Fast, but throws away the history incremental indexing needs |
| GitHub API download       | Rate-limited, no local history                               |

## Output feeds → Stage 2 (Chunk)

`repoPath` (files to parse) + `commitSha` (stamped onto every chunk for citations & diffs).
