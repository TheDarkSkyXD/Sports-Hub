# Rust source collector

The migration replaces collection for all 47 registered sources with an in-process Rust Node-API addon. It includes the 45 HTTP sources and the Sportsurge v2 and StreamEast browser catalogs. Electron retains Chromium navigation, challenges, DOM capture, cookies, media observation, and advancing-video verification. The coordinator retains game matching, eligibility, storage, retries, and media admission.

## Contract

Rust owns HTTP fetching, source request expansion, catalog caches, listing and detail parsing, published-player locators, browser sweep decisions, and catalog checkpoint state. JavaScript adapters translate existing domain calls and execute browser or resolver effects selected by Rust. They do not run the previous collector implementations as a fallback.

Preserve source IDs, parser versions, event and player identities, ordering, kickoff times, duplicate conflicts, and partial category results. Keep confirmed empty, changed, unsupported, unpublished, blocked, and failed outcomes distinct. Preserve bounded requests, redirect rules, cancellation through body reads, retry delays, and instance-owned catalog caches. An emitted player locator does not make a feed Available. The existing playback path still requires fresh advancing video.

## Design decision

| Design | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| In-process Rust addon | Keeps synchronous parser ports and adds no collector process. | Requires native loading and explicit artifact packaging. | Selected. |
| Owned Rust executable over stdio | Isolates native failures and hides collection behind asynchronous operations. | Adds three owner-local processes, framing, shutdown, and detail leases. | Rejected for this migration. |

The independent design review selected the addon. Each JavaScript environment owns its mutable collector state. The loaded addon uses a bounded asynchronous runtime. Browser and resolver state machines return domain-specific effects. JavaScript executes those effects and returns their results. Rust owns priority, source-reference batches, identity checks, acknowledgment interpretation, skipped or reused details, and complete or partial classification.

Existing coordinator sequencing stays intact. Detail enrichment can change matching before player resolution. The injected resolver reader remains available for deterministic tests. Production reads use Rust HTTP. This avoids a new coordinator lease API and preserves cancellation tests that require all started reads to settle before rejection.

The migration preserves the existing discovery URL policy. It does not add DNS policy changes. Playback providers continue to validate a locator independently when opening its media.

## Build and verification gates

Use a content-addressed native artifact to avoid overwriting a DLL loaded by Windows. Build freshness must cover Rust inputs, the source registry, Cargo lockfile, compiler and target, build helper, manifest, and selected binary. Stage the binary explicitly in both Electron resources and the standalone server. An installed app must run without Cargo or checkout access. Missing or stale native code must fail preparation with an actionable error.

Verification proceeds through native loading, frozen parser and sweep parity, source integration, then standalone and packaged Electron checks. Resource comparisons must measure the actual process tree. Rust alone does not establish the previous 500 MiB whole-app target.

The pre-migration baseline at `27abd3a` passed 779 tests with one existing skip and no failures.

## Implementation

The native addon replaces the HTTP parser and resolver modules and the two browser catalog parsers and sweep state machines. Removed collector modules have no compatibility fallback. Locator variants share the domain schemas at the TypeScript boundary. Native resolver failures select an owner-local error reference so the original error and retry delay survive the native call. Streamed response grammar is validated in Rust as each read settles. Malformed responses cancel sibling reads and wait for their settlement before rejection.

The runtime has two asynchronous workers and at most four blocking workers. It lives for the process lifetime. Deferred Node-API results avoid creating replacement runtimes after worker teardown. The loaded binary and source registry are verified against their manifest. An unchanged startup uses the staged addon without probing Cargo or rustc. Source, registry, platform, architecture, and Rust flags invalidate that cache. Use `node scripts/build-rust-collector.mjs --force` after a compiler upgrade to replace a cache built with the previous compiler.

The frozen corpus includes 19 listing cases with 16 positive source families, seven browser categories, and four sweep traces. It enumerates all 47 registered source entries. Enumeration is not individual positive coverage for every provider. Native fixture tests exercise the production HTTP policy for redirects, retry delays, body limits, cancellation, caches, and partial results.

## Measured parser cost

Three sequential paired runs compare the frozen TypeScript baseline with the final main-checkout addon `9d926962934d7d7e03eda3d06e3dee1477a25de0d81f6acd2a6121e5df9bcb89`. Each run asserts full-object parity before timing 100 rounds across 19 cases and consuming 2,500 observations.

| Metric, median of three runs | TypeScript baseline | Rust addon |
| --- | ---: | ---: |
| Process CPU time | 984 ms | 563 ms |
| Sampled peak process RSS | 180,862,976 bytes | 90,746,880 bytes |

The parser workload used about 43% less CPU time and 50% less sampled peak RSS. The RSS samples cover the benchmark process after each parse. They do not measure instantaneous allocation peaks or the Electron process tree. These figures do not establish a 500 MiB whole-app footprint.

The first native implementation regressed CPU because it compiled fixed regular expressions per parsed row. That candidate was rejected. Fixed parser expressions now compile once per call site. No provider work was skipped to obtain the accepted timings.

## Verification record

Rust format, strict Clippy across all targets, and 28 native tests passed. The full main-checkout suite passed 791 tests with one existing skip and no failures. Typecheck, lint, and the full-object corpus replay passed. The actual final addon passed two Electron 44.4.3 scenarios with ten worker reloads, three pending-read worker unloads, and all 19 listing objects per scenario. Live SWAC and PPV HTTP collection passed with JavaScript fetching disabled. These are two provider checks, not proof that every external site currently serves usable media.

Independent implementation review reproduced and then cleared both resolver issues. A native 429 fixture preserved the original `SourceFetchError` and its one-hour retry delay. Malformed responses canceled three pending sibling reads promptly. A real loopback HTTP server verified gzip, brotli, and deflate decoding. Compressed data that expands beyond 2 MiB is rejected by the native transport.

The default Next.js 16.3.4 Turbopack build passed from the physical main checkout. That gate caught native-loader tracing that copied the project and then the Rust compiler cache into standalone output. The loader now opts out of dynamic artifact tracing, and Next explicitly excludes native build inputs. The preparation script stages the bridge, manifest, registry, and selected binary. Standalone and packaged artifact checks reject Rust source and compiler-cache leakage. Compiled-startup fixtures wait for lifecycle events under a test watchdog while retaining the existing stop responsiveness checks.

The prepared standalone worker loaded all 47 sources and 14 league scopes, then stopped. A Windows x64 unpacked package built successfully. A copy launched from a temporary directory outside the checkout with Cargo and rustc unavailable on PATH. Its main and server resources contained the same native binary hash. The running app returned HTTP 200 for both game and source APIs, with 413 games, 1,173 listings, and 1,118 published candidates across 76 games. All 14 schedule scopes were complete at the captured snapshot, including MotoGP and Motorsport. Browser catalogs were active. Their first captured sweeps retained partial results with parser-changed diagnostics; this run does not establish every live provider category as complete.

The package's embedded Electron Node runtime also fetched and parsed live SWAC and PPV pages with JavaScript fetching disabled. The main renderer console recorded no errors during the verification window. The isolated app was stopped after verification. The user's normal profile was not used.

## Whole-app limit

A 61-second sample during early use of that fresh packaged profile measured the owned process tree. Mean private memory was 1,704.71 MiB and peak private memory was 1,899.17 MiB, with at most 17 processes. The GPU process used 575.75 MiB at the peak-memory sample. Mean CPU use was 53.39% of one core, or 3.34% of the 16-core machine.

The 500 MiB whole-app target remains unmet. This was a fresh packaged profile with automatic room selection and active browser collectors and checks. It is not a matched whole-app before/after comparison with the older source-launch measurements. The parser improvements above must not be reported as whole-app savings.

Local execution evidence is retained in `.desktop-runtime/rust-collector/`, including `root-full-tests-final.log`, `default-build-packaging.log`, `packaged-launch.json`, `packaged-api-proof.json`, `packaged-candidate-proof.json`, `installed-native-http.json`, and `packaged-resources.json`. The committed fixture, benchmark, build, standalone, and package checks provide repeatable gates. [The decision trail](rust-collector-decisions.tsv) records rejected candidates and the verification corrections.
