# Adversarial review report

## Verdict

Revise. Two reproduced resolver regressions violate the preserved error and cancellation contract. Retry-After disappears across the resolver boundary, and malformed Streamed responses no longer cancel pending sibling reads. These are local corrections; neither finding rejects the addon architecture.

Release approval also needs the actual default Next build, staged standalone server, and packaged Electron application checks. A webpack build in a worktree with linked dependencies does not establish the default Turbopack path.

## Review contract

- Known target: `.desktop-runtime/rust-collector-worktree`, base `27abd3a`, supplied HEAD `a3cbb7a`, plus root-owned working tests/docs and the current `sources.ts`. The parent reports the final native artifact prefix `30dfd` and an ESM bootstrap correction in `7f09`.
- Known intent: Rust owns HTTP collection, listing/detail interpretation, resolver decisions, and browser sweep policy. Electron retains browser navigation and playback verification. Existing source identities, player identities, partial outcomes, rate limits, cancellation, and packaging must remain compatible.
- Known constraints: read-only implementation review, no full suite/build/Cargo invocation while other agents work. Only this report is written.
- Evidence inspected: source and baseline paths named below; `implementation-contract.md`, `grounding.md`, `task.md`, `decisions.tsv`, full-test log summaries, live native HTTP JSON, actual Electron main-first/main-after JSON, ABI restart JSON, parser timing JSON, and targeted native-fixture reproductions.
- Inferred: source compatibility is required beyond the recorded positive examples, including provider throttling and malformed detail responses.
- Unknown at review time: successful default build and packaged application results after final integration; final rerun after the lifecycle fixture adjustment; production behavior of every remote provider.

## Decision register

| Decision | Purpose | Assumptions | Failure probes | Evidence | Simpler alternative |
| --- | --- | --- | --- | --- | --- |
| Native addon with explicit process-lifetime Tokio runtime | Share one binary across Node and Electron and bound worker threads | Environment teardown safely releases pending collector work | Main-first/main-after worker restarts and pending unloads | `lib.rs:46`, `lib.rs:151`; ABI restart artifacts; actual Electron JSON | No replacement justified by inspected evidence |
| Rust HTTP with fixture transport | Preserve bounded requests and make failures reproducible | The real and fixture transports enforce the same contract | Cancellation during body reads, response bounds, redirects/status handling | `http.rs:191`, `http.rs:223`, `http.rs:333`; fixture tests; live SWAC/PPV evidence | Keep the seam, add missing failure cases |
| Resolver read batches through JavaScript | Keep networking effects separate from Rust source policy | Error metadata and early failure semantics survive serialization | HTTP 429 with Retry-After; malformed JSON with a pending sibling | AR-01 and AR-02 reproduce failures | Preserve typed errors and permit Rust to validate each completed read before the batch finishes |
| Rust browser sweep state machine | Preserve checkpoint/ack ordering and free-player selection | Ack changes affect subsequent navigation and accepted snapshots remain replayable | Reused/skipped details, background admission, failed checkpoints | `sweep.rs:473`, `sweep.rs:695`, `sweep.rs:811`, `sweep.rs:890`; targeted existing tests | No new abstraction required |
| Content-addressed addon and manifest | Prevent stale or corrupt native loading and allow startup without Rust | Input hash covers build inputs; staged files match manifest | Missing/corrupt binary, source changes, cached startup, forced rebuild | `bridge.cjs:37`; `build-rust-collector.mjs:116`; root-owned build tests | Keep current design and document compiler-upgrade force behavior |
| Standalone and Electron resource staging | Ship native collection without requiring Cargo | Default Next output and Electron paths load the staged binary | Default build, standalone startup, packaged main and workers | `prepare-desktop.mjs`, `electron-builder.yml`, `next.config.ts`; final evidence pending | No fallback production collector |

## Findings

### AR-01. Resolver failures discard provider retry deadlines

| Field | Detail |
| --- | --- |
| Severity | High |
| Confidence | High |
| Objectives | Correctness, reliability, compatibility |
| Decision or assumption | Resolver errors serialized as name/message preserve the existing transport contract. |
| Scenario | A Streamed, LiveSportPro, or TVApp extra detail request returns HTTP 429 or 503 with a long Retry-After. `readHtml` creates `SourceFetchError`, but the resolver driver drops its retry metadata and the final rejected value becomes a plain Error. The coordinator schedules the detail retry using the normal refresh interval. |
| Evidence | `lib/football/adapters/sources.ts:114` emits only name/message; `native/collector/src/resolver.rs:23` has only those fields; `sources.ts:122` reconstructs `Error`. `lib/football/runtime/composition.ts:38` extracts retry delay only from `SourceFetchError` or `PartialListingReadError`. `coordinator.ts:1303` uses that result for detail `nextEligibleAt`. Baseline `adapters/streamed.ts` rethrows the original settled rejection. |
| Impact | A provider's one-hour retry instruction can become a routine source refresh. Repeated detail attempts violate the server backoff and can prolong rate limiting. The initial observation read does not preserve this missing deadline because these failures occur in subsequent resolver reads. |
| Recommendation | Carry a typed transport-failure variant including retryAfterMs through Rust and reconstruct `SourceFetchError`, or preserve the original JavaScript error behind a stable response identifier returned by Rust. Preserve TimeoutError separately. |
| Verification | Using the existing Buffalo Sabres fixture, replace event.sources with one `golf/2123` reference and enqueue a native fixture response with status 429 and `retry-after: 3600`. The current rejection is `{"name":"Error","message":"http-429","retryAfterMs":null,"isSourceFetchError":false}`. Require 3,600,000 ms and the proper error type, then verify the coordinator's next detail eligibility. Include TVApp and sibling cancellation. |

### AR-02. Malformed Streamed responses wait for siblings and can become timeout evidence

| Field | Detail |
| --- | --- |
| Severity | Medium |
| Confidence | High |
| Objectives | Reliability, compatibility, performance, observability |
| Decision or assumption | Parsing a completed read batch preserves the previous immediate failure behavior. |
| Scenario | The first Streamed response in a batch contains malformed JSON while another response is pending. JavaScript waits for all reads before Rust parses the completed bodies. The malformed response therefore cannot abort its sibling. If the sibling times out, Rust returns the transport error before inspecting the malformed body. |
| Evidence | `sources.ts:109` awaits the whole `Promise.all`; `sources.ts:119` calls native advance only afterward. `resolver.rs:239` returns any read error before `resolver.rs:256` invokes streamed parsing. Baseline `adapters/streamed.ts` parses each response within its individual task and aborts the shared controller immediately on parse failure. |
| Impact | The detail slot stays occupied until the remaining HTTP request settles, normally up to the ten-second request deadline and potentially longer across redirects. A conclusive parser failure becomes a timeout, so the coordinator records different evidence. |
| Recommendation | Give Rust each completed response with its stable batch position so it can validate the response and request sibling cancellation before the batch joins. Keep source parsing in Rust. A native validation method used by the mechanical driver is also possible if it preserves the resolver's single policy owner. |
| Verification | Existing fixture event with two `golf` references: first body `malformed-json`, second delayed fixture failure `timed out`. Current result is `{"name":"TimeoutError","message":"timed out","cancels":[]}`. An injected-reader probe with an indefinitely pending second read remains unsettled and uncanceled after 100 ms; only external cleanup abort settles it. Require parser-changed and sibling cancellation before its deadline. |

## Missing requirements

The Rust quality gates are not all encoded in CI. `.github/workflows/quality.yml:23` runs locked Cargo tests, and those tests include committed golden data, but the workflow does not run `cargo fmt --check` or strict Clippy. Add both gates with their required toolchain components. The reported local 27-test and strict-Clippy passes do not prevent a later change from bypassing those checks.

## Open questions

- The parent owns actual default-build, standalone, and packaged Electron verification. Require startup and collection from staged resources with Cargo unavailable, including the real main/worker paths. Existing addon-only Electron tests establish ABI/lifecycle evidence, not package completeness.
- `full-tests-final.log` is not a clean final suite. It records 788 passed, one lifecycle failure, and one skip. The parent reports the lifecycle fixture adjustment in `a3cbb7a`; require the subsequent passing result before reporting a clean suite.
- Actual live HTTP evidence covers SWAC and PPV. Compression-dependent provider responses, all provider-specific endpoints, and remote browser challenge behavior are not independently established here. No finding is asserted without a reachable provider example.

## Cleared concerns

- The actual reqwest reader checks cancellation both while obtaining headers and while consuming chunks. It caps body bytes at 2 MiB, drops non-success bodies without consuming them, disables automatic redirects, and validates redirect destinations in the shared reader. This is production code, not a fixture-only limit.
- Catalog snapshots have the 30-minute lookup lifetime. Streamed/LiveSportPro/Sportsbite catalogs update only after parsed/empty outcomes. Sportsfeed complete catalogs clear previous routing entries while partial results retain known routes. No new cache-lifetime defect was proven.
- Class drop cancels registered requests; task-owned state is reference-counted. The explicit runtime limits worker threads to two and blocking threads to four. Actual Electron evidence reports ten worker restarts and three pending-read unloads per main-order scenario. Prototype evidence separately records only two runtime thread IDs.
- Browser sweep inspection confirms accepted snapshots are captured before ack application, skip/reuse updates prune pending navigation, free-server pages feed the native parser, and every fourth admission can serve background work. Existing focused tests cover ack changes during detail reads and accepted-checkpoint replay. No new concrete browser-sweep defect was proven.
- Loader and staging validate content-addressed binary and registry hashes. Source changes affect startup input identity; force bypasses the cached path and obtains compiler/cargo identity. Compiler upgrades alone intentionally do not invalidate cached startup, which permits startup without the compiler. This is a documented behavior to retain or explicitly change, not an accidental unverified claim of compiler-sensitive startup invalidation.

## Coverage and limits

The review used both implementation and architecture checks. Source inspection covered HTTP, cache routing, resolver errors, facade integration, representative parser/golden seams, browser sweeps, native lifecycle, loader/build identity, standalone staging, Electron resources, and CI. Three focused read-only Node probes exercised the current addon; no Cargo command, full suite, build, or implementation edit was performed.

Attention flags in the supplied decision trail: the first full migration suite had 22 failures; the later supplied log still has one failure. The first parser timing was rejected and replaced after fixed-regex caching. The paired final parser sample shows 938.3 ms wall/469 ms CPU/93.7 MB sampled peak RSS versus 1605.39 ms/891 ms/180.1 MB in one baseline sample. These are parser benchmark measurements, not total application memory or a 500 MiB application claim. The decision TSV also contains a split malformed row around parser-port; the review did not rely on it as a complete chronological audit.

The loose player-wire schema was already a known root-owned correction and is excluded from duplicate findings here. Its final replacement still needs validation. The current report assesses the inspected revision; fixes made during the review require their own focused rerun. This reviewer did not receive the full parent transcript and does not claim to have reviewed it. Different-model-family review was unavailable because the agent pool uses GPT-family models; this is an independent task review, not a different-family audit.

## Follow-up review at 74aa01e

The revised implementation clears AR-01 and AR-02. The current verdict is **approve with conditions**, limited to these fixes and the inspected player boundary/parser cleanup. Final integration and packaging gates remain owned by the root agent. This section supersedes the original findings' unresolved status and the original overall verdict, while preserving the historical review.

The reviewed commits are native fix `50d3b0d` and integration fix `74aa01e`. The manifest loaded during the probes names `collector-d735511abc67ad3af9f02d9e23b327de6cdf7df943224f8c7e31508c23653d98.node`. This distinction matters: `50d3b0d` is a commit, not the loaded binary digest.

### Cleared findings and checks

| Item | Result | Evidence |
| --- | --- | --- |
| AR-01, retry metadata | Cleared | The driver retains original JavaScript errors in a per-resolution map and sends a stable error ID through Rust. Native 429 fixture with Retry-After 3600 now rejects with `SourceFetchError`, message `http-429`, and `retryAfterMs: 3600000`. The new injected-reader test also verifies exact object identity. |
| AR-02, early malformed-response cancellation | Cleared | Native `validateResolveResponse` checks each completed Streamed body before batch settlement. Native fixtures with malformed response at index 0 and index 3 each canceled all three pending siblings, rejected `parser-changed`, and settled in 53 ms and 38 ms respectively. This verifies cancellation independently of the new injected-reader test. |
| New resolver tests | Passed | `node --experimental-strip-types --test tests/native-collector-resolver.test.ts`: two tests passed, no failures. The second test covers malformed JSON and invalid stream number. |
| Native player boundary | Cleared known loose-cast concern | `sources.ts` derives the six native locator variants from shared schemas and validates both direct and resolver player results. `as ResolvedPlayer[]` and the provider-only passthrough schema are gone. A process-local injected-output probe rejected unknown provider, incomplete TVApp, invalid Gooz ID, and invalid event-page URL. It preserved an otherwise valid event-page locator with a caller-supplied fixture game ID. This was a JavaScript boundary probe, not proof that Rust emits malformed values. |
| Shared locator rules | No new concrete regression found | `shared.ts` extracts the previous locator objects into named schemas without changing the persisted `CandidateLocatorSchema` rules. Only native input/output wrappers relax the caller-supplied gameId to a string, preserving the existing collector API while the domain schema retains its stricter game ID policy. |
| Orphan JavaScript parser | Cleared | `parsePlayers` and `SourcePlayer` were removed from `lib/sunday.ts`. Search of application and test source found no remaining caller. Existing Gooz extraction tests now call native `compatiblePlayers`, including lookalike-host rejection and backup deduplication. Scoreboard parsing remains because it is outside the source-player migration. |
| CI requirements | Addressed in working tree | `quality.yml` now installs rustfmt/clippy and runs format, strict Clippy, locked Cargo tests, and the full-object parity replay. Final execution results are pending from the root agent. |

The early validator matches the baseline Streamed schema-level check. Identity and target policy remain in the resolver after collection, as in the baseline. The stable error-ID map is local to one resolution and retains original Error instances, including SourceFetchError and TimeoutError. No additional concrete defect was found in the inspected changes.

### Decision-trail audit

The TSV header has six fields: timestamp, phase, decision, why, evidence, result. Exactly historical lines 11 through 15 have two fields each. These split the parser-port phase, merge decision, rationale, commit list, and result into five separate timestamped lines. The root should append one six-field correction referencing those original lines and reconstructing that single decision. Preserve the original lines as history. No other row had an invalid field count when checked.

### Remaining conditions and limits

The root must attach final gate results and actual default-build/standalone/packaged Electron evidence before treating deployment as approved. This follow-up ran only the focused two-test file and process-local Node probes; it did not run Cargo, a build, or the full suite, and did not modify implementation files. The same review model performed the follow-up. Different-family review remains unavailable, and no full parent transcript was supplied or claimed as reviewed.

### Follow-up compression check

The parent requested a focused assessment of missing reqwest gzip/brotli/deflate features before freezing packaging. `Cargo.toml` enables only native-tls and stream for reqwest, and the request builder does not send Accept-Encoding. The implementation consequently does not decode those content codings.

Eight real provider header probes used Node's raw HTTPS client, the native User-Agent/Accept headers, and no Accept-Encoding. Streamed, LiveSportPro, Sportsbite, NFLStreams, Buffstream CFB, PPV, and SWAC returned status 200 with no Content-Encoding. LiveTV failed Node certificate verification, so it supplied no content-coding evidence. Each response was destroyed after its headers were inspected. These probes do not establish behavior of every provider, redirect, or detail endpoint, but they found no current compressed-response failure.

Omitting Accept-Encoding does **not** request identity encoding. Under [RFC 9110 section 12.5.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-accept-encoding), its absence permits any content coding; an empty value requests no coding. The smallest correction is to explicitly send `Accept-Encoding: identity` or an empty Accept-Encoding value so the request advertises the actual client capability. Adding gzip/brotli/deflate decoding would restore the broader baseline fetch capability, but no live provider probe here proves that larger change is required now. Treat explicit identity negotiation as a bounded compatibility condition, not a reproduced provider outage. If decompression is added later, the existing 2 MiB cap must continue to apply to decoded bytes.

## Compression correction review at 65e8c21

The compression/negotiation condition is **cleared** by `65e8c21`. The correction enables reqwest gzip, Brotli, and deflate support and updates the lockfile. The production request/body path remains unchanged, so its existing cancellation, timeout, redirect, and decoded-byte accumulation logic still applies. This restores baseline decoding capability and supersedes the earlier recommendation to request identity explicitly.

The new `native_transport_decodes_compressed_body_before_enforcing_page_cap` test calls the actual `ReqwestTransport` against a local TCP HTTP server. It checks successful decoded bytes for gzip, Brotli, and deflate, verifies that the outbound request advertises all three encodings, and rejects a gzip payload that expands beyond 2 MiB with `response-too-large`. The cap sits after reqwest decoding in the same body stream for all three encodings. The test bypasses the discovery policy only by invoking the private transport seam from the `cfg(test)` module; it adds no production URL exception or allowlist bypass.

The root reports format, strict Clippy, and all 28 native tests passing, and reports the physical-root artifact rebuilt with digest prefix `9d926962`. This follow-up inspected the implementation and test; it did not rerun Cargo or independently load that rebuilt artifact. The actual default-build and installed package/standalone evidence remains pending from the root. No additional concrete defect was found in this bounded correction.

The appended `trail-correction` TSV record at `2026-10-09T19:57:12.6565623Z` has the intended six-column shape, explicitly references original rows 11 through 15 and commits `8e5c0bd`, `3e69a75`, `8198482`, and restores their decision/rationale/evidence/result without rewriting the fragments. The decision-trail condition is cleared.

The overall verdict remains **approve with conditions**, now limited to the final integration and actual default-build/standalone/packaged application gates. The same-model and limited-parent-transcript qualifications still apply.

## Final review at 7ead203

**Approve the Rust collector migration.** The supplied final integration and packaged-runtime evidence clears the remaining migration conditions. No unresolved material implementation finding remains from this review. Approval does not declare the separate 500 MiB whole-app goal achieved, or prove that every external provider currently supplies playable media.

### Final corrections and artifact checks

The loader tracing correction `a2a94c6` adds Turbopack ignore annotations to dynamic native artifact reads and loading. Hash verification and explicit staging remain intact. `7ead203` excludes Rust source, target output, Cargo files, build.rs, and declaration files from standalone tracing. `912be54` adds artifact guards for Rust source/compiler-cache leakage in standalone and packaged checks. These changes address the artifact leakage observed during the actual default build. They do not remove the explicitly prepared bridge, registry, manifest, or selected binary.

The physical root's reviewed resolver, HTTP implementation, bridge, and Next configuration are byte-identical to the integration worktree. The source-registry files have different byte serialization, but their parsed values and ordering are identical. This explains the distinct registry byte hashes without a source-policy difference.

The external copied package remains available under the directory recorded by `packaged-launch.json`. Independent file reads and SHA-256 calculations confirmed both main and server binary and registry hashes match their manifests. Each uses binary `9d926962934d7d7e03eda3d06e3dee1477a25de0d81f6acd2a6121e5df9bcb89`. Main resources contain only the manifest, registry, and selected binary; the server directory additionally contains `bridge.cjs`. Neither contains Rust source, Cargo files, or compiler output.

| Gate | Evidence and result |
| --- | --- |
| Full physical-root suite | `root-full-tests-final.log`: 792 tests, 791 passed, one existing skip, zero failures. |
| Default production build | `default-build-packaging.log`: Next 16.3.4 Turbopack, successful compile/typecheck/page generation, no build warning in the log. |
| Prepared standalone | Preparation log confirms 29 runtime package trees. Root reports the standalone worker loaded 47 sources and 14 scopes and stopped; subsequent real package API results establish successful server worker startup. |
| Windows package | `package-build.log` records electron-builder Windows x64 unpacked packaging. Builder metadata warnings about missing description/author and duplicate dependency references are not new collector load failures. |
| Checkout/toolchain independence | `run-packaged.mjs` copies the unpacked app outside the checkout, removes collector override variables, restricts PATH, checks Cargo/rustc fail with ENOENT, and launches with an isolated profile. `packaged-launch.json` records the external executable and matching resource manifests. |
| Running application | `packaged-api-proof.json` records HTTP 200 game/source APIs, 413 games, 1,173 listings, 47 sources, and all 14 schedule scopes complete, including MotoGP and Motorsport. |
| Published player collection | `packaged-candidate-proof.json` records 1,118 published candidates across 76 games. Browser collectors retain partial results and parser-changed diagnostics. |
| Installed resource HTTP | `installed-native-http.json` records live SWAC/PPV parsed results from Electron 44.4.3/Node 24.21.0. The inspected verification script imports the copied server adapter and disables JavaScript fetch before reads. |
| Visible application | `packaged-app.png` shows the rendered room and schedule rather than an error window. Its cards explicitly show no verified stream yet; the screenshot does not prove playback. Root reports zero captured main-renderer console errors. |
| Fixture cleanup | PID 24516 was absent when checked. The launcher uses an isolated temporary profile. |

### Final decision-trail audit

The committed-doc candidate `docs/research/rust-collector-decisions.tsv` contains 30 records. Only original lines 11 through 15 have invalid field counts, as already documented. The append-only correction remains present. Later records separately capture the rejected first timing, resolver review corrections, lifecycle-fixture synchronization, compression correction, actual tracing failures, outside-checkout package verification, final-artifact timing, and negative whole-app memory result. The inspected artifacts support those outcome distinctions. Earlier timing and test figures remain historical records rather than being rewritten as final results.

Independent recomputation from the three installed-baseline and installed-native JSON pairs confirms median CPU 984 versus 563 ms and sampled peak process RSS 180,862,976 versus 90,746,880 bytes. The final integration documentation reports these as approximately 43% less CPU and 50% less sampled RSS for the parser workload. The process-tree artifact separately records 61.17 seconds, mean private memory 1,704.71 MiB, peak 1,899.17 MiB, and at most 17 processes. The documentation correctly keeps these measurements separate.

### Final attention flags

- The 500 MiB whole-app target is unmet. The early-use process-tree sample is not a matched whole-app before/after experiment, and parser savings cannot substitute for that measurement.
- Browser first sweeps were partial with parser-changed diagnostics. StreamEast's captured proof had zero free rows. Preserved fixture behavior and published candidates establish collection operation, not universal current provider health or advancing playback.
- The verified artifact is a Windows x64 unpacked package copied outside the checkout. This is meaningful runtime/package-independence evidence, but it is not a fresh NSIS installer execution, signed release, update flow, or cross-platform package proof.
- Full tests and final build/package operations were performed by the root. This reviewer inspected their logs, scripts, data, screenshot, and packaged bytes; it did not rerun the whole pipeline. Reported native fmt/Clippy/28-test and final Electron restart passes remain root evidence, supplemented by this reviewer's earlier independent focused addon reproductions.
- The same model performed the review and follow-ups. Different-family review was unavailable. The reviewer received the task summaries and inspected the available decision trail/artifacts, not the full parent transcript. No claim of full-transcript review is made.

These flags constrain the claims that should accompany the ready PR. They are not additional unresolved defects in the reviewed migration.
