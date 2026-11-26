# defuss-serve

Native HTTP hosting for Bun and Node.js. Serve a built frontend, media and listener-independent protocol endpoints from the same socket. The core has no runtime npm dependencies and does not require Express.

## Install

```sh
bun add defuss-serve
```

This is the intended package name. For this source distribution, run `make setup && make build`, then pack with `npm pack --ignore-scripts` and install the resulting tarball. See [verification](docs/VERIFICATION.md) for the checks run on this release candidate.

## Quick start

```ts
import { createServer } from 'defuss-serve';

const server = createServer({
  host: '127.0.0.1',
  port: 8080,
  publicDir: './dist',
  staticMode: 'immutable',
});
await server.start();
console.log(server.url);
```

Run `make start` to build and launch the frontend and health endpoint example in the background (`PORT=18080 make start` if 8080 is taken). `make status`, `make log` and `make stop` manage it; the process ID is in `tmp/example.pid` and output in `var/log/example.stdout` and `.stderr`. Alternatively, run `examples/server.ts` with Bun after building. Point `publicDir` at the output of your frontend build, including defuss-shadcn. The server does not compile templates or bundle frontend code.

## Compose RPC, MCP and observability

The server owns the listener. Each plugin owns a protocol endpoint. With the current defuss-rpc singleton API and defuss-mcp Fetch API:

```ts
import { createServer } from 'defuss-serve';
import { rpcPlugin, mcpPlugin } from 'defuss-serve/plugins';
import { createRpcServer, rpcRoute } from 'defuss-rpc/server';
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';

const MathApi = { async add(a: number, b: number) { return a + b; } };
createRpcServer({ MathApi });
const mcp = createMcpHttp(createMcpApi(
  { name: 'math', version: '1.0.0' },
  { add: MathApi.add },
));
const server = createServer({
  host: '127.0.0.1',
  port: 8080,
  publicDir: './dist',
  plugins: [rpcPlugin(rpcRoute), mcpPlugin(mcp)],
});
await server.start();
```

A backplane can omit `publicDir`. Both RPC and MCP may expose the same service methods. To preserve RPC guards when exposing RPC methods through MCP, use the upstream MCP-to-RPC bridge rather than directly registering the underlying functions as in this small independent example.

The legacy RPC adapter does not create or isolate the process-global upstream registry. Do not create two independent legacy RPC registries in the same process. defuss-rpc 4.0.0 `createRpcServer()` returns an instance-local endpoint: pass it to `rpcPlugin(rpc)`, which the release gate exercises with the real RPC client, or pass it directly if it implements `ServePlugin` and supplies its own transport protections.

`rpcPlugin` mounts the current RPC wire paths, requires `application/json` for calls, bounds decompressed call bodies to 1 MiB by default, and accepts gzip and deflate JSON calls. Uploads pass through without call-body buffering. Use `rpcPlugin(rpcRoute, { maxCallBytes: 4 * 1024 * 1024 })` to change the call limit. The host applies a 1 GiB wire ceiling by default; configure a stricter plugin limit or an explicit larger global limit for uploads. The upstream endpoint still owns decompressed upload limits and authentication. The legacy adapter deliberately does not implement dynamic response gzip; NDJSON and SSE pass through without compression or buffering.

`mcpPlugin(mcp, '/mcp')` routes GET, POST and DELETE to the endpoint and calls its `close()` during removal or shutdown. Set the MCP endpoint's allowed hosts, origins and authentication when deploying beyond loopback. Host CORS is not authorization.

The observability adapter accepts any Fetch endpoint, including a future native defuss-o11y instance. Declare only the routes it implements:

```ts
import { o11yPlugin } from 'defuss-serve/plugins';

const health = o11yPlugin(
  { fetch: () => Response.json({ ok: true }) },
  [{ path: '/health', methods: ['GET', 'HEAD'] }],
);
```

The generic adapter does not define defuss-o11y health semantics. Its default routes are `/health`, `/healthz` and `/metrics`; defuss-o11y 0.3.0 also serves `/readyz` and `/livez`, so pass all five routes, as `tests/o11y-fixture.ts` does. The optional `onLifecycle`, `onRequest` and `onDiagnostic` callbacks expose host-level observations to your logging or metrics system.

## Reverse proxy

`proxyPlugin(path, target, options?)` forwards a path's subtree to the same subtree of an upstream URL. An app can then give its browser one origin for its own API and for a service behind it, such as an auth service:

```ts
import { createServer } from 'defuss-serve';
import { proxyPlugin } from 'defuss-serve/plugins';

const server = createServer({
  publicDir: './dist',
  plugins: [proxyPlugin('/auth', 'http://127.0.0.1:43127/apps/linear-clone/auth', {
    headers: { 'X-Backplane-Key': process.env.BACKPLANE_API_KEY! },
  })],
});
```

`GET /auth/me?x=1` reaches `http://127.0.0.1:43127/apps/linear-clone/auth/me?x=1`. The body streams in both directions, with no buffering, under the host's body limits. The proxy forwards end-to-end fields (Authorization, Cookie, Origin) and drops `Host`, `Content-Length`, the hop-by-hop fields and every field that `Connection` names. `headers` replaces the client's field of the same name, so a client cannot forge a service credential that the proxy sets. Unless `forwarded: false`, it sets `X-Forwarded-For` to the socket peer, appended to a chain that a trusted proxy sent, and sets `X-Forwarded-Host` and `X-Forwarded-Proto`. An upstream on defuss-serve keeps them only if the proxy's address is in its `trustedProxies`. Several `Set-Cookie` fields stay separate. A redirect into the target's subtree becomes a path under `path` on this origin, and a redirect elsewhere passes unchanged.

VERIFIED: `tests/proxy.test.ts` runs every behavior above on Node and Bun against a real upstream. The proxy asks for `Accept-Encoding: identity`, because Node and Bun `fetch()` decode a compressed answer but keep its `Content-Encoding` and encoded `Content-Length`. An answer in gzip, deflate or br still arrives decoded, without those fields. Any other coding gets 502, because whether `fetch()` decodes zstd depends on the runtime. An unreachable upstream also gets 502; set `executionTimeoutMs` for a 504 when the upstream sends no headers in time. WebSocket upgrades are not proxied.

`remoteAddress(request)` from `defuss-serve` returns the socket peer of the Request a plugin received. A Request that the plugin builds itself has none. It is the direct peer, so behind a reverse proxy it is the proxy's address.

## Static-first dispatch

| Request | Result |
| --- | --- |
| `GET /` | `publicDir/index.html` |
| `GET /assets/main.js` | Static asset if present |
| `GET /movies/demo.mp4` | Media file; supports byte ranges |
| `GET /rpc/schema` | Static file if present, otherwise RPC |
| `POST /rpc/schema` | RPC; the defuss-rpc client fetches its schema this way |
| `POST /rpc` | RPC; static files never handle POST |
| `GET /rpc/upload/progress/id` | RPC SSE if no matching static file |
| `POST /mcp` | MCP |
| `GET /health` | Observability if configured and no matching static file |
| Unknown route | 404, or optional HTML navigation fallback |

Existing files win for GET and HEAD. A denial, precondition response, redirect or range error is terminal. Missing files proceed to the plugin registry. Declared plugin paths with unsupported methods receive 405 and an Allow header. Plugin errors do not fall through to other endpoints. The opt-in SPA fallback runs only for unclaimed GET/HEAD navigations accepting `text/html`, and does not rewrite a request whose final path segment contains a dot. Directory indexes are enabled; directory listing is not.

Static files are public. Never place credentials, private media, upload staging files or authentication-protected API data inside `publicDir`. Hidden files and external symlink targets are denied by default. Serve from a trusted deployment directory not writable by remote clients or untrusted local users. This is not a filesystem sandbox against concurrent malicious directory replacement.

## Media and caching

Static responses advertise `Accept-Ranges: bytes`. Single bounded, suffix and open-ended ranges return 206 and `Content-Range`; valid unsatisfiable ranges return 416. Malformed, unsupported and multi-range headers are ignored. HEAD returns headers for the full selected representation without a body. Node reads only the selected bytes from an open descriptor. Node transfers directly from the descriptor to its response pump without a Web response-body stream. Bun uses a tracked Web stream by default. Bun 1.4.5 sends any stream body of 256 bytes or more with chunked transfer encoding and drops the declared Content-Length. On Bun, a tracked static file or plugin body of that size therefore arrives without Content-Length, though HEAD still reports it and the byte count is still enforced. Node always sends the declared length. Bun can opt into native `Bun.file()` or its slice using `nativeStaticFastPath`, subject to the explicit accounting trade-off documented in the API reference. The Bun paths were verified on Bun 1.4.5 for macOS arm64; recheck them on other Bun versions.

Metadata-based weak ETags and Last-Modified support conditional requests. For strong, representation-specific SHA-256 ETags, build a trusted manifest alongside the immutable frontend:

```sh
bun run asset-manifest ./dist ./asset-digests.json
```

Then set `staticMode: 'immutable'` and `assetManifest: './asset-digests.json'`. The manifest must be outside the public tree; the builder writes a new file rather than overwriting an existing one. Deploy the manifest and unchanged assets together. The server validates digest syntax and file sizes but does not rehash large files at startup. A strong ETag is valid only if that deployment contract holds. Each encoded representation has its own hash and coding. A weak ETag is not a strong If-Range validator; an exactly matching Last-Modified date can permit a range. Last-Modified has second resolution. Publish immutable or versioned media if byte identity across requests matters. Revalidation is the default cache policy.

Precompressed `.br` and `.gz` siblings are negotiated using Accept-Encoding and have representation-specific validators. The server does not compress dynamically. Keep sidecars consistent with their original file when deploying. Identity is preferred for ranges where acceptable. If only a compressed representation is acceptable, offsets refer to its encoded bytes.

```html
<video controls preload="metadata" src="/movies/demo.mp4"></video>
```

## Plugin contract

```ts
import type { ServePlugin } from 'defuss-serve';

const plugin: ServePlugin = {
  name: 'health',
  routes: [{ path: '/health', methods: ['GET', 'HEAD'] }],
  fetch: () => Response.json({ ok: true }),
};
```

Declared routes are authoritative when no optional matcher is supplied, avoiding an extra URL parse. A matcher can narrow a declared route. Route declarations enable startup collision checks and 405 handling; a declared prefix matches a slash-delimited subtree, not arbitrary string prefixes. Without declarations the server evaluates `matches()` and fails closed if more than one plugin matches. Matchers must be synchronous and side-effect-free. Protocol plugins should declare their routes. No generic Express or REST API is exposed.

```ts
await server.addPlugin(plugin);
await server.removePlugin('health');
await server.stop();
```

Plugin mutations are serialized and publish a compiled route snapshot without restarting the listener. `start()` is idempotent while running; a stopped instance is terminal. Removal unpublishes a plugin, waits for handler and response-source settlement, and only then closes resources. Expiry aborts work and returns within the grace budget, but an uncooperative handler or cleanup remains quarantined until it really settles. Inspect `server.stats.pendingCleanup` and diagnostics. An endpoint is exclusively owned by one server, including multiple wrappers of the same endpoint and ESM/CommonJS copies. Ownership is claimed during registration and released only after successful cleanup. Matcher-only endpoints are probed against immutable paths at startup and checked against actual static requests at dispatch.

## WebSockets

A plugin accepts a WebSocket by returning `acceptWebSocket(request, handlers)` from `fetch`. The plugin runs its own checks first and returns any other Response to refuse:

```ts
import { createServer, acceptWebSocket, type ServePlugin } from 'defuss-serve';

const echo: ServePlugin = {
  name: 'echo',
  routes: [{ path: '/echo', methods: ['GET'] }],
  fetch: request => request.headers.get('origin') === 'http://127.0.0.1:8080'
    ? acceptWebSocket(request, { message(socket, data) { socket.send(data); } })
    : new Response('Forbidden', { status: 403 }),
};
```

`socket` is the same on Bun and Node: `send(string | Uint8Array)`, `close(code?, reason?)`, `protocol`, `remoteAddress` and `bufferedAmount`. Text arrives as a string, binary data as a Uint8Array. `protocol` picks one of the subprotocols the client offered, and `headers` adds fields to the 101 response. The host validates the Host before the plugin runs. A request that is no handshake gets 400, and an unsupported version gets 426. An open socket counts as an active request and stream and holds its plugin lease. `removePlugin` and `stop` close it with 1001 at once. A throwing handler closes its socket with 1011. A message over `maxWebSocketMessageBytes` (1 MiB) closes it with 1009. Sockets have no idle timeout, pings or compression: a protocol that needs keepalive sends its own messages. Bun uses its native WebSockets. Node runs the RFC 6455 framing in this package, so no runtime dependency is needed.

## Host response fields

`responseHeaders` names fields that every dispatched response carries: static files, plugin responses, refusals, errors and WebSocket handshakes. They replace a response's own field of the same name. A page that needs cross-origin isolation, for a SharedArrayBuffer for example, sets both fields once:

```ts
createServer({
  publicDir: './dist',
  responseHeaders: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
});
```

Framing, connection, representation, cookie and WebSocket handshake fields are refused when the server is made (`Content-Length`, `Content-Type`, `Content-Encoding`, `Content-Range`, `Set-Cookie`, `Sec-WebSocket-*` and the hop-by-hop fields). Some refusals leave the listener before dispatch: on Node, the HTTP parser's errors and timeouts; on Bun, malformed requests and bodies over the global `maxBodyBytes`. They carry no host fields.

## Production configuration

```ts
const server = createServer({
  host: '127.0.0.1',
  port: 8080,
  publicDir: './dist',
  staticMode: 'immutable',
  immutableAssetPattern: /\.[a-f0-9]{8,}\.(js|css)$/,
  staticShadow: 'error',
  maxConcurrentRequests: 512,
  maxConcurrentStreams: 128,
  maxConcurrentHandlers: 256,
  maxConcurrentUploads: 32,
  maxOpenStaticFiles: 128,
  maxBodyBytes: 1024 ** 3,
  bodyTimeoutMs: 300000,
  onLifecycle(event) {
    // Forward stable route IDs, source bytes and elapsed time to your metrics sink.
    if (event.phase === 'complete') console.log(event.route, event.bytes);
  },
  plugins: [rpcPlugin(rpc, { maxCallBytes: 1024 ** 2 }), mcpPlugin(mcp)],
});
await server.start();
```

Use `live` for development; optional `staticCacheTtlMs` and `staticCacheEntries` enable bounded negative lookups. Use `immutable` for production files that never change in place. It eliminates filesystem operations on ordinary misses and metadata-only responses. Immutable mode denies symlinks; deploy a new root instead of updating files in place. The immutable filename regex must match your actual build naming contract. It is not automatic hash detection.

A wildcard bind (`0.0.0.0` or `::`) requires explicit `allowedHosts`; an empty `host` is rejected because Node would bind it to every interface. Both runtimes refuse to start on an occupied port. Forwarded headers are stripped from requests unless the direct socket peer is listed in `trustedProxies`. The host does not rewrite URLs using forwarded headers. CORS is not authorization.

The default wire-body ceiling is 1 GiB and the default admission limit is 1024. Plugins can narrow the body ceiling/deadline. Response streams, executing handlers, body-bearing uploads and open static descriptors have independent budgets. The stream budget is checked when a response body is available, not before protocol side effects; use handler and per-plugin limits for admission before execution. A bodyless health response can still succeed when stream capacity is exhausted. `maxConnections` is Node-only; configure edge connection limits for Bun.

`executionTimeoutMs` on a plugin sends 504 on expiry and aborts cooperatively, but an uncooperative handler still holds its lease and handler budget until it settles. Transport framing validates response headers. It drops hop-by-hop headers (`Connection` and the fields it names, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`, `Upgrade` and `Transfer-Encoding: chunked`), so a `fetch()` proxy response passes through. A transfer coding other than chunked is rejected with 500; the Node pump never writes bytes beyond Content-Length and closes a connection after a committed short frame.

`onRequest` receives one event for each request that defuss-serve answers, refusals included, when the response headers are ready. A host can keep an access log with it:

```ts
createServer({
  onRequest: e => console.log(`${new Date().toISOString()} info ${e.method} ${e.path} -> ${e.status}${e.rejected ? ' rejected' : ''}`),
});
```

`path` is the parsed path and query, or the raw target when it does not parse. A query can carry a token, so filter it before you log it. `rejected` is true when defuss-serve refused the request before a plugin or static file could answer: a missing, malformed or forbidden Host, an unusable target, a stopped or busy server, a declared body over the limit. A request without a usable Host, such as an HTTP/1.0 request without one, gets 400 on both runtimes. A refusal that the runtime sends before the listener sees the request produces no event: on Node 22.16 and Bun 1.4.5 this covers an HTTP/1.1 request without a Host and the parser's errors.

`onLifecycle` measures response-source production, not confirmed network delivery. Native Bun static fast path requires request, stream and descriptor budgets disabled and no lifecycle observer. Native completion accounting cannot safely be promised with the currently implemented BunFile interface.

See [API reference](docs/API.md) for every option, defaults, compatibility details and lifecycle semantics. See [architecture](ARCH.md) for the invariants and security boundaries.

## Development and verification

TypeScript, Bun package management, pkgroll ESM/CommonJS exports, real HTTP tests and defuss-vae. The package is server-only; browser consumers use HTTP.

```sh
make setup
make browsers
make verify
make bench
make bench-frameworks
```

The development gate runs lint, typecheck, Node and Bun HTTP tests, coverage, packed-consumer E2E and Chromium/WebKit media seeking. The release gate additionally requires a tracked Bun lockfile and a frozen install, and the actual RPC, MCP and O11y packages: the published defuss-rpc 4.1.0, defuss-mcp 0.6.2 and defuss-o11y 0.3.0 unless `DEFUSS_RPC_PACKAGE`, `DEFUSS_MCP_PACKAGE` or `DEFUSS_O11Y_PACKAGE` names another spec or an absolute tarball path. `tests/o11y-fixture.ts` mounts the O11y package; `DEFUSS_O11Y_FIXTURE` can replace it for another defuss-o11y version. See [verification](docs/VERIFICATION.md). Publishing invokes `make release-verify`, which fails closed if prerequisites are unavailable. Do not interpret an offline fallback build or source tests as a complete release attestation.

Run the separate-process benchmark against native transport and an optional previous build:

```sh
BASELINE_PACKAGE_DIR=/absolute/path/to/defuss-serve-0.2.0 make bench
make bench-frameworks
```

The harness verifies response payloads and reports throughput, latency percentiles, server CPU/RSS and file descriptor counts. Express, Fastify, Hono and native Node comparison modes implement the same tested fixture routes and static semantics, not all defuss-serve production safeguards. Native Bun is a lower-bound transport reference. Comparative packages are development-only. See [benchmark evidence](docs/BENCHMARKS.md) for the local results and limitations.
