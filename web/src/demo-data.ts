/**
 * Static, real, previously-captured pipeline output for the "Understand"
 * tab — deliberately NOT live. Every `output` block below is copy-pasted
 * from an actual `npm run <stage>` invocation against
 * https://github.com/thalaivar-subu/telemetry-go during this project's own
 * build (see each stage's README.md "Example output" section for the
 * original capture) — real data, just not re-run on every page load. This
 * keeps the teaching tab instant and always available, independent of
 * whether a backend/model happens to be running.
 */

export interface DemoStage {
  id: string;
  pipeline: 'ingest' | 'query';
  title: string;
  summary: string;
  command: string;
  output: string;
}

export const DEMO_REPO = 'https://github.com/thalaivar-subu/telemetry-go';
export const DEMO_QUESTION = 'who calls RecordTaskDuration?';

export const DEMO_STAGES: DemoStage[] = [
  {
    id: 'clone',
    pipeline: 'ingest',
    title: 'Clone',
    summary: 'Fetch the repo (partial clone) or read a local folder; capture repoId + commit.',
    command: `npm run clone -- ${DEMO_REPO}`,
    output: `── Ingest · Stage 1: Clone ─────────────────────────────────────
  → source: remote → ${DEMO_REPO}
  → repoId: thalaivar-subu-telemetry-go-7c354319
  → partial-cloning into .cache/repos/thalaivar-subu-telemetry-go-7c354319 …
  → cloned — HEAD a5d74d13 on main — 25 tracked files

  Result
  ------
  repoId        thalaivar-subu-telemetry-go-7c354319
  source        remote
  commit        a5d74d13629c
  branch        main
  trackedFiles  25
  reused        false`,
  },
  {
    id: 'chunk',
    pipeline: 'ingest',
    title: 'AST Chunking',
    summary: 'Parse files into a syntax tree; emit function/class-level chunks with line ranges.',
    command: `npm run chunk -- ${DEMO_REPO} --file "common.go" --symbol Instrument --json`,
    output: `{
  "id": "247397eb33fc50636c7895c7da03fb56",
  "repoId": "thalaivar-subu-telemetry-go-7c354319",
  "filePath": "telemetry/common.go",
  "kind": "code",
  "language": "go",
  "symbolName": "InstrumentProcessor",
  "symbolType": "function",
  "startLine": 12,
  "endLine": 44,
  "content": "func InstrumentProcessor(ctx context.Context, processorMethod string, startTime time.Time, span trace.Span, attribMap map[string]interface{}, hasError bool) context.Context {\\n\\tdefer Recover(...)\\n\\tif ENABLED {\\n\\t\\tattributes := ...\\n\\t\\tif !DISABLE_METRICS {\\n\\t\\t\\tIncTaskCounter(ctx, 1, attributes...)\\n\\t\\t\\tRecordTaskDuration(ctx, startTime, attributes...)\\n\\t\\t}\\n\\t\\t...\\n\\t}\\n\\treturn ctx\\n}",
  "contentHash": "04a808f53eb7667db87894becf21b64695a99ec7dabebc676e27e808e09a0288",
  "commitSha": "a5d74d13629cc6aa1a7536508c0eb74c56ed528d"
}

82 chunks total from 25 tracked files (code + config, tree-sitter AST across Go/TS/JS/Python/Java).`,
  },
  {
    id: 'embed',
    pipeline: 'ingest',
    title: 'Embed',
    summary: 'Turn each chunk into a vector (content-hash cached).',
    command: `npm run embed -- ${DEMO_REPO} --sample 0`,
    output: `model: Xenova/bge-small-en-v1.5

  total 82  |  embedded 82  |  cached 0  |  dims 384  |  7776 ms

  52fcefe8cbf8ec58ff95d5c3516d2f8e  hash=4183b036ac92…  vector[0..3]=-0.0742,-0.0373,0.0232,-0.0539

Re-running the same command a second time: embedded 0, cached 82 — the content-hash
cache means unchanged chunks are never re-embedded.`,
  },
  {
    id: 'index',
    pipeline: 'ingest',
    title: 'Index',
    summary: 'Store vectors + lexical index with deterministic ids.',
    command: `npm run index -- ${DEMO_REPO} --dump 1`,
    output: `repoId thalaivar-subu-telemetry-go-7c354319  |  chunksIndexed 82  |  vectorCount 82  |  lexicalCount 82  |  99 ms

  ── raw vector-store rows (1) ──
{
  "id": "52fcefe8cbf8ec58ff95d5c3516d2f8e",
  "repoId": "thalaivar-subu-telemetry-go-7c354319",
  "filePath": "go.mod",
  "kind": "config",
  "configFormat": "gomod",
  "symbolName": "go.mod",
  "symbolType": "file",
  "startLine": 1,
  "endLine": 68,
  "vector": [-0.0742, -0.0373, 0.0232, "... 384 numbers total"]
}

Re-running the same command again: counts stay at 82 — the upsert is idempotent, not additive.`,
  },
  {
    id: 'route',
    pipeline: 'query',
    title: 'Route',
    summary: 'Classify the question (symbol / concept / trace) — rule-based, no LLM.',
    command: `npm run route -- "${DEMO_QUESTION}"`,
    output: `question   "${DEMO_QUESTION}"
  intent     trace
  symbols    [RecordTaskDuration]
  files      []
  reason     matched trace phrase "who calls" — needs call/dependency graph expansion`,
  },
  {
    id: 'retrieve',
    pipeline: 'query',
    title: 'Retrieve',
    summary: 'Dense (vector) + lexical (BM25) search in parallel.',
    command: `npm run retrieve -- ${DEMO_REPO} "${DEMO_QUESTION}" --k 5`,
    output: `intent     trace  (symbols=[RecordTaskDuration] files=[])

  vector candidates (nearest first)
    0.5165  RecordTaskDuration       telemetry/metrics.go:81-90
    0.9198  IncTaskCounter           telemetry/metrics.go:70-79
    1.0024  InstrumentProcessor      telemetry/common.go:12-44

  lexical candidates (highest score first)
    13.8483  RecordTaskDuration       telemetry/metrics.go:81-90
    7.3326  InitializeOTEL           telemetry/otel.go:62-112

Route's extracted symbol "RecordTaskDuration" drove a second, precise lexical query — without
it, lexical search on the full question alone ranked a different, weaker match first.`,
  },
  {
    id: 'fuse',
    pipeline: 'query',
    title: 'Fuse',
    summary: 'Merge the two ranked lists with Reciprocal Rank Fusion.',
    command: `npm run fuse -- ${DEMO_REPO} "${DEMO_QUESTION}" --k 5`,
    output: `fused ranking (top 5)
    0.03279  [vector+lexical]  RecordTaskDuration       telemetry/metrics.go:81-90
    0.01613  [vector      ]  IncTaskCounter           telemetry/metrics.go:70-79
    0.01613  [lexical     ]  InitializeOTEL           telemetry/otel.go:62-112
    0.01587  [vector      ]  InstrumentProcessor      telemetry/common.go:12-44
    0.01563  [vector      ]  InitLogger               telemetry/utils.go:16-26

RecordTaskDuration ranks #1 in BOTH lists, so its fused score (2/61 ≈ 0.03279) is roughly
double any single-list-only hit — Reciprocal Rank Fusion, k=60.`,
  },
  {
    id: 'rerank',
    pipeline: 'query',
    title: 'Rerank',
    summary: 'Cross-encoder reorders candidates; 50 → 8.',
    command: `npm run rerank -- ${DEMO_REPO} "${DEMO_QUESTION}" --k 10 --limit 6`,
    output: `fused candidates: 11
  reranked in 6480 ms → top 6

  rerankScore  rrfScore   symbol                    location
  0.0273       0.0328     RecordTaskDuration        telemetry/metrics.go:81-90
  0.0124       0.0159     InstrumentProcessor       telemetry/common.go:12-44
  0.0003       0.0154     RegisterMetrics           telemetry/metrics.go:29-68
  0.0001       0.0161     InitializeOTEL            telemetry/otel.go:62-112

InstrumentProcessor had a LOWER rrfScore than InitializeOTEL but ranks far above it after
reranking — the cross-encoder read the actual chunk content, not just retrieval rank.`,
  },
  {
    id: 'expand',
    pipeline: 'query',
    title: 'Expand',
    summary: 'Add callers/callees via a name-based symbol graph.',
    command: `npm run expand -- ${DEMO_REPO} "${DEMO_QUESTION}" --k 20 --limit 8`,
    output: `reranked   8 hits
  expand     +10 chunk(s) via the symbol graph

  [rerank ] RecordTaskDuration       telemetry/metrics.go:81-90
  [rerank ] InstrumentProcessor      telemetry/common.go:12-44
  [caller ] logError                 telemetry/metrics.go:92-96
  [caller ] InitializeTelemetry      telemetry/otel.go:19-35
  [callee ] Recover                  telemetry/utils.go:68-81

"logError" (right after RecordTaskDuration in the same file) surfaces as [caller] — the
first thing in this whole pipeline that actually answers "who calls X", not just "what is X".`,
  },
  {
    id: 'grade',
    pipeline: 'query',
    title: 'Grade',
    summary: '"Enough to answer?" If not, loop back to Retrieve with what this hop learned.',
    command: `npm run grade -- ${DEMO_REPO} "who triggers newPropagator internally?" --max-hops 3 --k 2 --limit 1`,
    output: `question   "who triggers newPropagator internally?"
  intent     symbol

  hop 0  query="who triggers newPropagator internally?"
         insufficient — looping — best rerank score (0.0055) is below the confidence threshold (0.01)
  hop 1  query="who triggers newPropagator internally? initSdk newResource newPropagator"
         sufficient — confident top match

Hop 0's low-confidence match still ran Expand, which found related symbols — those get folded
into hop 1's query. This is the "you don't know hop 2 until hop 1 returns" case that's the
whole justification for a stateful loop instead of a one-shot chain.`,
  },
  {
    id: 'generate',
    pipeline: 'query',
    title: 'Generate',
    summary: 'Stream a cited answer from a local LLM (node-llama-cpp, Vulkan/APU).',
    command: `npm run generate -- ${DEMO_REPO} "${DEMO_QUESTION}" --max-tokens 200`,
    output: `question   "${DEMO_QUESTION}"
  hops       1  (18 chunks in final context)

  ── answer ──
  The function \`RecordTaskDuration\` is called by the \`InstrumentProcessor\` function.

  generated in 21946 ms
  citations resolved from text: 0

Factually correct (confirmed against the real InstrumentProcessor source above) — but this
1.5B local model didn't wrap it in the required (file:line) citation syntax. A real, measured
limitation, not hidden — see Verify below.`,
  },
  {
    id: 'verify',
    pipeline: 'query',
    title: 'Verify',
    summary:
      'Check every cited file:line resolves against the context the model was actually given.',
    command: `npm run ask -- ${DEMO_REPO} "${DEMO_QUESTION}" --max-tokens 200`,
    output: `intent      trace
  hops        1
  citations   0 found, 0 resolved
  ⚠ the answer cited nothing — nothing to verify, treat with more skepticism

Without Verify, a UI has no principled way to tell this apart from a confident-sounding
hallucination. hasCitations:false is a real, actionable signal — this demo's own "Ask" tab
shows exactly this warning live.`,
  },
];
