# Verification episodes

- Node tests initially found that Headers normalizes leading newlines in a configured Cache-Control value. The constructor now rejects CR, LF and NUL explicitly; regression test added.
- Upstream source review found that raw RPC routing bypasses the legacy HTTP core's JSON guard and decompressed size limit. The RPC adapter now enforces both and tests gzip expansion and unsupported content types.
- Bun, pkgroll, oxlint and upstream npm packages were unavailable in the offline build environment. Full VAE gate remains open until the real toolchain and upstream integration tests pass.
- v0.3 raw HTTP probes confirmed the framing and ownership regressions. Tests now enforce no overflow bytes, connection termination on short frames and cleanup of invalid-header bodies.
- First direct pump failed a delayed-cancel test because read completion could race the cancel promise. Await actual cancellation before releasing the lease.
- Cross-module ownership testing exposed duplicated build files in the initial coverage denominator. The production ESM artifact is now measured once; CJS is tested by installed-package E2E. The failed original coverage report remains recorded.
- Node verification passes. The native Bun test is skipped here, and lock-check fails closed without a generated tracked bun.lock. No release attestation.
2026-11-23T23:30:19Z s=5940460f-14cc-4755-8f90-6d3a2cd68b90 FINDING lint: first real oxlint run failed no-control-regex at src/runtime/node.ts requestUrl and src/static/resolve.ts safeSegments; intentional, justified inline disables learn=verifier
2026-11-23T23:30:19Z s=5940460f-14cc-4755-8f90-6d3a2cd68b90 FINDING typecheck: TS 5.9.3 rejects Buffer as BodyInit in tests/server.test.ts gzip bodies; wrapped in Uint8Array learn=verifier
2026-11-23T23:30:19Z s=5940460f-14cc-4755-8f90-6d3a2cd68b90 FINDING src/runtime/bun.ts: Bun 1.4.5 development:false implies SO_REUSEPORT, so start() on a busy port succeeded; reusePort:false learn=verifier
2026-11-23T23:30:19Z s=5940460f-14cc-4755-8f90-6d3a2cd68b90 FINDING src/runtime/node.ts listenNode: hostUrl throw after listen (IPv6 zone host) leaked the listener; close on failure, reject empty host learn=test
2026-11-23T23:30:19Z s=5940460f-14cc-4755-8f90-6d3a2cd68b90 FINDING Bun 1.4.5 drops declared Content-Length for stream bodies >=256 B; HYPOTHESIS same-pull close in fileBody falsified (fixes only <256 B), reverted; documented limit learn=memory
2026-11-24T00:57:34Z s=5940460f DONE fp=d824307d75cc cov=89.0% paths=.github/workflows/release-verify.yml,.github/workflows/verify.yml,AGENTS.md,ARCH.md(+55)
2026-11-24T00:57:34Z s=5940460f FINDING src/runtime/bun.ts:listenBun learn=verifier: .vae/VERIFY.py bun.no-reuse-port plus tests/server.test.ts port-collision case
2026-11-24T00:57:34Z s=5940460f FINDING src/runtime/node.ts:listenNode learn=test: tests/regression.test.ts 'failed post-bind startup closes the listener' fails with EADDRINUSE when the fix is reverted
2026-11-24T00:57:34Z s=5940460f FINDING src/runtime/node.ts:requestUrl, src/static/resolve.ts:safeSegments learn=verifier: make lint (oxlint --deny-warnings) runs in make verify and the gate
2026-11-24T00:57:34Z s=5940460f FINDING tests/server.test.ts gzip bodies learn=verifier: strict typecheck runs in make verify
2026-11-24T00:57:34Z s=5940460f FINDING ARCH.md:33 (A10/A09) learn=none: paragraph placement is a reading judgment; vae.py prose has no mechanical rule for it
2026-11-24T00:57:34Z s=5940460f FINDING docs/BENCHMARKS.md:15 (B09) learn=none: staleness of an environment claim is not mechanically checkable
2026-11-24T00:57:34Z s=5940460f FINDING README.md:163 (A10) learn=none: paragraph size is a reading judgment
2026-11-24T00:57:34Z s=5940460f FINDING src/static/serve.ts:15 StaticStore learn=none: comment placement is not mechanically checkable by a rule kind
2026-11-24T01:12:13Z s=5940460f DONE fp=1ecabcbdd6bc cov=89.1% paths=ARCH.md,CHANGELOG.md,docs/BENCHMARKS.md,docs/VERIFICATION.md(+7)
2026-11-24T01:12:13Z s=5940460f FINDING src/server.ts:dispatch, src/registry.ts:acquire, src/runtime/node.ts:handle learn=memory: .vae/MEMORY.md [Node 22 perf]; a CPU budget is load-dependent, so no timing test
2026-11-24T01:12:13Z s=5940460f FINDING tests/regression.test.ts (test gap) learn=test: tests/regression.test.ts 'client disconnect aborts a running handler signal and releases its lease', mutation-checked on Node and Bun
2026-11-24T01:12:13Z s=5940460f FINDING package.json:test:bun learn=verifier: .vae/VERIFY.py tests.bun-paths
2026-11-24T01:12:13Z s=5940460f FINDING docs/BENCHMARKS.md:7,31,33,35,46 (B01, B03, P06) learn=none: claim-to-data agreement needs reading; no rule kind can compare prose numbers with result files
2026-11-24T01:12:13Z s=5940460f FINDING docs/VERIFICATION.md:26-34 (B09, P09) learn=none: staleness of a dated record is not mechanically checkable
2026-11-24T03:04:43Z s=5940460f DONE fp=ff67ced5f7b1 cov=89.3% paths=ARCH.md,CHANGELOG.md,README.md,docs/VERIFICATION.md(+5)
2026-11-24T03:04:43Z s=5940460f FINDING src/plugins/rpc.ts:rpcRoutes learn=test: VERIFIED: server.test.ts static-first dispatch test asserts POST /rpc/schema reaches the endpoint; upstream e2e also covers it.
2026-11-24T03:04:43Z s=5940460f FINDING src/runtime/framing.ts:forbidden learn=test: VERIFIED: regression.test.ts connection-management test fails with 500 on the pre-fix build and passes on Node and Bun, covering mutable headers, immutable fetc
2026-11-24T03:04:43Z s=5940460f FINDING ARCH.md:51 L03 S06 learn=none: Prose fix; no mechanical check fits.
2026-11-24T03:04:43Z s=5940460f FINDING docs/VERIFICATION.md defect list P09 learn=none: Prose fix; no mechanical check fits.
2026-11-24T03:33:07Z s=5940460f DONE fp=df43981a406a cov=89.3% paths=ARCH.md,CHANGELOG.md,README.md,docs/BENCHMARKS.md(+6)
2026-11-24T03:33:07Z s=5940460f FINDING docs/BENCHMARKS.md:50 B09; docs/VERIFICATION.md:44 B09 learn=none: Prose precision fix; no mechanical check fits.
2026-11-24T04:12:00Z s=5940460f DONE fp=c1036188a392 cov=89.3% paths=.github/workflows/release-verify.yml,ARCH.md,CHANGELOG.md,README.md(+7)
2026-11-24T04:12:00Z s=5940460f FINDING src/runtime/framing.ts:validateResponse learn=test: VERIFIED: regression.test.ts hop-by-hop test fails on the previous build at /sse and passes on Node and Bun for plugin, fetch() proxy and streamed fetch() proxy
2026-11-24T04:12:00Z s=5940460f FINDING scripts/e2e.ts:DEFUSS_O11Y_FIXTURE learn=test: VERIFIED: make release-verify passed with defuss-rpc@4.0.0 and defuss-mcp@0.6.0 from npm and the bundled fixture on Node and Bun.
2026-11-24T22:44:28Z s=7987786a FAIL tests.unit,tests.e2e.1
2026-11-24T22:52:47Z s=7987786a DONE fp=803ee2fc23b0 cov=89.8% paths=ARCH.md,CHANGELOG.md,README.md,docs/API.md(+18)
2026-11-24T22:52:47Z s=7987786a FINDING src/runtime/node-websocket.ts:closing learn=test: regression test with a half-open raw client
2026-11-24T22:52:47Z s=7987786a FINDING src/runtime/node-websocket.ts:frame learn=test: case added to the forbidden-frames test
2026-11-24T22:52:47Z s=7987786a FINDING src/runtime/bun.ts:fetch (Sec-WebSocket-Protocol) learn=none: the gate's pinned Bun is 1.4.5; the 1.4.3 deviation is documented in docs/API.md and ARCH.md
2026-11-24T23:07:30Z s=7987786a DONE fp=c1a10a4a9cf3 cov=89.8% paths=ARCH.md,CHANGELOG.md,README.md,docs/API.md(+19)
2026-11-25T00:01:48Z s=5940460f FAIL tests.unit
2026-11-25T00:05:46Z s=5940460f FAIL tests.unit
2026-11-25T00:05:47Z s=5940460f FAIL tests.unit,coverage
2026-11-25T00:09:03Z s=5940460f DONE fp=5c5ebad7c267 cov=89.8% paths=ARCH.md,CHANGELOG.md,README.md,docs/API.md(+19)
2026-11-25T00:09:03Z s=5940460f FINDING src/runtime/node.ts:upgrade learn=test: tests/websocket.test.ts sends an h2c POST whose body ends 50 ms after the head; it passes on Node 22.16, 24.22, 26.13 and Bun 1.4.5, and my first fix (socket on
2026-11-25T00:15:19Z s=5940460f DONE fp=fb535e98ffc0 cov=89.8% paths=.github/workflows/release-verify.yml,CHANGELOG.md,Makefile,README.md(+1)
2026-11-25T00:15:19Z s=5940460f FINDING Makefile:release-verify learn=verifier: make release-verify itself now resolves the packages, so the publish hook and CI run the same check; e2e.ts still fails closed if a resolved value is missing.
2026-11-25T00:15:19Z s=5940460f FINDING Makefile:UPSTREAM learn=none: a defect of this change before commit, fixed in place; make -n is the check, and no shipped behaviour regressed.
2026-11-25T06:51:40Z s=2dc3da1e DONE fp=ded7c04c658f cov=90.0% paths=ARCH.md,CHANGELOG.md,README.md,docs/API.md(+9)
2026-11-25T06:51:40Z s=2dc3da1e FINDING src/server.ts:dispatch (new URL(incoming.url)) learn=test: tests/regression.test.ts 'a request without a usable Host gets 400 on both runtimes, never 500' fails on the HEAD build and passes on Node 22.16, Bun 1.4.5 and 
2026-11-25T06:51:40Z s=2dc3da1e FINDING src/runtime/node.ts:handle,upgrade (adapter 400) learn=test: tests/regression.test.ts 'onRequest reports the path of every request ...' (Node absolute-form case) and the stats.rejected=4 assertion of the host-less test, w
2026-11-25T06:51:40Z s=2dc3da1e FINDING ARCH.md:63 P09 learn=none: prose judgement; vae.py prose reported 0 findings, no rule kind detects version narration reliably
2026-11-25T06:51:40Z s=2dc3da1e FINDING ARCH.md:61,63 L01 learn=none: reading-only check
2026-11-25T06:51:40Z s=2dc3da1e FINDING README.md:201 P08 learn=none: reading-only check
2026-11-25T06:51:40Z s=2dc3da1e FINDING docs/API.md:57-59 A03 A10; CHANGELOG.md:6 R03 learn=none: reading-only check
2026-11-25T17:24:17Z s=d517bc7c FAIL tests.unit
2026-11-25T17:27:40Z s=d517bc7c DONE fp=c86ef73df2f7 cov=90.0% paths=ARCH.md,CHANGELOG.md,Makefile,README.md(+10)
2026-11-25T17:27:40Z s=d517bc7c FINDING Makefile:build (recipes used the bun on PATH) learn=verifier: .vae/checks/policy.py (repo.policy rule and make lint) now asserts the Makefile keeps `mise bin-paths` and `build: toolchain`; the toolchain target itself fails
2026-11-25T17:27:40Z s=d517bc7c FINDING src/server.ts:dispatch rejected flag vs stats.rejected learn=none: Behaviour matches the documented contract; tests/regression.test.ts covers the 200, 404, 400, 403, 413 and encoded-slash cases on both runtimes.
2026-11-26T09:49:10Z s=2a2a1289 DONE fp=88899f03af96 cov=90.3% paths=ARCH.md,CHANGELOG.md,README.md,docs/API.md(+9)
2026-11-26T09:49:10Z s=2a2a1289 FINDING src/plugins/proxy.ts:hopByHop|decoded learn=test: tests/proxy.test.ts gzip, zstd and Host assertions; MEMORY line fetch() proxying
2026-11-26T09:49:10Z s=2a2a1289 FINDING tests/consumer.ts:echo learn=test: packed consumer asserts the forwarded chain with trustedProxies; README states the trustedProxies requirement
2026-11-26T09:49:10Z s=2a2a1289 FINDING ARCH.md:Reverse proxy B (evidence) learn=test: tests/proxy.test.ts 'cancels the upstream request when the client disconnects'
2026-11-26T09:49:10Z s=2a2a1289 FINDING docs/API.md:proxyPlugin P (precision) learn=none: a doc omission, not mechanically checkable
2026-11-26T09:49:10Z s=2a2a1289 FINDING src/http.ts:markPeer learn=none: comment wording
2026-11-26T11:09:18Z s=2a2a1289 DONE fp=8970f60dcba6 cov=90.3% paths=ARCH.md,CHANGELOG.md,README.md,docs/API.md(+11)
2026-11-26T11:09:18Z s=2a2a1289 FINDING package.json:version learn=none: release bookkeeping
