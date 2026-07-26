/**
 * Every dev script under `src/scripts/` hand-rolled the same `--flag value`
 * argument parser (13 copies, character-for-character identical in most
 * cases) — see docs/REFACTOR-PLAN.md #17.
 */

export interface ParsedCliArgs {
  /** Non-flag tokens, in order. */
  positional: string[];
  /** The value following a value-flag (e.g. `--k 20` → getFlag('--k') === '20'), or undefined if absent. */
  getFlag(name: string): string | undefined;
  /** Whether a boolean flag (e.g. `--fresh`, `--json`) was present. */
  hasFlag(name: string): boolean;
}

/**
 * `valueFlags` lists which `--flag` names consume the NEXT token as a value.
 * Anything else starting with `--` is a standalone boolean flag whose
 * presence doesn't consume the following token. The old per-script parsers
 * didn't make this distinction — they filtered positionals with
 * `!a[i-1]?.startsWith('--')`, which assumed EVERY `--flag` takes a value.
 * A boolean flag placed before a positional (`npm run clone -- --fresh
 * myrepo`) silently ate `myrepo` as if it were `--fresh`'s value under that
 * old parser; explicitly declaring which flags take values fixes it.
 */
export function parseCliArgs(argv: string[], valueFlags: string[] = []): ParsedCliArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flagValues = new Map<string, string>();
  const boolFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positional.push(token);
    } else if (valueFlags.includes(token)) {
      flagValues.set(token, args[++i]);
    } else {
      boolFlags.add(token);
    }
  }

  return {
    positional,
    getFlag: (name) => flagValues.get(name),
    hasFlag: (name) => boolFlags.has(name),
  };
}

/** Prints a usage line and exits — the shared shape every script's "missing required arg" path used. */
export function usageError(usage: string): never {
  console.error(`Usage: ${usage}`);
  process.exit(1);
}
