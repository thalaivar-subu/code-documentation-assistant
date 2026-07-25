# Working agreement for this repo

## Phase gates (non-negotiable)

One pipeline stage at a time. Implement only what the current stage names — no stubs "to save a
round trip" from a later stage. After implementing, run the full **Stage-completion checklist**
below automatically, report the results, then **stop** — refactor/fix/review in the current stage as
needed, but do not start the next stage until the user explicitly says "proceed" (or names it).

## Stage-completion checklist — run this yourself, every stage, unprompted

Do not wait to be asked for any of this. It is the definition of "done" for a stage:

1. `npx prettier --write` the files you touched, then `npx eslint .` — must be clean.
2. `npx vitest run` — all tests passing (not just the new stage's file).
3. Update that stage's `README.md` "Example output" section with a **real** run — actual command,
   actual terminal output — against the standard test repo below. Never a synthetic/hand-typed example.
4. Flip that stage's `status` to `'done'` in `src/pipeline/stages.manifest.ts`.
5. In the chat report, include the full runnable command chain from Stage 1 through the current
   stage, using the standard test repo and a "show everything" flag (`--sample 0`, `--json`, etc.).
6. Stop and wait for explicit go-ahead before touching the next stage.

## Standard example/test repo

Use `https://github.com/thalaivar-subu/telemetry-go` (the user's own public Go repo) for every
example command and as a fixture in tests that need a real multi-file repo — it's public, no auth
token needed. Don't default to `.` or `octocat/Hello-World` unless there's a specific reason to.

## Commits

Never `git commit` without explicit go-ahead in that turn, even if a commit-per-stage plan was
agreed earlier.

## Skills

- `.claude/skills/docs-sync` — checks `docs/` against reality (stale paths, rejected features
  still described as current, stage `status` vs actual folder contents). Run it after finishing a
  stage's docs, or whenever asked to check/sync docs. Cross-cutting decisions live in
  `docs/DECISIONS.md` (one table, not per-decision files); don't recreate `docs/adr/`.
