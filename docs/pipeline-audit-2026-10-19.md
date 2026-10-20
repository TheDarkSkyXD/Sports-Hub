# Pipeline performance audit, October 19, 2026

The original pipeline was partly Rust. Rust fetched and parsed source pages and resolved player addresses. TypeScript still owned schedules, source polling, detail queues, game matching, verification policy, playback sessions, SQLite, and inventory projection. Moving those decisions into Rust requires replacing that state owner, not translating the HTML parsers again.

The migration is described in [Rust pipeline](rust-pipeline.md). This audit distinguishes measured costs from architectural risks. A change of language alone does not prove a performance improvement.

## Does discovery scan every source and feed?

Discovery considers the configured sources, checks their polling deadlines, and fetches the sources that are due. A provider listing can contain its entire schedule. The pipeline must read that listing before it can identify the relevant events. It does not start one request for every published feed at startup.

With an empty cache, every configured ordinary listing can be due. The four-request global limit and one-request-per-family limit still apply. With a warm cache, saved attempts, publication freshness, game eligibility, and transport cooldowns determine what runs. Discovery is not limited to sources that already have a working feed.

After acquisition, matching and schedule eligibility narrow detail work. Automatic feed checks cover live events and scheduled events on today or tomorrow in America/Chicago. Fresh schedule evidence is required. Finished events keep their retained viewer routes but receive no new automatic checks.

The registry in the captured checkout contained 129 sources: 117 ordinary listings, ten catalogs, and two browser catalogs. The two browser catalogs need Electron because their acquisition depends on browser execution. Their saved categories and details have their own reuse rules and polling deadlines.

Working feeds affect priority. They do not turn discovery off. Ten verified feeds is the working-feed target for a game. A game below that target gets discovery priority, while a covered game can still acquire additional published backups. The pipeline checks distinct route identities rather than counting aliases as separate working feeds.

There are several separate limits:

| Stage | Active limit | Additional bound |
| --- | --- | --- |
| Schedule HTTP | 8 globally | 6 per origin |
| Listing acquisition | 4 globally | 1 per source family |
| Detail acquisition | 8 globally | 2 per host, 80 admissions per pass |
| Feed verification while idle | 16 by default | 256 admitted queued jobs |
| Feed verification while viewing | 4 by default | Viewer recovery and background fairness rules |

The UI's checking count is not the count of allocated browser windows. It can include a route that is due but waiting for admission. In the captured inventory, 744 routes showed checking while four checks were active and 25 were queued.

## What happens during a cold start?

There are three different cold starts to account for.

The desktop process starts Electron, the local Next server, the pipeline worker, and the native addon. This cost includes process startup, module loading, native library loading, and restoring SQLite state. Development compilation is a separate cost and should not be mixed with the packaged application's startup time.

The pipeline restores schedules, publications, completed checks, and working-feed records. It validates provider identity, game ownership, lifecycle, and age before reuse. It does not restore active network requests, admitted queue positions, browser contexts, or in-flight verification sessions. Those operations must be planned again.

A player cold start occurs when a feed needs a new browser or media session. Navigation, redirects, provider scripts, playlist acquisition, decoding, and observing video advance all contribute. A saved player URL cannot replace that proof. Rust can reduce orchestration cost, but it does not eliminate Chromium or media startup cost.

The main freshness intervals explain when apparently warm state needs work again:

| Evidence | Interval or deadline |
| --- | --- |
| Fresh schedule | 90 seconds |
| Working-video proof | 30 minutes |
| Working-route maintenance eligibility | 25 minutes |
| Ordinary failed-check retry | 5 minutes |
| Incomplete-check retry | 30 seconds, 1 minute, 2 minutes, 5 minutes, then 10 minutes |
| Retained detail publication | Bounded by listing rules and a 60-minute maximum |

Transport cooldowns and `Retry-After` can postpone acquisition. Repeatedly restarting the app does not make a blocked provider become ready sooner. It can instead recreate process and player startup work while the same cooldown remains in force.

## What the running app showed before migration

The October 19 capture contained 443 scheduled board events, 27 games with sources, and 872 candidates. Availability was 40 playable, 60 unavailable, 744 checking, and 28 unknown. This is a workload sample, not a universal maximum.

The full sources response was about 865 KB. The compact room response was about 285 KB, and the games response was about 430 KB. Sources requests took roughly 489 to 586 ms in the sampled waves. The room response was smaller but had similar latency, which points to shared computation before the response was reduced.

A seven-second CPU sample showed the server main thread about 95% idle. The pipeline worker was about 59% idle. That establishes where CPU work occurred during that interval. It does not show a permanently saturated server, nor does it measure native or Chromium work completely.

The sampled process tree used about 2,348 MiB of private memory. Summed working sets were about 4,663 MiB. Summed working sets include shared pages, so that figure is not unique physical memory consumption. Browser and player processes were a large part of the application footprint. Replacing JavaScript policy with Rust cannot remove their memory cost.

The Electron baseline had a ready watch room and two advancing videos. Both reported media readiness level four and no media error. The source checker used four of four permitted active slots while viewing.

## Bottlenecks and changes

Repeated full projections are a CPU and allocation cost. A schedule partition, listing update, detail response, or health update can affect different parts of the inventory. Rebuilding the entire inventory after each individual callback repeats matching, catalog traversal, candidate construction, and diagnostic work. Rust batches publication and probe planning so completed work can share a projection.

Repeated SQLite decoding is another avoidable cost. The first native comparison found per-candidate freshness checks decoding whole schedule partitions. Reading partition timestamps once per synchronous pass removed that repeated work. Source-attempt reads also use a native cache that detects external SQLite commits and invalidates on native writes.

Copying a cached result can be expensive even when the computation is cached. A captured inventory with 64 games and 1,152 candidates occupied 231,730 JSON bytes. The initial Rust implementation deep-copied its cached value and then copied it again through a JSON reply wrapper. A separate optimized Rust experiment reproduced about 417 ms of the 512 ms owner time across 100 source requests. The reply now serializes an immutable shared snapshot without those two copies.

Large responses remain a transport cost. Caching the native projection does not remove JSON serialization, crossing the native boundary, schema decoding, worker messages, HTTP serialization, or renderer parsing. The compact room projection reduces response size. Further reductions should follow measured consumer needs rather than sending the complete diagnostic inventory to every room refresh.

Native projection also had repeated whole-game-list copies per observation and repeated rank-map construction per game. Those inputs are now prepared once per projection. Single-detail completion reads that detail by its SQLite primary key instead of decoding the full detail table. Fixed regular expressions are reused rather than compiled for each row.

Compiled regex reuse also needs execution-cache reuse. The first helper returned a clone of its cached pattern on every call. A 50,000-iteration normalization benchmark took about 580 ms with cloning and 7 ms with a shared reference. The helper now borrows its cached pattern. Provider-route checks also compiled expressions containing each event's path. Fixed captures and exact field comparisons removed that work. A focused test went from 240 runtime compilations to zero while retaining accepted routes and rejecting mismatched ownership and suffixes.

Source diagnostics previously scanned every candidate for each source. With 129 sources and 922 candidates, that repeated eligibility checks and composite-key serialization. A local index now groups eligible candidates by source once per projection. The focused test reduced eligibility visits from 129 to one for a single candidate, with unchanged source counts.

Allocation cost remained spread across matching, diagnostics, catalog history, and JSON conversion. An isolated Windows experiment ran the same projection with the system allocator and [Microsoft mimalloc](https://github.com/microsoft/mimalloc). The system runs took 404 to 467 ms; mimalloc took 200 to 220 ms. All ten runs produced the same output hash. The Windows addon now uses mimalloc for Rust allocations. It does not replace Electron's allocator or redirect the process's C allocator.

The host timer needed a runtime limit. An unsupported source can have a deadline at JavaScript's maximum safe integer. Passing that delay to Node produced repeated overflow warnings and one-millisecond timers. A focused test reproduced the overflow before the fix and passed afterward. The host now caps the delay to Node's maximum; Rust still owns the actual deadline.

Completion ordering affects coverage as well as CPU. Publishing four simultaneous check results and admitting replacement work after only the first result gave already-covered games extra turns. Rust now commits the ready outcomes before pumping the existing queue. Discovery also starts after accepted schedule evidence, while a deferred launch still allows collection when a schedule request hangs.

Browser verification remains the largest resource multiplier. Concurrency limits matter more than the number of feeds in the catalog. A large catalog can be held as data without opening a player for every route. Keep idle admission, viewing admission, and queue limits separate. Raising check concurrency can improve coverage time while increasing memory, decoding work, and interference with the selected viewer.

Live inspection exposed a separate admission cost that the frozen-clock inventory comparison missed. Every change in the millisecond timestamp invalidated the detail waiting plan. A follow-up planning pass rebuilt it even when all eight detail slots were occupied. A ten-second live trace contained 37 detail completions and 41 follow-up flushes; their native calls consumed about 3.5 and 5.1 seconds respectively. Wake deadlines were still in the future, so this was repeated planning rather than a past-deadline timer loop.

The copied-data reproduction holds all external work pending. Seven unchanged-clock wakes took about 3.5 to 3.8 ms each. Advancing time by just one millisecond made them take 83 to 95 ms each, with the same eight occupied slots and no possible admission. Detail planning now checks active and per-pass capacity before reading or ranking the inventory. This preserves queue order and leaves the next available slot to plan against current evidence. The timestamp validity rule remains unchanged.

After the capacity check, advancing-clock wakes take a median of 3.37 ms, compared with 86.4 ms before. Queue construction also indexes prior detail evidence by observation ID and calculates the working-feed count once per game. These are local indices within a planning pass. No persistent cache or new freshness interval was added. Probe planning on the copied 922-candidate workload still costs about 75 to 89 ms per flush and remains a separate CPU target.

The live call trace also found an actual retry loop. Two unresolved Iohit listing IDs were admitted 19 and 18 times in ten seconds; a Dudestream listing was admitted eight times. An early return discarded completed detail results when the enriched observation could not identify one game. With no saved negative evidence, the same listing remained immediately due. The TypeScript owner retained those completed outcomes.

Rust now saves the unresolved evidence without assigning it a game. The existing explicit conflicting-game result keeps its five-minute retry deadline. Focused tests prove that it does not immediately read the detail again and becomes eligible at that deadline. Separate tests preserve the rejection of results that now belong to another game. Capacity limits alone could not stop this loop because every completed request released a slot for the same unresolved listing.

Cold-start reuse depends on trustworthy persistence. Reusing completed checks avoids unnecessary first attempts, while reusing valid working proof avoids loading a player solely to rediscover evidence that is still fresh. Retention must reject reassigned events, changed ownership, future timestamps, and invalid provider identities. Queue cancellation and local capacity are not completed negative checks.

Restoration also exposed an encoding mismatch. SQLite contained valid integer-valued timestamps encoded as JSON numbers ending in `.0`. Rust now accepts those equivalent encodings at the persisted boundary. This restored 262 previously rejected final records. All 4,093 comparisons against the preserved TypeScript store passed, including 843 final records and individual observation lookups. The database schema did not change.

Native callbacks can remain queued after cancellation. A focused test held the JS event loop until Rust queued current-schedule progress, then aborted before delivery. Both schedule adapters now discard progress after their request is cancelled. The test failed with two late callbacks before the fix and passed with zero afterward.

## Controlled comparison after migration

The comparison uses private copies of one local SQLite backup and the preserved dirty TypeScript checkout. Both use four verification slots, the same frozen clock, 27 source games, 129 sources, and 922 candidates. External acquisition and player checks do not run. This separates pipeline CPU from provider and Chromium delays. Captured projection output also matches the full pre-optimization snapshot exactly, including catalog history and diagnostic reasons.

This table measures restoration and inventory reads. The advancing-clock admission reproduction above exercises started scheduling and occupied queues separately. A fast cached inventory read alone does not establish efficient live scheduling.

The adjacent final runs measured:

| Operation | Preserved TypeScript | Rust addon and reply decoding |
| --- | --- | --- |
| Open and restore the owner | 748 ms wall, 1,078 ms CPU | 500 ms wall, 499 ms CPU |
| First sources snapshot | 719 ms wall, 1,000 ms CPU | 360 ms wall, about 360 ms CPU |
| Unchanged cached snapshot | 9 to 11 ms wall | 8 to 9 ms wall |
| Snapshot after the 15-second cache deadline | 282 ms wall, 375 ms CPU | 362 ms wall, about 359 ms CPU |
| Process RSS at the end of the workload | 410 MiB | 262 MiB |

The first snapshot takes about half the wall time and 64% less CPU in this sample. The cache-expiry rebuild still takes about 80 ms longer, with similar CPU time. This is a remaining cost, not a demonstrated speedup. Typed internal projection inputs and fewer full diagnostic rebuilds are the next CPU targets.

RSS is one process snapshot after the workload. It includes the adapters, native library, allocator retention, and JS runtime. It is not a garbage-collection-stabilized heap measurement or total application memory. Browser processes are absent from this comparison. The initial native port was slower than both final implementations, with real copied-inventory projections taking roughly 2.5 to 2.9 seconds. The real-data benchmark caught that regression before handback; the smaller synthetic fixture did not.

The inventory comparison used native artifact `77eccaf73e0e89826dd8209e59a73be6d0a50622e3a7b2da757ed1c61aa52d8e`. Local evidence includes `live-inventory-final24.json`, `live-baseline-measure.json`, and `replay-live-view-77eccaf7.json` under `.scratch/rust-pipeline/`. The admission fix is artifact `2f6711333ea0e1d7af10844b07102b0d943ec3a0bc9f978bcee2e534ff0b9e72`. Its advancing-clock measurements are in `profile-detail-clock-26.json`; `replay-live-view-2f671133.json` confirms the same complete snapshot hash and schema. The negative-result and ownership fix is artifact `9fa9324cf1b2e6be9e78ba392f100141f4d1044d04c007beaa8c431fcc24d14c`.

## Further improvements to measure

The final Electron run loaded native artifact `9fa9324c...`, and its served source identity matched the current checkout. The Watch room had two advancing selected players with no media errors. All 17 schedule scopes were present. Viewing verification stayed at four active checks. The settings Sources panel loaded and the Game schedule rendered; the app was returned to Watch room.

The three looping listings now have actual persisted unresolved records with five-minute deadlines and no game attribution. A subsequent ten-second trace launched no new detail reads. It recorded 54 native calls taking about 3.19 seconds in total. Before the fix, detail completions and their follow-up flushes alone consumed about 8.6 seconds in a ten-second trace. These are live samples with changing background work, not a fixed-workload speed ratio.

The later process sample consumed 2.30 CPU seconds over 4.27 seconds, then 0.67 CPU seconds over 4.40 seconds in the local server. That is roughly 0.54 and 0.15 of one logical core, compared with about one core during the retry loop. The application tree used about 1,826 to 1,910 MiB of private memory in that sample. Browser activity and selected feeds differed from the original capture, so it does not establish a controlled whole-application memory reduction.

End-to-end latency remains a limitation. The last three full Sources requests took about 980 to 1,243 ms. A collection burst in the preceding sample took about 4.5 seconds. Those results are slower than the original 489 to 586 ms sampled waves, despite the controlled restoration and inventory gains. The final full snapshot was about 547 KB and the room snapshot about 92 KB. This audit does not claim that the Rust migration made every live request faster.

The final local rebuild took about 64 seconds from launch to server readiness, including a fresh Next build, type checking, standalone preparation, and artifact validation. That is development rebuild time. It is not a packaged cold-start benchmark. Pipeline restoration and player startup must remain separate measurements.

Prioritize smaller room updates and less repeated diagnostic transfer. Compare response bytes, serialization CPU, renderer parsing, and request latency with an unchanged inventory. A revision-based response or a narrowly scoped room update may help, but it must retain deadline-driven availability changes.

Measure player startup separately from pipeline readiness. Record process start to room readiness, schedule readiness, first eligible candidate, first selected navigation, and first advancing video. A single total hides whether a delay belongs to compilation, restoration, provider acquisition, or decoding.

Profile native catalog validation and matching with large real catalogs. Fixed regular expressions should not compile once per provider row, and identical catalog histories should not be decoded repeatedly within one publication pass. Add caches only where the measurements establish repeated work and a clear invalidation rule.

The next priorities are:

| Priority | Change to evaluate | Evidence to collect |
| --- | --- | --- |
| 1 | Reconcile changed catalog data and batch schedule publication before full candidate projection | Cost and count of `accept_catalog`, `project_candidates`, and deferred flush calls during a real collection pass |
| 2 | Invalidate detail preparation on relevant changes and due deadlines | Advancing-clock work with empty queues, available capacity, changed demand, proof expiry, and schedule freshness |
| 3 | Reduce repeated full inventory transfer and schema copying | Warm request CPU, bytes, allocations, and renderer update time |
| 4 | Build typed projection inputs directly inside Rust | Cache-miss CPU and allocations from the current internal JSON encode/decode round trip |
| 5 | Keep browser checks within measured idle and viewing budgets | Private memory, selected-video progress, and coverage time at each limit |
| 6 | Review polling for persistently failing or already-covered sources | Requests per hour, replacement-feed discovery delay, and recovery after a viewer failure |
| 7 | Report separate startup milestones | Process ready, restored board, fresh schedule, first candidate, and advancing video |

Changing source polling or stopping collection after ten working feeds would change product behavior. The migration preserves the existing discovery policy. Those changes need a coverage-versus-resource comparison before adoption.

Use representative workloads for performance comparisons. The saved fixture separates pure pipeline CPU from upstream latency and Chromium. The live Electron check covers integration and playback. Neither substitutes for the other, and changing upstream game availability prevents a controlled before-and-after memory comparison.

## Evidence

The original live capture, process samples, request measurements, and CPU profiles are under `.scratch/performance/audit-2026-10-19/`. The preserved working TypeScript checkout, frozen-fixture generators, red and green test logs, comparison scripts, and append-only decisions are under `.scratch/rust-pipeline/`. These captures are local review evidence and are not production telemetry.

Final verification passed 1,721 TypeScript tests and 120 native tests. One TypeScript test was skipped because this Windows user lacks symlink privileges. Typecheck, lint, Rust formatting, and `git diff --check` passed. Live evidence includes `electron-final.json`, `current-app-final.json`, `negative-detail-live-final.json`, `live-step-profile-final27.json`, and `process-final.json`. The temporary server inspector was closed after profiling. The current development Electron app and its local server were left running.
