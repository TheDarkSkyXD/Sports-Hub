# Confirmed playback and resource verification

## Root causes and behavior

Available previously accepted a media response or a single decoded frame. Neither establishes moving video. The original Electron reproduction found 131 Available feeds and no fresh advancing-playback proof. The checker now uses the same GamePlayer and relay as the viewer and requires at least two seconds of both elapsed observation and advancing media time, plus three presented frames. Proof expires after five minutes. Pauses, waits, seeks, frozen video, and discontinuous samples reset observation.

Two checks run concurrently in one hidden Electron window. Source capture closes before playback verification. Private verification sessions authorize playback before public availability exists and revoke access after completion or cancellation. Eight verification relay reads can hold bodies concurrently; ordinary viewing reads bypass that gate. This bounds checker work and avoids a verification admission deadlock. It does not impose a global Chromium process cap because source pages can create their own frames.

The room previously rendered every game card and kept a fast source poll for pending work anywhere in the snapshot. The resource change renders an initial 40 cards while retaining full-board search, counts, selection, and expansion. After startup, only actionable pending feeds on selected, non-final games request fast room polls. Source Settings mounts the inventory only on its selected tab. Sweeps retain pruning and cancellation but skip unchanged working-feed persistence.

## Original and fixed Electron reproduction

The strict check reads the live `/api/sources` response and requires at least one Available feed. An empty result is inconclusive, not a pass.

```text
{"games":89,"candidates":1174,"available":131,"playbackConfirmed":0,"availableWithoutPlayback":131}
FAIL: available feeds include media without fresh advancing playback
```

After the reviewed code was applied and the actual local Electron app restarted on October 8, 2026:

```text
{"games":81,"candidates":624,"available":2,"playbackConfirmed":2,"availableWithoutPlayback":0}
PASS: every available feed has fresh advancing playback
```

A later live response had six Available feeds, all with fresh advancing proof. These checks establish availability semantics on real providers at the observation time. They do not establish continuous service or a guarantee against later upstream buffering.

## Production native playback fixture

`npm run build` and `node scripts/prepare-desktop.mjs` passed in the physical workspace. The prepared standalone worker loaded all 47 sources and 14 league scopes and stopped cleanly.

An isolated adapter used production coordinator, streamIndex, and streamToken code with a temporary SQLite database and a generated HLS clip. The actual hidden Electron verifier loaded the production standalone Next page. Two checks ran together, a third was denied until a slot freed, a frozen feed was rejected, and an aborted verification lost token access. The production run returned:

```text
TWO_PROOFS [{"kind":"playable","proof":{"kind":"advancing-video","version":1,"startupMs":3055,"observedMs":2033,"mediaAdvanceMs":2000,"presentedFrames":49}},{"kind":"playable","proof":{"kind":"advancing-video","version":1,"startupMs":3030,"observedMs":2033,"mediaAdvanceMs":2042,"presentedFrames":50}}]
FROZEN {"kind":"unavailable"}
ABORT_REVOKE {"abortResult":{"kind":"deferred"},"tokenStatus":404}
SOURCES [{"id":"feed-1","availability":"playable"},{"id":"feed-2","availability":"playable"},{"id":"feed-3","availability":"unavailable"},{"id":"feed-4","availability":"checking"}]
STATS {"opens":4,"closed":1,"reads":29,"pending":0,"windows":1,"rendererPid":23772}
```

The Electron harness propagated a deliberately failed run as exit code 1. Fixture processes were stopped before the final resource sample. The fixture proves native decoding and lifecycle behavior with a controlled transport; the live Electron reproduction separately proves successful checks on real providers.

## Resource measurements and limits

The 407-game browser fixture measured 12,020 DOM nodes with every card expanded and 1,378 at the initial 40 cards, an 88.5 percent reduction. Search reached game 407 and expansion reached all cards. Six sweeps made 168 unchanged persistence calls before the change and zero after, with identical persisted rows and public snapshots. The short replay had variable timing and no stable CPU improvement.

The resource-only native comparison used zero room streams in the same long-lived development-mode process tree. The old layout had 12,267 DOM nodes and the new layout had 1,345, an 89.0 percent reduction. Over approximately one minute per sample, CPU fell from 99.49 to 85.38 percent of one core. Mean private memory rose from 3,295.39 to 3,507.33 MiB, and mean process count rose from 23.81 to 36.57. Dynamic source browsing and changing process lifetimes make this a noisy observation. The results establish less rendered work, not a general reduction in memory or processes.

Two earlier samples with two active room videos measured 169.21 and 115.09 percent of one core without a code change. Those games finished and naturally expired under the user's five-minute retention preference before a matching post-change sample. Comparing those video samples with an empty room would misstate the benefit. The latest 166-byte saved room was captured immediately before the final restart and remained byte-for-byte equal after it.

The final combined checker sample ran after six minutes of warmup in the restarted development-mode Electron app, with no room videos and automatic collection still active. Over 61.23 seconds it measured 22.02 percent of one core, or 1.38 percent of the 16-logical-processor machine. Mean private memory was 2,016.97 MiB with a 2,206.58 MiB peak. Mean process count was 15.8 with a peak of 20. The adjacent room had 40 cards and 1,341 DOM nodes, and the saved room still matched its pre-restart value.

Compared with the long-lived zero-stream baseline, these observations are 99.49 to 22.02 percent of one core, 3,295.39 to 2,016.97 MiB mean private memory, and 23.81 to 15.8 mean processes. The app restart, different uptime, provider responses, and additional playback verification all changed between these samples. These are operating measurements, not a controlled estimate of the patch's CPU, memory, or process benefit. The resource-only same-process comparison above remains the narrower comparison and showed increased memory and processes. Site frames can still create transient processes even with two logical checker slots.

The final sample spans 02:46:50 to 02:47:49 UTC. Its raw artifact is `.desktop-runtime/native-resources-confirmed-playback-final-zero-stream.json`. The baseline artifacts are `.desktop-runtime/native-resources-resource-ui-zero-stream-baseline.json` and `.desktop-runtime/native-resources-resource-ui-zero-stream-after.json` in the physical workspace. The measurement follows descendant PIDs every two seconds, sums private memory rather than shared working sets, and counts CPU deltas only after a process has first been seen. CPU from short-lived processes can therefore be missed.

## Final native refresh cycle

The restarted development-mode Electron app was observed for 36 samples from 02:40:46 to 02:46:43 UTC on October 9, 2026. All samples had zero schedule warnings and request errors, all 47 registered sources, and distinct LiveSportPro listing URLs. Peak active media checks were two. The maximum Board response was 318 ms and the maximum Sources response was 449 ms, both below the 3,000 ms gate. The root renderer recorded zero console errors.

Fresh proof expired during this interval and rechecks published renewed proof. After the cycle, the strict live check returned:

```text
{"games":80,"candidates":712,"available":13,"playbackConfirmed":13,"availableWithoutPlayback":0}
PASS: every available feed has fresh advancing playback
```

This approximately six-minute run covers an automatic five-minute cycle. It does not predict behavior over days or guarantee every upstream provider remains reachable. The raw interval record is `.desktop-runtime/runtime-after-fixes-1791513646455.json` in the physical workspace.

## Other checks

The clean combined tree passed 768 tests, with zero failures and one skip. Typecheck and lint passed. Browser fixtures passed for Settings lifecycle, card expansion/search/drag, selected-game poll cadence, and six player quality scenarios. An independent reviewer passed 88 focused tests and additional lifecycle, proof-expiry, alias, relay-abort, and native-host checks, with no remaining blocking findings.

Browser-only operation without the native observer cannot automatically produce this playback proof. Existing weak saved proofs remain route hints and require verification before they become Available. A healthy foreground viewer renews evidence every minute. Five-minute rechecks remain scheduled, but two checker slots cannot guarantee every discovered candidate completes within five minutes.

See [resource design and measurements](resource-footprint-decision.md) for the narrower resource changes.
