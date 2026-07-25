# Build Cost & Trajectory

> ⚙️ **This file is generated.** Do not edit by hand.
>
> Produced by the `cost-report` skill (`npm run cost:report`), which parses the Claude
> Code session transcripts at `~/.claude/projects/C--Users-Subramanian-VE-Workspace/*.jsonl`.
> The transcripts already carry per-turn token usage — `input_tokens`, `output_tokens`,
> `cache_creation_input_tokens`, `cache_read_input_tokens`, `model`, `timestamp` — so cost
> is **derived**, never hand-logged.
>
> **Status:** placeholder — populated once the `cost-report` skill runs (wired in Phase 7,
> runnable earlier).

The generated report will show: per-prompt tokens and model, cumulative spend, cache-hit
ratio, and cost broken down against the build phases in [PLAN.md](./PLAN.md). Raw per-turn
dumps land in `.cache/trajectory/` (gitignored); this aggregate is committed as study
material — a token-cost breakdown of building an AI system.
