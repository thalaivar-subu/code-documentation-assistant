/**
 * Query · Stage 1 — Route. Classifies a question into one of three intents so
 * later stages know how to weight themselves, before any retrieval happens.
 * →  docs: ./README.md
 *
 * Rule-based, not LLM-based — deliberately. No LLM is wired into this project
 * yet (that's Phase 5); routing a question is cheap enough to do with regexes,
 * and doing it that way keeps this stage free, instant, and testable without a
 * model. Revisit only if real questions turn out to need judgment a few regexes
 * can't approximate.
 */

export type QueryIntent = 'symbol' | 'trace' | 'concept';

export interface RouteResult {
  intent: QueryIntent;
  /** Identifier-looking tokens found in the question (camelCase/PascalCase/snake_case/backticked). */
  symbols: string[];
  /** Filename-looking tokens found in the question (e.g. "clone.ts"). */
  files: string[];
  /** Short, deterministic explanation of why this intent was picked (UI popover / debugging). */
  reason: string;
}

const BACKTICKED_RE = /`([^`]+)`/g;
const CAMEL_CASE_RE = /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/g;
const PASCAL_CASE_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+\b/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const FILE_RE =
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|go|java|rb|rs|c|cpp|h|hpp|cs|php|kt|swift|md|json|ya?ml|toml)\b/gi;

/**
 * Ordered roughly by specificity — longer/more distinctive phrases first so a
 * generic word inside a longer match doesn't shadow it (matching is substring,
 * not word-boundary-only, since "who calls X" and "X's callers" both count).
 */
const TRACE_PHRASES = [
  'call chain',
  'call graph',
  'call stack',
  'who calls',
  'what calls',
  'called by',
  'calls into',
  'callers',
  'caller of',
  'callees',
  'callee of',
  'used by',
  'usage of',
  'depends on',
  'depend on',
  'dependency of',
  'dependencies of',
  'invoked by',
  'invokes',
  'invoked',
  'trace the',
  'flow of',
  'propagates',
  'propagate to',
];

function extractByPattern(question: string, re: RegExp): string[] {
  return [...question.matchAll(re)].map((m) => m[1] ?? m[0]);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function matchedTracePhrase(lowerQuestion: string): string | undefined {
  return TRACE_PHRASES.find((phrase) => lowerQuestion.includes(phrase));
}

export function routeQuery(question: string): RouteResult {
  const symbols = dedupe([
    ...extractByPattern(question, BACKTICKED_RE),
    ...extractByPattern(question, PASCAL_CASE_RE),
    ...extractByPattern(question, CAMEL_CASE_RE),
    ...extractByPattern(question, SNAKE_CASE_RE),
  ]);
  const files = dedupe(extractByPattern(question, FILE_RE));

  const tracePhrase = matchedTracePhrase(question.toLowerCase());
  if (tracePhrase) {
    return {
      intent: 'trace',
      symbols,
      files,
      reason: `matched trace phrase "${tracePhrase}" — needs call/dependency graph expansion`,
    };
  }

  if (symbols.length > 0 || files.length > 0) {
    const hit = symbols[0] ?? files[0];
    return {
      intent: 'symbol',
      symbols,
      files,
      reason: `found identifier-like token "${hit}" — likely asking about a specific symbol/file`,
    };
  }

  return {
    intent: 'concept',
    symbols,
    files,
    reason: 'no specific symbol, file, or trace phrase found — treated as a conceptual question',
  };
}
