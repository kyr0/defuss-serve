# Verification

The source distribution includes a reproducible VAE project policy (`.vae/VERIFY.py`, `.vae/checks/policy.py`) and a CI workflow. This is an unpublished release candidate. `make release-verify` passed locally against the published RPC and MCP packages and a local defuss-o11y build. No CI run has confirmed it yet.

## Run on a development machine

Install the toolchain from `mise.toml` and OpenSSL for the certificate-validated HTTPS test. Then run `make setup` and `make browsers`, review and commit the generated `bun.lock`, and run `make verify`. Use `mise exec -- make verify` when the shell's own `bun` or `node` differ from the pins. The Makefile deliberately requires Bun for the standard verification gate.

For the upstream VAE program, run `make vae-init` and `make vae-gate` with `VAE_HOME=/path/to/defuss-vae` (a checkout) or `VAE=/path/to/plugin/scripts/vae.py` (an installed agent plugin). Complete its actual review and docs stages; do not create synthetic attestations.

Actual RPC and MCP package-consumer integration is optional during local transport development but required for claiming upstream interoperability. Use absolute paths to the upstream tarballs with `DEFUSS_RPC_PACKAGE` and `DEFUSS_MCP_PACKAGE`, as described in the README. The upstream MCP 0.6.0 package requires at least Node 22.19.0; npm warns about the engine when installing it on the pinned 22.16.0, and the tests still pass. defuss-o11y is not published on npm. `make release-verify` also requires `DEFUSS_O11Y_PACKAGE`, a published package spec or an absolute tarball path; `tests/o11y-fixture.ts` mounts it unless `DEFUSS_O11Y_FIXTURE` names another fixture. The release workflow defaults the three packages to defuss-rpc 4.0.0, defuss-mcp 0.6.0 and defuss-o11y 0.3.0, so it fails until defuss-o11y is published.

The built-in Node coverage gate measures the executed ESM build once. Node cannot execute Bun-specific native branches. Unit/integration coverage is not evidence of protocol compatibility or performance on another runtime.

## Local results, 2026-11-24

Environment: macOS arm64, Node 22.16.0 and Bun 1.4.5 from `mise.toml`, pkgroll 2.29.0, oxlint 1.90.0, TypeScript 5.9.3, Playwright 1.64.1. Commands: `mise exec -- make verify` and `mise exec -- make release-verify`, both exit 0.

- pkgroll ESM/CommonJS build, repository policy, oxlint with `--deny-warnings` and strict typecheck: passed.
- Node HTTP tests: 39 tests, 38 passed, 0 failed, 1 skipped. The skipped test is the native Bun file path, which only Bun can execute.
- Bun HTTP tests: 39 tests across 3 files, 39 passed, 0 failed.
- ESM production-artifact coverage: 89.31% lines, 90.10% branches, 92.00% functions, above the 85/75/80 thresholds.
- Packed consumer on Node and Bun: ESM and CommonJS declarations and HTTP checks passed.
- Browser media seeking: Chromium and WebKit, each against Node and Bun listeners, passed with 206 range responses.
- Actual upstream RPC and MCP on Node and Bun: passed with the published defuss-rpc 4.0.0, defuss-mcp 0.6.0 and `@modelcontextprotocol/client` 2.4.0 from npm. The RPC client called a method and read a stream; the MCP SDK client called a tool.
- Actual upstream O11y on Node and Bun: passed with defuss-o11y 0.3.0 packed from a local build, because it is not published. `tests/o11y-fixture.ts` follows defuss-o11y's own `examples/serve/verify.mjs`: health, readiness, liveness and metrics payloads, 405 for POST, and readiness turning 503 after drain.
- `make lock-check`: passed against the tracked `bun.lock` with a frozen install.
- Benchmarks: `make bench` and `make bench-frameworks` ran on this machine. [Benchmark evidence](BENCHMARKS.md) has the results and an A/B of the Node request-path change.

The first runs with the real toolchain found these defects. Each has a fix and a regression test or verifier rule:

- oxlint rejected two intentional control-character regular expressions. They carry justified inline exceptions.
- TypeScript 5.9.3 rejected `Buffer` request bodies in a test. The test passes `Uint8Array`.
- Bun 1.4.5 enables `SO_REUSEPORT` when development mode is off, so a second server on an occupied port started. The Bun adapter sets `reusePort: false`, the port-collision test passes on Bun, and `.vae/VERIFY.py` checks the option.
- A host that binds but cannot be expressed as a URL, such as `::1%lo0`, rejected `start()` while leaving the socket bound. The Node adapter closes the socket, a regression test reclaims the port, and an empty `host` is rejected.
- The first `make release-verify` run found that `rpcPlugin` answered `POST /rpc/schema` with 405. The defuss-rpc client fetches its schema with POST, so `getRpcClient` failed. The route accepts POST, and a server test covers it.
- It also found that MCP through defuss-serve returned 500: defuss-mcp 0.6.0 sends `Connection: keep-alive` on SSE, and response validation rejected every hop-by-hop header. The listener drops hop-by-hop headers, including `Transfer-Encoding: chunked` from `fetch()` proxies, and still rejects other transfer codings; a regression test covers both on Node and Bun.
- `bun test tests/*.test.ts` treated its arguments as substring filters, so a repository copy under `tmp/` raised the Bun suite to 75 tests. The script passes `./tests/` paths, and `.vae/VERIFY.py` checks it.

Bun 1.4.5 sends any stream body of 256 bytes or more with chunked transfer encoding and drops its declared Content-Length; raw-socket probes confirmed this for default, `direct`, `bytes` and async-iterator streams. Tests accept a missing Content-Length on Bun but never a wrong one, and still check exact bytes.

## Earlier offline record

The files in `validation/` came from an earlier offline v0.3.0 build, before the 2026-11-24 fixes, in a Linux container without Bun, pkgroll, oxlint or registry access, using a TypeScript compiler fallback build. They are kept as history, not as evidence for the current sources. That record includes a failed first coverage attempt (55.81% lines) caused by duplicate CJS artifacts in the denominator, in `validation/coverage-duplicate-artifacts.log`.

## Primary design references

- [Bun HTTP routing and file responses](https://bun.com/docs/runtime/http/routing)
- [Bun 1.3.13 Range support](https://bun.com/blog/release-notes/bun-v1.3.13)
- [Bun HTTP server](https://bun.com/docs/runtime/http/server)
- [defuss-rpc server](https://github.com/kyr0/defuss-rpc/blob/main/src/server.ts)
- [defuss-rpc HTTP core](https://github.com/kyr0/defuss-rpc/blob/main/src/http-core.ts)
- [defuss-mcp HTTP endpoint](https://github.com/kyr0/defuss-mcp/blob/main/src/http.ts)
- [defuss-vae](https://github.com/kyr0/defuss-vae)
- [HTTP semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)
