# CLI gist

- VERIFIED[gate] `mise exec -- make verify`: pinned toolchain, Node+Bun tests, coverage, packed E2E with Chromium and WebKit.
- VERIFIED[browsers] `mise exec -- make browsers`: installs the Playwright engines the e2e gate requires.
- VERIFIED[service] `PORT=18080 make start`, then `make status|log|stop`: detached example server; port 8080 may be taken locally.
- VERIFIED[vae] `make vae-gate VAE=<plugin>/scripts/vae.py`: an installed plugin has no plugin/ prefix.
- VERIFIED[release] `mise exec -- make release-verify` tests the published upstreams the Makefile names; for unreleased siblings pack ../defuss-{rpc,mcp,o11y} with `bun pm pack --ignore-scripts --destination <scratch>` and set DEFUSS_*_PACKAGE to the tarballs BC exit 0 2026-11-25; never run it beside another verify (both rebuild dist/).
- VERIFIED[gate] `mise exec -- python3 <vae>/scripts/vae.py gate --repo . --session <id>`: the gate runs `make test` and `make e2e` with PATH's bun and node, so run it under mise; on PATH's Bun 1.4.3 the WebSocket client tests behaved differently (2026-11-24).
