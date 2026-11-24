# CLI gist

- VERIFIED[gate] `mise exec -- make verify`: pinned toolchain, Node+Bun tests, coverage, packed E2E with Chromium and WebKit.
- VERIFIED[browsers] `mise exec -- make browsers`: installs the Playwright engines the e2e gate requires.
- VERIFIED[service] `PORT=18080 make start`, then `make status|log|stop`: detached example server; port 8080 may be taken locally.
- VERIFIED[vae] `make vae-gate VAE=<plugin>/scripts/vae.py`: an installed plugin has no plugin/ prefix.
- VERIFIED[release] Pack ../defuss-{rpc,mcp,o11y} with `bun pm pack --ignore-scripts --destination <scratch>`, then `DEFUSS_RPC_PACKAGE=… DEFUSS_MCP_PACKAGE=… DEFUSS_O11Y_PACKAGE=… DEFUSS_O11Y_FIXTURE=<fixture exporting createO11yFixture> mise exec -- make release-verify` BC exit 0 2026-11-24; never run it beside another verify (both rebuild dist/).
