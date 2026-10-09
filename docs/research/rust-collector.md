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

Three sequential paired runs compare the frozen TypeScript baseline with addon `d735511abc67ad3af9f02d9e23b327de6cdf7df943224f8c7e31508c23653d98`. Each run asserts full-object parity before timing 100 rounds across 19 cases and consuming 2,500 observations.

| Metric, median of three runs | TypeScript baseline | Rust addon |
| --- | ---: | ---: |
| Process CPU time | 969 ms | 439 ms |
| Sampled peak process RSS | 180,768,768 bytes | 90,927,104 bytes |

The parser workload used about 55% less CPU time and 50% less sampled peak RSS. The RSS samples cover the benchmark process after each parse. They do not measure instantaneous allocation peaks or the Electron process tree. These figures do not establish a 500 MiB whole-app footprint.

The first native implementation regressed CPU because it compiled fixed regular expressions per parsed row. That candidate was rejected. Fixed parser expressions now compile once per call site. No provider work was skipped to obtain the accepted timings.

## Verification record

Rust format, strict Clippy across all targets, and 27 native tests passed. Typecheck, lint, and the full-object corpus replay passed. The actual addon passed two Electron 44.4.3 scenarios with ten worker reloads, three pending-read worker unloads, and all 19 listing objects per scenario. Live SWAC and PPV HTTP collection passed with JavaScript fetching disabled. These are two provider checks, not proof that every external site currently serves usable media.

Independent implementation review reproduced and then cleared both resolver issues. A native 429 fixture preserved the original `SourceFetchError` and its one-hour retry delay. Malformed responses canceled three pending sibling reads promptly. Final full-suite, default build, and installed-artifact checks follow below after execution.
