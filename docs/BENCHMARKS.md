# Benchmark evidence

`make bench` starts each server in its own process and drives it over loopback HTTP with 32 concurrent keep-alive connections after a warmup. The client asserts status codes and byte counts, compares small payloads exactly and samples media chunk boundaries. Each row reports the mean of the per-round request rates and the server's CPU time per request. `make bench-frameworks` runs the same fixture routes on native Node, Express, Fastify and Hono. The reference adapters share the fixture's byte-range and conditional semantics, not the host protections and lifecycle contract of defuss-serve.

## Local results, 2026-11-24

Environment: macOS arm64 (Apple M5 Max, 18 cores), Node 22.16.0, Bun 1.4.5, Express 5.1.0, Fastify 5.4.0, Hono 4.8.3 with @hono/node-server 1.14.4. Three rounds of 4000 small and conditional requests, 500 SSE requests, 400 range requests and 48 full media transfers per mode. Other processes kept the load average between 5 and 9. The fastest and slowest of the three rounds differed by a median of 17 to 21 % of the mean rate on Node and 35 % on Bun, and by up to 85 % in a single cell. Only large differences in these tables are meaningful; the alternating A/B below measures the request-path change.

Node 22.16, requests per second with server CPU microseconds per request:

| Case | Native Node | Express | Fastify | Hono | defuss-serve immutable |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small route | 20333 (81) | 12190 (119) | 18765 (86) | 31395 (57) | 18208 (96) |
| SSE | 28722 (57) | 14345 (95) | 30022 (57) | 45752 (51) | 21488 (112) |
| Conditional 304 | 29216 (55) | 15553 (89) | 27959 (61) | 30593 (60) | 34157 (50) |
| 64 KiB range | 8947 (262) | 6465 (313) | 9337 (260) | 7664 (288) | 11057 (183) |
| 4 MiB file | 621 (3435) | 616 (2977) | 642 (3280) | 702 (2958) | 1162 (1431) |

Bun 1.4.5, same units:

| Case | Native Bun | defuss-serve immutable | defuss-serve API only | defuss-serve live |
| --- | ---: | ---: | ---: | ---: |
| Small route | 63929 (10) | 53745 (22) | 61959 (19) | 24901 (54) |
| SSE | 76530 (9) | 46315 (29) | 57208 (29) | 22784 (64) |
| Conditional 304 | 61320 (23) | 59236 (24) | | 30416 (150) |
| 64 KiB range | 27053 (41) | 8875 (198) | | 10214 (241) |
| 4 MiB file | 1324 (653) | 971 (1793) | | 991 (1909) |

VERIFIED: On Node, static transfer is where defuss-serve leads. The response pump reads the selected bytes straight from the descriptor, so a 4 MiB file takes less than half the server CPU of the stream-piping references, and conditional responses match native Node.

VERIFIED: Small API and SSE calls on Node cost more CPU than Fastify and Hono. In a CPU profile of a small API call, the largest remaining costs are the socket write (22 % of busy time), the one validated Fetch Request per call (9 %) and web-stream body reads (about 6 %). The installed @hono/node-server 1.14.4 builds its undici Request lazily, only when a handler reads it; defuss-serve builds a real Request because protocol endpoints consume it unchanged.

VERIFIED: On Bun, small, SSE and conditional responses reach 60 to 97 % of native Bun throughput. Small requests use about twice native Bun's CPU, SSE about three times, and conditional responses about the same. Tracked file bodies are the exception: Bun consumes them as JavaScript streams, at 3 to 5 times the CPU of native file responses. A probe that removed one stream layer or read through `Bun.file(fd)` was not faster. `nativeStaticFastPath` trades request accounting for the native path.

VERIFIED: Live mode resolves the filesystem on every request, including API calls that miss static files. In a separate Node run, live mode used 127 us per small request against 101 us in immutable mode and served about half the conditional rate (14114 against 29962 requests/s). On Bun it halved small-request and conditional throughput. Use immutable mode, or the bounded negative cache in live mode, when that matters.

### Request-path change

Plugin calls on Node reuse the adapter's Request and its abortable signal instead of cloning the Request and combining signals with `AbortSignal.any` per call. An API-only server from the previous build and from the current build alternated six times. Each run measured 30000 requests at 32 concurrent connections after a 2000-request warmup, on Node 22.16 on the same machine. Values are medians.

| Path | Server CPU per request, before | After | Requests per second, before | After |
| --- | ---: | ---: | ---: | ---: |
| Small route | 48.2 us | 36.6 us | 27609 | 35223 |
| SSE | 45.8 us | 35.1 us | 25166 | 32533 |

Server CPU per request fell by 24 % for the small route and 23 % for SSE; throughput rose by 28 % and 29 %. The standard harness reports about 100 us per request for the same build. HYPOTHESIS: its verifying client drives the server at a lower rate, so each request pays more event-loop wakeup cost; a run at matched request rates would test this. A five-round interleaved standard harness run against the previous build showed the same direction within its noise. On Bun the dispatcher still clones the Bun-created Request once, and Bun results did not change beyond noise.

## Earlier offline record

These numbers came from an earlier offline v0.3.0 build, before the 2026-11-24 fixes, in a Linux container with Node.js 22.16.0: process-isolated loopback HTTP, 32 concurrent requests, warmup before measurement. Two complete matched rounds, 800 small/conditional requests, up to 500 SSE requests, 400 range requests and 48 full media transfers per round and mode. Arithmetic mean of the per-round rates, rounded. Status and transferred byte counts are asserted; media payload checks sample chunk boundaries. The v0.2.0 baseline is the actual previous offline package, extracted without rebuilding.

| Case | v0.2 immutable | v0.3 immutable | v0.2 live | v0.3 live | Native Node reference |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small requests/s | 2980 | 3206 | 2539 | 2814 | 4682 |
| SSE requests/s | 2930 | 4023 | 3629 | 3348 | 5382 |
| Conditional requests/s | 5475 | 5104 | 4424 | 3742 | 9681 |
| 64 KiB ranges/s | 3140 | 4479 | 3230 | 3618 | 3330 |
| 4 MiB transfers/s | 350 | 414 | 267 | 337 | 220 |

Results are workload-dependent; compare the rates in the table rather than assuming universal improvement. Round-to-round variance is substantial; the small sample is not a regression significance test. The direct pump and stricter framing are retained for correctness; further optimization should be driven by repeated profiling and feature-matched tests. CPU, RSS, latency and descriptor measurements are in `validation/benchmark.json`.

Reproduce with a built v0.2.0 baseline: `BASELINE_PACKAGE_DIR=/absolute/path/to/v0.2.0 BENCH_REQUESTS=3000 BENCH_ROUNDS=3 make bench`. Use `make bench-frameworks` after installing the pinned development dependencies to compare native Node, Express, Fastify, Hono and immutable defuss-serve. The reference adapters share the same tested fixture routes, byte-range and conditional semantics, not the full host protection and lifecycle contract. Native Bun remains a separate lower-bound reference. The offline Linux container that produced this table had neither the framework dependencies nor Bun, so those modes were not part of it. Do not use this table as evidence for performance superiority over those frameworks.
