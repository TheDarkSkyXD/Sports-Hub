# Universal feed collection

The collector covers every supported league for today and tomorrow in America/Chicago. Live events remain eligible across midnight. Source Settings filters affect presentation. Collection starts before schedule requests finish.

## Root causes

Repeated matching preparation blocked the schedule worker. The preceding schedule fix reuses prepared matching state. On the same saved profile, inventory generation fell from 10,300 ms before that fix to 785 ms with this pipeline. A subsequent complete schedule refresh finished in 6,761 ms without errors. These measurements describe that local run; provider latency varies.

Browser collection previously covered football categories. Separate provider and inventory matching rules could disagree. The shared registry now supplies source coverage and verified category routes. The common matcher checks league, participant aliases, date or race session, and external event identity. NFL ESPN IDs remain bare. Every other league uses its canonical league prefix.

Dispatch capacity hid unqueued choices as unknown. The coordinator now reports retained candidate backlog as queued and refills its bounded dispatch queue. The 300-choice behavior test verifies that every choice receives a check with at most four active probes.

Native media replay lost the cookie context used by the website. Electron ignores a manually supplied Cookie header on this request path. Replay now seeds bounded captured cookie pairs in a separate Chromium session. It enables cookies only for the captured media origin, including its port. Requests to other origins cannot use that cookie store. Cleanup must finish before a session can be reused.

Captured Cookie headers do not contain cookie Path metadata. Replay scopes those pairs to all paths on the captured origin so a playlist under `/hls/` can reach protected segments under `/segments/`. Cookies and signed media addresses remain ephemeral and do not enter source snapshots or SQLite.

Timeouts, incomplete capture, lost frame ownership, and player network errors previously collapsed into unavailable results. They now retain a retriable incomplete outcome and the activation, capture, ownership, or replay phase. A recognized offline player remains a no-feed result.

Replay also shortened an accepted full cross-origin referrer. A path-gated playlist returned HTTP 403 after the browser had fetched it successfully. Replay now retains that captured referrer for the observed media origin and sets a compatible Chromium request policy. Other origins retain only the referring origin unless the request returns to that referring origin. The native fixture verifies the protected playlist, segment, and foreign-origin header isolation.

Next.js treated a default runtime data path inside the worker bundle as a filesystem asset pattern. Moving the expression between bundled modules did not fix it. Web and desktop launchers now supply the data directory before starting the worker. A subsequent production build emitted no Turbopack tracing warnings. Direct Next.js or standalone launches that bypass the supplied launchers require `SUNDAY_ROOM_DATA_DIR`, as documented in the README.

## Source Settings states

| Evidence | Display |
| --- | --- |
| Complete source read with no events in the window | No events from this source today or tomorrow |
| Listed events with recognized unpublished players | No feeds available for the listed events today or tomorrow |
| Failed, blocked, stale, partial, or unverified read | Incomplete check with its reason |
| Paid, unsupported, unclassified, or unfinished player rows | Incomplete feed details |
| Known dated event with unknown status | Visible event with incomplete schedule evidence |
| Playlist and segment media proof | Media verified, playback not yet confirmed |
| Advancing decoded playback | Working, playback decoded |

Browser categories with unverified future detail paths remain explicit. A new nonempty page cannot become a confirmed empty result by guessing a URL pattern. Retained working proof remains subject to the existing owner, publication, final-game, and expiry rules.

## Verification

Run `npm run verify:record -- <command> [args...]` from the repository root to retain each verification attempt. For the full test suite, run `npm run verify:record -- node --experimental-strip-types --test tests/*.test.ts`. On Windows, pass Node tools through their `node` entrypoint.

The recorder prints output as the command runs. Each attempt gets an `output.log` and `result.json` under `.desktop-runtime/verification-runs/<run>/`. The result records the exact command arguments, working directory, start and end times, exit code, and termination signal. The recorder returns the command's exit code. Pass only arguments that are safe to save in `result.json`; the recorder does not save the environment.

Run the normal typecheck, lint, build, and test commands. `tests/universal-feed-inventory.test.ts` exercises the public coordinator across all 14 leagues and both days, failed and pending schedules, complete empty reads, unknown status, more than 1,000 listings, and 300 choices. Captured browser pages cover NBA, NHL, MLB, and Sportsurge F1 identity and routes.

Run `node --experimental-strip-types tests/verify-observed-cookie-electron.mjs` for actual Chromium capture and native replay. The fixture requires a cookie on a playlist and a sibling-path segment, rejects cookies on another origin, and verifies `probeCandidate` returns media proof. It uses an isolated profile, local HTTPS fixtures, and a test-only address resolver. Production URL and DNS guards remain active.

Run `node tests/player.browser.mjs --desktop --live-only` for decoded HLS playback and live-edge controls in Electron. After a production build, run `node scripts/prepare-desktop.mjs` and `node tests/verify-standalone-feed-worker.mjs`. Preparation requires the source registry and game timing module. The verifier starts the actual standalone worker, reads all 42 sources and 14 league scopes, then stops it.

A live Streamcenter NBA listing also decoded on its website and in the Electron app. Website decoded frames advanced from 1,089 to 2,677. App frames advanced from 62 to 1,557, and the source inventory recorded decoded proof for the same candidate. This check occurred before tipoff and verifies the listed feed's playback. It does not establish that every external feed works or that the pregame content is the scheduled game.

Real providers can block access, change markup, or publish players only near kickoff. The checks cannot establish decoded playback for every external stream before publication. Those cases remain incomplete or unpublished and eligible for a later check.
