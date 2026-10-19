# Matching and collector planning, October 18, 2026

This pass removes repeated matching work and unused browser-collector setup. Existing playback recovery changes remain in place. All earlier workspace edits are preserved. No migration, production action, commit, or pull request was performed.

## Team ownership is computed once per loop

The latest worker trace attributed about 689 ms inclusively to observation-matcher construction. Resolving its minified symbols showed repeated alias preparation. Team ownership was recomputed for each alias while building the owner index and while removing ambiguous aliases.

Ownership now stays constant within each team loop. The matcher keeps the same aliases, ambiguity rules, ordering, freshness checks, and results. The failing work-bound test recorded 172 ownership normalizations for two teams with 40 aliases each. It now records 12 and verifies literal full-name, alias, and stale-observation results.

A preserved-build replay alternated nine pairs and excluded the first warmup pair. Each measured batch built 12 matchers for 256 games and checked every game against its literal expected result. With 12 extra aliases per team, conventional median time fell from 230.89 to 136.81 ms without team IDs and from 163.09 to 136.76 ms with IDs. Complete result hashes matched. These are controlled matching fixtures, not whole-app latency measurements.

## Empty checkpoints avoid unrelated detail reads

Browser polling previously loaded all saved detail evidence and created a matcher even when it had no collected events to inspect. Persistence and detail-reuse helpers also prepared those inputs when their loops could do no work.

Each helper now checks whether any event is actionable before preparing inputs. Category deadlines, reuse decisions, retry behavior, and candidate reconciliation stay in their existing owners. An empty checkpoint retains its one required candidate-reconciliation read; unused reads fall from five to one. Polling empty or pending categories reads no detail evidence instead of reading it once.

Twelve failing-first public-command tests verify both providers with complete-empty, pending, and failed checkpoints, including nonempty event lists in pending categories. They assert literal deadlines and acknowledgments. Fifty existing focused tests also passed.

The comparison uses separate identical in-memory stores with 2,048 saved detail rows. Across seven alternating pairs per state, excluding one warmup pair, twelve public polling commands fell from 341.94 to 0.875 ms for empty catalogs and from 316.19 to 0.757 ms for pending catalogs. Required detail reads fell from twelve to zero. Polling replies, full source snapshots, and compact room snapshots had identical hashes in every pair. Saved details remained present. This measures the case where a catalog has no actionable events; active catalogs still perform the required planning.

## The persistent detail cache was deferred

A scratch prototype cached validated deep detail graphs and returned cloned values. It helped repeated reads but made a cold read 35% slower and a write-before-every-read workload about 39% slower. Detail collection writes frequently, and the live trace did not establish a safe cache-hit ratio. The prototype did not change application source. Removing unused synchronous work gives a bounded gain without that write-heavy penalty.

Laziness Protocol kept these changes to invariant calculations and early guards. The verification scripts and preserved-build comparisons provide rerunnable evidence. Root owns app launches and matching; the worker owned coordinator edits. Each reviewed the other's final source change.

## Evidence

Evidence is under .scratch/performance/continuation-2026-10-18/. It includes matching-red.log, matching-green.log, compare-matching.mjs, matching-comparison.json, empty-planning/, and detail-read/. The canonical append-only log remains .scratch/performance/pipeline-2026-10-18/decisions.tsv.

Review used available same-family Codex agents because the configured other-provider reviewers were unavailable in this session. The final source and recorded comparisons had no outstanding review findings.

## Final verification

The full suite passed: 1,674 tests passed, one skipped, zero failed. Typecheck, repository lint, final scoped lint, and whitespace checks passed. Tests captured the failing behavior before the two implementation changes.

The rebuilt Electron app passed schedule and room navigation and the Sources flow, showing 28 of 28 NHL sources. Both room tiles and saved room preferences were preserved. These flow checks recorded no renderer errors.

Ten passive samples over about nine seconds showed both a direct video and an embedded player advancing continuously. Direct playback advanced from 102.45 to 111.57 seconds and from 5,604 to 6,152 frames; embedded playback advanced from 30.05 to 39.15 seconds and from 846 to 1,392 frames. Neither paused or reported a media error. This short observation does not establish that every intermittent pause cause is resolved; this pass made no player changes.

Build e64c5f17-b351-4754-901d-3189478a89e4 matches source fingerprint e9315cf3382b7a85f8d1bfe58f4deb7d981d3a62ca7a258368cd99d646f59b92. Exactly one local Sports Hub main instance remains running, PID 30948, with server PID 93584. Verification disconnected without closing the app.

Final evidence: tests-final.log, typecheck-final.log, lint-final.log, whitespace-final.log, final-navigation.json, final-sources.json, final-app-check.json, and playback-ready-samples.json in the evidence directory above. The initial startup-only sample is retained separately as playback-startup-samples.json.
