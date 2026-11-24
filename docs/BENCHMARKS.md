# Benchmark evidence

Node.js 22.16.0, Linux, process-isolated loopback HTTP, 32 concurrent requests, warmup before measurement. Two complete matched rounds, 800 small/conditional requests, up to 500 SSE requests, 400 range requests and 48 full media transfers per round and mode. Arithmetic mean of the per-round rates, rounded. Status and transferred byte counts are asserted; media payload checks sample chunk boundaries. The v0.2.0 baseline is the actual previous offline package, extracted without rebuilding.

| Case | v0.2 immutable | v0.3 immutable | v0.2 live | v0.3 live | Native Node reference |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small requests/s | 2980 | 3206 | 2539 | 2814 | 4682 |
| SSE requests/s | 2930 | 4023 | 3629 | 3348 | 5382 |
| Conditional requests/s | 5475 | 5104 | 4424 | 3742 | 9681 |
| 64 KiB ranges/s | 3140 | 4479 | 3230 | 3618 | 3330 |
| 4 MiB transfers/s | 350 | 414 | 267 | 337 | 220 |

Results are workload-dependent; compare the rates in the table rather than assuming universal improvement. Round-to-round variance is substantial; the small sample is not a regression significance test. The direct pump and stricter framing are retained for correctness; further optimization should be driven by repeated profiling and feature-matched tests. CPU, RSS, latency and descriptor measurements are in `validation/benchmark.json`.

Reproduce with a built v0.2.0 baseline: `BASELINE_PACKAGE_DIR=/absolute/path/to/v0.2.0 BENCH_REQUESTS=3000 BENCH_ROUNDS=3 make bench`. Use `make bench-frameworks` after installing the pinned development dependencies to compare native Node, Express, Fastify, Hono and immutable defuss-serve. The reference adapters share the same tested fixture routes, byte-range and conditional semantics, not the full host protection and lifecycle contract. Native Bun remains a separate lower-bound reference. The offline Linux container that produced this table had neither the framework dependencies nor Bun, so those modes were not part of it. Do not use this table as evidence for performance superiority over those frameworks.
