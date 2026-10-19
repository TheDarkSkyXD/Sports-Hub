# Collection and verification pipeline, October 18, 2026

This pass reduces repeated detail planning and source projection work, and preserves verification failure causes through retry scheduling. Existing advancing-video proof, first-check fairness, feed identity, maintenance, and concurrency policies remain intact.

## Measured baseline

A fresh CPU trace used the running build `97dc0f2d-1f45-4c39-86b9-3d3b78ec9c36`. The verified local server was PID 92700. Profiling did not pause execution or change app data. All worker sessions detached and the temporary inspector closed afterward.

The football-worker profile covered 10.18 seconds. Inclusive samples included 4,518 ms in `sourcesSnapshot`, 1,082 ms in `browserPollingPlan`, and 638 ms in `resolveObservations`. These overlapping values must not be added. Repeated native iterator samples belonged to `sourceAttempts` beneath snapshot and deadline planning. The HTTP server spent about 9.82 of 10.74 sampled seconds idle. Unauthenticated readiness-route requests returned 404 in 5.8 to 7.1 ms while coordinator-backed responses reached roughly two seconds. This identifies worker contention, not exact process CPU utilization.

## Detail planning waits for admission capacity

The resolver previously rebuilt its ranked observation queue whenever a collector wake changed the detail revision, including while all eight detail slots were occupied. Those rebuilds could not admit more work.

The revision stays dirty while slots are full. When a slot opens, the resolver reranks against current state before admission. The queue, revision, and existing visit-time guards remain the organizing structures. No persistent match cache or new lifecycle state was added. This follows Laziness Protocol and Model the Domain.

The public collector regression first reproduced six redundant scans across six saturated wakes. The controlled preserved-build replay used 64 background observations, eight held reads, 24 refresh wakes, and a later live listing. It reduced saturated scans from 24 to zero and upper-median measured wake work from 41.29 to 9.49 ms, about 77%, across eight measured rounds after one warmup round. The replay selects the upper middle sample; conventional medians are 39.93 and 9.36 ms. Complete source snapshots and the order of all 65 detail requests matched across nine alternating rounds. Literal checks preserve the latest live admission, all 130 candidate IDs, eight global reads, two reads per host, and the existing background fairness turns.

That timing describes the detail-replenishment fixture. It is not a whole-refresh or whole-app speed claim.

## One persisted input set per source projection

The inventory projection captured one `at` timestamp but its per-observation deadline callback repeatedly consulted a one-second coordinator cache. A long synchronous projection could expire that cache multiple times and reread the same retained attempt history.

The projection now reads attempts, observations, and both catalog histories once. It computes one deadline map from those inputs and the captured timestamp, then uses that map for all admitted links. Explicit projection inputs bypass the ordinary cache lookup. Other callers retain the existing revision, games, and time guards. No projection input or callback is retained across an asynchronous update.

A deterministic slow-read model advances the injected clock by 1.1 seconds per real in-memory attempt read. Before implementation, a 32-link projection read attempts 97 times. After implementation, full diagnostics and compact room replies each read attempts once and observations once. Literal checks preserve fresh pending links, matched game IDs, source wake times, and compact pending state. Next-command schedule and proof-boundary tests also pass. The simulated clock is a work-bound probe; it does not measure production query duration.

A separate ordinary fixed-clock coordinator replay compared complete full and compact output digests against the preserved build. All digests matched. Its first run overlapped the busy app and showed higher wall times despite lower sampled process CPU; that run is retained. A second run during the announced restart, with the old app stopped, measured cold full snapshots at 20.22 to 19.67 ms and cold room snapshots at 14.00 to 13.51 ms. Those small differences do not establish a normal-workload latency improvement. The accepted projection claim is elimination of repeated persisted reads during cache rollover.

## Verification causes reach retry policy

The configured verifier adapter now preserves existing result-union causes. Timeout errors report `timeout`; ordinary caller aborts report `cancelled`; transport and non-success service responses report `upstream`; malformed JSON and invalid result payloads report `unverified`.

HTTP 429 retains its two-second capacity deferral. Other existing retry delays, valid reported outcomes, advancing-video proof, timings, and legacy unavailable fallback remain. The adapter does not invent a playback phase when the observer did not report one. Boundary Discipline keeps this mapping at the transport boundary.

The first failing run had 13 failures in 15 adapter tests. A consuming coordinator test uses the adapter's actual cancellation result: an upstream check waits 30 seconds, cancellation waits 30 seconds, and the next upstream check waits 60 seconds. Cancellation does not advance the incomplete streak.

Review caught an additional deadline case. A caller's aborted signal can carry `TimeoutError`, so the signal's cause must take precedence over the transport exception. That case failed as `cancelled` before the correction. The final related suite passed 69 tests, including ordinary Error/AbortError cancellation precedence. The code-style guide records the general abort-cause rule.

## Evidence and limits

Evidence is under `.scratch/performance/pipeline-2026-10-18/`. The `planning` directory holds the red/green collector test and nine-round replay. The `verification` directory holds cause-mapping and consuming-retry tests. Projection evidence is in `projection-red.log`, `projection-focused.log`, and `tests/source-projection-inputs.test.ts`. Both ordinary coordinator replays are retained.

The live trace still shows other matching, inventory, browser polling, and SQLite work. A resource-derived verifier cap was not supported by this trace, so the existing 16-check policy remains. This pass adds no sustained-playback ranking policy or new diagnostics UI. No provider access rules, authentication, schema migrations, or retained-data deletion were introduced.

Independent code reviews found no proven blocking defect. Reviewers used the available same-family agents because the configured other-provider roles could not run in the live tool catalog. The parent owns final compiled Electron and whole-suite verification.
## Final verification

The complete suite passed with four file workers: 1,634 passed, one skipped, zero failed. The command was `node --experimental-strip-types --test --test-concurrency=4 tests/*.test.ts`. Final `npm run typecheck` and `npm run lint` exited zero. The whitespace check passed with `git -c core.whitespace=cr-at-eol diff --check`, which respects the existing CRLF line endings without changing repository configuration.

Electron rebuilt successfully and runs build `fa59e608-e0a4-42a4-8285-d2efdfe4a1af`. Its source fingerprint matched `bf4ef7d8d0f9dcca42704dd4b257bbcd08059915f34e6dc3d8415c5cd17a967e`. The actual compiled app passed schedule-to-room navigation and rendered the Sources panel with 28 of 28 NHL sources. Saved room preferences stayed unchanged; both flows recorded no renderer exceptions. Settings closed, and the watch room showed three visible tiles during navigation. The later final readiness checkpoint showed two visible tiles; both checkpoints found the room ready with its dialog closed. Source-panel controls used DOM events in the existing Electron renderer. No additional app instance was launched for those checks.

A post-change live trace covered about 9.62 seconds of football-worker activity. It still contained about 2.42 seconds beneath `sourceAttempts`, 3.00 seconds in detail resolution, and 1.22 seconds in source snapshots. These inclusive samples overlap and the live collector workload differs from the baseline. The trace is not a controlled before/after speed measurement. All games/source responses were 200, but coordinator-backed headers still ranged from about 343 ms to 2.63 seconds. Unauthenticated readiness-route requests returned 404 in about 3 to 6 ms; these timings are not successful health checks. Inventory matching, global detail projection, and native history scanning remain sources of worker contention.

The post-change temporary inspector and all worker sessions were detached and closed, confirmed in `after/inspector-cleanup.json`. The app's ordinary development debugging endpoints were unchanged. The app and its required server remain running.

The reliable performance claim is the bounded detail-replenishment improvement and the elimination of repeated persisted-input reads during snapshot cache rollover. A general app latency improvement is not established. Actual playback proof requirements and the 16-check policy were not weakened. Real native fullscreen and prior lazy-settings automation gaps were outside this backend pipeline pass.

Final artifacts include `tests-final.log`, `typecheck-final.log`, `lint-final.log`, `final-app-check.json`, `navigation-after.json`, `compiled-sources.json`, and the before/after captures and cleanup records. No commit or pull request was created.
