/**
 * Cross-cutting configuration. Lives in `core/` because it is shared by the whole
 * app, not owned by any single pipeline stage.
 *
 * Secrets come from the environment only — never hard-coded, never logged.
 */

/**
 * Resolve a Git access token for cloning private repositories.
 * Checked in order; first non-empty wins. Returns undefined when none is set,
 * in which case only public repos can be cloned.
 */
export function resolveGitToken(explicit?: string): string | undefined {
  const candidate = explicit || process.env.GITHUB_TOKEN || process.env.GIT_TOKEN;
  const token = candidate?.trim();
  return token ? token : undefined;
}

/**
 * Replace a token substring with `***` so it can never appear in logs or errors.
 * Matches both the raw token and its `encodeURIComponent` form — clone.ts embeds
 * the token as a percent-encoded URL username, so git error text (which often
 * echoes the remote URL) contains the encoded form, not the raw one. A token
 * with no URL-reserved characters encodes to itself, so this is a no-op split
 * in the common case and only does real work when the token needs it.
 */
export function redactToken(text: string, token?: string): string {
  if (!token) return text;
  const encoded = encodeURIComponent(token);
  let result = text.split(token).join('***');
  if (encoded !== token) result = result.split(encoded).join('***');
  return result;
}
