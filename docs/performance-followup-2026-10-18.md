# Performance follow-up, October 18, 2026

This pass implements the five recommendations from the first audit. Changes preserve the watch room's selections, source-check policy, player visibility rules, and update notifications.

## API profiling and deadline planning

A live CPU trace localized the intermittent API stalls to the football coordinator worker. Lightweight server requests took 2.4 to 6.4 ms while coordinator-backed requests took 162 to 2105 ms. The server and schedule worker spent most sampled time idle; the football worker spent little sampled time idle. These samples identify the busy worker, not precise process CPU utilization.

Repeated deadline planning scanned the full schedule once per source. Each planning pass now filters feed-eligible games once and reuses that collection. It adds no persistent cache or new protocol.

A warmed seven-round replay compared the preserved pre-change build with the new implementation using identical in-memory inputs. Median deadline planning fell from 31.07 to 8.33 ms, 73.2%. Median cold source snapshots fell from 106.83 to 94.61 ms, 11.4%. Complete deadline and snapshot hashes matched. Tests preserve idle, kickoff, and live wake times and bound repeated schedule reads.

The live trace also identified retained-feed ownership checks, ranking, observation matching, and historical SQLite reads. Those costs remain. The controlled gain does not prove that all live multi-second API stalls are removed.

## Home rendering

Home now memoizes game lookup, league discovery, filtered and sorted lists, selected games, and live-game summaries against their actual inputs. The hidden scoreboard is not sorted. Sorting also updates at local midnight.

An isolated Electron frame running the actual Home component observed 160 game-date parses for two unrelated theater toggles before the change and zero afterward. Volume and drag-hover changes also performed zero game-date parses. Filters, favorites, selected games, pending collection, board refresh, and midnight invalidation passed.

## Settings loading

SourceInventory and UpdatePanel use Next dynamic imports. Source diagnostics load when opened. Updates loads on its first visit and remains mounted across tab switches until Settings closes. UpdatePopup remains eager so startup notifications keep working.

A regression check first reproduced a lost unsaved update-source draft after switching tabs. The fix preserves that draft without saving or changing the update source. Closing Settings resets the panel's original lifetime. The code-style guide records the general rule about preserving unsaved state when deferring panels.

The isolated Home test adapts Next framework boundaries and cannot establish production chunk splitting. The compiled-app gate checks actual emitted chunks and first-open panel content separately.

## Shared player layout monitoring

Four isolated players now share one document MutationObserver, one ResizeObserver, one polling interval, and one animation-frame schedule. Each player retains its own bounds, five-point occlusion checks, layout signature, bridge updates, and viewer or verification rules. The 500 ms fallback cadence is unchanged. Monitoring starts with the first player and stops with the last.

The actual ManagedPlayer React/Electron probe first measured four of each observer and interval, then one of each after the change. It verified initial layouts, one overlay query for an event burst, dialog hide and restore, partial occlusion, focus transfer, document visibility, verification behavior, offscreen slots, partial removal, and final cleanup. A resize after the last unmount produced no further layout query.

The probe's native bridge is isolated and simulated. Actual compiled native-view and fullscreen verification is recorded separately.

## Calendar and countdown updates

The shared clock supports second and local-calendar-day cadences. Calendar labels update at local midnight. Countdown text renders independently and keeps its second-level updates. The day timer respects daylight-saving transitions.

The Electron check measured zero calendar-only rerenders over five simulated seconds while the second subscriber rendered five times. Date formatting did no additional work during countdown ticks. Local midnight and year rollover, 23-hour and 25-hour days, motorsport start transitions, football kickoff, hydration, and timer cleanup passed.

## Evidence and limits

Focused checks and red/green evidence are under `.scratch/performance/followup-2026-10-18/`, partitioned into `api`, `home`, `layout`, and `clocks`. The controlled API comparison needs the preserved build identified in `api/result.md`. The live capture and attribution are in `api/live/result.md`.

Useful checks are `tests/discovery-deadline-scaling.test.ts`, `tests/home-render.electron.mjs`, `tests/game-clock.electron.mjs`, and `tests/player-layout-monitor.electron.mjs`. Electron checks attach to the existing local app rather than launch another instance and disconnect without closing it.

Independent cross-reviews found no proven defect in the backend, Home, clock, or shared-monitor changes. They required compiled lazy-chunk and real native-view verification because the isolated probes adapt framework and native bridge boundaries. No reviewer from a different model family was available.

## Final verification

The final application source passed `npm test` (1,600 passed, one skipped, zero failed), `npm run typecheck`, `npm run lint`, and `git diff --check`. The final compiled-settings test also passed focused ESLint. Production compilation succeeded before the final restart.

The compiled Electron app passed schedule-to-room navigation with four selected tiles, no renderer exceptions, and unchanged saved room preferences. The final source fingerprint matched the running build `ce5b40af-6576-4710-9349-95fe02bc9e21` at 23:05 UTC. One main app instance and its required server remain running, with Settings closed and the watch room ready.

The first compiled Settings run observed Sources and Updates absent from the initial and General-tab resources, fetched each emitted module when opened, rendered both real panels, and preserved an unsaved update-source draft across tabs without submitting it. Its close/reopen check failed because the test assumed Updates would stay selected; Settings instead activates General. The isolated Electron regression passed the corrected close/reset behavior.

The complete compiled Settings rerun remains incomplete. After an authorized reload, CDP mouse events stopped reaching the main document even with explicit native focus. The DOM-event fallback rendered Sources, but its resource assertion failed because that cached module was absent from the performance entries. Verification stopped there. This is a test-driver limitation, not evidence that a settings action works end to end. The first-run screenshots and recovered transcript evidence are distinguished from the final failed artifact in the evidence directory.

Actual native placement, focus, and fullscreen also remain unverified: the compiled app had no active native player or isolated slot. The read-only native check preserved bounds, fullscreen, focus, and selections. The four-player isolated Electron test passed bounds, occlusion, focus, visibility, and cleanup through its simulated bridge.

Final artifacts are `final-app-check.json`, `navigation-after.json`, `tests-final.log`, `typecheck-final.log`, `lint-final.log`, `home/compiled-lazy.json`, and `layout/compiled-native.json` under the follow-up evidence directory. No commit or pull request was created.
