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
    </div>
  );
}
