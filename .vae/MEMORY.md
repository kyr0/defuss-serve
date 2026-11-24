# Project memory

- VERIFIED[dispatch] Static GET/HEAD precedes protocol dispatch; denials are terminal, misses fall through, SPA last BC tests/server.test.ts static-first test.
- VERIFIED[src/plugins/rpc.ts] Raw legacy RPC routing bypasses the upstream JSON guard and decompressed limit; the adapter enforces both BC upstream http-core review; server.test.ts legacy RPC test.
- VERIFIED[Node request bodies] Cancelling the incoming Node stream can destroy the socket before 413; reject without cancel, close unread requests BC v0.2 regression; rpc.ts prepareCall.
- VERIFIED[Bun native file] A whole BunFile auto-applies Range; if the shared decision ignores Range, stream instead BC regression.test.ts native Bun If-Range case.
- VERIFIED[src/runtime/bun.ts] Bun 1.4.5 development:false implies SO_REUSEPORT; keep reusePort:false or a busy port starts silently BC same-port probe; bun test port collision case.
- VERIFIED[Bun 1.4.5 Bun.serve] A ReadableStream body of 256 B or more is sent chunked and its declared Content-Length dropped; every tracked Bun body is a stream BC raw-socket probes.
- VERIFIED[src/runtime/node.ts] A throw after listen() must close the server, else port and process stay alive BC ::1%lo0 zone-host probe; regression.test.ts post-bind test.
- VERIFIED[leases] Cancellation is not completion: hold leases until handler and source cancellation settle; a 504 does not end the handler BC delayed-cancel failure; deadline test.
- VERIFIED[coverage] Count the ESM dist once; CJS is verified by the packed consumer BC duplicate-artifact run 55.81% (validation/coverage-duplicate-artifacts.log).
- VERIFIED[toolchain] PATH has bun 1.4.3 and node 26; run gates via `mise exec --` for the pinned bun 1.4.5 and node 22.16.0 BC mise ls; verify run 2026-11-24.
- VERIFIED[Node 22 perf] API CPU is undici Request/signal churn, not routing: avoid per-call Request clones and AbortSignal.any BC alternating A/B 6x30k req, 48->37us/req, 2026-11-24
- VERIFIED[Bun static perf] Tracked file bodies cost ~4x native CPU from JS-stream consumption; fewer layers or Bun.file(fd) streams do not help BC 2026-11-24 probe
