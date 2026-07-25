/**
 * Pipeline stage manifest — the single source of METADATA for every stage.
 *
 * Prose lives in each stage's own README.md (co-located with its code); this file
 * only holds the machine-readable metadata that links them together. It is consumed
 * by: the docs index generator, the `/architecture` UI page (later), and tests that
 * assert the folder layout matches the declared stages.
 *
 * Rule: one entry per stage folder. `dir` and `doc` are repo-relative paths.
 */

export type PipelineName = 'ingest' | 'query';
export type StageStatus = 'done' | 'in-progress' | 'planned';

export interface StageMeta {
  /** Order within its pipeline (matches the NN- folder prefix). */
  order: number;
  /** Stable id, e.g. 'clone'. */
  id: string;
  pipeline: PipelineName;
  title: string;
  /** One-line description shown collapsed in the UI pipeline bar. */
  summary: string;
  /** Repo-relative folder. */
  dir: string;
  /** Repo-relative path to the stage's README (its prose doc). */
  doc: string;
  /** Primary tool this stage is built on (undefined for pure-logic stages). */
  tool?: { name: string; pkg?: string };
  status: StageStatus;
}

export const INGEST_STAGES: StageMeta[] = [
  {
    order: 1,
    id: 'clone',
    pipeline: 'ingest',
    title: 'Clone',
    summary: 'Fetch the repo (partial clone) or read a local folder; capture repoId + commit.',
    dir: 'src/pipeline/ingest/01-clone',
    doc: 'src/pipeline/ingest/01-clone/README.md',
    tool: { name: 'simple-git', pkg: 'simple-git' },
    status: 'done',
  },
  {
    order: 2,
    id: 'chunk',
    pipeline: 'ingest',
    title: 'AST Chunking',
    summary: 'Parse files into a syntax tree; emit function/class-level chunks with line ranges.',
    dir: 'src/pipeline/ingest/02-chunk',
    doc: 'src/pipeline/ingest/02-chunk/README.md',
    tool: { name: 'web-tree-sitter', pkg: 'web-tree-sitter' },
    status: 'done',
  },
  {
    order: 3,
    id: 'embed',
    pipeline: 'ingest',
    title: 'Embed',
    summary: 'Turn each chunk into a vector (content-hash cached).',
    dir: 'src/pipeline/ingest/03-embed',
    doc: 'src/pipeline/ingest/03-embed/README.md',
    tool: { name: 'Transformers.js', pkg: '@huggingface/transformers' },
    status: 'done',
  },
  {
    order: 4,
    id: 'index',
    pipeline: 'ingest',
    title: 'Index',
    summary: 'Store vectors + lexical index with deterministic ids.',
    dir: 'src/pipeline/ingest/04-index',
    doc: 'src/pipeline/ingest/04-index/README.md',
    tool: { name: 'LanceDB + MiniSearch', pkg: '@lancedb/lancedb' },
    status: 'done',
  },
];

export const QUERY_STAGES: StageMeta[] = [
  {
    order: 1,
    id: 'route',
    pipeline: 'query',
    title: 'Route',
    summary: 'Classify the question (symbol / concept / trace).',
    dir: 'src/pipeline/query/01-route',
    doc: 'src/pipeline/query/01-route/README.md',
    status: 'done',
  },
  {
    order: 2,
    id: 'retrieve',
    pipeline: 'query',
    title: 'Retrieve',
    summary: 'Dense (vector) + lexical (BM25) search in parallel.',
    dir: 'src/pipeline/query/02-retrieve',
    doc: 'src/pipeline/query/02-retrieve/README.md',
    status: 'done',
  },
  {
    order: 3,
    id: 'fuse',
    pipeline: 'query',
    title: 'Fuse',
    summary: 'Merge the two ranked lists with Reciprocal Rank Fusion.',
    dir: 'src/pipeline/query/03-fuse',
    doc: 'src/pipeline/query/03-fuse/README.md',
    status: 'done',
  },
  {
    order: 4,
    id: 'rerank',
    pipeline: 'query',
    title: 'Rerank',
    summary: 'Cross-encoder reorders candidates; 50 → 8.',
    dir: 'src/pipeline/query/04-rerank',
    doc: 'src/pipeline/query/04-rerank/README.md',
    tool: { name: 'bge-reranker', pkg: '@huggingface/transformers' },
    status: 'done',
  },
  {
    order: 5,
    id: 'expand',
    pipeline: 'query',
    title: 'Expand',
    summary: 'Add callers/callees via the symbol graph.',
    dir: 'src/pipeline/query/05-expand',
    doc: 'src/pipeline/query/05-expand/README.md',
    status: 'done',
  },
  {
    order: 6,
    id: 'grade',
    pipeline: 'query',
    title: 'Grade',
    summary: 'Enough to answer? If not, loop back to Retrieve (the agent cycle).',
    dir: 'src/pipeline/query/06-grade',
    doc: 'src/pipeline/query/06-grade/README.md',
    tool: { name: 'heuristics + a hand-rolled loop (LangGraph deferred, see README)' },
    status: 'done',
  },
  {
    order: 7,
    id: 'generate',
    pipeline: 'query',
    title: 'Generate',
    summary: 'Stream a cited answer from the LLM.',
    dir: 'src/pipeline/query/07-generate',
    doc: 'src/pipeline/query/07-generate/README.md',
    tool: { name: 'node-llama-cpp', pkg: 'node-llama-cpp' },
    status: 'done',
  },
  {
    order: 8,
    id: 'verify',
    pipeline: 'query',
    title: 'Verify',
    summary: 'Check every cited file:line resolves to real context.',
    dir: 'src/pipeline/query/08-verify',
    doc: 'src/pipeline/query/08-verify/README.md',
    status: 'done',
  },
];

export const ALL_STAGES: StageMeta[] = [...INGEST_STAGES, ...QUERY_STAGES];
