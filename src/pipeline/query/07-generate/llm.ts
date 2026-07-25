/**
 * The LLM itself — Stage 7's only ML dependency, and the first place this
 * project actually needs a language model. →  docs: ./README.md
 *
 * `node-llama-cpp` in-process, GGUF, via its Vulkan backend — see
 * docs/DECISIONS.md #0008. On this machine that means the Ryzen 5700G's
 * integrated GPU: modest VRAM, but `getLlama()` auto-detects it and offloads
 * for free, no config needed (verified: `llama.gpu === 'vulkan'` here).
 *
 * ── MANAGED SWAP ─────────────────────────────────────────────────────────────
 * Default: in-process (this file), GGUF via node-llama-cpp. To use a managed
 * endpoint instead (Ollama, Groq, vLLM, Together, OpenRouter — anything
 * OpenAI-compatible), add an adapter behind the same `generateAnswer`
 * signature and wire it in `generate.ts` via `opts.generateFn`. Only
 * `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` should need to change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getLlama,
  LlamaChatSession,
  resolveModelFile,
  type Llama,
  type LlamaModel,
} from 'node-llama-cpp';

/**
 * Qwen2.5-Coder-1.5B-Instruct, Q4_K_M — small enough to load and run on CPU/
 * iGPU in a few seconds, code-aware (this is a code-documentation assistant),
 * Apache-2.0 (commercially clean, unlike Llama's community license or
 * Codestral's non-commercial terms — see docs/DECISIONS.md #0008's old
 * Ollama-model reasoning, same logic applies to the GGUF choice).
 */
export const LLM_MODEL_URI =
  'hf:Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf';
const MODEL_DIR = '.cache/models/gguf';

let llamaPromise: Promise<Llama> | undefined;
let modelPromise: Promise<LlamaModel> | undefined;

function getLlamaInstance(): Promise<Llama> {
  llamaPromise ??= getLlama();
  return llamaPromise;
}

async function getModel(): Promise<LlamaModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const [llama, modelPath] = await Promise.all([
        getLlamaInstance(),
        resolveModelFile(LLM_MODEL_URI, MODEL_DIR),
      ]);
      return llama.loadModel({ modelPath });
    })();
  }
  return modelPromise;
}

export interface GenerateOptions {
  maxTokens?: number;
  /** Called with each streamed text chunk as it's generated, if you want live output. */
  onToken?: (chunk: string) => void;
}

const DEFAULT_MAX_TOKENS = 512;

/** Run one prompt through the model and return the full text (streamed via onToken as it goes). */
export async function generateAnswer(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  const model = await getModel();
  const context = await model.createContext();
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    return await session.prompt(prompt, {
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      onTextChunk: opts.onToken,
    });
  } finally {
    await context.dispose();
  }
}
