# Query · Stage 7 — Generate

> Turn the graded context into a cited answer — the first stage in this whole project that
> actually needs a language model. Linked from [`stages.manifest.ts`](../../stages.manifest.ts).

`generate(question, context, opts)` → `{ answer, citations }`.

## The LLM, and why it's local

|                  |                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model            | `Qwen2.5-Coder-1.5B-Instruct`, GGUF Q4_K_M (~1.1 GB)                                                                                                              |
| Runtime          | `node-llama-cpp`, in-process, Vulkan backend                                                                                                                      |
| Why this small   | Runs entirely on this machine's Ryzen 5700G iGPU (`llama.gpu === 'vulkan'`, confirmed) — zero services, zero API key, code-aware, Apache-2.0 (commercially clean) |
| Why local at all | Matches every other stage's "package, not a service" default — see [`docs/DECISIONS.md`](../../../../docs/DECISIONS.md) #0008                                     |

**Doc correction made while building this stage:** `DECISIONS.md` #0008 and `docs/PLAN.md`'s
locked-decisions table both said "Ollama default" — copied from an early draft ADR that predated
the actual governing decision (node-llama-cpp/Vulkan/APU, which is what this project has stated as
locked since planning and is what's actually built here). Both docs are now corrected to match.

## Managed swap

Same convention as every other ML stage in this project — see `llm.ts`'s header comment. Swap to
Ollama/Groq/vLLM/Together/OpenRouter by adding an `openai-compatible` adapter behind the same
`generateAnswer` signature; only `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` should need to change.

## A real bug this stage caught: one lockfile was over half of every prompt

The first real run against `telemetry-go` took **107.5 seconds** for one answer. Measuring the
actual prompt: 18 context chunks, 27,450 characters total — and `go.sum` (a Go dependency
_checksum_ file, not a declaration) alone was **14,705 of those characters**, over half the entire
prompt, for a file with zero documentation value. Root cause: `discover.ts`'s `CONFIG_NAMES` had
`go.sum` mapped to an indexable config format, while `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`
were already correctly excluded as noise — an inconsistency, not a deliberate choice. Fixed by
adding `go.sum` to the same exclusion list the JS lockfiles use. Result: the same question, same
repo, dropped to **21.9 seconds** — a ~5x improvement from one five-line fix. Regression test:
`discover.test.ts` confirms `go.mod` (a real declaration) stays indexed while `go.sum` doesn't.

A second, independent line of defense was added regardless: `buildPrompt` truncates any single
chunk's content past 1500 characters. `go.sum` no longer reaches this stage at all, but the cap
protects against the next thing that does (an oversized function chunk that slipped past Stage 2's
splitter, a different generated file, etc.) — tested directly in `generate.test.ts`.

## An honest limitation, not hidden: citation format compliance is inconsistent

The prompt hard-requires `(file:line)` citations for every claim, restated once more right before
the answer. In isolated single-chunk testing this measurably helped — the model went from stating a
fact with no citation at all to naming the file and line in prose. But under the real 18-chunk,
multi-source context the pipeline actually produces, the model still frequently gives a short,
factually-correct answer with **zero** citations, despite the instruction. This is a genuine,
measured characteristic of a 1.5B model, not a prompt bug to keep chasing — a larger model or a
managed endpoint would likely comply more reliably, at the cost of the zero-infra default.

This is exactly the gap Stage 8 (Verify, not built yet) exists for: it resolves every citation the
model _did_ produce against the real index, and — per its design — an answer with no resolvable
citations at all is a signal worth surfacing to the user, not silently accepting.

## Example output

Against a real public repo
([`thalaivar-subu/telemetry-go`](https://github.com/thalaivar-subu/telemetry-go)):

```bash
npm run generate -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --max-tokens 200
```

```
  question   "who calls RecordTaskDuration?"
  intent     trace
  hops       1  (18 chunks in final context)

  ── answer (streaming) ──

The function `RecordTaskDuration` is called by the `InstrumentProcessor` function.

  generated in 21946 ms
  citations resolved from text: 0
```

The answer is factually correct — `InstrumentProcessor`'s body (`telemetry/common.go`) really does
call `RecordTaskDuration` (visible in this repo's own chunk dump from Stage 2's README) — read
directly from the provided context, not from outside knowledge. It just didn't wrap that fact in
the required citation syntax, per the limitation above.

## Verify

```bash
npm test -- 07-generate                                                                            # prompt construction, citation regex (5 cases), truncation, real-model smoke test
npm test -- 02-chunk                                                                                # go.sum exclusion regression
npm run generate -- https://github.com/thalaivar-subu/telemetry-go "who calls RecordTaskDuration?" --max-tokens 200
```

## Output feeds → Stage 8 (Verify)

`GenerateResult.citations` (whatever the model actually produced, possibly none) is what Stage
"Verify" (`src/pipeline/query/08-verify`, not built yet) will resolve against the real index —
checking each citation is real, and flagging when there's nothing to check at all.
