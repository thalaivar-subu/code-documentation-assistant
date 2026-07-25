import { useState } from 'react';
import { AskTab } from './components/AskTab.tsx';
import { UnderstandTab } from './components/UnderstandTab.tsx';

type Tab = 'ask' | 'understand';

export function App() {
  const [tab, setTab] = useState<Tab>('ask');

  return (
    <div className="app">
      <header className="app-header">
        <h1>code-documentation-assistant</h1>
        <p>Ask any codebase questions in plain English, get answers with file:line citations.</p>
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
      <main className="tab-panel">{tab === 'ask' ? <AskTab /> : <UnderstandTab />}</main>
    </div>
  );
}
