import { Fragment } from 'react';

const INGEST = [
  { name: 'Clone', tool: 'simple-git' },
  { name: 'Chunk', tool: 'tree-sitter (AST)' },
  { name: 'Embed', tool: 'Transformers.js' },
  { name: 'Index', tool: 'LanceDB + MiniSearch' },
];

const QUERY = [
  { name: 'Route', tool: 'regex heuristics' },
  { name: 'Retrieve', tool: 'dense + BM25' },
  { name: 'Fuse', tool: 'RRF' },
  { name: 'Rerank', tool: 'bge-reranker' },
  { name: 'Expand', tool: 'symbol graph' },
  { name: 'Grade', tool: 'score heuristic' },
  { name: 'Generate', tool: 'local LLM (llama.cpp)' },
  { name: 'Verify', tool: 'citation check' },
];

/**
 * Static reference diagram of the full 12-stage architecture — always visible,
 * unlike PipelineBar which only lights up during a real index/ask run. Gives
 * a map of the whole system, and what actually runs each stage, at a glance
 * without needing to run anything.
 */
export function PipelineFlowchart() {
  return (
    <div className="flowchart">
      <h3>How it works</h3>

      <div className="flow-group">
        <span className="flow-label">Ingest — once per repo</span>
        <div className="flow-col">
          {INGEST.map((s, i) => (
            <Fragment key={s.name}>
              <div className="flow-node">
                {s.name}
                <span className="flow-tool">{s.tool}</span>
              </div>
              {i < INGEST.length - 1 && (
                <span className="flow-down" aria-hidden="true">
                  ↓
                </span>
              )}
            </Fragment>
          ))}
        </div>
      </div>

      <div className="flow-group">
        <span className="flow-label">Query — per question</span>
        <div className="flow-col">
          {QUERY.map((s, i) => (
            <Fragment key={s.name}>
              <div className={`flow-node${s.name === 'Grade' ? ' flow-node-loop' : ''}`}>
                {s.name}
                <span className="flow-tool">{s.tool}</span>
                {s.name === 'Grade' && <span className="flow-loop-tag">↺ retrieve</span>}
              </div>
              {i < QUERY.length - 1 && (
                <span className="flow-down" aria-hidden="true">
                  ↓
                </span>
              )}
            </Fragment>
          ))}
        </div>
      </div>

      <p className="flow-note">
        Grade is the one deliberate loop — it decides whether to answer or fetch another round of
        context.
      </p>
    </div>
  );
}
