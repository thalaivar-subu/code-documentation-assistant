# Build Cost & Trajectory

> ⚙️ **This file is generated.** Do not edit by hand — regenerate with `npm run cost:report`.
>
> Produced by `src/scripts/cost-report.ts`, which reads this machine's real Claude Code session
> transcripts (`~/.claude/projects/**/*.jsonl`) and sums the per-turn token usage they already
> carry. A transcript file counts only if it mentions "code-documentation-assistant" at least 100
> times — 2 file(s) qualified this run (a "Resume"-titled session with a handful of
> incidental mentions was correctly excluded during development of this script).
>
> **This tool only works on the machine that actually built the project** — the transcripts live
> outside this repo, outside version control, and outside `.cache/` (they're Claude Code's own
> history, not this project's). Nothing to derive them from anywhere else.

## Headline numbers

- **4,253** assistant turns (each one LLM call within the agentic tool loop — a single
  user message can span many of these)
- **4,071,108** output tokens generated
- **1,941,428,682** cache-read tokens — this dwarfs everything else because prompt caching
  means the same accumulated context gets cheaply re-read on almost every turn of a long agentic
  session, not re-sent at full price. It is **not** 1,941,428,682 tokens of new content.
- **43,427,697** cache-creation tokens (the one-time cost of writing new context into
  the cache)
- **8,400** fresh (non-cached) input tokens — small, because caching absorbed almost
  everything
- Calendar span: **2026-07-23 → 2026-07-26**
- Active-work-time estimate (sum of gaps between turns at or under a threshold, treating anything
  longer as a break/overnight — NOT the raw calendar span, which would include ~3 nights of sleep):
  **~12.7h** at a 20-minute gap threshold (**11.0h** at 10min,
  **14.9h** at 60min — reported as a range since the "what counts as still working"
  cutoff is inherently a judgment call, not something the data settles precisely)

No dollar figure is reported here — this environment doesn't distinguish metered API billing from
subscription-plan usage, and getting that distinction wrong would be worse than just reporting the
real token counts and letting them be converted against whatever your actual plan's pricing is.

## By model

| Model           | Fresh input | Output    | Cache read    | Cache create |
| --------------- | ----------- | --------- | ------------- | ------------ |
| claude-sonnet-5 | 7,546       | 3,329,373 | 1,842,609,830 | 37,872,927   |
| claude-opus-4-8 | 743         | 651,380   | 78,785,157    | 4,485,339    |
| claude-opus-5   | 111         | 90,355    | 20,033,695    | 1,069,431    |

## By day

| Day        | Turns | Fresh input | Output    | Cache read  | Cache create |
| ---------- | ----- | ----------- | --------- | ----------- | ------------ |
| 2026-07-23 | 78    | 146         | 166,400   | 6,368,022   | 397,485      |
| 2026-07-24 | 1181  | 2,297       | 1,539,257 | 376,555,159 | 11,702,828   |
| 2026-07-25 | 1319  | 2,624       | 1,131,449 | 653,005,316 | 17,141,908   |
| 2026-07-26 | 1675  | 3,333       | 1,234,002 | 905,500,185 | 14,185,476   |

## What this doesn't capture

- **No per-phase breakdown against [PLAN.md](./PLAN.md).** The transcripts don't tag which pipeline
  phase a given turn belongs to, and reconstructing that mapping reliably from message content alone
  wasn't attempted — a real gap, not an oversight.
- **"Assistant turns" isn't "user messages."** One user request can trigger many tool-use iterations
  within Claude Code's agentic loop; this counts every one of those, not the number of times the user
  actually typed something.
- **Active-time is an estimate, not a timesheet.** The gap-threshold method is a reasonable proxy, not
  ground truth — a long thinking pause under the threshold still counts as "active," and a short
  real break just over it doesn't.
