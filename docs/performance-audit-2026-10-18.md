# Performance audit, October 18, 2026

The audit addressed four sources of repeated work in the watch room, source settings, and background schedule processing. The changes preserve server choices, feed-check states, source links, and schedule output.

## Changes and evidence

### Send the room its own source summary

The watch room fetched and validated the full diagnostic inventory on every source poll. That included source listings and three generations of collector history, even with Settings closed.

`/api/sources?view=room` now returns server choices, collection status, revision, and whether each event still needs frequent polling. The coordinator projects the summary before worker serialization. Settings continues to receive the full inventory.

One post-change Electron sample returned 760,654 bytes for the full inventory and 253,743 bytes for the room summary, a 66.6% reduction. The initial full-inventory sample was 776,531 bytes. Live inventories change as collection proceeds, so the simultaneous post-change comparison is the useful payload measurement.

Tests cover pending listings, stale schedules, queued and active checks, deferred checks, playable choices, unavailable choices, and a coordinator round trip. Every selectable candidate retains its existing fields.

### Mount diagnostic details when opened

Closed HTML `details` elements hid their contents without avoiding React rendering. Source rows, grouped game rows, and collector history now create their bodies when opened and remove them when closed. Inventory scoping is memoized by snapshot, branding, and league.

The pre-change Electron check found three listing groups mounted inside closed source rows. The updated check found zero with all 129 source rows present. It opened a source and game, verified links and check results, then closed the source and verified removal. Different league scopes were active in the two samples, so their total DOM counts are not comparable.

### Skip validation of superseded attempt history

`FootballStore.sourceAttempts()` validated every retained catalog attempt, although older attempts could not replace an already selected valid result. It now skips that validation after checking the payload timestamp.

The SQL query, ordering, invalid-row fallback, payload timestamp precedence, and tie behavior remain intact. The focused test reduced validation from 264 attempts to at most six while checking the exact returned outcomes.

Historical isolated measurements reported median reads of 38.53 to 17.60 ms for 10,000 rows and 137.48 to 83.94 ms for 50,000 rows. These measure this store operation, not application latency. The database scan and JSON decoding remain.

### Read membership once per season per rebuild

Schedule rebuilding read and parsed the same college-team membership for each game. A local typed map now reads each season once, including absent seasons. The map exists only during that synchronous rebuild; subsequent rebuilds observe saved changes.

A replay against the preserved pre-change build used 431 college games and a 1,000-team membership. Reads fell from 431 to one, board output matched, and subsequent saved changes appeared. One seven-run replay measured medians of 99.78 to 13.90 ms. This synthetic workload establishes the mechanism; it does not attribute the mixed-league application's full endpoint delay to membership reads.

## Verification

- The initial suite passed 1,595 tests and skipped one.
- The final suite passed 1,599 tests and skipped one, with zero failures.
- Typecheck, ESLint, and the compiled desktop build passed.
- An intermediate suite run failed an existing server-readiness timing test during the build. Its isolated 23-test file and the subsequent full suite passed. The test was not changed.
- Electron checks exercised source expansion and collapse, the watch room, game schedule, and General, Playback, Updates, and Privacy settings. Navigation preserved saved room preferences and produced no renderer exceptions during the check.
- The local Electron app was restarted from the changed source and left running. Production and packaged release channels were not changed.

`scripts/audit-ui-performance.mjs` attaches to the existing Electron renderer on port 9321, records a bounded sample, probes payload sizes, and disconnects without closing the app. `tests/source-inventory-render.electron.mjs` verifies diagnostic rendering against the running app. Unit tests cover the protocol and background changes.

Local evidence is under `.scratch/performance/`, including `before-ui.json`, `after-steady-ui.json`, `source-render-after.log`, `navigation-after.json`, `tests-final.log`, `typecheck-after.log`, `lint-final.log`, `runtime-findings.txt`, and `decisions.tsv`. The membership replay additionally requires the preserved pre-change local build named in `runtime-findings.txt`.

## Coverage and remaining work

Source inspection covered the room and schedule, settings, source inventory and collector history, browser playback sessions, managed and HLS players, native layout synchronization, player controls, update components, shared clocks, mobile detection, and the internal verifier.

These candidates need measurements before further changes:

- Home sorts the hidden scoreboard and recomputes discovery and filters during unrelated interactions.
- Settings and source components are loaded eagerly with the main page.
- Relative calendar labels subscribe visible cards to the shared one-second clock.
- Each isolated player observes document mutations and polls layout. Changing this requires focus, occlusion, resize, and fullscreen verification.

The live before/after samples used different selected games and playback activity. They do not establish a whole-application CPU or endpoint-latency improvement. The source payload reduction and isolated background improvements are established. Playback reliability across external providers and the full updater workflow were not verified; upstream 403 and provider failures remain outside these changes.

## Review attention

An independent GPT-6.1 review found no proven application defect. It caught two measurement defects: probe requests were included in the timed request counts, and the original membership benchmark stopped reproducing its baseline after the fix. Both tools were corrected. Earlier request counts should not be used as polling-rate evidence. A reviewer from another model family was unavailable.

The five follow-up recommendations were addressed in the [performance follow-up](performance-followup-2026-10-18.md), with separate measurements and verification limits.
