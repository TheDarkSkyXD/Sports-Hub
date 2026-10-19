# Feed coverage and player changes, October 18, 2026

The goal is to make background checks progress while watching, recover potentially working routes sooner, and expand direct custom-player media support. A feed stays marked working only after decoded video proof. Upstream outages, unknown selected-player ownership, unsupported codecs, and DRM remain separate limits.

## Baseline

The existing Electron app remained playing throughout investigation. The first source snapshot reported four active checks, fifteen queued, and 157 completed. One check for the live NFL game had waited 502,736 ms in the queue and then completed resolution in 4,518 ms. A later snapshot found 67 overdue incomplete rows for that game while first attempts still occupied the queue. Candidate rows include aliases; these numbers do not count unique working streams.

The coordinator's first-attempt frontier blocks every automatic retry and maintenance check until all first attempts across the current and future days finish. The existing three-to-one retry fairness code cannot take effect while that frontier exists. This explains an internal cause of persistent Retry due messages. It does not explain every upstream media failure.

## Selected changes

Permit due failed or incomplete retries for current-day and live games alongside first attempts. Rechecks of working feeds wait for today's first attempts and can run before tomorrow's. Keep the existing three new attempts to one retry fairness, today's first attempts before tomorrow's, future-day retries behind first attempts, and the four-job viewing budget. Queue priority is separate from the number of discovered or verified feeds.

For new media support, retain HLS.js and native progressive playback. Add a lazy DASH engine through Shaka Player. Let the library parse DASH templates and inherited bases, and route its requests through the existing generation-bound media capability. A server-side MPD rewrite was considered; it would duplicate a mature library's template and base-resolution rules. HTTP FLV and standalone MPEG-TS use a second lazy engine, mpegts.js. MP4 and WebM retain native video playback. MPEG-TS inside HLS continues through HLS.js.

## Earlier renewal keeps options available

The first and later captures show eight previously playable NFL rows becoming queued or active checks rather than failed results. The old code starts a working-feed recheck at the same 30-minute age that makes proof too old to select. Rechecks now become eligible at 25 minutes, with the proof cutoff unchanged at 30 minutes. A held renewal stays selectable at 25 minutes and just before 30 minutes, then loses working status at exactly 30 minutes without a new successful check.

This schedules about 20% more maintenance starts for a stable feed. The five-minute headroom reduces expiration gaps but cannot guarantee a renewal while all four slots are busy. Active work still drains naturally when more urgent work appears.

## Media boundary and coverage

The new DASH path recognizes owned MPD responses, carries the format explicitly, and loads Shaka only when needed. Bounded MPD parsing admits declared media and manifest references. Nested manifests get their own existing media capability, preserving their original base. Authorization, request cancellation, source URL validation, cookie/referrer replay, ranges and generation revocation remain required. Undeclared references and oversized or unsupported manifests fail rather than turn the relay into a general public proxy.

The library handles DASH playback and URL-template expansion. The small server parser restricts where the engine may request media; it does not rewrite the manifest. Unknown ownership and unsupported paths retain the existing selected-document fallback. HLS startup does not import either new engine.

A root-run native fixture exercised actual ManagedPlayer and GamePlayer against real relay functions in the existing Electron process. DASH with two H.264 representations and separate AAC audio, MP4, WebM, FLV and MPEG-TS all produced decoded advancing-video proof. The fixture checked each actual format path, Pause/resume, volume and player removal. The first native run exposed misplaced local fixture fragments; moving those fragments and fixing the generator working directory corrected the fixture. No production change was justified by that failure.

## Throughput checkpoint

- Reproduce live statuses and fix the scheduling model before any source edit.
- Pipeline worker owns coordinator and queue tests. Media worker owns discovery, relay, playback components, media tests and dependencies. Root owns documentation, app controls and evidence.
- Each writer owns separate files. Shared Electron launches, server rebuilds and final checks stay with root.
- Verify each concern before combining it in a rebuild. Run focused red/green tests, full static checks and the actual Electron flows. Do not add a framework or raise browser concurrency to hide the delay.

## Verification

The scheduler fairness test and early-renewal test each failed before implementation. All 65 related coordinator tests passed. The complete frozen Node suite passed with 1,711 tests and one skip; full ESLint and TypeScript checks passed. Independent review checked the queue, proof deadlines, the changed test expectations, and media boundaries.

Native viewing passed all five direct-format paths, Pause/resume, volume, removal and worker cleanup. DASH switched from 180p to 360p. Native verification also passed all five formats, each with at least 49 presented frames and two seconds of media advancement. The actual format path was asserted, so a cached presentation could not make several formats appear covered by one engine.

Verification mode exposed two bugs after viewing passed. First, zero-second backward cleanup in mpegts.js attempted SourceBuffer.remove(0,0) and blocked appends. Cleanup now retains a one-to-two-second backward window. Second, the UI's native live-sync path sought inside MPEG-TS while its engine was still loading. The clock reached the end with only three decoded frames. The automatic-sync guard now uses the explicit DASH/FLV/TS format before engine attachment. The final native verification run showed zero unwanted seeks and advancing decoded frames. Evidence thresholds and startup deadlines were not relaxed.

HLS child-token URLs continue accepting unrelated query parameters such as low-latency reload keys. DASH child operations alone require the strict reference/kind query shape. Two tests exercise the actual Next route and passed after a failing-first compatibility check.

Electron rebuilt and restarted with build 4adab382-1e96-4aae-856a-069ac955fe78. Its source identity is 5c5d507392d26dc65c0a9d2efcfc0835a190a756f1d8bda95e6d4f2f7f19b20f, matched against current source using Electron's own Node runtime. The local app main PID is 3052.

A final isolated window loaded the rebuilt /internal/playback-verifier page, its actual Next.js chunks and production Content Security Policy. Only fixture media requests were routed to the real relay fixture. All five formats returned playable through the compiled verifier, with 49 or 50 decoded frames and 2.00 to 2.04 seconds of advancement. Each assignment removed its player before the next began. This checks the production client bundle and CSP in addition to the earlier source-bundled component checks. The first attempt stalled in the audit harness because its WebSocket opened before the listener attached; checking the socket's existing state fixed the harness without changing production code.

The rebuilt app also passed Game schedule, Watch room and Settings Sources navigation. Saved room preferences stayed byte-for-byte identical and no renderer exception occurred in those flows. Sources showed 31 of 31 NFL sources. The schedule now reports zero live games and the main room has no active tile. That prevents a comparable after-change live-game latency or resource sample. No game was added to manufacture one. The idle source pipeline was progressing with its configured sixteen-check limit; future publications and real upstream failures still retain cooldowns. Evidence is under .scratch/performance/feed-coverage-2026-10-18/. Decisions append to .scratch/performance/pipeline-2026-10-18/decisions.tsv.
## Compatibility limits

These changes cannot guarantee every feed. Codecs must be supported by Chromium or the chosen engine. DRM requires authorized provider and CDM integration. RTMP, RTSP, WebSocket media, arbitrary transcoding, provider outages, expired source credentials and missing game publications are outside this change. A future game can legitimately have no published working feed yet. A feed is selectable only after playback proof, and the existing ten-feed target prioritizes games with fewer choices rather than imposing a maximum.

The engine choices follow their primary documentation: [Shaka Player](https://github.com/shaka-project/shaka-player), [Shaka networking](https://shaka-project.github.io/shaka-player/docs/api/shaka.net.NetworkingEngine.html), and [mpegts.js](https://github.com/xqq/mpegts.js).
## Resource and verification limits

The existing four-check budget while watching and sixteen-check idle budget remain in place. Stable-feed renewals start more often to preserve choices. There is no measured whole-app CPU, RAM, or total working-feed percentage for this pass. Source collection and Chromium child-process counts are separate from the check admission budget.

FLV/TS live mode in mpegts.js ignores its lazy-load forward-duration options. Those unused options were removed. Backward buffer cleanup is bounded; an enforced forward-time buffer cap is not claimed for these paths. Verification closes each player after proof, and the existing relay byte/network budgets remain. HLS and DASH verification retain their existing small configured buffer goals.

The separate Storybook coverage command failed with three existing findings: player-controls-overlay is not imported by a product story, and source-inventory/update-panel stories are reported unused. The latter two are false negatives because that checker does not follow dynamic imports used by the app. New format stories and their local generated assets passed types and lint; a full static Storybook build was not run. These checks do not establish blanket coverage of every external provider.
## Review and principles

Independent Codex review checked the selected-player and manifest boundaries, cold/import cancellation, terminal cleanup, route query compatibility, scheduling fairness and exact proof expiry. Other model families were unavailable in the live model catalog. No production deployment, migration, commit or pull request was performed.

Model the Domain kept media format explicit across discovery, presentation and engine selection. Laziness Protocol kept the existing queue and generation-resource owner. Prove It Works required actual decoded video through the compiled Electron verifier rather than accepting a manifest or an advancing clock alone.