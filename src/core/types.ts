/**
 * Shared domain types. Kept intentionally small and grown one pipeline stage at a
 * time, so each type earns its place by being used.
 *
 * Stage 1 (Clone) introduces: RepoSource and CloneResult.
 * Stage 2 (Chunk) introduces: CodeLanguage, FileKind and FileEntry.
 */

/** Where the code to be indexed comes from. */
export type RepoSource = { kind: 'remote'; url: string } | { kind: 'local'; path: string };

/** Languages we chunk with a real AST (tree-sitter). */
export type CodeLanguage = 'ts' | 'js' | 'python' | 'java' | 'go';

/**
 * What a file *is*, which decides how it gets chunked:
 *  - 'code'   → AST chunking by `language`.
 *  - 'config' → build/deploy/config (Dockerfile, CI, k8s/Helm, Terraform, manifests…);
 *               structured/whole-file chunking. Answers "how is this built & deployed?".
 *  - 'text'   → prose/other (markdown, scripts). Opt-in only, text-splitter chunking.
 */
export type FileKind = 'code' | 'config' | 'text';

/**
 * One discovered source file (Stage 2, part A). `sha256` is the incremental-indexing
 * key: on re-index, files whose hash is unchanged are skipped entirely.
 */
export interface FileEntry {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the repo root, POSIX-style (stable across OSes, good for citations). */
  relPath: string;
  kind: FileKind;
  /** Set only when `kind === 'code'`. */
  language?: CodeLanguage;
  /** Set only when `kind === 'config'`, e.g. 'dockerfile' | 'yaml' | 'json' | 'toml' | 'hcl'. */
  configFormat?: string;
  sizeBytes: number;
  sha256: string;
}

/** What a chunk represents. Code chunks use the specific symbol kinds; config/text use 'file'/'block'. */
export type SymbolType =
  'function' | 'method' | 'class' | 'interface' | 'enum' | 'record' | 'type' | 'file' | 'block';

/**
 * The atom of the system (Stage 2, part B output). A retrievable, citable unit —
 * usually one function/class for code, or a whole small config file. `startLine`/
 * `endLine` come straight from the parser, which is where citations come from.
 */
export interface Chunk {
  /** Deterministic id — stable across runs so re-indexing upserts instead of duplicating. */
  id: string;
  repoId: string;
  /** Repo-relative POSIX path of the source file. */
  filePath: string;
  kind: FileKind;
  language?: CodeLanguage;
  configFormat?: string;
  symbolName: string;
  symbolType: SymbolType;
  /** Enclosing class/namespace, when the chunk is a method inside one. */
  parentSymbol?: string;
  startLine: number;
  endLine: number;
  content: string;
  /** sha256 of `content` — the embedding cache key. */
  contentHash: string;
  /** HEAD commit at index time (for citation permalinks + incremental diffs). */
  commitSha?: string;
}

/**
 * The output of Stage 1. Everything downstream (chunking, embedding, indexing)
 * keys off `repoId` and reads files from `repoPath`. `commitSha` is what makes
 * incremental re-indexing possible later — it is the anchor for `git diff`.
 */
export interface CloneResult {
  /** Deterministic, filesystem-safe id derived from the source. Stable across runs. */
  repoId: string;
  /** Absolute path to the working tree on disk. */
  repoPath: string;
  /** How the repo was obtained. */
  source: RepoSource;
  /** HEAD commit. Empty string only if the local source is not a git repo. */
  commitSha: string;
  /** Current branch name, or 'DETACHED' / '' when not on a branch. */
  branch: string;
  /** Number of git-tracked files (a quick sanity signal that the clone worked). */
  trackedFiles: number;
  /** True when an existing local dir or previous clone was reused instead of re-fetched. */
  reused: boolean;
}
