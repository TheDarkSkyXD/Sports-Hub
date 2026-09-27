# Football pipeline verification

The implementation is tracked in [issue 14](https://github.com/TheDarkSkyXD/Sports-Hub/issues/14). These checks distinguish working pipeline behavior from source coverage that still needs verification.

## Source and schedule evidence

All 17 supplied URLs have entries in the discovery registry. The [before](football-parser-baseline.json) and [after](football-parser-after.json) probes record listing extraction and access failures. They do not prove that every source supplies playable video.

On September 26, 2026, the ESPN FBS and FCS schedule union contained the same 116 event IDs as ESPN group 90. The [probe](football-schedule-implementation-probe.json) also records separate season membership references. This checks consistency within ESPN, not completeness against an independent schedule authority.

The membership evidence is season-specific. It does not establish effective dates for changes within a season.

A separate [HTTP probe](football-espn-request-probe.json) records why the adapter uses single dates and a limit of 200. The date-range request returned HTTP 400. A limit of 1000 returned 25 events for the same day and group where a limit of 200 returned 65.

An unmocked development-browser check played Clemson at California through the custom player at 1280 by 720 pixels. Video time advanced from 2.97 to 7.98 to 12.99 seconds. Concurrent development edits caused reloads during the wider check, so this is evidence of decoded playback, not a stable production soak test.

Only the Gooz-compatible media resolver is implemented. Other sources can contribute internal observations, but remain unavailable to the player until their media and matching evidence pass acceptance. [Issue 15](https://github.com/TheDarkSkyXD/Sports-Hub/issues/15) tracks the remaining source adapters. Live NFL and FCS playback are not yet verified. [Issue 16](https://github.com/TheDarkSkyXD/Sports-Hub/issues/16) tracks RedZone channel sessions.

## Reproducible checks

Run the application checks with Node 24 or newer.

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

At code commit `32ad94e`, an independent run passed all 42 tests, type checking, and zero-warning lint. The tests exercise dated matching, ambiguous observations, overlapping college schedules, persisted final deadlines, outage behavior, worker ownership and crash recovery, bounded failover, and relay restrictions. The architecture test also verifies that forbidden module imports fail lint.

The [application checks workflow](../../.github/workflows/quality.yml) runs these commands on pull requests with Node 24. Desktop media tests remain separate because they require a browser and Electron.

For browser checks, start the production server and run `npm run test:player`. Run `npm run test:player:desktop` for Electron. The browser script uses generated HLS video and controlled schedule and provider responses. It verifies actual media decoding and custom controls, but does not certify a live provider. Final runs passed 24 browser scenarios and 25 Electron scenarios. Electron also checked playback while minimized, a refresh on resume, and closure of the owned server port after exit.

Run `npm run diagnostics:football -- --listings` after the pipeline has collected data. A direct check returned all 17 source states and 25 internal listing samples with match reasons. Set `SUNDAY_ROOM_DATA_DIR` to inspect a different application database.

## Review findings

Review of the initial implementation found abandoned relay resources, failure to deliver newly discovered backup candidates to an existing player, and offline failures that could count against a provider. These findings are corrected. Relay expiry preserves paused-session heartbeats, session responses carry current candidates, and local interruptions reload without penalizing a provider.

The delayed-score test verifies a full five-minute grace measured from acceptance. Browser checks cover unexpected provider end-of-stream, late backup discovery, offline startup, and a media failure that arrives during a pending heartbeat. The heartbeat regression passed in the production browser. The desktop crash check is `node tests/desktop-crash.mjs`.

Forced-crash checks passed on Windows in production and development mode, including Next's development child process. Run the latter with `node tests/desktop-crash.mjs --dev`. The first test incorrectly killed Playwright's launcher rather than Electron's main process; that failure did not establish a server shutdown defect. The corrected test reads Electron's main PID, kills it, and checks that the owned server port closes. An IPC-connected supervisor now owns the Next process tree.

The final Standards and Spec rechecks cleared all accepted findings. Discriminated game and session types reject contradictory states. The coordinator depends on application-owned ports, and the composition module constructs its adapters. Default-deny import rules enforce this separation. The independent audit used `gpt-5.6-sol`; a different model family was unavailable in this session.

The [final check record](football-pipeline-checks.json) contains the command outcomes, timestamps, code commit, and browser scenario results. All eight local checks passed. The final Electron run includes the IPC supervisor and graceful shutdown. GitHub Actions execution is separate from this local evidence.

The audit trail is in [football-pipeline-decisions.tsv](football-pipeline-decisions.tsv). Generated browser results and screenshots live under ignored `work/player-verification/` and `work/player-verification-electron/`; rerun the committed browser script to reproduce them.
