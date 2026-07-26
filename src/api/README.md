# API — the UI's backend

> Everything else in this project is a package, callable directly from a dev script or a test — a
> browser can't do that, so this is the one layer that exists purely to give the UI something to
> talk to over HTTP. Thin: it wires the same `cloneRepo → chunkRepo → embedChunks → indexRepo` and
> `answerQuestion` functions the dev scripts call, and streams their progress as SSE.

`buildServer()` (`server.ts`) returns a Fastify instance with no `.listen()` call, so it's testable
via `.inject()` without a real port. `scripts/serve.ts` is the thin entrypoint that actually listens.

## Routes

| Route     | Method | Body                                                     | Response                                                               |
| --------- | ------ | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/health` | GET    | —                                                        | `{ ok: true }`                                                         |
| `/stages` | GET    | —                                                        | `ALL_STAGES` from `stages.manifest.ts` (hover data)                    |
| `/repos`  | GET    | —                                                        | `{ repoId, chunksIndexed }[]` — every repo indexed so far, disk-backed |
| `/index`  | POST   | `{ repo: string, fresh?: boolean }`                      | SSE: `step`× → `done` \| `error`                                       |
| `/ask`    | POST   | `{ repoId, question, maxHops?, k?, limit?, maxTokens? }` | SSE: `route` → (`hop`×, `token`×)× → `done` \| `error`                 |

`/index` runs Clone → Chunk → Embed → Index and caches the resulting chunks in memory
(`repoChunks`), keyed by `repoId` — `/ask` looks them up to hand to Expand's symbol graph. That
in-memory cache doesn't survive a server restart, but `/ask` no longer needs it to: on a miss,
`repo-cache.ts`'s `getOrReconstructChunks` rebuilds the chunk list straight from the on-disk vector
store (`vector-store.ts`'s `listVectors` + `vectorRowToChunk`) instead of requiring a full
re-clone/re-chunk/re-embed. `/repos` uses the same disk-backed source of truth (the lexical index
directory, where every `indexRepo` call unconditionally writes `<repoId>.json`) to list every repo
ever indexed, independent of what's in memory right now — that's what the UI's repo picker reads.

`/ask` also caches full answers in memory, keyed by `(repoId, question, options)`
(`ask-stream.ts`'s `askCache`) — repeating the same question against the same repo replays the
cached route/hops/answer instantly instead of re-running Retrieve through Generate. A re-index
clears any cached answers for that `repoId` (`invalidateAskCache`), so a repeat question can't
return a stale answer from before the content changed.

## SSE, and the two real bugs it took to get right

`sse.ts`'s `openSse()` calls `reply.hijack()` before writing raw headers/body — without it, Fastify
still tries to manage the reply lifecycle after the handler resolves and a real browser's `fetch()`
fails with `net::ERR_FAILED` even though `curl` and Fastify's own `.inject()` both look fine (they're
more lenient than an actual browser). Second-order effect of hijacking: it also skips Fastify's
`onSend` hooks, which is where `@fastify/cors` normally injects `Access-Control-Allow-Origin` — so a
hijacked SSE response needs that header added manually in `openSse()`, or the browser silently blocks
the response with no console-visible CORS error at all. Both bugs only showed up under a real browser
`fetch()`, not `.inject()` — see `server.test.ts` and the note in `sse.ts` for the full story.

## Example — real run against the standard test repo, through the actual HTTP API

```bash
npm run serve            # starts the API on :8080 (npm run web:dev serves the UI on :5173)
```

```bash
curl -s -X POST http://localhost:8080/index \
  -H 'Content-Type: application/json' \
  -d '{"repo":"https://github.com/thalaivar-subu/telemetry-go"}'
```

```
event: step
data: {"stage":"clone","message":"source: remote → https://github.com/thalaivar-subu/telemetry-go"}

event: step
data: {"stage":"chunk","message":"82 chunks"}

event: step
data: {"stage":"embed","message":"embedded 0, cached 82"}

event: done
data: {"repoId":"thalaivar-subu-telemetry-go-7c354319","chunksIndexed":82,"vectorCount":82,"lexicalCount":82}
```

```bash
curl -s -X POST http://localhost:8080/ask \
  -H 'Content-Type: application/json' \
  -d '{"repoId":"thalaivar-subu-telemetry-go-7c354319","question":"who calls RecordTaskDuration?","maxTokens":250}'
```

```
event: route
data: {"intent":"trace","symbols":["RecordTaskDuration"],"files":[],"reason":"matched trace phrase \"who calls\" — needs call/dependency graph expansion"}

event: token
data: {"token":"The"}
...

event: done
data: {"answer":"The function `RecordTaskDuration` is called by the `InstrumentProcessor` function.","citations":[],"verify":{"resolvedCount":0,"totalCount":0,"resolutionRate":0,"hasCitations":false, ...}, ...}
```

Same 0-citation case Stage 8's README documents — the API doesn't hide it: `verify.hasCitations`
is `false` here, and the UI reads that field directly to decide whether to show a citations-resolved
count at all (it doesn't, when there's nothing to report) versus surfacing the real retrieved
context (`expanded`) so a user can judge groundedness themselves instead of trusting a citation
that was never there — see `web/README.md`'s "pipeline trace" section.

## Bounding an open, unauthenticated `/index`

Nothing gates who can call `/index`, so an unbounded number of distinct repos would otherwise
accumulate forever on disk. `index-stream.ts` enforces `MAX_INDEXED_REPOS` (default 20, override via
the env var of the same name): indexing a **new** repoId once already at the limit evicts the
least-recently-indexed repo first (`lexical-store.ts`'s `findLeastRecentlyIndexedRepoId`, using the
lexical index file's mtime as an LRU proxy — indexing bumps it, asking doesn't, so it's "least
recently indexed" rather than a perfectly tracked "least recently used," a deliberate simplification
over adding a separate access-tracking store). Re-indexing an **existing** repoId never triggers
eviction — the count doesn't grow.

## Verify

```bash
npm test -- src/api/server.test.ts    # /health, /stages, /index, /ask (incl. a real end-to-end run over HTTP, ~60s)
npm run serve                         # then curl as above, or open the web UI (../../web/README.md)
```
