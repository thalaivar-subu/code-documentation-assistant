# API — the UI's backend

> Everything else in this project is a package, callable directly from a dev script or a test — a
> browser can't do that, so this is the one layer that exists purely to give the UI something to
> talk to over HTTP. Thin: it wires the same `cloneRepo → chunkRepo → embedChunks → indexRepo` and
> `answerQuestion` functions the dev scripts call, and streams their progress as SSE.

`buildServer()` (`server.ts`) returns a Fastify instance with no `.listen()` call, so it's testable
via `.inject()` without a real port. `scripts/serve.ts` is the thin entrypoint that actually listens.

## Routes

| Route     | Method | Body                                                     | Response                                               |
| --------- | ------ | -------------------------------------------------------- | ------------------------------------------------------ |
| `/health` | GET    | —                                                        | `{ ok: true }`                                         |
| `/stages` | GET    | —                                                        | `ALL_STAGES` from `stages.manifest.ts` (hover data)    |
| `/index`  | POST   | `{ repo: string, fresh?: boolean }`                      | SSE: `step`× → `done` \| `error`                       |
| `/ask`    | POST   | `{ repoId, question, maxHops?, k?, limit?, maxTokens? }` | SSE: `route` → (`hop`×, `token`×)× → `done` \| `error` |

`/index` runs Clone → Chunk → Embed → Index and caches the resulting chunks in memory, keyed by
`repoId` — `/ask` looks them up to hand to Expand's symbol graph. This cache is **not persisted**;
a server restart loses it even though the actual vector/lexical index on disk survives. That's a
deliberate tradeoff for a single-process demo server (see the comment above `repoChunks` in
`server.ts` for the production alternative).

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

Same 0-citation case Stage 8's README documents — the API doesn't hide it, and neither does the UI
(it renders the `⚠ answer cited nothing` badge directly off `verify.hasCitations`).

## Verify

```bash
npm test -- src/api/server.test.ts    # /health, /stages, /index, /ask (incl. a real end-to-end run over HTTP, ~60s)
npm run serve                         # then curl as above, or open the web UI (../../web/README.md)
```
