# Catalogue browser memory

Sportsurge and StreamEast kept their final catalogue pages loaded during the refresh cooldown. The Rust collector does not own those Chromium renderers. Each desktop collector now destroys its BrowserWindow after the whole native sweep settles, before it admits another sweep. The collector retains its named Electron session. Its next sweep creates a fresh window with the same cookies.

Window release also runs after partial results, publication failure, and terminal stop. A stopped or aborted read cannot allocate another window. The refresh interval, rate-limit floor, navigation policy, native parser, and media-check concurrency stay unchanged.

## Measurement

A five-minute baseline completed on October 9, 2026. The final-code app copy entered desktop shutdown after about 280 seconds, before its five-minute sampler completed. The shutdown initiator was not established. That planned run is incomplete. The comparison below uses the complete first four minutes from each run and excludes the later shutdown samples.

Both sequential copies used fresh profiles and the same diagnostic hook. Archive comparison checked 273 files. The treatment changed only the two collector modules in addition to the identical main-process hook. The packaged Rust binary was identical in both runs.

The primary result is mean private memory in the two direct catalogue renderers during the last two minutes of those four-minute windows: **204.52 MiB before, 0 MiB after**. The baseline retained two catalogue windows. The treatment retained none. The sampler tracked process creation identities, including children of the app. Cleanup checks confirmed that all 89 baseline and 84 final-treatment process identities observed by the sampler exited.

| Owned app processes | Before | After |
| --- | ---: | ---: |
| Mean private memory | 1,401.94 MiB | 1,191.89 MiB |
| Peak sampled private memory | 1,984.90 MiB | 1,631.68 MiB |
| Mean process count | 15.08 | 13.14 |

The whole-app difference is observational. Main-window visibility varied, and the final live-source inventory was not captured before shutdown. An earlier completed treatment also had different listing and detail counts amid provider rate limits. These runs do not prove equal live-source coverage or a causal whole-app reduction. The 500 MB target remains unmet.

Private memory does not measure dedicated GPU memory. Earlier live snapshots found fresh decoded-video proof, but advancing video alone does not prove that a stream shows the requested game. The live women's hockey games still had incomplete feed listings. Those provider gaps are not resolved by this browser-lifetime change.

## Verification

The new lifecycle tests failed against the original collectors and passed with the fix. They cover whole-sweep reuse, release after success and failure, overlap, stop during pending renderer work, late callbacks, destroy reentry, and renderer loss. Existing cadence and rate-limit checks also pass.

Run the deterministic Electron lifecycle fixture from the repository root:

```powershell
node scripts/verify-catalog-browser-lifetime.mjs
```

The fixture supplies local HTML at each provider's actual category URL. It runs the original collectors with a two-read sweep stub. Both providers complete two sweeps with a fresh renderer for the second sweep. The renderer exits from Electron metrics and OS process checks after each release. The retained cookie exists in the session and is visible in the second renderer. This fixture proves browser lifetime and cookie continuity. It does not test native parsing or live provider challenges.

The app suite passed 805 tests. One installer-artifact test was skipped because `SUNDAY_ROOM_RELEASE_DIR` was unset. Scoped ESLint passed. The existing live-player driver also passed against the patched packaged executable with local HLS fixtures: video advances, pause retains position, resume returns near the live edge, and finite media stays at its selected position. This establishes decoded playback behavior, not playback of an external live game.

[Measurement evidence](catalog-browser-memory-evidence.json) contains the comparisons, archive provenance, lifecycle result, and cleanup records. Raw traces and test output remain local under `.desktop-runtime/memory-improvement/`; their hashes are included in the evidence file.
