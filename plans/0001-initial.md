# Initial implementation acceptance

1. `make lint` builds with pkgroll, checks repository policy, runs oxlint and strict TypeScript. Both export conditions resolve.
2. `make test` exercises real HTTP listeners on Node and Bun. Static GET/HEAD wins over RPC schema; POST reaches RPC. Verify conditional responses, malformed and large ranges, symlink containment, precompressed negotiation, CORS, body limits and live registry mutations.
3. `make coverage` enforces at least 85% lines, 80% functions and 75% branches of executed Node build code. Report Bun separately; do not infer Bun coverage from Node.
4. `make e2e` packs the publishable artifact, installs it in a fresh consumer, checks both TypeScript declaration modes and runs real requests under both runtimes. Provide actual RPC/MCP package artifacts to exercise their real clients.
5. `make bench` reports warmed transport smoke results without conflating client and server throughput. Optimize only on a reproduced bottleneck.
6. Review trust boundaries, document limitations, and execute the upstream VAE gate before release. Do not attest to checks that could not run.
