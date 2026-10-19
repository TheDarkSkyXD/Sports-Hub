# Backend performance pass, October 18, 2026

This pass implements the four remaining backend recommendations. It preserves candidate selection rules, source evidence, saved room preferences, and retained history. No schema migration, new database index, persistent freshness cache, commit, or pull request was added.

## Baseline and design

A read-only probe through the existing Electron renderer reproduced room-source response headers between 129 and 1019 ms. Those requests shared a changing worker and live collector workload, so they are a baseline observation rather than a controlled benchmark.

The design keeps candidate facts and partition freshness local to one synchronous pass. Compact and full inventory projections share listing admission, evidence, eligibility, availability, and ordering. A more aggressive scalar cache deadline was rejected because schedule, ownership, midnight, proof, publication, and clock changes affect validity.

Build the Lever produced `tests/benchmark-football-coordinator.mjs`. It compares the preserved `ce5b40af-6576-4710-9349-95fe02bc9e21` build with current code using separate identical in-memory stores. The fixture contains 96 games, eight live games, 12 sources, 192 retained playable candidates, and 492 persisted listing attempts. Three warmups precede seven alternating measured rounds. Every operation must retain its complete output digest.

## Ranking facts are computed once per sort

`candidateRanking()` memoizes proof and recent decoded-startup facts for each candidate during one sort. All legacy comparator callers migrated. Startup speed still affects ordering only when both candidates have recent measurements; missing decoded data does not receive a synthetic priority. No game/source index was added because the smaller comparator change established the gain.

A failing public session-command test measured 253 partition reads for 64 retained servers against a 192-read bound. The implementation passes that bound and literal tests for mixed/expired decoded observations and explicit selection.

The independent 128-server controlled replay reduced median session-command time from 6.50 to 2.34 ms, about 64%, and partition reads from 1,679 to 383. Complete candidate summaries and selection matched. Independent review also checked decoded and proof expiry immediately before, at, and after their boundaries.

## History reads avoid large JavaScript allocations

`sourceAttempts()` now iterates each source's history in payload-time order until its newest valid attempt is found. Zod remains the validator. The SQL handles ordinary timestamps directly and preserves last-key semantics for duplicate or escaped timestamp keys. Row timestamp and insertion order preserve ties. Malformed and schema-invalid rows retain fallback behavior; the legacy sources table keeps precedence at equal timestamps.

At 50,000 retained rows, returned catalog payloads and JSON decodes fell from 50,000 to two. Measured transient JavaScript heap growth fell from 27.2 MB to about 11.6 KB. Normal-GC median wall time fell from 344.45 to 270.69 ms. The 1,000-row normal-GC case added 0.83 ms.

A separate forced-GC comparison regressed at 50,000 rows from 117.90 to 133.20 ms. A consistent wall-time improvement is not claimed. SQLite still scans and sorts retained rows; the clear improvement is much smaller JavaScript payload transfer, decoding, and allocation for valid history. Invalid newer candidates still require fallback reads and schema validation. Total native memory was not measured. No retained history was deleted or migrated.

## Snapshot validation shares partition reads

Snapshot validation reads each shared schedule partition once per pass. The existing revision, eligible/fresh game membership, day, proof-expiry, and 15-second TTL checks remain. Results do not persist across passes.

The failing public-command test measured 80 extra partition reads for 80 games sharing one partition. The change reduces that validation to one read. Exact 90-second freshness boundaries and a newly written partition remain visible. The small combined benchmark did not show a reliable cached-request latency gain, so the claim is reduced repeated work.

A separate failing test reproduced a future snapshot after clock rollback. Cache reuse now requires the current clock to be at or after its creation time.

## Compact polling skips full diagnostic assembly

`roomSourceInventory(input)` shares the full projector's listing and catalog admission pipeline, then returns before source diagnostics, collection health, counts, shared routes, and catalog-history views. The coordinator skips eager diagnostic history and schedule-scope reads for room requests.

A full cached inventory can supply a room projection. A compact cache cannot supply diagnostics; a full request rebuilds and replaces it at the later request time. Both modes use the same cache validity policy. A public-command test covers promotion across decoded-startup expiry and confirms subsequent compact replies match the new full result.

The domain replay reduced median projection time from 27.14 to 12.58 ms, 53.65%, with identical compact output. It used 80 games, 24 sources, 480 candidates, 1,920 observations, and 2,400 history rows. Diagnostic history reads fell from 24 to zero; diagnostic identity calls fell from 24,000 to zero. Candidate eligibility and availability calls stayed unchanged.

The combined retained-feed coordinator replay measured cold room snapshots at 7.43 to 4.74 ms, about 36% lower. Full snapshots were 9.25 to 9.15 ms; cached full and room snapshots were roughly 0.08 ms in both implementations. Complete full and compact output digests matched across every round. These are controlled computation results, not a whole-app latency claim.

## Evidence

Evidence lives under `.scratch/performance/backend-pass-2026-10-18/`. It includes the decision log, live baseline, combined replay, failing/green cache and coordinator tests, and the ranking/history/summary comparisons. The history report preserves both normal and forced-GC results. The preserved baseline build is required to rerun the comparisons.

The first integrated suite had one failure in the unchanged native-collector cancellation fixture. Its fixed 10 ms failure delay allowed one sibling not to start under concurrent load. The exact file passed in isolation. Final suite and compiled Electron results follow below.
## Final verification and remaining limits

The complete suite passed with bounded file concurrency:

```sh
node --experimental-strip-types --test --test-concurrency=4 tests/*.test.ts
```

It ran 1,616 tests: 1,615 passed, one skipped, zero failed. Two default-concurrency runs failed different unchanged timing assumptions. The first missed a native collector sibling before a 10 ms failure. The second reached a readiness assertion before the local HTTP request began within its 60 ms observation window. The affected files passed in isolation, five of five and 23 of 23. Their source was not changed or assertions weakened. The repository's default test command remains unchanged; its timing sensitivity remains a test-infrastructure limitation.

The production Electron rebuild succeeded. Build `97dc0f2d-1f45-4c39-86b9-3d3b78ec9c36` matched source fingerprint `efc56cf561d9b25af2bbdcfc3da8df470acf5e814ed94dd9e7d68cdeda9745b0`. The compiled app passed schedule-to-room navigation, retained four selected tiles and saved preferences, rendered its actual Sources panel with 30 of 30 MLB sources, and produced no renderer exceptions during those flows. Source-panel controls used DOM events in the existing Electron renderer. Settings finished closed. The detached app and its server remain running.

Every sampled API call returned 200. Cold post-restart samples, collected while tests were active, reached 3.34 seconds for full sources. A separate warmed sample after the suite finished ranged from 81 to 1055 ms for room sources and 73 to 1795 ms for full sources. These live samples have changing collector state and do not establish a whole-app latency improvement. Worker queue delays and retained-history SQLite scans remain. The controlled replay is the evidence for the accepted computation changes.

Three independent agents reviewed the changed code. The audit-trail reviewer required the timing regressions, invalid-history fallback cost, cache-promotion behavior, and live latency limits to stay visible; they are recorded here. All reviewers used the same model family because the live tool catalog could not run the configured other-provider reviewers. No cross-family verdict is claimed.

Final evidence includes `tests-bounded.log`, `typecheck-final.log`, `lint-final.log`, `replay-final.json`, `final-app-check.json`, `navigation-after.json`, `compiled-sources.json`, `live-after.json`, and `live-warmed.json` in the backend-pass evidence directory. The prior audit's real native fullscreen and complete lazy-settings automation gaps were not retested by this backend pass.

Final npm run typecheck and npm run lint both exited successfully. git diff --check passed. Process inspection confirmed exactly one current Electron main instance after the compiled checks.


The last readiness check at 23:34 UTC showed three visible room tiles and no open dialog. The earlier navigation check recorded four tiles. Saved preferences were unchanged by the verified navigation and diagnostics flows; no tile selection was edited during this pass.
