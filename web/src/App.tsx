import { useState } from 'react';
import { AskTab } from './components/AskTab.tsx';
import { PipelineFlowchart } from './components/PipelineFlowchart.tsx';
import { UnderstandTab } from './components/UnderstandTab.tsx';

type Tab = 'ask' | 'understand';

const LANGUAGES: { name: string; color: 'violet' | 'ember' | 'green' | 'amber' | 'rose' }[] = [
  { name: 'TypeScript', color: 'violet' },
  { name: 'JavaScript', color: 'amber' },
  { name: 'Python', color: 'green' },
  { name: 'Java', color: 'rose' },
  { name: 'Go', color: 'ember' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('ask');

  return (
    <div className="app">
      <header className="app-header">
        <h1>code-documentation-assistant</h1>
        <p>Ask any codebase questions in plain English, get answers with file:line citations.</p>
        <div className="supports-row">
          <span className="supports-label">Supports</span>
          {LANGUAGES.map((l) => (
            <span key={l.name} className={`badge-lang badge-${l.color}`}>
              {l.name}
            </span>
          ))}
          <span className="supports-note">+ config/build files (JSON, YAML, TOML, …)</span>
        </div>
        <div className="tabs">
          <button
            className={`tab${tab === 'ask' ? ' tab-active' : ''}`}
            onClick={() => setTab('ask')}
          >
            Ask a repo
          </button>
          <button
            className={`tab${tab === 'understand' ? ' tab-active' : ''}`}
            onClick={() => setTab('understand')}
          >
            Understand the RAG pipeline
          </button>
        </div>
      </header>
      <div className="layout">
        <main className="tab-panel">
          {/* Both tabs stay mounted and are only hidden via CSS — conditionally
              rendering one or the other would unmount the inactive tab, and
              React throws away all its useState (indexed repo, asked question,
              streamed answer, everything) on unmount. Switching tabs should
              never lose an in-progress index/ask. */}
          <div style={{ display: tab === 'ask' ? 'block' : 'none' }}>
            <AskTab />
          </div>
          <div style={{ display: tab === 'understand' ? 'block' : 'none' }}>
            <UnderstandTab />
          </div>
        </main>
        <aside className="flow-sidebar">
          <PipelineFlowchart />
        </aside>
      </div>
      <footer className="site-footer">
        <a
          href="https://github.com/thalaivar-subu/code-documentation-assistant"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
        <a
          href="https://github.com/thalaivar-subu/code-documentation-assistant/blob/main/docs/ARCHITECTURE.md"
          target="_blank"
          rel="noreferrer"
        >
          Architecture
        </a>
        <a
          href="https://github.com/thalaivar-subu/code-documentation-assistant/blob/main/docs/DECISIONS.md"
          target="_blank"
          rel="noreferrer"
        >
          Decisions
        </a>
        <a href="https://www.linkedin.com/in/subramanian-ve/" target="_blank" rel="noreferrer">
          LinkedIn
        </a>
        <span className="footer-note">
          Local-first RAG · Node.js/TypeScript · open-source models
        </span>
      </footer>
    </div>
  );
}
