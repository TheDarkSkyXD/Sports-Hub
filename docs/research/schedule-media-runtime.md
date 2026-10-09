# Schedule and media runtime stalls

Normal Electron use exposed several local scheduling problems. Feed collection and media checks occupied the football worker long enough to delay public commands and expire schedule deadlines together. Saved scores hid the missing refresh behind warnings for many leagues. Increasing the checker count alone left the CPU feedback and projection work in place.

## Root causes

The original schedule transport shared the busy football worker. A controlled fifteen-second blockage reproduced simultaneous ESPN date-read timeouts. A separate schedule worker continued current and future reads during the same blockage. MotoGP and Motorsport also shared slow listing pages with racing consumers; those pages required bounded admission, shared successful reads, and independent consumer cancellation.

Media checks shared four logical jobs. Browser checks could block direct HTTP work, and request deadlines could begin before physical admission. A deadline during body consumption could cancel a partial playlist into an ordinary completed read, which the probe then classified as invalid media. Private HTTP and observer permits now cover admission, body consumption, cancellation, and observer cleanup. An incomplete check retries after five minutes while existing playable proof remains available.

Progress and completion callbacks repeatedly rebuilt the full checker frontier. A native capture measured the football worker busy for 90.3 seconds of a ninety-second interval, mostly inside `checkSources`. Removing false waiting notifications alone did not stop the feedback. Automatic completion plans now coalesce through the event loop, and immutable candidate probe keys use a private weak cache.

After that correction, a separate native capture found the remaining CPU cost in schedule acceptance, observation matching, and source inventory. The matcher scanned the full schedule for each observation, including repeated contextual NCAA alias checks. Fifteen simultaneous partition accepts also rebuilt the full projection fifteen times. Prepared alias and team indices now narrow matching, detail resolution reuses the current game generation, and current observation ownership uses a keyed SQLite read. Schedule callbacks persist independently and coalesce projection publication.

## Ownership and publication

Board and source commands flush pending schedule publication before exposing state. Refresh completion also flushes it. Current schedules remain visible while optional history is pending, and a failed optional date keeps its specific coverage warning.

Async listing, detail, player, and probe completions flush a pending publication before accepting ownership. This prevents a late result from saving proof after a final transition or a corrected kickoff outside the feed window. A game-generation check rejects player resolution across schedule replacement. Stop cancels queued publication and discovery work. A schedule-triggered discovery cancels its startup fallback so fast sources cannot be fetched twice.

## Verification

The saved-state replay uses a read-only backup of 365 schedule games, 2,385 observations, and 107 working feeds. Diagnostics write only their own SQLite clones.

| Measure | Baseline | Corrected copied state |
| --- | ---: | ---: |
| First board response | 13,135 ms | 249 ms |
| Source response | 1,139 ms | 1,085 ms |
| Schedule rebuilds in the burst | 15 | 1 |

The matcher decision digest remained `087f14d5acf03b9c9b657dd4ac35ecca48a015749b6e5c06d4e112b5888577b4`. Independent review reproduced the same decisions, one rebuild, a 484 ms board response, and a 1,731 ms source response. Back-to-back copied-state operations can still delay a timer, so the native API gate is separate.

- The frozen code suite passed 759 tests, with one skipped and zero failures. Typecheck, repository lint, and diff checks passed.
- Independent review passed 168 focused semantic tests, including alias ambiguity, source coverage, dates, finished ownership, pending history, late proof, and discovery cancellation. A second review passed 55 tests covering the exact-timestamp cache and its consumers.
- The production Turbopack build and desktop preparation passed. The fresh standalone worker loaded 47 sources and 14 league scopes and stopped cleanly.
- The nested standalone schedule smoke returned 410 games with zero warnings in 2,721 ms.
- The final native Electron gate passed all 36 samples across a complete five-minute recheck cycle. Maximum board latency was 990 ms and source latency was 1,157 ms. All samples stayed below three seconds, with zero schedule warnings and request failures. All 47 sources remained present, and all 48 LiveSportPro URLs were distinct.
- Renderer console capture reported zero errors. The saved room matched its value before the restart. The old checker-slot message was absent. Native development execution and standalone worker smoke checks passed; this run did not launch an installed NSIS package.

The post-fix thirty-second CPU capture verified the generated development worker contains the alias indices and publication coalescing. Probe-key and provider-identity work consumed about 166 ms, compared with 61 seconds in the earlier ninety-second capture. Contextual anchor checks consumed 58 ms. The football worker remained busy during active collection, so this change proves responsiveness rather than low idle CPU usage. The separate schedule worker was idle for 30.25 of 30.49 seconds in that capture. Profiling detached cleanly.

The first native run after projection coalescing reduced maximum board latency to 2,219 ms and recorded no warnings or request failures. One source request took 3,319 ms during the five-minute burst, so the run failed the three-second bound. The remaining profile showed repeated Chicago calendar formatting. A private 4,096-entry exact-timestamp cache preserves timezone and invalid-date behavior without rounding. On a frozen copy of the newer live inventory, date formatting fell from 38,749 calls to 210 calls for 210 distinct timestamps. Two source replays fell from 2,897-2,923 ms to 1,401-1,527 ms with the same match digest. These copied runs are CPU evidence; the final native gate remains separate.

The native baseline recorded 36 successful API samples with zero schedule warnings, but eighteen samples exceeded three seconds. Maximum board latency was 17,313 ms and source latency was 17,359 ms. That run failed responsiveness. The final run reduced maximum source latency by 16,202 ms, or 93.3 percent. Its local artifact is `.desktop-runtime/runtime-after-fixes-1791508066614.json`. Earlier failed gates remain available for comparison.

## Runtime bounds

Media work permits eight HTTP operations and four native observers. The checker admits a fair frontier across games and prioritizes requested feeds and due rechecks. Actual waiters appear as scheduled checks; undispatched candidates remain unchecked. Existing working feeds remain selectable during inconclusive rechecks. Remote outages, blocked players, and explicit missing media can still produce truthful source errors.

The diagnostic evidence and public-command replay are produced by the local verification scripts. Behavior coverage lives in `tests/football-board-refresh.test.ts`, `tests/live-gap-red.test.ts`, `tests/observation-indexed-matching.test.ts`, `tests/probe-replan-responsiveness.test.ts`, and the capacity, priority, and working-feed tests.
