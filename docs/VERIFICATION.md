# Verification

The source distribution includes a reproducible VAE project policy (`.vae/VERIFY.py`, `.vae/checks/policy.py`) and a CI workflow. This is a development candidate, not a published or release-verified build: the actual upstream RPC, MCP and O11y interoperability tests have not run, and the Bun lockfile is not tracked in version control.

## Run on a development machine

Install the toolchain from `mise.toml` and OpenSSL for the certificate-validated HTTPS test. Then run `make setup` and `make browsers`, review and commit the generated `bun.lock`, and run `make verify`. Use `mise exec -- make verify` when the shell's own `bun` or `node` differ from the pins. The Makefile deliberately requires Bun for the standard verification gate.

For the upstream VAE program, run `make vae-init` and `make vae-gate` with `VAE_HOME=/path/to/defuss-vae` (a checkout) or `VAE=/path/to/plugin/scripts/vae.py` (an installed agent plugin). Complete its actual review and docs stages; do not create synthetic attestations.

Actual RPC and MCP package-consumer integration is optional during local transport development but required for claiming upstream interoperability. Use absolute paths to the upstream tarballs with `DEFUSS_RPC_PACKAGE` and `DEFUSS_MCP_PACKAGE`, as described in the README. The upstream MCP 0.6.0 package requires at least Node 22.19.0. No defuss-o11y upstream package was available to verify; only the structural Fetch adapter is tested. `make release-verify` also requires `DEFUSS_O11Y_PACKAGE` and `DEFUSS_O11Y_FIXTURE`: published package specs or absolute tarball paths and a real O11y fixture, as described in `scripts/e2e.ts`.

The built-in Node coverage gate measures the executed ESM build once. Node cannot execute Bun-specific native branches. Unit/integration coverage is not evidence of protocol compatibility or performance on another runtime.

## Local results, 2026-11-24

Environment: macOS arm64, Node 22.16.0 and Bun 1.4.5 from `mise.toml`, pkgroll 2.29.0, oxlint 1.90.0, TypeScript 5.9.3, Playwright 1.64.1. Command: `mise exec -- make verify`, exit 0.

- pkgroll ESM/CommonJS build, repository policy, oxlint with `--deny-warnings` and strict typecheck: passed.
- Node HTTP tests: 37 tests, 36 passed, 0 failed, 1 skipped. The skipped test is the native Bun file path, which only Bun can execute.
- Bun HTTP tests: 37 tests, 37 passed, 0 failed.
- ESM production-artifact coverage: 88.95% lines, 90.21% branches, 92.35% functions, above the 85/75/80 thresholds.
- Packed consumer on Node and Bun: ESM and CommonJS declarations and HTTP checks passed.
- Browser media seeking: Chromium and WebKit, each against Node and Bun listeners, passed with 206 range responses.
- Actual upstream RPC/MCP and O11y: not run, because no upstream packages or fixture were supplied.
- `make release-verify`: not run. The directory is not a git repository, so `make lock-check` cannot find a tracked `bun.lock`.
- Benchmarks: not rerun. [Benchmark evidence](BENCHMARKS.md) records the earlier offline Linux rounds.

The first runs with the real toolchain found these defects, now fixed with regression evidence:

- oxlint rejected two intentional control-character regular expressions; they carry justified inline exceptions.
- TypeScript 5.9.3 rejected `Buffer` request bodies in a test; the test now passes `Uint8Array`.
- Bun 1.4.5 enables `SO_REUSEPORT` when development mode is off, so a second server on an occupied port started. The Bun adapter now sets `reusePort: false`; the port-collision test passes on Bun, and `.vae/VERIFY.py` checks the option.
- A host that binds but cannot be expressed as a URL, such as `::1%lo0`, rejected `start()` while leaving the socket bound. The Node adapter now closes it; a regression test reclaims the port. An empty `host` is rejected.

Bun 1.4.5 sends any stream body of 256 bytes or more with chunked transfer encoding and drops its declared Content-Length; raw-socket probes confirmed this for default, `direct`, `bytes` and async-iterator streams. Tests accept a missing Content-Length on Bun but never a wrong one, and still check exact bytes.

## Earlier offline record

The v0.3.0 files in `validation/` came from an offline Linux container without Bun, pkgroll, oxlint or registry access, using a TypeScript compiler fallback build. They are kept as history, not as evidence for the current sources. That record includes a failed first coverage attempt (55.81% lines) caused by duplicate CJS artifacts in the denominator, in `validation/coverage-duplicate-artifacts.log`.

## Primary design references

- [Bun HTTP routing and file responses](https://bun.com/docs/runtime/http/routing)
- [Bun 1.3.13 Range support](https://bun.com/blog/release-notes/bun-v1.3.13)
- [Bun HTTP server](https://bun.com/docs/runtime/http/server)
- [defuss-rpc server](https://github.com/kyr0/defuss-rpc/blob/main/src/server.ts)
- [defuss-rpc HTTP core](https://github.com/kyr0/defuss-rpc/blob/main/src/http-core.ts)
- [defuss-mcp HTTP endpoint](https://github.com/kyr0/defuss-mcp/blob/main/src/http.ts)
- [defuss-vae](https://github.com/kyr0/defuss-vae)
- [HTTP semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)
