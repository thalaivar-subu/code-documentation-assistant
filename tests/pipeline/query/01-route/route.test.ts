/**
 * Tests for Query · Stage 1 (Route) — rule-based intent classification.
 */

import { describe, expect, it } from 'vitest';
import { routeQuery } from '../../../../src/pipeline/query/01-route/route.ts';

describe('routeQuery — symbol intent', () => {
  it('detects a PascalCase identifier', () => {
    const r = routeQuery('What does RecordTaskDuration do?');
    expect(r.intent).toBe('symbol');
    expect(r.symbols).toContain('RecordTaskDuration');
  });

  it('detects a camelCase identifier', () => {
    const r = routeQuery('Explain chunkRepo please');
    expect(r.intent).toBe('symbol');
    expect(r.symbols).toContain('chunkRepo');
  });

  it('detects a snake_case identifier', () => {
    const r = routeQuery('What is record_task_duration for?');
    expect(r.intent).toBe('symbol');
    expect(r.symbols).toContain('record_task_duration');
  });

  it('detects a backtick-quoted token regardless of casing', () => {
    const r = routeQuery('What is `add` used for?');
    expect(r.intent).toBe('symbol');
    expect(r.symbols).toContain('add');
  });

  it('detects a filename', () => {
    const r = routeQuery('What does clone.ts do?');
    expect(r.intent).toBe('symbol');
    expect(r.files).toContain('clone.ts');
  });

  it('does not false-positive on an ordinary single-word capitalized term', () => {
    const r = routeQuery('How does Docker work here?');
    expect(r.intent).toBe('concept');
    expect(r.symbols).toEqual([]);
  });

  it('dedupes a symbol mentioned twice', () => {
    const r = routeQuery('Does chunkRepo handle both code and config? Explain chunkRepo fully.');
    expect(r.symbols.filter((s) => s === 'chunkRepo')).toHaveLength(1);
  });
});

describe('routeQuery — trace intent', () => {
  it('detects "who calls"', () => {
    const r = routeQuery('Who calls RecordTaskDuration?');
    expect(r.intent).toBe('trace');
    expect(r.symbols).toContain('RecordTaskDuration');
  });

  it('detects "used by"', () => {
    const r = routeQuery('Where is chunkRepo used by other files?');
    expect(r.intent).toBe('trace');
  });

  it('detects "depends on"', () => {
    const r = routeQuery('What does the embed stage depend on?');
    expect(r.intent).toBe('trace');
  });

  it('trace phrase takes priority over a plain symbol match', () => {
    const r = routeQuery('What calls RecordTaskDuration?');
    expect(r.intent).toBe('trace');
    expect(r.symbols).toContain('RecordTaskDuration'); // still extracted, just not the deciding intent
  });
});

describe('routeQuery — manifest intent', () => {
  it('detects a bare "dependencies" mention with no code symbol', () => {
    const r = routeQuery('Give me the dependencies bro');
    expect(r.intent).toBe('manifest');
  });

  it('detects "what packages"', () => {
    const r = routeQuery('What packages does this project use?');
    expect(r.intent).toBe('manifest');
  });

  it('detects an explicit manifest filename mention', () => {
    const r = routeQuery("What's declared in package.json?");
    expect(r.intent).toBe('manifest');
  });

  it('"dependencies of X" still routes to trace, not manifest (code-level tracing wins)', () => {
    const r = routeQuery('What are the dependencies of the embed stage?');
    expect(r.intent).toBe('trace');
  });
});

describe('routeQuery — concept intent (fallback)', () => {
  it('classifies a general architecture question as concept', () => {
    const r = routeQuery('How does authentication work in this system?');
    expect(r.intent).toBe('concept');
    expect(r.symbols).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('classifies a why-this-tool question with no identifier-like tokens as concept', () => {
    const r = routeQuery('Why was a vector database chosen over a relational one?');
    expect(r.intent).toBe('concept');
  });

  it('does route a compound-capitalized product name as symbol (two-hump PascalCase is a real heuristic hit, not a bug)', () => {
    const r = routeQuery('Why was LanceDB chosen over a managed vector database?');
    expect(r.intent).toBe('symbol');
    expect(r.symbols).toContain('LanceDB');
  });
});

describe('routeQuery — reason field', () => {
  it('always returns a non-empty explanation', () => {
    for (const q of ['What calls foo?', 'Explain fooBar', 'How does this work?']) {
      expect(routeQuery(q).reason.length).toBeGreaterThan(0);
    }
  });
});
