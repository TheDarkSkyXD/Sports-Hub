# Active pipeline planning, October 18, 2026

This pass removes two repeated operations from collection and source projection. It preserves matching rules, retry deadlines, published feeds, and saved room state. Earlier workspace edits remain intact. No database migration, production action, commit, or pull request was performed.

## Skip finished-game matching when there are no finals

A fresh CPU trace of the running Electron app showed matching and detail planning still consuming football-worker time. The live games response contained 440 games, two live and 438 scheduled, with no finals. Finished-game filtering nevertheless prepared team aliases for the full schedule and matched observations that could not identify a final.

The finished-game matcher now prepares aliases only when its captured schedule contains a final. Both dated and bound-event checks immediately return no match otherwise. When any final exists, the matcher still uses the full schedule. This preserves ambiguity between a final and another game with the same teams and date. Callers create a new matcher when replacing the schedule.

The new work-bound test failed before implementation with 120 normalizations. It passes with zero. Literal assertions cover rejection results, a replacement schedule containing a final, expected game ownership, retained undated bindings, and final/live ambiguity. Ten initial focused tests passed, and an independent review ran 37 matching and caller tests across matchup, racing, combat, and wrestling cases.

A controlled replay compares the preserved e64c5f17-b351-4754-901d-3189478a89e4 build with current source. The fixture contains 440 games, eight sources, 256 observations, and four extra aliases per team. Each batch builds six source projections. Nine alternating pairs ran for each scenario, with the first warmup pair excluded. Medians use the middle two of the eight remaining values.

| Projection with no finals | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Full Sources, six projections | 139.95 ms | 85.67 ms | 38.8% |
| Room sources, six projections | 142.25 ms | 81.64 ms | 42.6% |

All 36 before-and-after output hash pairs matched across full and room projections with and without a final. The final-containing scenarios are behavior controls. This report claims no speed gain for those controls or for the whole application.

## Read category history once within a planning pass

Starting-run browser polling already read provider history and selected the newest catalog from another run. Its provider-specific category-reuse branches then read and validated that same history again and repeated the selection. No write or asynchronous work occurred between those reads.

The branches now reuse the selected catalog within the function. The existing catalogIssues field distinguishes provider shapes. An authoritative Object.values type argument preserves the stored-catalog union without casts. The input is read again on the next command, so this adds no persistent cache or invalidation rules.

Five public-command tests failed before implementation because warm polling used three catalog reads instead of two. All reply and deadline assertions already passed. The tests now pass with two reads. They cover both providers, received-time ties, pending detail reset, category order, Sportsurge category issue exclusions, and a later completed checkpoint replacing the earlier plan. Sixty related tests passed. This establishes one fewer history read in the starting-run case, not a measured whole-pipeline latency percentage.

## Decisions and verification

Laziness Protocol kept both changes local and removed unused work without a cache. Type System Discipline preserved the provider union from its authoritative history type. Build the Lever produced the rerunnable comparison and focused work-bound tests. Sequence Work into Verifiable Units kept each change behind a failing and passing check.

The complete suite passed with four file workers. It recorded 1,681 passed, one skipped, and zero failed in 103.45 seconds. Full repository lint and final typecheck passed. The first app preparation rejected a source identity change because the final type annotation landed during compilation. Source was frozen before the replacement launch.

The rebuilt Electron app passed schedule and watch-room navigation and the Sources flow. Both tiles and saved room preferences were preserved, the dialog closed afterward, and the flow checks recorded no renderer exceptions. Sources showed 28 of 28 NHL sources.

Ten passive samples over about nine seconds showed both selected direct videos advancing. The NHL feed advanced from 73.79 to 82.89 seconds and from 3,826 to 4,371 frames. The NFL feed advanced from 73.04 to 82.15 seconds and from 3,841 to 4,386 frames. Neither paused or reported a media error. This short check does not establish that all intermittent pause causes are resolved; no player code changed in this pass.

Build 1ce4191e-3b57-47fd-a7e5-8d9756e0a4b1 matches current source fingerprint 35de02be7fd03254cb07609cc98e8761447fab6e286a703717592808024b36c0. One local main app remains running, PID 86876, with server PID 94388. Controls disconnected without closing the app.

The final live worker trace sampled 9.99 seconds, including 3.44 seconds idle. All nine requested games and source responses returned 200 and capture errors were empty. Observation decoding and detail planning still consumed time during active collection. Different background collection work prevents a live before-and-after latency claim. The controlled replay above establishes the accepted gain. Both temporary profiling listeners were verified closed.

Final artifacts include final-navigation.json, final-sources.json, final-app-check.json, playback-ready-samples.json, and after/ in the evidence directory.

## Evidence and review limits

Evidence is under .scratch/performance/active-planning-2026-10-18/. It includes before/ for the live trace and temporary-inspector cleanup, compare-finished.mjs, finished-comparison.json, finished-red.log, finished-green.log, category-reuse/, tests-final.log, and lint-final.log. The canonical append-only trail remains .scratch/performance/pipeline-2026-10-18/decisions.tsv.

Root owns matching, measurements, app launches, and this report. The worker owned browserPollingPlan and its new tests. Independent review uses available Codex agents. Other configured model families were disabled or unavailable in the live orchestration catalog. This limits review diversity.

## Attention

Reviewed by available Codex agents from the same model family. No outstanding source or audit-trail findings were reported. Review confirmed final/live ambiguity, provider narrowing, history ordering, received-time ties, literal replies, fresh later checkpoints, and measured artifact counts. Other model families could not run, so this is not a cross-model review.
