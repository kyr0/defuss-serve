# CLI gist

- VERIFIED[gate] `mise exec -- make verify`: pinned toolchain, Node+Bun tests, coverage, packed E2E with Chromium and WebKit.
- VERIFIED[browsers] `mise exec -- make browsers`: installs the Playwright engines the e2e gate requires.
- VERIFIED[service] `PORT=18080 make start`, then `make status|log|stop`: detached example server; port 8080 may be taken locally.
- VERIFIED[vae] `make vae-gate VAE=<plugin>/scripts/vae.py`: an installed plugin has no plugin/ prefix.
- UNKNOWN[upstream e2e] `DEFUSS_RPC_PACKAGE=/abs/rpc.tgz DEFUSS_MCP_PACKAGE=/abs/mcp.tgz make e2e` BC no upstream tarballs available.
- UNKNOWN[release] `make release-verify` BC no git repo, so bun.lock is untracked; upstream RPC/MCP/O11y packages absent.
