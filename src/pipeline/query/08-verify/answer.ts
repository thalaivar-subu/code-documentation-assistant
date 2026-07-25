/**
 * The whole query pipeline, end to end: Route → {Retrieve → Fuse → Rerank →
 * Expand → Grade}×hops → Generate → Verify. →  docs: ./README.md
 */

import type { Chunk } from '../../../core/types.ts';
import {
  runQueryLoop,
  type QueryLoopOptions,
  type QueryLoopResult,
} from '../06-grade/query-loop.ts';
import { generate, type Citation, type GenerateStageOptions } from '../07-generate/generate.ts';
import { verifyCitations, type VerifyResult } from './verify.ts';

export interface AnswerResult extends QueryLoopResult {
  answer: string;
  citations: Citation[];
  verify: VerifyResult;
}

export async function answerQuestion(
  repoId: string,
  question: string,
  allChunks: Chunk[],
  opts: QueryLoopOptions & GenerateStageOptions = {},
): Promise<AnswerResult> {
  const loop = await runQueryLoop(repoId, question, allChunks, opts);
  const { answer, citations } = await generate(question, loop.expanded, opts);
  const verify = verifyCitations(citations, loop.expanded);
  return { ...loop, answer, citations, verify };
}
