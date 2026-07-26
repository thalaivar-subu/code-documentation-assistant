/**
 * Tests for cross-cutting config helpers (src/core/config.ts).
 */

import { describe, expect, it } from 'vitest';
import { redactToken, resolveGitToken } from '../../src/core/config.ts';

describe('resolveGitToken', () => {
  it('prefers the explicit token over env vars', () => {
    expect(resolveGitToken('explicit-token')).toBe('explicit-token');
  });

  it('returns undefined when nothing is set', () => {
    const prevGithub = process.env.GITHUB_TOKEN;
    const prevGit = process.env.GIT_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GIT_TOKEN;
    try {
      expect(resolveGitToken()).toBeUndefined();
    } finally {
      if (prevGithub !== undefined) process.env.GITHUB_TOKEN = prevGithub;
      if (prevGit !== undefined) process.env.GIT_TOKEN = prevGit;
    }
  });
});

describe('redactToken', () => {
  it('redacts a plain raw-token occurrence', () => {
    expect(redactToken('error near ghp_abc123', 'ghp_abc123')).toBe('error near ***');
  });

  it('redacts the encodeURIComponent-encoded form of the token', () => {
    // Regression: clone.ts's withToken() embeds the token in a URL via
    // encodeURIComponent, so error text that echoes the URL contains the
    // ENCODED form — redactToken must catch that too, not just the raw token.
    const token = 'token/with+special=chars';
    const encoded = encodeURIComponent(token); // 'token%2Fwith%2Bspecial%3Dchars'
    const text = `remote: Authentication failed for 'https://${encoded}@github.com/org/repo'`;
    const result = redactToken(text, token);
    expect(result).not.toContain(encoded);
    expect(result).not.toContain(token);
    expect(result).toContain('***');
  });

  it('is a no-op split (still safe) when the token has no URL-reserved characters', () => {
    const token = 'ghp_simpletoken123';
    expect(encodeURIComponent(token)).toBe(token); // sanity: nothing to encode
    expect(redactToken(`x ${token} y`, token)).toBe('x *** y');
  });

  it('returns the text unchanged when no token is given', () => {
    expect(redactToken('no secrets here')).toBe('no secrets here');
  });
});
