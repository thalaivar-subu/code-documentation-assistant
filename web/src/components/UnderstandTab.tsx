import { useState } from 'react';
import { DEMO_QUESTION, DEMO_REPO, DEMO_STAGES } from '../demo-data.ts';
import { PipelineBar, type PipelineStageView } from './PipelineBar.tsx';

const INGEST = DEMO_STAGES.filter((s) => s.pipeline === 'ingest');
const QUERY = DEMO_STAGES.filter((s) => s.pipeline === 'query');

export function UnderstandTab() {
  const [selectedId, setSelectedId] = useState(DEMO_STAGES[0].id);
  const selected = DEMO_STAGES.find((s) => s.id === selectedId)!;

  const toView = (stages: typeof DEMO_STAGES): PipelineStageView[] =>
    stages.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.id === selectedId ? 'active' : 'done',
    }));

  return (
    <div>
      <section className="panel">
        <p className="stage-explain">
          Real, captured output from this project's own build — every card below is copy-pasted from
          an actual run against{' '}
          <a href={DEMO_REPO} target="_blank" rel="noreferrer">
            thalaivar-subu/telemetry-go
          </a>{' '}
          answering <em>"{DEMO_QUESTION}"</em> (Grade uses a second question to show a real 2-hop
          loop). Click any stage to see what it actually produced.
        </p>

        <h3>Ingest pipeline (offline, once per repo)</h3>
        <PipelineBar stages={toView(INGEST)} onSelect={setSelectedId} selectedId={selectedId} />

        <h3 style={{ marginTop: 18 }}>Query pipeline (per question)</h3>
        <PipelineBar stages={toView(QUERY)} onSelect={setSelectedId} selectedId={selectedId} />
      </section>

      <section className="panel">
        <h2>
          {selected.title}
          <span className="badge" style={{ marginLeft: 10 }}>
            {selected.pipeline}
          </span>
        </h2>
        <p className="stage-explain">{selected.summary}</p>
        <div className="chunk-card">
          <div className="chunk-card-header">
            <span>$ {selected.command}</span>
          </div>
          <pre>{selected.output}</pre>
        </div>
      </section>
    </div>
  );
}
