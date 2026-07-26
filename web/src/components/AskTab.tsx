import { useEffect, useRef, useState } from 'react';
import {
  askQuestion,
  fetchRepos,
  indexRepo,
  type AskDoneEvent,
  type HopEvent,
  type IndexedRepo,
  type IndexDoneEvent,
  type RouteEvent,
} from '../api.ts';
import { PipelineBar, type PipelineStageView } from './PipelineBar.tsx';

const INGEST_STAGES = [
  { id: 'clone', title: 'Clone' },
  { id: 'chunk', title: 'Chunk' },
  { id: 'embed', title: 'Embed' },
  { id: 'index', title: 'Index' },
];

const QUERY_STAGES = [
  { id: 'route', title: 'Route' },
  { id: 'retrieve', title: 'Retrieve' },
  { id: 'fuse', title: 'Fuse' },
  { id: 'rerank', title: 'Rerank' },
  { id: 'expand', title: 'Expand' },
  { id: 'grade', title: 'Grade' },
  { id: 'generate', title: 'Generate' },
  { id: 'verify', title: 'Verify' },
];

const HISTORY_LIMIT = 5;

interface HistoryEntry {
  id: string;
  repoId: string;
  question: string;
  answer: string;
  route: RouteEvent | null;
  hops: HopEvent[];
  askResult: AskDoneEvent;
}

export function AskTab() {
  const [repo, setRepo] = useState('');
  const [indexing, setIndexing] = useState(false);
  const [indexLog, setIndexLog] = useState<string[]>([]);
  const [indexResult, setIndexResult] = useState<IndexDoneEvent | null>(null);
  const [indexStage, setIndexStage] = useState<string | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [route, setRoute] = useState<RouteEvent | null>(null);
  const [hops, setHops] = useState<HopEvent[]>([]);
  const [answer, setAnswer] = useState('');
  const [askResult, setAskResult] = useState<AskDoneEvent | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const [indexedRepos, setIndexedRepos] = useState<IndexedRepo[]>([]);

  // route/hops accumulate via SSE events during a single ask; the onDone
  // closure below was created once, at call time, so it can't see later
  // setRoute/setHops updates — these refs mirror the same values so onDone
  // can read the final, accumulated state instead of a stale snapshot.
  const routeRef = useRef<RouteEvent | null>(null);
  const hopsRef = useRef<HopEvent[]>([]);
  const nextHistoryId = useRef(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    fetchRepos()
      .then(setIndexedRepos)
      .catch(() => setIndexedRepos([])); // best-effort — an empty list just hides the picker
  }, [indexResult]);

  function pickIndexedRepo(r: IndexedRepo) {
    setIndexError(null);
    setIndexLog([]);
    setIndexStage(null);
    setAskResult(null);
    setIndexResult({
      repoId: r.repoId,
      chunksIndexed: r.chunksIndexed,
      vectorCount: r.chunksIndexed,
      lexicalCount: r.chunksIndexed,
    });
  }

  /**
   * Editing the repo field invalidates whatever is currently indexed — without
   * this, a pill click (or an earlier index) stays "active" while a completely
   * different, not-yet-indexed URL sits in the box, with no visible link
   * between the two. Forces an explicit re-index or re-pick instead of asking
   * against a target the user can no longer see confirmed anywhere.
   */
  function handleRepoInputChange(value: string) {
    setRepo(value);
    if (indexResult) {
      setIndexResult(null);
      setAskResult(null);
      setAnswer('');
      setRoute(null);
      setHops([]);
    }
  }

  async function handleIndex() {
    setIndexing(true);
    setIndexLog([]);
    setIndexResult(null);
    setIndexError(null);
    setIndexStage(null);
    setAskResult(null);
    try {
      await indexRepo(repo, {
        onStep: (e) => {
          setIndexStage(e.stage);
          setIndexLog((log) => [...log, `[${e.stage}] ${e.message}`]);
        },
        onDone: (e) => setIndexResult(e),
        onError: (message) => setIndexError(message),
      });
    } catch (err) {
      setIndexError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  }

  async function handleAsk() {
    if (!indexResult) return;
    const repoId = indexResult.repoId;
    setAsking(true);
    routeRef.current = null;
    hopsRef.current = [];
    setRoute(null);
    setHops([]);
    setAnswer('');
    setAskResult(null);
    setAskError(null);
    try {
      await askQuestion(
        { repoId, question, maxTokens: 250 },
        {
          onRoute: (e) => {
            routeRef.current = e;
            setRoute(e);
          },
          onHop: (e) => {
            hopsRef.current = [...hopsRef.current, e];
            setHops((h) => [...h, e]);
          },
          onToken: (t) => setAnswer((a) => a + t),
          onDone: (e) => {
            setAskResult(e);
            setHistory((h) =>
              [
                {
                  id: String(nextHistoryId.current++),
                  repoId,
                  question,
                  answer: e.answer,
                  route: routeRef.current,
                  hops: hopsRef.current,
                  askResult: e,
                },
                ...h,
              ].slice(0, HISTORY_LIMIT),
            );
          },
          onError: (message) => setAskError(message),
        },
      );
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  function revisitHistory(entry: HistoryEntry) {
    setQuestion(entry.question);
    setRoute(entry.route);
    setHops(entry.hops);
    setAnswer(entry.answer);
    setAskResult(entry.askResult);
    setAskError(null);
  }

  const ingestStages: PipelineStageView[] = INGEST_STAGES.map((s) => {
    const order = INGEST_STAGES.findIndex((x) => x.id === s.id);
    const currentOrder = indexStage ? INGEST_STAGES.findIndex((x) => x.id === indexStage) : -1;
    let status: PipelineStageView['status'] = 'pending';
    if (indexResult) status = 'done';
    else if (order < currentOrder) status = 'done';
    else if (order === currentOrder) status = 'active';
    return { id: s.id, title: s.title, status };
  });

  const lastHop = hops[hops.length - 1];
  const looping = hops.length > 1;
  const queryStages: PipelineStageView[] = QUERY_STAGES.map((s) => {
    let status: PipelineStageView['status'] = 'pending';
    if (s.id === 'route') status = route ? 'done' : asking ? 'active' : 'pending';
    else if (['retrieve', 'fuse', 'rerank', 'expand'].includes(s.id)) {
      // Stays 'active' through every hop the grade loop takes — only the final,
      // sufficient hop (or a finished askResult) means these are truly done.
      status = route ? (askResult || lastHop?.grade.sufficient ? 'done' : 'active') : 'pending';
    } else if (s.id === 'grade') {
      status = lastHop
        ? lastHop.grade.sufficient
          ? 'done'
          : 'insufficient'
        : route
          ? 'active'
          : 'pending';
    } else if (s.id === 'generate') {
      status = askResult
        ? 'done'
        : answer
          ? 'active'
          : lastHop?.grade.sufficient
            ? 'active'
            : 'pending';
    } else if (s.id === 'verify') {
      status = askResult ? 'done' : 'pending';
    }
    return {
      id: s.id,
      title: s.title,
      status,
      detail: s.id === 'grade' && looping ? `${hops.length} hops` : undefined,
    };
  });

  return (
    <div>
      <section className="panel">
        <h2>1. Index a repo</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!indexing && repo) handleIndex();
          }}
        >
          <input
            type="text"
            value={repo}
            onChange={(e) => handleRepoInputChange(e.target.value)}
            placeholder="e.g. https://github.com/thalaivar-subu/telemetry-go, or a local path"
          />
          <button type="submit" className="primary" disabled={indexing || !repo}>
            {indexing ? 'Indexing…' : 'Index'}
          </button>
        </form>
        {indexedRepos.length > 0 && (
          <div className="pill-row">
            {indexedRepos.map((r) => (
              <button
                key={r.repoId}
                type="button"
                className={`pill${indexResult?.repoId === r.repoId ? ' pill-active' : ''}`}
                onClick={() => pickIndexedRepo(r)}
                disabled={indexing}
                title="Already indexed — skip re-indexing and ask directly"
              >
                {r.repoId} · {r.chunksIndexed}
              </button>
            ))}
          </div>
        )}
        <PipelineBar stages={ingestStages} />
        {indexLog.length > 0 && <div className="log">{indexLog.join('\n')}</div>}
        {indexResult && (
          <p className="stage-explain">
            Indexed <strong>{indexResult.chunksIndexed}</strong> chunks ·{' '}
            <span className="badge">repoId: {indexResult.repoId}</span>
          </p>
        )}
        {indexError && <p className="stage-explain mark-bad">✗ {indexError}</p>}
      </section>

      <section className="panel">
        <h2>2. Ask a question</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!asking && indexResult && question) handleAsk();
          }}
        >
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="who calls RecordTaskDuration?"
          />
          <button type="submit" className="primary" disabled={asking || !indexResult || !question}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </form>
        {indexResult ? (
          <p className="stage-explain">
            Asking against <span className="badge">{indexResult.repoId}</span>
          </p>
        ) : (
          <p className="stage-explain">Index a repo first.</p>
        )}
        <PipelineBar stages={queryStages} />
        {(answer || asking) && (
          <div className="chunk-card">
            <div className="answer">{answer || '…'}</div>
          </div>
        )}
        {askResult && (
          <>
            {askResult.verify.hasCitations && (
              <p className="stage-explain" style={{ marginTop: 12 }}>
                citations: {askResult.verify.resolvedCount}/{askResult.verify.totalCount} resolved
              </p>
            )}
            <details style={{ marginTop: 6 }}>
              <summary className="stage-explain" style={{ cursor: 'pointer', marginBottom: 0 }}>
                Show pipeline trace — how this answer was reached
              </summary>
              <div style={{ marginTop: 10 }}>
                {route && (
                  <p className="stage-explain">
                    <strong>Route</strong> — intent: {route.intent}
                    {route.symbols.length > 0 && <> · symbols: {route.symbols.join(', ')}</>} —{' '}
                    {route.reason}
                  </p>
                )}
                {hops.length > 0 && (
                  <div className="stage-explain">
                    <strong>Grade loop</strong> ({hops.length} hop{hops.length > 1 ? 's' : ''})
                    <ul className="citation-list">
                      {hops.map((h) => (
                        <li key={h.hop}>
                          <span className={h.grade.sufficient ? 'mark-ok' : 'mark-bad'}>
                            {h.grade.sufficient ? '✓' : '↻'}
                          </span>
                          <span>
                            hop {h.hop}: "{h.query}" — {h.grade.reason}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {askResult.expanded.length > 0 && (
                  <div className="stage-explain">
                    <strong>Context used</strong> ({askResult.expanded.length} chunks)
                    <ul className="citation-list">
                      {askResult.expanded.map((hit) => (
                        <li key={hit.id}>
                          <span className="badge">{hit.via}</span>
                          <span>
                            {hit.symbolName} — {hit.filePath}:{hit.startLine}-{hit.endLine}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {askResult.citations.length > 0 && (
                  <div className="stage-explain">
                    <strong>Citations checked</strong>
                    <ul className="citation-list">
                      {askResult.verify.checks.map((c, i) => (
                        <li key={i}>
                          <span className={c.resolved ? 'mark-ok' : 'mark-bad'}>
                            {c.resolved ? '✓' : '✗'}
                          </span>
                          <span>
                            {c.citation.filePath}:{c.citation.startLine}-{c.citation.endLine}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          </>
        )}
        {askError && <p className="stage-explain mark-bad">✗ {askError}</p>}
      </section>

      {history.length > 0 && (
        <section className="panel">
          <h2>Recent questions</h2>
          <p className="stage-explain">
            Last {history.length} of {HISTORY_LIMIT} — click one to revisit its answer and trace.
          </p>
          <ul className="history-list">
            {history.map((h) => (
              <li key={h.id}>
                <button type="button" className="history-item" onClick={() => revisitHistory(h)}>
                  <span className="history-q">{h.question}</span>
                  <span className="badge">{h.repoId}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
