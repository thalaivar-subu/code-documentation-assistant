/**
 * Ingest · Stage 1: Clone.  →  docs: ./README.md
 *
 * Turns a user-supplied source (a Git URL or a local folder) into a working tree
 * on disk plus the metadata later stages need: a stable `repoId`, the `repoPath`,
 * and the HEAD `commitSha` that anchors incremental re-indexing.
 *
 * Key behaviours (see README.md for the full rationale):
 *  - Partial clone (`--filter=blob:none`): full history, blobs on demand.
 *  - Idempotent reuse via a deterministic `repoId`.
 *  - Local folders are first-class (uploaded zip / existing checkout).
 *  - Private repos: falls back to a token (GITHUB_TOKEN / GIT_TOKEN / option),
 *    with interactive prompts disabled so a missing credential fails fast.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

import { redactToken, resolveGitToken } from '../../../core/config.ts';
import type { CloneResult, RepoSource } from '../../../core/types.ts';

/** Where remote repos are cloned. Under `.cache/`, which is gitignored. */
const REPOS_DIR = resolve('.cache', 'repos');

export type StepReporter = (message: string) => void;
const noop: StepReporter = () => {};

export interface CloneOptions {
  /** Force a fresh fetch even if a cached clone exists. Default: false (reuse). */
  fresh?: boolean;
  /** Explicit Git token for private repos. Falls back to env (GITHUB_TOKEN / GIT_TOKEN). */
  token?: string;
  /** Progress callback. */
  onStep?: StepReporter;
}

/** Classify a raw input string as a remote URL or a local path. */
export function parseSource(input: string): RepoSource {
  const trimmed = input.trim();
  const isRemote =
    /^https?:\/\//i.test(trimmed) ||
    /^git@/i.test(trimmed) ||
    /^ssh:\/\//i.test(trimmed) ||
    trimmed.endsWith('.git');
  return isRemote ? { kind: 'remote', url: trimmed } : { kind: 'local', path: resolve(trimmed) };
}

/**
 * Derive a stable, filesystem-safe id from the source. Same input → same id on
 * every run, which is what makes clone (and later indexing) idempotent.
 *
 *   https://github.com/expressjs/express.git  →  expressjs-express-1a2b3c4d
 *   /home/me/projects/foo                      →  foo-9f8e7d6c
 */
export function toRepoId(source: RepoSource): string {
  const raw = source.kind === 'remote' ? source.url : source.path;
  const name =
    source.kind === 'remote'
      ? raw
          .replace(/\.git$/, '')
          .split('/')
          .filter(Boolean)
          .slice(-2)
          .join('-')
      : basename(raw);
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'repo';
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/** True when a git error message looks like an auth/permission failure. */
function isAuthError(message: string): boolean {
  return /authentication failed|could not read Username|terminal prompts disabled|invalid username or password|remote: (Repository not found|Forbidden)|403|access denied|permission denied|please make sure you have the correct access/i.test(
    message,
  );
}

/** Inject a token into an https URL as the username (GitHub accepts a PAT this way). */
function withToken(url: string, token?: string): string {
  if (!token || !/^https:\/\//i.test(url)) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(token);
  u.password = '';
  return u.toString();
}

/** A git instance with interactive credential prompts disabled (fail fast, don't hang). */
function nonInteractive(baseDir?: string): SimpleGit {
  const git = baseDir ? simpleGit(baseDir) : simpleGit();
  // Copy the real env but drop editor vars — simple-git rejects EDITOR/GIT_EDITOR as
  // unsafe. We only need prompt-disabling here, not an editor.
  const env = { ...process.env };
  delete env.EDITOR;
  delete env.GIT_EDITOR;
  return git.env({ ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
}

/** Read HEAD sha + branch + tracked-file count from a working tree. */
async function readRepoMeta(
  git: SimpleGit,
): Promise<{ commitSha: string; branch: string; trackedFiles: number }> {
  // A git-init'd-but-commit-less repo is a valid repo (checkIsRepo() is true) but
  // has no HEAD commit to resolve yet — both revparse forms throw ("ambiguous
  // argument 'HEAD'") in that case, not just the plain-sha one. Degrade to ''
  // rather than throwing, same as the "not a git repo at all" case handles it.
  const commitSha = await git
    .revparse(['HEAD'])
    .then((s) => s.trim())
    .catch(() => '');
  const branchRaw = await git
    .revparse(['--abbrev-ref', 'HEAD'])
    .then((s) => s.trim())
    .catch(() => ''); // unborn HEAD (no commits yet) — distinct from a real detached HEAD
  const branch = branchRaw === 'HEAD' ? 'DETACHED' : branchRaw;
  const listed = (await git.raw(['ls-files'])).trim();
  const trackedFiles = listed === '' ? 0 : listed.split('\n').length;
  return { commitSha, branch, trackedFiles };
}

/**
 * Turn a raw git failure into a clear, secret-free, actionable error.
 *
 * `withToken` only ever applies a token to `https://` URLs — for `git@`/`ssh://`
 * remotes a token is never sent, so blaming "the token" on an SSH auth failure
 * would be actively wrong. Give scheme-appropriate advice instead.
 */
export function explainFailure(url: string, raw: string, token: string | undefined): Error {
  const safe = redactToken(raw, token);
  if (!isAuthError(safe)) return new Error(`Clone failed for ${url}: ${safe}`);

  if (!/^https:\/\//i.test(url)) {
    return new Error(
      `Access denied for ${url}. This is an SSH/non-HTTPS remote — GITHUB_TOKEN/GIT_TOKEN ` +
        `do not apply here; check your SSH key/agent is configured for this host.`,
    );
  }
  return new Error(
    token
      ? `Access denied for ${url}. The token was rejected — check it has 'repo' scope and has not expired.`
      : `Access denied for ${url}. If this repo is private, provide a token:\n` +
          `  set GITHUB_TOKEN=<your-token>   (or pass { token } to cloneRepo)`,
  );
}

/**
 * Stage 1 entrypoint. Clone (or reuse) a repo and return its metadata.
 */
export async function cloneRepo(input: string, opts: CloneOptions = {}): Promise<CloneResult> {
  const onStep = opts.onStep ?? noop;
  const source = parseSource(input);
  const repoId = toRepoId(source);

  onStep(`source: ${source.kind} → ${source.kind === 'remote' ? source.url : source.path}`);
  onStep(`repoId: ${repoId}`);

  // ── Local source ───────────────────────────────────────────────────────────
  if (source.kind === 'local') {
    if (!existsSync(source.path)) throw new Error(`Local path does not exist: ${source.path}`);
    onStep('local path exists — using in place (no copy)');
    const git = simpleGit(source.path);
    const isGit = await git.checkIsRepo().catch(() => false);
    if (!isGit) {
      onStep('not a git repo — proceeding without a commit anchor');
      return {
        repoId,
        repoPath: source.path,
        source,
        commitSha: '',
        branch: '',
        trackedFiles: 0,
        reused: true,
      };
    }
    const meta = await readRepoMeta(git);
    onStep(
      `HEAD ${meta.commitSha.slice(0, 8)} on ${meta.branch} — ${meta.trackedFiles} tracked files`,
    );
    return { repoId, repoPath: source.path, source, ...meta, reused: true };
  }

  // ── Remote source ────────────────────────────────────────────────────────────
  const token = resolveGitToken(opts.token);
  const dest = resolve(REPOS_DIR, repoId);
  const alreadyCloned =
    existsSync(dest) &&
    (await simpleGit(dest)
      .checkIsRepo()
      .catch(() => false));

  if (alreadyCloned && !opts.fresh) {
    onStep('cached clone found — reusing');
    const git = nonInteractive(dest);
    await fetchLatest(git, source.url, token, onStep);
    const meta = await readRepoMeta(git);
    onStep(
      `HEAD ${meta.commitSha.slice(0, 8)} on ${meta.branch} — ${meta.trackedFiles} tracked files`,
    );
    return { repoId, repoPath: dest, source, ...meta, reused: true };
  }

  await mkdir(REPOS_DIR, { recursive: true });
  // We only reach here when NOT reusing (fresh=true, or dest wasn't a valid repo).
  // A stale/partial dir would make `git clone` fail ("not an empty directory"), so clear it.
  if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
  // Token only ever applies to https:// remotes (see withToken) — don't claim
  // "(authenticated)" for an SSH/git@ URL where it's silently unused.
  const tokenApplies = Boolean(token) && /^https:\/\//i.test(source.url);
  onStep(
    tokenApplies
      ? 'partial-cloning (authenticated) …'
      : `partial-cloning into .cache/repos/${repoId} …`,
  );
  const git = nonInteractive();
  try {
    // `--filter=blob:none`: full history, blobs on demand.
    await git.clone(withToken(source.url, token), dest, ['--filter=blob:none']);
  } catch (err) {
    throw explainFailure(source.url, err instanceof Error ? err.message : String(err), token);
  }
  // Strip any token from the stored remote so the secret is never persisted on disk.
  if (token) await simpleGit(dest).remote(['set-url', 'origin', source.url]);

  const meta = await readRepoMeta(simpleGit(dest));
  onStep(
    `cloned — HEAD ${meta.commitSha.slice(0, 8)} on ${meta.branch} — ${meta.trackedFiles} tracked files`,
  );
  return { repoId, repoPath: dest, source, ...meta, reused: false };
}

/**
 * Fetch newest commits for a cached clone. On an auth failure we retry once with a
 * token (temporarily, then restore the clean remote URL) rather than persisting the
 * secret; if still denied, we keep the cached commit instead of hard-failing.
 */
async function fetchLatest(
  git: SimpleGit,
  cleanUrl: string,
  token: string | undefined,
  onStep: StepReporter,
): Promise<void> {
  onStep('fetching latest (partial)…');
  try {
    await git.fetch(['--filter=blob:none']);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isAuthError(msg)) throw explainFailure(cleanUrl, msg, token);
    if (!token) {
      onStep('fetch skipped (auth required) — reusing cached commit');
      return;
    }
    // Retry with a temporary tokenised remote, then restore the clean URL.
    await git.remote(['set-url', 'origin', withToken(cleanUrl, token)]);
    try {
      await git.fetch(['--filter=blob:none']);
    } catch (retryErr) {
      // Route the retry failure through the same redaction as every other
      // failure path — the tokenised remote URL is live at this exact moment,
      // and git's own error text often echoes the remote URL it was fetching.
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw explainFailure(cleanUrl, retryMsg, token);
    } finally {
      await git.remote(['set-url', 'origin', cleanUrl]);
    }
  }
}
