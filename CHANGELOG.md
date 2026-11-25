# Changelog

## 0.4.0

- Add WebSockets: a plugin's `fetch` returns `acceptWebSocket(request, { open, message, close, protocol?, headers? })`, and the listener sends 101 and runs the socket. Bun uses its native WebSockets; Node gets an RFC 6455 implementation in the package, so no runtime dependency was added. The host checks the Host before the plugin runs, and the plugin returns its own refusals. A request that is no handshake gets 400, a version other than 13 gets 426. An open socket holds a request, a stream slot and its plugin lease. Removing the plugin or stopping the server closes it with 1001 at once.
- Add `maxWebSocketMessageBytes` (1 MiB): a larger message closes its socket with 1009.
- Add `responseHeaders`: fields the host sets on every response it dispatches, replacing a response's own field of that name. This covers static files, plugin responses, refusals, errors and 101 handshakes, for example the two fields of cross-origin isolation. Fields of framing, the representation, cookies and the WebSocket handshake are refused when the server is made.

## 0.3.0

- Enforce exclusive endpoint ownership across server instances, wrappers and module formats.
- Validate response framing and release source leases on header serialization errors; never write bytes beyond declared length.
- Detect matcher-only static shadows at startup and request time.
- Transfer static file plans directly through the Node response pump, with precomputed immutable representation metadata and optional build-generated strong SHA-256 ETags.
- Add independent handler, upload, response stream, descriptor, connection and plugin budgets; return 504 for execution deadlines while retaining unsettled leases.
- Make declarative routes sufficient without a redundant matcher.
- Add generated invariant checks, raw pipelining regressions, resource endurance, framework benchmark modes and a tracked-lockfile release gate.
- Change `maxConcurrentStreams` to count actual bodies after handler return. Use handler or plugin budgets for pre-execution limits.
- Bun: set `reusePort: false`. Bun 1.4.5 enables `SO_REUSEPORT` when development mode is off, so `start()` on an occupied port succeeded and shared connections.
- Node: close the bound socket when listener setup fails after binding (for example an IPv6 zone host), instead of leaking a listener that keeps the port and process alive. Reject an empty `host`, which Node binds to every interface.
- Document that Bun 1.4.5 drops a declared Content-Length and sends chunked for stream bodies of 256 bytes or more.
- `make start` runs the example server detached; add `stop`, `restart`, `status`, `log` and `metrics` verbs. The example logs ISO-8601 timestamps and levels.
- Make lint and typecheck pass with the pinned oxlint 1.90.0 and TypeScript 5.9.3.
- Node: plugin calls reuse the adapter's Request and signal instead of cloning it, and leases forward the client signal without `AbortSignal.any`. Server CPU per small API or SSE request fell by 23 to 24% and throughput rose by 28 to 29% in an alternating A/B on Node 22.16.
- Test that a client disconnect aborts a running handler's signal and releases its lease on both runtimes.
- Drop hop-by-hop headers from plugin responses instead of answering 500: `Connection` and the fields it names, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`, `Upgrade` and `Transfer-Encoding: chunked`. defuss-mcp 0.6.0 and the defuss-rpc 4.0.0 upload progress stream send `Connection: keep-alive`, so MCP and RPC upload progress failed, and `fetch()` proxy responses failed on `Transfer-Encoding: chunked`. Other transfer codings still return 500.
- Bundle the defuss-o11y release fixture as `tests/o11y-fixture.ts`; the release workflow defaults to the published defuss-rpc 4.0.0, defuss-mcp 0.6.0 and defuss-o11y 0.3.0.
- RPC: route `POST /rpc/schema` to the endpoint. The defuss-rpc client fetches its schema with POST, which received 405, so `getRpcClient` failed against `rpcPlugin`.
- Scope `test:bun` to `./tests/` paths; bare arguments are Bun substring filters and also ran test files from repository copies under `tmp/`.

## 0.2.0

- Add immutable static manifest, bounded live negative cache and static/API collision policies.
- Compile route snapshots and eliminate duplicate Node stream adapters through demand-driven descriptor reads and socket drain.
- Quarantine uncooperative startup, handlers and cancellation until actual settlement; bound lifecycle waits by deadlines.
- Add host allowlists, trusted proxy policy, admission budgets, body deadlines and per-plugin wire limits.
- Add source-completion observability, stable route IDs and resource counters.
- Add packed browser seek tests, mandatory upstream release gate, cross-platform CI and matched-process benchmarks.

## 0.1.0

- Introduce native Bun and Node HTTP listeners with static-first protocol dispatch.
- Support file streaming, single byte ranges, conditional requests, precompressed assets and optional SPA navigation fallback.
- Add structural RPC, MCP and observability adapters, dynamic plugin lifecycle, CORS, TLS and transport observations.
- Include runtime tests, a packed consumer suite, optional real upstream integrations and VAE project policy.
