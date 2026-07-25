/**
 * Query · Stage 7 — Generate. Turns the graded context into a cited answer.
 * →  docs: ./README.md
 */

import type { ExpandedHit } from '../05-expand/expand.ts';
import { generateAnswer, type GenerateOptions } from './llm.ts';

/**
 * Per-chunk content cap, independent of any upstream fix (like excluding
 * go.sum in discover.ts — see 07-generate/README.md): this in-process model
 * has no dedicated GPU, and prompt-processing time scales with prompt size,
 * so one abnormally large chunk (a generated file, an oversized function
 * that slipped through Stage 2's splitter) can dominate response latency all
 * by itself. Truncating defends the prompt regardless of what produced it.
 */
const MAX_CHUNK_CONTENT_CHARS = 1500;

function truncateContent(content: string): string {
  if (content.length <= MAX_CHUNK_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_CHUNK_CONTENT_CHARS)}\n… (truncated, ${content.length} chars total)`;
}

/**
 * Every claim must cite `file:line` or `file:line-line` — enforced by the
 * prompt, checked for real by Stage 8 (Verify, not built yet), which
 * resolves each citation against the actual index instead of trusting the
 * model said something plausible-looking.
 */
export function buildPrompt(question: string, context: ExpandedHit[]): string {
  const contextBlock = context
    .map(
      (c) =>
        `### ${c.filePath}:${c.startLine}-${c.endLine} (${c.symbolName})\n\`\`\`\n${truncateContent(c.content)}\n\`\`\``,
    )
    .join('\n\n');

  return [
    'You are a code documentation assistant. Answer the question using ONLY the code context',
    'below — do not use outside knowledge or guess. Every factual claim MUST cite the exact',
    'file:line it came from, in parentheses, e.g. (src/foo.ts:10-15). If the context does not',
    'contain enough information to answer, say so explicitly instead of guessing.',
    '',
    '## Question',
    question,
    '',
    '## Context',
    contextBlock || '(no context was retrieved)',
    '',
    '## Answer (remember: cite file:line for every claim, using the file:line shown in each ### heading above)',
  ].join('\n');
}

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
}

// A filename-with-extension, a colon, a line number, and an optional -endLine.
const CITATION_RE =
  /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+):(\d+)(?:-(\d+))?/g;

/** Pull every `file:line[-line]` the model cited out of its answer text. */
export function extractCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const [, filePath, start, end] = m;
    citations.push({
      filePath,
      startLine: Number(start),
      endLine: end ? Number(end) : Number(start),
    });
  }
  return citations;
}

export interface GenerateResult {
  answer: string;
  citations: Citation[];
}

export interface GenerateStageOptions extends GenerateOptions {
  /** Swap the generation function — tests inject a fake to skip loading the real model. */
  generateFn?: (prompt: string, opts: GenerateOptions) => Promise<string>;
}

export async function generate(
  question: string,
  context: ExpandedHit[],
  opts: GenerateStageOptions = {},
): Promise<GenerateResult> {
  const generateFn = opts.generateFn ?? generateAnswer;
  const prompt = buildPrompt(question, context);
  const answer = await generateFn(prompt, opts);
  return { answer, citations: extractCitations(answer) };
}
