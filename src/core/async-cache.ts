/**
 * The cache-the-promise-not-the-value pattern (see `docs/ENGINEERING.md`'s
 * "cache the resource, never the failure" principle) was hand-rolled three
 * times with the same shape: `getSharedVectorStore`'s connection cache,
 * `getCachedLexicalIndex`'s index cache, and (still bespoke — see its own
 * comment) `ask-stream.ts`'s answer cache. The first two are a clean fit for
 * this shared helper: single-key invalidation, nothing else. `askCache` isn't
 * — it invalidates by repoId, a tag shared across many keys, not by one exact
 * key — so it keeps its own small implementation rather than bending this one
 * to fit a shape it doesn't have.
 */
export interface AsyncCache<K, V> {
  /** Returns the cached value for `key`, calling `create()` on a miss. A rejected `create()` is never cached — the next call retries instead of repeating the same failure forever. */
  getOrCreate(key: K, create: () => Promise<V>): Promise<V>;
  invalidate(key: K): void;
}

export function createAsyncCache<K, V>(): AsyncCache<K, V> {
  const entries = new Map<K, Promise<V>>();
  return {
    getOrCreate(key, create) {
      let cached = entries.get(key);
      if (!cached) {
        cached = create().catch((err: unknown) => {
          entries.delete(key);
          throw err;
        });
        entries.set(key, cached);
      }
      return cached;
    },
    invalidate(key) {
      entries.delete(key);
    },
  };
}
