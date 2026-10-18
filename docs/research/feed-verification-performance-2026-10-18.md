# Feed verification performance

The resource issue reproduced in the local Electron app. Its browser acquisition and playback checker dominated the process count. Sportsurge and StreamEast catalog collectors already reuse a window for each serial collection run.

## Source entries returning to unchecked after restart

The source view reproduced 613 rows reading "Playback not checked yet" while all 16 slots were active. A nearby inventory had 611 completed attempts, 720 unknown candidates today, and 99 tomorrow candidates waiting behind today's first pass. The bounded queue had 26 entries. This snapshot establishes a backlog, not permanent scheduler starvation.

Only working-video proof was durable. Failure and incomplete-check state lived in memory. Across the recent restarts, 286 previously checking entries and 72 unavailable entries became unknown. The snapshots omit locators, so publication changes may explain some transitions. A failing temporary-database test then reproduced the defect with fixed route identities. After two completed outcomes and an interrupted third route, restarting checked the first route again rather than continuing the third.

The fix stores completed nonhealthy outcomes in a separate `feed_checks` cache table. It records the existing route identity hash, game ownership and date, outcome, time, and retry state. It stores no player addresses or candidates. Startup reads at most 10,000 records from the previous 24 hours, then attaches them only to currently published, owned routes before admitting new work. Capacity, cancellation, active work, and queued work are not saved as completed attempts. A temporary maintenance failure retains the old working route as a hint, preserving the existing recovery behavior.

The restart fixture now preserves the failure reason and incomplete status, gives untouched feeds the next slots, and resumes incomplete retries with the next backoff interval. The source view labels genuinely untouched feeds "Waiting for first playback check." This wording does not claim playback or an assigned slot. The full suite passed 1,564 tests with one platform skip. Typecheck, lint, and 34 focused restart and retention tests passed. Independent review found and verified a correction for older failures surviving newer playback proof on nonpersistable players.

The user approved the local schema addition, and Electron restarted with it. The real cache held 92 completed outcomes before a second restart. All 92 survived; 103 published source rows retained their exact result times, and none of the compared rows became unknown. The second startup painted in 7.0 seconds with the existing build and observed the board in 10.0 seconds. All 16 checker slots were active after restarting. These results are in `.scratch/coverage-20261018/history-proof-before.json` and `history-proof-after.json`.

The final live check found one local Electron main instance with the latest changes. All three room videos advanced about 2.5 seconds and 150 frames without a media error, and both local APIs returned HTTP 200. At that snapshot, 15 of 23 games remained below ten working choices, and today's first pass was still running. Tomorrow's first pass remained behind it.

A live sample with persistence completed 38 attempts in 31.7 seconds. Mean summed working sets were 7,064 MB, and a separate CPU sample used 12.67% of machine capacity. A temporary-database benchmark of 500 writes measured 0.86 ms median, 1.21 ms at the 95th percentile, and a 7.7 ms startup read. Those fixture timings do not establish the real database's per-write cost. Changing candidates, room state, and process ages prevent attributing the live rate or resources to persistence alone.

Make Operations Idempotent guided the durable progress record. Fix Root Causes kept this work focused on lost results instead of changing an unchecked feed into a working one.

## Higher parallelism and earlier deferral

The latest checker capacity is 16, increased from eight through the shared verification policy. The coordinator, acquisition slots, verifier window, media-read limits, and native-player pools all use that policy. A failing behavior test first admitted only eight of 16 assignments. After the change, 16 ran in one verifier window, the 17th waited, and releasing a slot admitted its replacement. The Electron layout fixture decoded all 16 videos with advancing-frame proof.

| Live sample | Seconds | Completed checker trials | Trials per minute | Playable trial results | Ending summed working sets |
| --- | ---: | ---: | ---: | ---: | ---: |
| Eight slots | 60 | 22 | 22 | 1 | 4,473 MB |
| Sixteen slots | 120 | 104 | 52 | 6 | 8,734 MB |

All three room videos advanced during both samples. Candidate sets and process ages changed across the restart, so these observations do not establish a controlled causal speedup. These numbers come from the verifier's trial events. The trace-only measurement mode does not populate feed-inventory update counts. Higher parallelism increased memory use, so capacity remains at 16.

The remaining native startup bottleneck consumed 55 to 56 seconds for a player with no decoded progress, then classified it as an unavailable playback failure with a five-minute retry. Verification players now stop after 12 seconds without real progress. The timer starts before `proxy.start()` and navigation, after creating the proxy object. Only consecutive, owned, plausible advances in both media time and presented frames reset it. Advancing video can complete the unchanged two-second proof after the original cutoff. Viewing players retain their recovery deadline. This bounds the native playback stage; earlier ownership and capture stages can still take about 20 seconds.

A stopped verification player reports a temporary upstream deferral and closes its native view. It starts with a 30-second retry interval through the existing incomplete-check backoff. Repeated incomplete results can still reach five minutes, and automatic retries still wait for first passes. This change does not eliminate conclusive playback failures.

The native startup fixture failed before the fix because no result appeared after 15 seconds and its view remained open. After the fix, it reported `failed/upstream`, then `ended`, and closed the view at 12,010 ms. The full suite passed 1,557 tests with one platform skip. Typecheck and lint passed. The late-progress, viewer, and hung-navigation tests passed.

The long live sample after the cutoff change failed its workload gate because the room changed from three videos to two. It is excluded from speed comparisons. The resource harness also no longer treats every sampled non-local session as an observer session. Its earlier 1.58 MB cache failure included heterogeneous collector and reader sessions. It now reports that cache aggregate without a false one-megabyte gate, while retaining the shared capacity assertion. Observer and native playback partitions still disable HTTP caching.

A separate final counter sample recorded 87 completed attempts in 60.8 seconds, or 85.8 attempts per minute. Mean summed working sets were 7,002 MB, with 53 peak Electron processes and zero sampled session cache bytes. Total project Electron CPU used 16.77% of machine capacity in a separate 15-second sample. That counter sample did not hold the room workload constant, so it is not directly comparable with the table above. Completed attempts include failures and deferrals. The inventory still had 20 of 23 games below ten working choices.

## Today-first verification

The later investigation reproduced 1,192 unknown feeds and 20 queued feeds for today while tomorrow's checks and repeated attempts were active. Some untouched candidates had been waiting over 30 minutes. The scheduler now finishes available feeds' first attempts for today, then tomorrow, before admitting automatic retries or healthy-feed maintenance. A real incomplete upstream attempt advances that first pass. Local capacity and cancellation do not. Explicit retry requests can bypass this order. Already active work can finish when new candidates arrive.

The scheduler derives the remaining first-pass identities from its existing candidate, job, and result state. It adds no persistent queue or timer. The later restart fix above makes completed unavailable and incomplete outcomes durable. Active, queued, capacity, and cancelled work do not establish durable completed attempts. Identity-based working counts remain. The later parallelism change above raises capacity to 16.

Three media failures reproduced:

- An embed had a full-size visible iframe but an 18-pixel body. The evidence code incorrectly clipped the player to that body. It now applies the viewport boundary when body overflow propagates there. The [CSS overflow specification](https://www.w3.org/TR/css-overflow-3/#overflow-propagation) describes that rule. A native Electron fixture checks the visible case and genuine ancestor, containment, and body clipping.
- A provider changed its football player path and offline banner. The checker now recognizes the captured current form and releases its slot without waiting for the capture deadline. The original offline form remains supported.
- Selected HLS manifests returned HTTP 404 or 500, but capture ignored failed responses and waited for its deadline. Background probes now release capture after proving that the manifest belongs to the selected source and its visible frame chain. Every such response remains incomplete and retries later. Viewer capture retains its recovery behavior. The error cause reaches the checker as an upstream deferral.

Published WNBA cards on basketball pages now retain their WNBA league and exact team identities. Only sources registered for WNBA can emit those events. Five affected parser versions invalidate saved older results. In the restarted app, all five sources matched the WNBA board event. LiveTV's fresh, unique, exact NFL listings now match through the existing published-listing evidence policy. The running inventory changed from zero to 13 matched LiveTV games. These matches do not establish playable media, and some detail pages still publish no compatible player.

A 60-second baseline recorded 18 completed attempts. A later 60-second sample with the HTTP capture change recorded 25, including 21 deferrals and four unavailable results. Both room videos passed the playback-continuity check in that sample. These changing candidate sets do not prove a controlled aggregate speed gain. An intervening sample failed because its room workload changed and is excluded from comparison.

An earlier 60-second sample completed 27 checks, including six playable results, 19 deferrals, and two unavailable results. Both room videos again passed the continuity check. A separate short resource sample recorded zero sampled session cache, 25 peak Electron processes, and 4,098 MB of mean summed working sets. The CPU sample recorded 8.52% of machine capacity. These are observations of a changing live workload, with the same resource-accounting limits described below.

That earlier full suite passed 1,553 tests with one platform skip. Typecheck and lint passed. The native visibility fixture and the Electron delayed-playlist buffering fixture passed. A launch requiring a rebuild took 52.2 seconds to paint. Restarting with that existing build took 7.2 seconds to paint and 10.2 seconds to observe the hydrated game board. These timings describe different startup paths and do not establish a cold-cache benchmark.

The ten-feed target remains unmet. That earlier inventory had 22 of 23 games below ten working choices and 1,358 today candidates still unknown. Tomorrow's 99 candidates had no active or queued checks while today's first pass remained. Automatic checks continue in the running app. Matching fixes cannot supply an unpublished player or turn upstream HTTP errors into advancing video.

The Fix Root Causes principle led to repairs at scheduling, visibility, and response handling. Model the Domain kept first-pass progress in the existing result state. Build the Lever and Prove It Works led to repeatable census, native visibility, throughput, and buffering checks. Evidence and the decision trail for this pass are in `.scratch/coverage-20261018`.

## Earlier resource measurements

These are short samples of real, changing upstream feeds. They are not a controlled throughput benchmark. Summed process working sets include shared pages, and the resource harness excludes the separate local server. The CPU harness includes project Electron executables, including that server.

| Sample | Background checks | Mean summed working sets | Peak Electron processes | Largest observed acquisition cache | Completed check attempts per minute |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original app | 32 | 14,797 MB | 81 | 36.4 MB | 78.5 |
| Cache disabled, later sample | 32 | 11,363 MB | 87 | 0 bytes | 81.5 |
| Cache disabled, eight checks, before coverage priority | 8 | 4,183 MB | 32 | 0.39 MB | 23.3 |
| Final retained changes, after restoring acquisition | 8 | 2,844 MB | 21 | 0 bytes | 9.7 |

CPU samples used 20.06% of total machine capacity originally, 16.38% after the cache-only restart, and 6.59% with eight checks. The original process had run much longer than the replacements. Restarts, source changes, and different candidate mixes prevent attributing every difference to one change.

The final retained build used 5.02% of total machine CPU in its 15-second sample. Its 30-second resource sample recorded five completed attempts and 23 of 24 inventory games below ten working choices. This was a restart of the original acquisition path with the cache, concurrency, identity-count, and coverage-priority changes.

The original application created 35 Electron processes and lost 31 in a ten-second profile. Observer browser sessions retained roughly 45 to 50 MB of HTTP cache each during direct inspection. These in-memory session caches survive window destruction. Electron defaults session caching to true and supports disabling it when creating a partition. See the [Electron session API](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options) and [performance guide](https://www.electronjs.org/docs/latest/tutorial/performance).

The resource check failed before the fixes because upstream media remained in acquisition caches. After the cache-only restart, that assertion passed, but the eight-check resource budget still failed. After limiting verification to eight checks, both assertions passed.

## Changes

- Transient observer and isolated-player partitions disable HTTP caching.
- The earlier resource pass reduced the global background checker budget from 32 to eight. The latest parallelism change raises it to 16.
- Games below ten distinct verified provider routes receive discovery priority. Automatic maintenance now waits for both first passes to finish.
- Source inventory counts use the same identity as the checker. Several public aliases for one checked route count once.
- The one-hour first-pass monitor, result helpers, and virtual deadline benchmark were removed. The hourly database retention cleanup remains because it is unrelated to feed verification.

The ten-feed target applies within the existing feed window: live games and scheduled games today or tomorrow in Chicago time. Upcoming programs may not broadcast video yet. The target does not manufacture feeds, treat listings as playback, or convert incomplete results into working status. Provider routes can also converge on the same downstream stream; this work does not establish independent broadcasters.

The original and eight-check snapshots had 24 inventory games, with 23 below ten working choices. Some games had no published candidates. The target is a scheduling policy, not evidence that every game has ten working feeds.

## Earlier verification

The alias-count and below-target priority tests failed before the scheduler change and passed afterward. A candidate still needs advancing-video proof before it becomes playable.

Focused tests covered ownership, session cleanup, presentation grants, decoded proof, source fairness, working-feed maintenance, retry backoff, and coverage priority.

The final full suite passed 1,520 tests, with one platform skip and no failures. Typecheck and lint passed. After the final rebuild and restart, both visible videos advanced roughly three seconds and presented 180 additional frames each, with no media error in that short sample. Both local APIs returned HTTP 200. A process check confirmed exactly one project Electron main instance; it and its server remain running.

## Rejected acquisition shortcut

An experimental shortcut sent exact published player documents straight to native decoded verification. It skipped their acquisition browser. Caller tests passed, including catalog event and stream-selection validation. In the restarted Electron app, several upstream player documents rejected that native presentation, and a 28-second sample completed no checks. This did not prove compatibility or higher throughput. The shortcut and its tests were removed, and the existing acquisition path remains. The public-page adapter later changed to retain the upstream deferral reason.

The earlier eight-slot pass reduced resource use and gave games below ten working routes priority. Its smaller resource budget completed fewer attempts per minute in the measured samples. The later 16-slot samples above completed more attempts and used more memory. Changing upstream workloads prevent a controlled causal speed comparison. A conclusive attempt may still be a failure or deferral; attempt counts are not working-feed counts.

Reproduce the short live resource sample with `node tests/background-resources.electron.mjs sample 15`. Run `tests/cpu-resources.electron.ps1 -Label sample -Seconds 15` for total project Electron CPU. The app must already be running with renderer debugging on port 9321 and main-process inspection on port 9331. The helpers disconnect without closing the app.

Measurement artifacts and the decision log are in `.scratch/performance`. The one-hour historical report remains in `cold-start-performance-2026-10-17.md` as past evidence; its sweep target is superseded by this work.

## LiveSportPro sandbox warning

The live native player reproduced the exact reported message, `Remove sandbox attributes on the iframe tag`, followed by its user agent. The provider loaded an inline PDF object with the address `data:application/pdf;base64,aG1t`. Its payload is three bytes, `hmm`. Observer capture already admitted local PDF objects, but the native playback request policy rejected this probe.

A live comparison changed only admission of that exact object. The rejected probe produced the warning and no video. The admitted probe produced advancing 1280-pixel video without the warning. Popup, permission, download, plugin, and PDF extension policies stayed unchanged. The shared request policy now admits only that exact payload as an object. Other payloads, request types, data documents, and extension addresses remain rejected by that policy.

The same investigation found two native loading defects. Requested bounds and visibility were applied after navigation, so a selected iframe could have zero visible area when its request was checked. The player now applies its requested layout before navigation. Request matching also confused a full document address with its fragment-free transport. It now accepts the exact selected address or its exact transport address, and rejects a different fragment. The observed inner ingest player retains its captured playback options when passed through the provider adapter and native admission.

An earlier theory concerned a different warning from the provider's popup advertising library. The captured library does skip its sandbox detector at the top level, but direct leaf playback still reproduced the user's exact warning. That theory did not explain this failure. The abandoned popup-warning fixture was removed.

After rebuilding and restarting Electron, both the real published wrapper route and its inner player decoded video without a diagnostic override. The wrapper route advanced 10.53 seconds at 1280 pixels wide and showed no warning. These are short playback checks of the captured route, not evidence that every upstream feed is available.

The final suite passed 1,570 tests, with one skip and no failures. Typecheck and lint passed. The native PDF test loaded the exact object, retained renderer sandboxing, created no windows, and continued to reject the PDF extension requests. Two videos in the main room advanced 149 frames during the readiness check, and both local APIs returned HTTP 200. One current project Electron main instance remains running.

Run `node tests/livesportpro-pdf-probe.electron.mjs` against the open local app to repeat the native object check. Its main inspector must be on port 9331. This helper disconnects and closes only its own fixture window. The live before-and-after artifacts are `native-leaf.json`, `native-pdf-allowed.json`, `native-production.json`, and `native-production-root.json` under `.scratch/livesportpro-sandbox-20261018`. This session's decisions are recorded in `.scratch/coverage-20261018/decisions.tsv`.
