# Collector and media checker audit

Audit date: October 14, 2026. Scope: source collection, provider resolution, browser media capture, decoded-video checking, relay playback, and the Electron watch room.

The target is direct video first, with an isolated player document as fallback when its event and player ownership can be established. An arbitrary event page is not a valid fallback.

This report records local work. No production system, migration, branch switch, commit, or pull request was involved. Existing checkout edits were preserved and the review compares against the checkout captured at the start of this audit.

## Findings and changes

| Finding | Impact | Change |
| --- | --- | --- |
| Checker admission multiplied across games and shared work. The initial native sample had 125 active source rows and 117 mounted video elements. | Hidden playback could compete with the watch room for CPU, memory, network, and decoding. | One global limit of four physical checker jobs; existing fair queue retained. Local resource contention returns a short capacity deferral. |
| Static extraction could choose an unrelated stream from page scripts. Browser capture could associate a media request with a frame merely because it contained a video. | A check could validate an ad or another event. | Unique selected-player evidence, direct media ownership, and a stable parent-to-child iframe chain. Hidden, transparent, clipped, or ambiguous players cannot establish proof. |
| Ad filtering covered a few exact paths, and acquisition paths applied different network rules. | Catalog and source pages could load unnecessary third-party traffic or reach non-public addresses. | One shared browser request policy with bundled EasyList/EasyPrivacy rules, public DNS validation and a pinned proxy, resource budgets, and blocked non-proxied WebRTC UDP. Native Rust HTTP reads also validate all DNS answers and connect through those admitted addresses. |
| Automatic playback assumed HLS. | Progressive video and player-only sources could fail despite a usable player. | Explicit HLS, progressive-video, and isolated-player presentation. Successful direct resolution keeps fallback dormant without creating a native view or session. |
| New native sessions on every fallback would accumulate Electron browser contexts until process shutdown. | Repeated checks could grow retained native resources. | A bounded eight-session pool. Reuse requires connection, authentication, storage, cache, and worker cleanup. Failed cleanup quarantines the session. |
| Hiding unrelated iframes after page load still allowed their requests. | Unselected content could execute before removal. | Child-frame network admission checks the selected iframe before navigation. The native fixture verifies that its unrelated sibling never loads. |
| Failure causes and retries were lost between stages. | Local contention and temporary upstream failures could appear as broken feeds with long retries. | Structured phase, reason, retry delay, and resolution/capture/decode timing now reach the verifier, coordinator, and inventory. Physical job counts and 32 bounded recent outcomes distinguish jobs from aliases. |
| Native row decoding could reject a complete batch because of one malformed row, and native stream-number admission differed from TypeScript. | Valid feeds could disappear with an invalid sibling. | Row-level validation retains valid siblings and enforces the existing stream-number contract. Focused Rust and TypeScript checks pass. |
| Progressive media inherited a 64 MiB response cap and a whole-read deadline intended for segments. | A normal long video could fail on an open byte range or stop partway through playback. | Progressive roots have a rolling traffic budget, bounded concurrent reads, cancellation, and an upstream idle deadline. Finite segment bounds remain. Tests cover both no-range and open-range reads past the old limits, including consumer backpressure. |
| An isolated startup timeout marked the UI failed but left its native player alive. | A mounted parent could retain network traffic and decoding, then accept contradictory late proof. | Terminal failure releases the native player immediately and ignores late events. A release during pending authorization also prevents late allocation. |

The player runtime uses a sandboxed, isolated `WebContentsView` with no Node integration, preload, or application bridge. The trusted host receives an opaque, generation-bound capability rather than a remote URL. Permissions, popups, downloads, and unrelated top-level navigation are denied. Closing or switching the player releases its native view.

The local network policy preserves TLS and browser web security. It does not strip source CSP or bypass DRM. Filter rules block recognized page ads and trackers; they cannot generally remove advertising encoded into the video stream itself.

Static HTML cannot prove which player the browser renders. Closed dialogs, closed details, templates, CSS, clipping, and scripts defeated successive static guesses. Generic HTML media extraction was removed. An iframe-discovered playlist also requires browser ownership from the original publishing page; only an original direct-media destination can take the HTTP shortcut. In the browser, native `checkVisibility` complements ancestor geometry and clipping. A closed-details video can report a 640 by 360 rectangle while remaining unrendered.

Unselected static child titles and dates cannot establish an event match or veto the selected player. Child metadata affects admission only when the existing observed player document or parent identifies that selected ancestry. Original publishing-page identity and exact supported provider bindings remain available.

## Runtime ownership

| Concern | Main code |
| --- | --- |
| Global checker admission, fairness, retries, bounded inventory diagnostics | `lib/football/runtime/coordinator.ts` |
| Typed presentation and generation-bound media capabilities | `lib/playback/presentation.ts`, `lib/stream-relay.ts`, `lib/stream-server.ts` |
| Provider-specific event and player binding | `lib/playback/providers/` |
| Browser-selected media and request provenance | `desktop/player-evidence.cjs`, `desktop/sportsurge-observer.cjs` |
| Browser ad filtering, DNS pinning, traffic limits, acquisition policy | `desktop/source-network.cjs`, browser collector and source-reader integrations |
| Captured-session media replay | `desktop/observed-media.cjs` |
| Sandboxed native fallback lifecycle and session cleanup | `desktop/isolated-player.cjs` |
| Shared direct and fallback controls | `components/managed-player.tsx`, `components/game-player.tsx` |
| Native HTTP and row admission | `native/collector/src/http.rs`, `native/collector/src/resolver.rs` |

Filtering uses pinned Ghostery 2.20.1 with bundled EasyList/EasyPrivacy data and a checked manifest. TypeScript address classification uses `ipaddr.js`; Rust uses pinned `iprfc` 1.0.0. Filter refresh/check tooling and packaging include the required engine, lists, and licenses. No remote filter download is needed to start playback.

## Performance evidence

The strongest measured lead is browser acquisition and process turnover. A ten-second phase-two profile saw nine new renderer processes and fifteen departing renderer processes. Main-process and watch-room JavaScript samples were mostly idle. That does not attribute native decoding, graphics, networking, or other renderers to a JavaScript function.

The checker now admits four physical jobs across the app. Source aliases can share one job, so the number of rows marked checking is not a physical job count. A focused reproduction showed six active aliases with one provider check. Native verification records assignments separately from source rows.

Sportsurge static lookup previously allowed three serial requests of up to 25 seconds each before browser capture. The new path shares a ten-second total static budget and retains bounded browser capture within the overall resolution deadline, leaving time for decoded-video proof. Successful HTTP providers do not open a browser solely to prepare fallback.

| Measurement | Result | What it establishes |
| --- | --- | --- |
| Phase-two published feed updates | Four in 30.44 seconds | Completion rate for that live interval, not maximum throughput. Deferred trials were not all counted by that older measurement. |
| Phase-two summed Electron working sets | 4214 MiB | A process working-set sum; shared pages can be counted repeatedly. It is not private memory or proof of a leak. |
| Phase-two source inventory replies | About 900 KB; 40 to 1257 ms receive time; 2.0 to 2.8 ms JSON parse time | Parsing alone did not explain response latency. The sample did not separate worker waits, projection, validation, or development-server overhead. |
| Shared ad engine | First three decisions about 18 ms; 10,000 warm decisions about 552 ms including assertions | The pinned engine has a small measured matcher cost relative to page acquisition. This is not an end-to-end playback benchmark. |
| Phase-five inventory boundary | 129 sources, 21 games, 474 candidates; 504,095 bytes. First receive 355 ms, four warm receives 29 to 52 ms at the same revision | The existing revision cache works. First-read delay still includes unmeasured construction, queueing, IPC, and development-server work. |
| Phase-five inventory stage medians | Worker validation 6.3 ms; clone 4.0 ms; client validation 4.9 ms; stringify 1.1 ms; parse 1.2 ms; UI validation 7.0 ms | Repeated validation costs more than parsing in this sample. These isolated warm measurements do not measure total pipeline latency or React rendering. |
| Phase-five recent trials | Several ownership deferrals spent 20 to 21 seconds in capture; some decode failures spent about 55 seconds active. Background queue waits reached 73 to 208 seconds | Browser startup, remote player behavior, proof deadlines, and queue turnover deserve attention before JSON parsing. The live workload is not a controlled comparison against earlier phases. |
| Final 60-second trace | Four physical slots; 11 new assignments, seven finished, six deferred and one unavailable. No new playable completion among those seven | This trace counts newly assigned verifier trials, including incomplete outcomes. Assignments already running at attachment are excluded. Inventory polling was disabled, so the legacy zero feed-update/inventory counters are unmeasured fields. |
| Final watch-room continuity | One Streamcenter stream advanced 60.047 seconds and 1,802 frames; one additional dropped frame; ready state 4 at both endpoints | Visible playback continued during this checker workload. This does not prove the broadcast is the event shown in the game card. |
| Final ten-second profile | Ten renderer starts, nine departures; main JavaScript 96.9% idle and room JavaScript 97.7% idle | Browser-process turnover remains substantial. These profiles exclude JavaScript in other renderers and do not attribute native CPU use. |
| Final aggregate resource snapshot | About 5,032 MiB summed Electron working sets; endpoint CPU estimate 88.8% of one core | These are limited development-session figures. Shared memory is counted repeatedly and departed-process CPU is missing. The workload has one room stream and differs from the earlier empty-room sample. |

The coordinator already caches inventory by revision and proof expiry. No second inventory cache was added. The verifier already uses a small HLS buffer; this audit retained that existing optimization.

The bottleneck fixes in this change are the four-job global admission limit, direct HTTP resolution before browser capture, one shared static lookup deadline, dormant fallback, and bounded reuse of clean native sessions. They prevent duplicated work and uncontrolled resource growth. They do not make an unavailable remote player respond faster.

The next performance experiment should group completed trials by phase and provider, then measure browser startup and ownership time separately under a fixed replay workload. Keep the four-job limit until that shows a safe improvement. A larger limit can shorten the queue while increasing decoding and browser contention. Inventory validation is a smaller measured follow-up; removing a boundary requires proving that boundary already received trusted, validated data.

No overall CPU, memory, or startup speed improvement is claimed from mismatched live workloads or development builds. The final trial trace confirms that slow incomplete acquisition and proof work continue to occupy the bounded checker slots.

## Native verification completed

- Selected nested iframe playback used real Hls.js, MSE, and decoded video. The fixture advanced more than two seconds and presented additional frames without exposing a global HLS instance.
- The network fixture blocked a real ad-script request, private DNS, and loopback destinations while public HTTPS worked through the pinned proxy. The isolated-player fixture blocked its unrelated sibling before load. The separate ownership fixture deliberately fetches unrelated media and proves that it cannot become the selected stream.
- A matched WebRTC control sent four loopback STUN packets. The production restricted source reader sent zero.
- The native Rust HTTP reproduction opened one loopback socket before public-DNS enforcement and zero afterward. Tests cover mixed public/private answers, address pinning, cancellation, and a DNS deadline.
- Real HTTPS progressive capture selected the video's MP4 while the page fetched a different MP4. Captured-session replay retained the cookie and `bytes=0-` range, decoded 320 by 180 video, and advanced 2.2 seconds and 53 frames.
- The actual `ManagedPlayer` component decoded progressive video without allocating an isolated view. It also decoded isolated playback and a fallback after direct HLS failure.
- Pause, resume, audio, dialog hide/restore, fullscreen bounds, source switching, removal, and capacity retry passed in a native Electron host.
- Reusing a real native session cleared a seeded cookie, local storage, and an installed service worker.
- A non-decoding isolated player timed out while its parent deliberately stayed mounted. The failing version retained one view and accepted one late proof; the corrected version retained zero views and accepted zero late proofs.
- The actual watch room played the current Nuggets-Clippers feed at 1920 by 1080 while four checker assignments ran. A short initial check encountered visible buffering; the later recorded sample advanced 2.295 seconds and 136 frames without a media error.
- The final restart reproduced intermittent PPV buffering in the same room. A failing fragment request returned an unavailable/upstream/replay result. After using Switch server, the Streamcenter alternative decoded 1280 by 720 video, advanced 2.518 seconds and 76 frames, and stayed at ready state 4 while four physical checker assignments ran. This does not prove the PPV stall was fixed.

The final focused gate passed 387 tests in 48 files. The complete Node suite passed all 1,302 tests in 202 files with no skips. Global lint and application typecheck passed. Rust passed all 54 tests, and the release collector addon was rebuilt and loaded in Electron. All 53 source hashes in the final implementation manifest matched the files verified. The restarted app passed the live Streamcenter playback and four-slot checks, followed by the stable 60-second trace above.

## Independent review

### Standards

No hard documented-standard violations were confirmed in either review. The native capacity script incorrectly treated active source aliases as physical jobs; it now checks the coordinator's physical count and the verifier's rendered assignments separately.

The reviewer also identified possible duplication in selected-frame ancestry traversal between capture and isolated playback. The DOM selection function is already shared. Capture additionally binds request provenance, while playback applies controls and decoded-video proof. A general traversal abstraction has not been added; the two lifecycles retain their focused ownership tests.

### Spec

The review found concealed static-media and iframe shortcuts, unselected-child event metadata, progressive transport limits, and incomplete terminal cleanup. Each received a failing reproduction and a focused correction. The final narrow follow-up found no actionable issue in iframe admission, selected-child identity, retry timing, malformed-row behavior, or the generated-output lint exclusion. The full-suite gate is recorded separately below.

The final trail review used gpt-5.6-sol, a different available GPT generation. It found the corrected evidence trail consistent, with the live-source, visual-content, provider-coverage, and performance limits recorded below. Cross-provider review and raw workspace transcript access were unavailable; that review used saved artifacts and supplied run facts. The full flags are saved in `final-trail-review.json` in the local audit artifacts.

## Coverage limits

Sportsurge identity checks cover existing NCAA aliases and exact full team pairs from matched NFL, NBA, NHL, and MLB source events. Real MLB title and heading extracts have saved capture hashes. A conflicting event or comparable published date rejects the match. A downstream-only date without a source-published date remains unverified. Team-name evidence does not independently identify the broadcast's visual content.

Channel-derived feeds have a further limit. The final Streamcenter screenshot contains historical basketball footage while the room card shows the current Nuggets-Clippers game. The sample proves continuous channel playback, but cannot establish whether that footage is part of the current broadcast or whether the channel is showing the expected game. The checker verifies source/player ownership and advancing video; it does not recognize teams, dates, or advertisements inside decoded video. It must not be described as visual event verification.

Racing needs the correct series, session, and published date; a track name alone is insufficient. Combat and weekly wrestling events need their event/card identity and date. A catalog listing alone does not prove that an unrelated downstream player shows the same event.

Codec support, DRM, provider availability, changed source markup, and ambiguous player ownership can still prevent playback. Unknown ownership remains incomplete rather than being reported as a verified feed.

All ten candidate adapters were reviewed. Evidence levels differ by adapter:

| Adapter | Available evidence | Remaining gap |
| --- | --- | --- |
| SWAC | Captured event metadata and event-bound media/DVR tests | No new live decoded proof |
| Gooz | Controlled provider playlist, quality, and signed-segment tests | No tracked complete live player response |
| Streamcenter | Captured uppercase player page and parent/HLS2 host binding | Current signed-CDN availability |
| StreamEast | Real MLB, NBA, and NHL listings | Listings do not prove playback; legacy channel adapter lacks a focused opening fixture |
| StreamEast server | Selected-server ancestry, Wikisport and Dlive behavior | No current full HTML and media trace for each transport |
| Sportsurge | Real listings, wrong-match fixture, hashed MLB title/heading captures, browser ownership tests | Strict race, combat, and wrestling downstream identity |
| Wikisport | Exact supported channel and selected nested player relationship | No tracked complete real player response or new live decoded proof |
| Event page | Captured event pages and published routes with strict player binding | Shared adapter covers more families than native live samples |
| TVApp | Frozen catalog parity and source/row revalidation tests | No complete current live player/API and continuous-media fixture |
| Catalog stream | Captured catalogs and provider revalidation | Every downstream media combination is not live verified |

The full local matrix is `phase5-provider-coverage.json` in the audit artifacts. Shared native runtime fixtures establish isolation and playback behavior, not current compatibility with every live provider.

## Repeatable local checks

These scripts attach to the running development Electron app. Run native checks one at a time. Temporary windows belong to the check and are removed afterward; the main watch room stays open.

```powershell
node tests/media-network.electron.mjs
node tests/media-ownership.electron.mjs
node tests/media-observer-progressive.electron.mjs
node tests/media-webrtc.electron.mjs
node tests/media-isolated-player.electron.mjs
node tests/media-managed-player.electron.mjs
node tests/media-checker-capacity.electron.mjs
node tests/media-inventory-performance.electron.mjs
node tests/feed-check-throughput.electron.mjs --port 9321 --seconds 60 --trace checks --output .desktop-runtime/media-audit-fixes/final-throughput.json
```

The decision trail, initial baseline, focused RED/GREEN logs, native JSON results, screenshots, and profiles are under `.desktop-runtime/media-audit-fixes/`. They are local verification artifacts.
