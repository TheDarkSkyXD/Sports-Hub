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
