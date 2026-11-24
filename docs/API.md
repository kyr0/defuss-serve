# API reference

## `defuss-serve`

`createServer(options?: ServeOptions): ServeServer` constructs a listener-independent server. It validates option ranges and declared routes synchronously and claims exclusive ownership of supplied endpoint instances. Stop unused constructed servers to release ownership. `start()` resolves the public root, builds the immutable manifest when configured, starts plugins and binds the listener. It rejects on failure and arranges cleanup of owned plugins. `state`, `runtime`, `port`, `url`, `plugins` and `stats` expose snapshots. `port` and `url` are undefined until bound and after shutdown. A returned URL is a copy.

`addPlugin(plugin): Promise<void>` validates the prospective registry, runs startup when already listening and atomically publishes the compiled route snapshot. `removePlugin(name): Promise<boolean>` unpublishes the plugin before draining active handlers and response sources. It returns false when absent. `stop(): Promise<void>` stops the listener and drains plugins concurrently under one absolute deadline measured from the start of the serialized operation. A close failure observed within the deadline rejects the operation; late errors are reported through `onDiagnostic`. A deadline may expire while application code is still running. Cleanup then remains quarantined until startup, handlers and cancellation actually settle. `stats.pendingCleanup` counts quarantined entries; names and instance identities cannot be reused while pending. Ownership is released only after successful cleanup; a failed close quarantines the endpoint identity. Lifecycle hooks must not await a mutation of the same server while holding its mutation queue. A stopped server cannot restart.

`ServePlugin` requires a name and `fetch(Request)` returning an unlocked Response or promise. Declare `routes` for fast dispatch, or provide a synchronous, side-effect-free `matches(Request)` when no routes exist. With declarations, the optional matcher narrows them. Optional `start()` and `close()` support lifecycle ownership. `maxBodyBytes` and `bodyTimeoutMs` narrow the global wire and body-read ceilings. A timeout value of zero disables that particular ceiling, not a stricter server ceiling. Route declarations use canonical paths without trailing slashes; trailing request slashes are normalized. A prefix includes the path and its slash-delimited descendants. Omitted methods mean all methods. A matcher can narrow the declaration. Overlapping declared ownership across plugins is rejected; overlapping dynamic matchers fail closed at request time. `maxConcurrentRequests` on a plugin bounds its live leases, including streams and deferred cancellation. `executionTimeoutMs` bounds wall-clock time to headers; 0 disables it. Expiry sends 504, aborts the handler, and retains handler/endpoint ownership until actual settlement and late-body cancellation. A synchronously blocking handler cannot be interrupted by a JavaScript timer. Returned response headers cannot contain connection-control or transfer-encoding headers. The listener owns framing. A nonnumeric or inconsistent Content-Length is rejected; streaming overflow is never written and a committed short response is terminated.

## Options

| Option | Default and semantics |
| --- | --- |
| `host`, `port` | Loopback `127.0.0.1`, 8080; zero selects a free port. An empty host is rejected. An occupied port rejects `start()` on both runtimes. A host the listener URL cannot represent, such as an IPv6 zone ID, rejects `start()` and closes the bound socket |
| `runtime` | `auto`: Bun if present, otherwise Node |
| `publicDir` | Omitted; no static hosting |
| `plugins` | Empty |
| `staticMode` | `live`; `immutable` builds a startup manifest for a trusted read-only deployment tree |
| `staticCacheTtlMs`, `staticCacheEntries` | 0 ms (off), 4096 entries; live negative metadata only, never caches permission failures |
| `maxManifestEntries` | 100000 entries including directories and denied aliases |
| `immutableAssetPattern` | Omitted; caller-supplied non-global, non-sticky regex on relative decoded path for content-versioned assets |
| `staticShadow` | `warn`; `allow` suppresses diagnostics, `error` rejects manifest collisions or requests rather than serving either side; includes matcher-only plugins |
| `assetManifest` | Omitted; path to trusted build-generated digest manifest outside publicDir, immutable mode only |
| `spaFallback` | False; true chooses index.html, string chooses relative file |
| `precompressed` | True, existing `.br` and `.gz` variants |
| `cacheControl` | `public, max-age=0, must-revalidate` |
| `allowDotfiles` | False |
| `allowedHosts` | Exact configured bind host; for loopback binds, localhost and IPv4/IPv6 loopback; wildcard binds require explicit hosts or `['*']` |
| `trustedProxies` | Empty; exact direct peer IPs, no forwarding-based URL rewriting |
| `cors`, `tls` | Omitted; explicit origin policy and PEM key/cert |
| `maxBodyBytes` | 1 GiB wire ceiling; legacy RPC additionally bounds decompressed calls to 1 MiB |
| `bodyTimeoutMs` | 300000; absolute deadline for reading a matched endpoint body; 0 disables |
| `headersTimeoutMs` | 30000; Node native header timeout, not a Bun option |
| `idleTimeout` | 120 seconds; 0 disables; SSE disables response idle timeout |
| `maxConcurrentRequests` | 1024 admitted request/source lifetimes; 0 disables |
| `maxConcurrentStreams` | 0; actual response-source slots; checked after handler returns |
| `maxConcurrentHandlers` | 0; executing Fetch handlers, including timed-out work until settlement |
| `maxConcurrentUploads` | 0; body-bearing plugin requests, including late settlement |
| `maxOpenStaticFiles` | 256, or 0 when nativeStaticFastPath is enabled; includes descriptor opens in progress |
| `maxConnections` | 0; Node native socket limit; nonzero rejected on Bun |
| `pluginStartTimeoutMs` | 30000 per startup hook; expiry quarantines initialization until settled |
| `shutdownTimeoutMs` | 5000 for one serialized removal or stop operation, including cleanup wait |
| `nativeStaticFastPath` | False; Bun opt-in, requires request, stream and descriptor limits 0 and no lifecycle observer |
| `onRequest`, `onLifecycle`, `onDiagnostic` | Optional isolated callbacks |

Each budget is independent. A stream slot is charged only for actual response bodies; reaching the stream limit returns a bodyless 503 and cancels the rejected body. A handler may already have performed side effects before this check. Handler and per-plugin budgets provide admission before side effects. `stats` reports `activeRequests`, `activeStreams`, `activeHandlers`, `activeUploads`, `openStaticFiles`, `pendingCleanup` and `rejected`. Rejection counts include admission decisions, not all HTTP failures. Bun has no verified native per-connection limit in this adapter; use a proxy or OS policy. Node header timeout enforcement uses native timer granularity. A late body-limit error after headers commit cannot retroactively replace the response status. Matcher-only collision detection probes synthetic GET/HEAD at startup and evaluates the real request at dispatch; a context-sensitive matcher cannot be proven collision-free from a startup probe.

`onLifecycle` reports admitted starts, response headers, and terminal complete/error/cancel phases, including stable route ID, method, status when known, elapsed time, source bytes and counters. Rejected admissions have headers and terminal events but no admitted start. Bytes count response source production (not confirmed delivery or wire framing), and header time is application response availability, not network-measured TTFB. `onRequest` remains the legacy header callback. No raw request URL, body, headers, secrets or exception text are exported by observers. `stats.rejected` counts host admission/validation/streamed body-limit rejections, not all non-2xx responses.

## `defuss-serve/plugins`

- `endpointPlugin(name, endpoint, routes, limits?)` adapts a Fetch endpoint and its optional start/close lifecycle.
- `rpcPlugin(endpointOrRpcRoute, options?)` accepts an endpoint or the legacy `(context: { request })` function. Options include `name`, `maxCallBytes`, `maxBodyBytes`, `bodyTimeoutMs`, `maxConcurrentRequests`, `executionTimeoutMs`; a string is accepted as the name. It mounts RPC calls, schema, downloads, raw uploads, upload status and progress. Preserve upstream authentication hooks.
- `mcpPlugin(endpoint, path?, name?, limits?)` adapts MCP HTTP. Defaults are `/mcp` and `mcp`.
- `o11yPlugin(endpoint, routes?, name?, limits?)` adapts a structural observability endpoint. Defaults are `/health`, `/healthz` and `/metrics` for GET/HEAD. Supply the real service's routes.

An instance-local RPC endpoint implementing `ServePlugin` can be passed directly if it enforces protocol-specific body/content-type checks. An upstream singleton cannot be isolated by a host adapter. The host owns the endpoint lifecycle, not the protocol's authentication, authorization or session semantics.
