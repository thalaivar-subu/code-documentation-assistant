/**
 * Generates docs/COST.md from this machine's real Claude Code session
 * transcripts — never hand-logged. See docs/COST.md's own header for the
 * rationale: those transcripts already carry per-turn token usage
 * (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`, `model`, `timestamp`) for every turn.
 *
 * This is a MACHINE-LOCAL tool, not part of the reproducible pipeline — it
 * reads `~/.claude/projects/**\/*.jsonl`, which lives outside this repo and
 * outside version control, and only exists on whichever machine actually ran
 * the Claude Code sessions that built this project. Running it on a
 * different machine (or after clearing local Claude Code history) finds
 * nothing to report.
 *
 * Session discovery is content-based, not a hardcoded session-id list: a
 * transcript file only counts if it mentions this project's name at least
 * `MIN_MENTIONS` times, so a session that's mostly about something else but
 * happens to reference this project in passing (observed: a "Resume"-titled
 * session with 31 incidental mentions) doesn't get counted as if it were
 * building this project — while an unrelated grep threshold pick doesn't
 * need updating as new real sessions accumulate.
 *
 * Usage:
 *   npm run cost:report
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_MARKER = 'code-documentation-assistant';
const MIN_MENTIONS = 100;
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
// fileURLToPath + dirname, not `import.meta.dirname` — the latter needs Node
// 20.11+, but this project's engines field only requires Node >=20.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(SCRIPT_DIR, '..', '..', 'docs', 'COST.md');

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function addTotals(a: TokenTotals, b: Partial<TokenTotals>): void {
  a.input += b.input ?? 0;
  a.output += b.output ?? 0;
  a.cacheRead += b.cacheRead ?? 0;
  a.cacheCreate += b.cacheCreate ?? 0;
}

/** Every `.jsonl` directly under any immediate subdirectory of ~/.claude/projects/. */
function findAllTranscripts(): string[] {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of projectDirs) {
    const full = join(PROJECTS_DIR, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const entry of readdirSync(full)) {
      if (entry.endsWith('.jsonl')) files.push(join(full, entry));
    }
  }
  return files;
}

async function countMentions(path: string): Promise<number> {
  const content = await readFile(path, 'utf8');
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(PROJECT_MARKER, idx)) !== -1) {
    count++;
    idx += PROJECT_MARKER.length;
  }
  return count;
}

interface ParsedSession {
  byModel: Map<string, TokenTotals>;
  byDay: Map<string, TokenTotals & { turns: number }>;
  timestamps: number[];
  turns: number;
}

async function parseTranscript(path: string): Promise<ParsedSession> {
  const result: ParsedSession = {
    byModel: new Map(),
    byDay: new Map(),
    timestamps: [],
    turns: 0,
  };

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: {
      type?: string;
      timestamp?: string;
      message?: { model?: string; usage?: Record<string, unknown> };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'assistant' || !obj.message?.usage) continue;

    const model = obj.message.model ?? 'unknown';
    const ts = obj.timestamp;
    result.turns++;
    if (ts) result.timestamps.push(Date.parse(ts));

    const day = ts?.slice(0, 10);
    if (day && !result.byDay.has(day)) result.byDay.set(day, { ...emptyTotals(), turns: 0 });
    if (day) result.byDay.get(day)!.turns++;

    if (!result.byModel.has(model)) result.byModel.set(model, emptyTotals());

    const iterations = obj.message.usage.iterations;
    const list =
      Array.isArray(iterations) && iterations.length > 0 ? iterations : [obj.message.usage];
    for (const raw of list) {
      const it = raw as Record<string, number>;
      const parsed: TokenTotals = {
        input: it.input_tokens ?? 0,
        output: it.output_tokens ?? 0,
        cacheRead: it.cache_read_input_tokens ?? 0,
        cacheCreate: it.cache_creation_input_tokens ?? 0,
      };
      addTotals(result.byModel.get(model)!, parsed);
      if (day) addTotals(result.byDay.get(day)!, parsed);
    }
  }
  return result;
}

/** Sum of gaps between consecutive turns at or under `thresholdMin` — larger gaps are breaks/overnight, excluded. */
function activeHours(sortedTimestamps: number[], thresholdMin: number): number {
  const thresholdMs = thresholdMin * 60 * 1000;
  let activeMs = 0;
  for (let i = 1; i < sortedTimestamps.length; i++) {
    const gap = sortedTimestamps[i] - sortedTimestamps[i - 1];
    if (gap > 0 && gap <= thresholdMs) activeMs += gap;
  }
  return activeMs / 3_600_000;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function main(): Promise<void> {
  const candidates = findAllTranscripts();
  const included: string[] = [];
  for (const path of candidates) {
    const mentions = await countMentions(path);
    if (mentions >= MIN_MENTIONS) included.push(path);
  }

  if (included.length === 0) {
    console.log(
      `No transcripts under ${PROJECTS_DIR} mention "${PROJECT_MARKER}" >= ${MIN_MENTIONS} times. Nothing to report (expected on a machine that didn't build this project).`,
    );
    return;
  }

  const byModel = new Map<string, TokenTotals>();
  const byDay = new Map<string, TokenTotals & { turns: number }>();
  const allTimestamps: number[] = [];
  let totalTurns = 0;

  for (const path of included) {
    const parsed = await parseTranscript(path);
    totalTurns += parsed.turns;
    allTimestamps.push(...parsed.timestamps);
    for (const [model, t] of parsed.byModel) {
      if (!byModel.has(model)) byModel.set(model, emptyTotals());
      addTotals(byModel.get(model)!, t);
    }
    for (const [day, t] of parsed.byDay) {
      if (!byDay.has(day)) byDay.set(day, { ...emptyTotals(), turns: 0 });
      const entry = byDay.get(day)!;
      addTotals(entry, t);
      entry.turns += t.turns;
    }
  }

  allTimestamps.sort((a, b) => a - b);
  const grand = emptyTotals();
  for (const t of byModel.values()) addTotals(grand, t);

  const first = new Date(allTimestamps[0]).toISOString();
  const last = new Date(allTimestamps[allTimestamps.length - 1]).toISOString();
  const active20 = activeHours(allTimestamps, 20);
  const active10 = activeHours(allTimestamps, 10);
  const active60 = activeHours(allTimestamps, 60);

  const modelRows = [...byModel.entries()]
    // A model tag with zero everywhere (observed: "<synthetic>", from
    // compaction-boundary or other non-billed system entries) adds no
    // information — drop it rather than print a row of zeros.
    .filter(([, t]) => t.input + t.output + t.cacheRead + t.cacheCreate > 0)
    .sort((a, b) => b[1].output - a[1].output)
    .map(
      ([model, t]) =>
        `| ${model} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheCreate)} |`,
    )
    .join('\n');

  const dayRows = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([day, t]) =>
        `| ${day} | ${t.turns} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheCreate)} |`,
    )
    .join('\n');

  const md = `# Build Cost & Trajectory

> ⚙️ **This file is generated.** Do not edit by hand — regenerate with \`npm run cost:report\`.
>
> Produced by \`src/scripts/cost-report.ts\`, which reads this machine's real Claude Code session
> transcripts (\`~/.claude/projects/**/*.jsonl\`) and sums the per-turn token usage they already
> carry. A transcript file counts only if it mentions "${PROJECT_MARKER}" at least ${MIN_MENTIONS}
> times — ${included.length} file(s) qualified this run (a "Resume"-titled session with a handful of
> incidental mentions was correctly excluded during development of this script).
>
> **This tool only works on the machine that actually built the project** — the transcripts live
> outside this repo, outside version control, and outside \`.cache/\` (they're Claude Code's own
> history, not this project's). Nothing to derive them from anywhere else.

## Headline numbers

- **${fmt(totalTurns)}** assistant turns (each one LLM call within the agentic tool loop — a single
  user message can span many of these)
- **${fmt(grand.output)}** output tokens generated
- **${fmt(grand.cacheRead)}** cache-read tokens — this dwarfs everything else because prompt caching
  means the same accumulated context gets cheaply re-read on almost every turn of a long agentic
  session, not re-sent at full price. It is **not** ${fmt(grand.cacheRead)} tokens of new content.
- **${fmt(grand.cacheCreate)}** cache-creation tokens (the one-time cost of writing new context into
  the cache)
- **${fmt(grand.input)}** fresh (non-cached) input tokens — small, because caching absorbed almost
  everything
- Calendar span: **${first.slice(0, 10)} → ${last.slice(0, 10)}**
- Active-work-time estimate (sum of gaps between turns at or under a threshold, treating anything
  longer as a break/overnight — NOT the raw calendar span, which would include ~3 nights of sleep):
  **~${active20.toFixed(1)}h** at a 20-minute gap threshold (**${active10.toFixed(1)}h** at 10min,
  **${active60.toFixed(1)}h** at 60min — reported as a range since the "what counts as still working"
  cutoff is inherently a judgment call, not something the data settles precisely)

No dollar figure is reported here — this environment doesn't distinguish metered API billing from
subscription-plan usage, and getting that distinction wrong would be worse than just reporting the
real token counts and letting them be converted against whatever your actual plan's pricing is.

## By model

| Model | Fresh input | Output | Cache read | Cache create |
| ----- | ----------- | ------ | ---------- | ------------ |
${modelRows}

## By day

| Day | Turns | Fresh input | Output | Cache read | Cache create |
| --- | ----- | ----------- | ------ | ---------- | ------------ |
${dayRows}

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
`;

  await writeFile(OUT_PATH, md, 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Included ${included.length} transcript(s), ${fmt(totalTurns)} assistant turns.`);
}

main().catch((err) => {
  console.error('cost-report failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
