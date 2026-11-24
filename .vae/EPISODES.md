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
