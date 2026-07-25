/**
 * Tests for Query · Stage 7 (Generate) — prompt construction and citation
 * extraction (pure, fast) plus one real-model smoke test.
 */

import { describe, expect, it } from 'vitest';
import type { ExpandedHit } from '../05-expand/expand.ts';
import { buildPrompt, extractCitations, generate } from './generate.ts';

function hit(overrides: Partial<ExpandedHit> = {}): ExpandedHit {
  return {
    id: 'a',
    filePath: 'telemetry/metrics.go',
    symbolName: 'RecordTaskDuration',
    startLine: 81,
    endLine: 90,
    content: 'func RecordTaskDuration() {}',
    commitSha: '',
    rerankScore: 0.5,
    rrfScore: 0.1,
    sources: ['vector'],
    via: 'rerank',
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('includes the question, every chunk file:line header, and its content', () => {
    const prompt = buildPrompt('who calls RecordTaskDuration?', [hit()]);
    expect(prompt).toContain('who calls RecordTaskDuration?');
    expect(prompt).toContain('telemetry/metrics.go:81-90');
    expect(prompt).toContain('func RecordTaskDuration() {}');
  });

  it('instructs the model to cite file:line and to refuse when insufficient', () => {
    const prompt = buildPrompt('q', [hit()]);
    expect(prompt).toMatch(/cite/i);
    expect(prompt).toMatch(/does not\s+contain enough information/i);
  });

  it('handles an empty context without crashing, and says so in the prompt', () => {
    const prompt = buildPrompt('q', []);
    expect(prompt).toContain('no context was retrieved');
  });

  it('truncates an abnormally large chunk instead of feeding it whole into the prompt', () => {
    // Regression: a real repo's go.sum chunk was 14.7KB and dominated an
    // entire prompt by itself — this caps any single chunk's contribution
    // regardless of what produced it (discover.ts now excludes go.sum
    // specifically, but this is a second, independent line of defense).
    const huge = 'x'.repeat(5000);
    const prompt = buildPrompt('q', [hit({ content: huge })]);
    expect(prompt).toContain('… (truncated, 5000 chars total)');
    expect(prompt.length).toBeLessThan(huge.length);
  });

  it('does not truncate a normal-sized chunk', () => {
    const normal = 'function f() { return 1; }';
    const prompt = buildPrompt('q', [hit({ content: normal })]);
    expect(prompt).toContain(normal);
    expect(prompt).not.toContain('truncated');
  });
});

describe('extractCitations', () => {
  it('extracts a file:line-line citation', () => {
    const citations = extractCitations('This is defined in (telemetry/metrics.go:81-90).');
    expect(citations).toEqual([{ filePath: 'telemetry/metrics.go', startLine: 81, endLine: 90 }]);
  });

  it('extracts a single-line citation (no range)', () => {
    const citations = extractCitations('See src/foo.ts:42 for details.');
    expect(citations).toEqual([{ filePath: 'src/foo.ts', startLine: 42, endLine: 42 }]);
  });

  it('extracts multiple citations from one answer', () => {
    const citations = extractCitations(
      'RecordTaskDuration (telemetry/metrics.go:81-90) is called by logError (telemetry/metrics.go:92-96).',
    );
    expect(citations).toHaveLength(2);
    expect(citations[0].startLine).toBe(81);
    expect(citations[1].startLine).toBe(92);
  });

  it('returns an empty array when the answer cites nothing', () => {
    expect(extractCitations('I could not find enough information to answer this.')).toEqual([]);
  });

  it('handles a bare filename with no directory', () => {
    const citations = extractCitations('Defined in go.mod:1-68.');
    expect(citations).toEqual([{ filePath: 'go.mod', startLine: 1, endLine: 68 }]);
  });
});

describe('generate', () => {
  it('calls the injected generateFn with the built prompt and extracts its citations', async () => {
    let capturedPrompt = '';
    const generateFn = async (prompt: string) => {
      capturedPrompt = prompt;
      return 'It calls recordTaskDuration (telemetry/metrics.go:81-90).';
    };

    const result = await generate('who calls X?', [hit()], { generateFn });

    expect(capturedPrompt).toContain('who calls X?');
    expect(result.answer).toContain('recordTaskDuration');
    expect(result.citations).toEqual([
      { filePath: 'telemetry/metrics.go', startLine: 81, endLine: 90 },
    ]);
  });

  it('passes maxTokens/onToken through to the generate function', async () => {
    let receivedOpts: unknown;
    const generateFn = async (_prompt: string, opts: unknown) => {
      receivedOpts = opts;
      return 'answer';
    };
    await generate('q', [], { generateFn, maxTokens: 50 });
    expect(receivedOpts).toMatchObject({ maxTokens: 50 });
  });
});

describe('generate — real model', () => {
  it('produces a real, on-topic, cited answer from real context', async () => {
    const context = [
      hit({
        content:
          'func RecordTaskDuration(ctx context.Context, startTime time.Time) {\n\t// records how long a task took\n}',
      }),
    ];

    const result = await generate('What does RecordTaskDuration do?', context, { maxTokens: 150 });

    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.answer.toLowerCase()).toMatch(/duration|time|record/);
  }, 60_000);
});
