# Pipeline robustness, 7 October 2026

The shared pipeline could stop making progress after a provider ignored cancellation, a hidden browser window disappeared, or native cleanup failed. The desktop could also wait indefinitely for startup or incorrectly declare an owned server stopped. This audit reproduced those mechanisms before changing production code.

The existing discovery window remains today, tomorrow, and live games. Settings > Sources retains the saved interval and the five-minute default. Working media proof, active selections, game identity, and finished-game cleanup retain their existing behavior.

## Root causes and corrections

| Reproduced fault | Cause | Correction |
| --- | --- | --- |
| Four stalled probes block every queued candidate and shutdown | An abort signal does not settle an uncooperative provider promise | The coordinator owns one 65-second deadline, settles before aborting, and ignores late results |
| Canceled media reads retain acquired playback | Reader cancellation can remain pending | Cancellation settles the probe promptly; acquired and late-opened playback close exactly once |
| Observer slot stays busy after frame teardown | An asynchronous native-frame failure escapes the observation | The current observation handles its rejection and releases only its own slot |
| Sportsurge document checks never settle after window disposal | Native `stop()` can throw before timeout or cancellation rejects the document wait | Guard that native operation and settle the wait; a later sweep can recreate its window; StreamEast's existing behavior passed the same check |
| Transient cleanup consumes the entire 32-session pool | Failed cleanup never returns a slot | Use at most three cleanup passes within five seconds; quarantine stalled or permanently failed cleanup without dirty reuse |
| Headless startup waits indefinitely or accepts another server | Readiness accepts any successful root response and has no total startup deadline | Require the spawned instance's private HEAD response and bound startup to two minutes; main reports failure and cleans up before exit |
| Shutdown reports success despite failed tree termination | Direct-child fallback is mistaken for descendant cleanup | Retain ownership until successful tree termination and observed owned exit; failures remain retryable and exited PIDs are never reused |
| One failed replacement permanently disables recovery | Unresolved ownership also disables subsequent checks | Retry termination of the same live owner after five seconds without overlapping attempts |
| Late exit after successful termination leaves recovery stalled | The exit handler discards already acquired termination evidence | Reconcile actual exit with retained tree-command success and schedule one replacement |

## Verification

Regression commits precede production fixes: `025e536`, `265fd0f`, `3bd9c10`, `10cc4b3`, and `b7c8d20`. Probe, browser, and server fixes are `f3fa888`, `31addd3`, and `5dffad4` respectively. Original progress tests were preserved; new liveness cases have a separate file.

The final combined run passed all 519 applicable tests with zero failures. The final server checks passed all 26 cases, including both recovery orderings, retained failed-stop ownership, hung termination, foreign readiness, and stop canceling retries. Full ESLint, TypeScript, and the production build passed. The installer-artifact case remains excluded: the local installer is version 1.0.6 while the project is version 1.0.10; no installer was rebuilt or published.

The actual Electron app was checked through Electron MCP and its native main-process inspector. Every restart followed a zero-active-process gate. A baseline ordinary close removed all 22 recorded owned processes. The updated app's ordinary close removed all 16 recorded processes. Injecting an observer cleanup failure still removed all six recorded processes and exited with status 1. Injecting startup failure into real Electron recorded the error-dialog call, stopped admission and server work, and exited with status 1 and no surviving owned process; the dialog was recorded rather than displayed in that fixture.

The final restart returned `visible: true`, `focused: true`, and `minimized: false`, centered on the primary display. The inspected screenshot showed today's and tomorrow's game cards. Runtime snapshots retained the five-minute setting, 19 sources, seven eligible games, and five working choices. Comparing snapshots showed all 19 source attempt times advanced automatically without manual retry.

Two independent design candidates and a separate judge selected coordinator deadlines with local resource ownership. The independent final reviewer used `gpt-6-astra`; both discovered recovery findings were corrected. A separate comment/style review found no remaining findings. Evidence and the append-only decision trail are retained locally under `.desktop-runtime/robustness/` and `.desktop-runtime/pipeline-robustness-decisions.tsv`; they are ignored runtime artifacts rather than distributable fixtures.

## Limits

Successful media checks describe measured upstream availability. Scheduled or externally unavailable feeds can remain unavailable. Permanent native cleanup failure intentionally quarantines a slot; unlimited recovery would require unsafe reuse or unbounded sessions. Failed operating-system tree termination remains an explicit failure rather than a claim that descendants are gone. The Windows process-tree behavior was verified locally; the portable branch does not establish an equivalent tree guarantee.

## Follow-up: periodic working feed checks

The next runtime inspection found five cached working choices with checks 54 to 444 minutes old despite the five-minute setting. `FootballCoordinator` skipped playable candidates both when it queued probes and when it admitted them. Discovery and failed-feed retries continued, but idle working routes never received another media check.

Working routes now enter the existing bounded queue when their proof reaches the saved interval. Working rechecks and failed retries share maintenance priority and due-time ordering. A pending or deferred recheck retains playable proof. A conclusive failure removes durable aliases and starts automatic retry. Newer decoded playback evidence cancels obsolete work. Rechecks also cover proof that could not be persisted. Current game identity, fresh schedules, and the today, tomorrow, and live window remain admission requirements; final games receive no new checks.

Regression commits `b1d1521` and `9cd119b` precede the production fix. Nine new cases cover due checks, non-durable proof, failure and recovery, deferral, decoded evidence, interval changes and restart, a full maintenance queue, and finished games. Existing tests were updated where they explicitly expected the old permanent exemption. The combined follow-up run passed all 528 applicable tests. Full ESLint, TypeScript, and the production build passed. Reproduce the suite with `node --experimental-strip-types --test --test-skip-pattern 'a packaged build produces an update record and installer without a blockmap' tests/*.test.ts`; the installer exclusion above still applies.

Before restart, an ordinary close removed all 11 recorded app-owned processes. The updated app started after zero active app processes and returned visible and focused native state. With no manual retry or interval change, all three retained aged Sportsurge routes received newer checks: one remained playable and two became unavailable. Two old TVApp candidates were absent from the refreshed inventory and are not counted as recheck evidence. The Sources screenshot confirms the updated explanation and unchanged five-minute setting. Local evidence is under `.desktop-runtime/working-rechecks/`.

The interval controls eligibility, not a guaranteed completion deadline. Initial discovery, provider cooldowns, and the existing four-slot limit can delay checks. This fix reuses that resource budget and adds no timer, setting, or public API.

## Follow-up: retain working player choices

A working alternative for an upcoming game could disappear when its listing expired if the locator was not persistable or its cache write failed. Runtime retention depended on a durable row, while the live-only exception excluded scheduled games. The selected route stayed pinned, which hid the loss of other choices.

Positive runtime proof now carries its captured matchup owner independently of persistence. Candidate projection, inventory, and player session replies retain that proof through discovery refreshes and queued, active, or deferred rechecks. A confirmed negative removes playable status before cache deletion. Probe admission and session selection capture ownership so late evidence for an old matchup cannot replace proof for a new matchup with the same game ID. Explicit source-page reassignment revokes the old game's proof, jobs, durable aliases, and session token. Sportsurge enforces that assignment on every reconciliation, including refresh or replay while replacement details are pending. Missing listings retain proof. Sportsurge discovery and reassignment use the same domain route identity, preserving distinct event URLs that share an event ID. Ownership stays private; public availability and the stored schema retain their existing shapes. Source, locator, game window, and final cleanup checks still apply.

Root reproduced eight retention failures and three cache-write or ownership failures before the production change. Regression commits `51eaa51` and `197f3b0` precede the fix. Independent review then reproduced explicit catalog reassignment; root committed its failing test as `28c2681`. Root also reproduced prior details republishing the old game during a new pending-detail run and committed `8d60d28` before correcting that boundary. All 548 applicable tests passed. After consolidating the unchanged route identity calculation in its domain helper, all 46 focused cases passed, as did full ESLint, TypeScript, and the production build. Independent final review approved the exact final patch and reran 29 recheck and reassignment cases. The negative-control viewer opens just before its recheck so its lease remains current. The previously documented installer exclusion still applies.

Every restart followed a zero-active-process check. The final close requested ordinary shutdown and then issued stops only after checking owned executable and process identity. Windows still lists one older network-process entry, but it reports `HasExited=true`; `taskkill` reports no running instance. This qualifies the earlier census wording that all entries were gone. The final app, PID 36292, returned visible, focused native state. Before final ownership refinements, Electron MCP inspected two enabled Sportsurge choices for Jacksonville State at Kennesaw State while playback advanced from 36 to 124 seconds. In the final build, Pixelwatch stayed selected and enabled as a working Aryawatch alternative appeared automatically. Video advanced from 25 to 99 seconds and decoded frames from 766 to 2,972. These real-player checks establish rendering and playback; controlled coordinator regressions establish retention when publication or cache writes fail. Evidence is under `.desktop-runtime/selection-retention/`.
