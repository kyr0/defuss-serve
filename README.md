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

The legacy RPC adapter does not create or isolate the process-global upstream registry. Do not create two independent legacy RPC registries in the same process. When the new instance-local RPC interface is available, pass its endpoint to `rpcPlugin(rpc)`, or pass it directly if it implements `ServePlugin` and supplies its own transport protections.

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

The generic adapter does not define defuss-o11y health semantics or claim compatibility with an unverified upstream release. The optional `onLifecycle`, `onRequest` and `onDiagnostic` callbacks expose host-level observations to your logging or metrics system.

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

`executionTimeoutMs` on a plugin sends 504 on expiry and aborts cooperatively, but an uncooperative handler still holds its lease and handler budget until it settles. Transport framing validates response headers. It drops `Connection`, the fields it names, `Keep-Alive` and `Proxy-Connection`, and rejects `Transfer-Encoding`, `TE`, `Trailer` and `Upgrade` with 500; the Node pump never writes bytes beyond Content-Length and closes a connection after a committed short frame.

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

The development gate runs lint, typecheck, Node and Bun HTTP tests, coverage, packed-consumer E2E and Chromium/WebKit media seeking. The release gate additionally requires a tracked Bun lockfile and a frozen install, actual RPC, MCP and O11y packages, plus an O11y fixture implementing the actual upstream API. See [verification](docs/VERIFICATION.md). Publishing invokes `make release-verify`, which fails closed if prerequisites are unavailable. Do not interpret an offline fallback build or source tests as a complete release attestation.

Run the separate-process benchmark against native transport and an optional previous build:

```sh
BASELINE_PACKAGE_DIR=/absolute/path/to/defuss-serve-0.2.0 make bench
make bench-frameworks
```

The harness verifies response payloads and reports throughput, latency percentiles, server CPU/RSS and file descriptor counts. Express, Fastify, Hono and native Node comparison modes implement the same tested fixture routes and static semantics, not all defuss-serve production safeguards. Native Bun is a lower-bound transport reference. Comparative packages are development-only. See [benchmark evidence](docs/BENCHMARKS.md) for the local results and limitations.
