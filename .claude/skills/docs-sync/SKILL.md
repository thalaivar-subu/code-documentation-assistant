---
name: docs-sync
description: Checks that this repo's docs haven't drifted from reality — stages.manifest.ts vs docs/PIPELINE.md, stage status vs actual folder contents, and rejected decisions (no CLI) that shouldn't still be described as current. Use after finishing a pipeline stage, or whenever asked to check/sync the docs.
---

# docs-sync

One of the two skills planned for this project from the start (see `docs/DECISIONS.md` /
`CLAUDE.md`) — deliberately not `adr-new` or `port-adapter`. This repo's docs are graded as part of
the assignment, so staleness here is a real defect, not cosmetic.

Run every check below. Report drift found — do not silently fix it unless asked; some fixes are a
one-line edit, others (regenerating `PIPELINE.md`) are a design decision the user should see first.

## 1. `docs/PIPELINE.md` vs `src/pipeline/stages.manifest.ts`

`PIPELINE.md` is supposed to be generated from the stage manifest. Check for:

- **Wrong source path.** `PIPELINE.md` may still say `src/core/pipeline/stages.ts` — the real file
  is `src/pipeline/stages.manifest.ts` (the path changed during implementation; the doc didn't
  follow). Flag if the paths don't match.
- **Rejected features still described as current.** The manifest/CLAUDE.md's locked decision is
  "no CLI as a product feature" — flag any doc still describing a `codedocs explain <stage>` or
  similar CLI command as if it ships.
- **Stage coverage.** Every entry in `INGEST_STAGES` and `QUERY_STAGES` (`stages.manifest.ts`)
  should be represented in `PIPELINE.md` (or `PIPELINE.md` should honestly say it's still a
  placeholder, as it currently does — a placeholder that says it's a placeholder is not drift; a
  placeholder that claims to be current is).

## 2. Stage `status` vs actual folder contents

For each entry in `stages.manifest.ts`:

- `status: 'done'` → its `dir` must contain a real `README.md` with at least an `## Example output`
  section and a `## Verify` section (this repo's established per-stage convention — see any
  completed stage's README for the shape), and the `## Example output` section must show a real
  command + real terminal output, not a hand-typed/synthetic example.
- `status: 'planned'` → its `dir` should be empty or contain only a placeholder; a `planned` stage
  with a real implementation already in it means the manifest is stale, not the code.
- Cross-check `doc` field's path actually exists on disk.

## 3. `CLAUDE.md` and the plan doc

- Confirm `CLAUDE.md`'s stage-completion checklist (prettier/eslint/tests/README-example/command-chain)
  matches what's actually been happening in recent stage completions — if the process has evolved
  (e.g. a new check got added ad hoc), `CLAUDE.md` should be updated to match, not left behind.

## Report format

A short table: `check | status (OK / DRIFT) | what's wrong | suggested fix`. End with a one-line
summary count. Don't rewrite files unless the user says to act on a specific row.
