# Performance and playback follow-up, October 18, 2026

This pass continues the measured worker audit and adds recovery for reproduced pause and freeze cases. Changes stay in the main checkout. No schema migration, production action, commit, or pull request was performed.

## Fewer collection history reads

Restored detail publication now builds its matcher and deadlines from the attempts and observations already captured for that synchronous pass. The rollover regression previously read attempts 43 times while restoring 32 feeds. It now reads attempts twice and observations three times across the whole constructor, including rebuild work outside detail publication. All 32 candidate IDs remain present. The 75 related tests and four existing planning/scaling tests passed.

The store now caches only the validated latest attempt for each source. Local listing/catalog writes and history sweeps invalidate after commit. SQLite data_version detects commits from other connections. Failed transactions preserve committed values. Each return is a separate structured clone. The retained-history query, malformed-row fallback, payload timestamp precedence, duplicate-key handling, and legacy normalization remain unchanged.

A replay compared the preserved ad23cb03 build with current code using separate identical temporary databases. It alternated nine pairs, excluding the first warmup pair. Forty unchanged reads over 2,048 retained rows and eight sources had conventional median batch times of 94.36 ms before and 3.48 ms after. Payload decodes fell from 320 to eight. Complete output hashes matched in every pair. These are batch measurements on unchanged data, not API or whole-app latency claims. Windows CPU accounting was too coarse to report a percentage. Catalog commits and sweeps invalidate the cache, so write-heavy workloads receive less reuse.

## Playback recovers when the feed stops

The user reported feeds stopping while the room was untouched and staying stopped until another feed was selected. Live observation did not catch a spontaneous incident. A reversible simulation in the actual compiled Electron feed reproduced one concrete failure: video stayed paused for six seconds while the app still requested playback. The original trigger of the spontaneous pause remains unconfirmed.

Direct playback now retries an unsolicited pause after a short delay while playback is still requested. Pending recovery cancels on explicit Pause, unmount, or a hidden room. Returning to the visible room can resume it. Picture-in-picture pause remains authoritative. The original live reproduction passed after the first rebuild.

Embedded playback also reconciles an unsolicited pause and retries an interrupted play request. It preserves explicit commands, ended media, and picture-in-picture intent. Independent review found a PiP exit race before a delayed renderer acknowledgment. Moving ownership capture into the shared presentation publisher fixed both control and polling paths. Its regression failed before the correction and passed afterward.

The existing direct stall check now requires presented frames as well as media-time advancement. A media clock that keeps advancing cannot hide frozen video. The actual GamePlayer Electron regression failed with a frozen frame counter before the change and passed afterward. It also covers explicit Pause, cancelled recovery, visibility, and the PiP event contract. The PiP event test simulates the document state; it does not establish native operating-system PiP behavior.

Embedded viewers now track progress after startup proof. Fifteen seconds without media and frame progress reports one upstream failure and disposes the player through the existing recovery owner. This includes persistent buffering and rejected resume requests. It does not launch an independent replacement. Hidden views, explicit pauses, seeking, ended media, PiP ownership, clock rollback, and sampler gaps reset or suspend that window. Startup proof requirements and the separate verification cutoff remain unchanged. The real native Electron fixture reproduced the missing failure before implementation. Final compiled verification is recorded below.

## Scope and evidence

Evidence is under .scratch/performance/autopilot-2026-10-18/. The canonical append-only log remains .scratch/performance/pipeline-2026-10-18/decisions.tsv.

The post-projection trace sampled 7.11 seconds of football-worker activity with 4.47 seconds idle. Source attempts still accounted for about 430 ms inclusively, supporting the cache experiment. Workloads differ from earlier traces, so this is not a controlled speed comparison. Its temporary inspector closed successfully.

Scratch probes found quadratic candidate-map copying and duplicate matching. Those changes were deferred because the fresh trace did not establish enough remaining detail-publication cost to justify a larger refactor. No adaptive verification cap or new ranking policy was added.

Laziness Protocol kept the publication change local. Model the Domain kept playback intent separate from observed progress. Build the Lever produced repeatable Electron regressions and preserved-build comparisons. Sequence Work into Verifiable Units kept each change behind failing and passing checks.

Independent same-family reviewers checked cache invalidation and playback races. Configured other-provider reviewers were unavailable. Review found no remaining blocking source defect. The final verification below passed.

## Final verification

The complete suite passed with four file workers: 1,661 passed, one skipped, zero failed in 86.18 seconds. The command was node --experimental-strip-types --test --test-concurrency=4 tests/*.test.ts. Final npm run typecheck, npm run lint, and the CRLF-aware git diff --check all passed.

The final native Electron fixture resumed an unsolicited pause after one interrupted play request, preserved explicit Pause, and proved video before simulating a freeze. It reported exactly one upstream failure after 15,112 ms and disposed the frozen view. It allocated no independent replacement. Final direct GamePlayer checks passed unexpected-pause recovery, explicit Pause, cancellation of pending recovery, visibility recovery, the PiP event contract, and frame-freeze detection.

Compiled room navigation and Sources passed with no renderer exceptions or saved-preference changes. The final Sources panel showed 28 of 28 NHL sources. The watch room was ready with two tiles and its dialog closed.

Electron runs build 9dc3f0cf-91b7-4a8e-b3dc-04c4ad6eaf92, with source fingerprint 41341a55554b56d1fc333479e752c1a602dce383af83d07869f4885a28433486. The final check compared the actual build fingerprint with current source using the Electron runtime. Main PID 89020 and server PID 92028 were running at handoff, with one local app instance. Both temporary profiling listeners closed. The normal development debugging endpoints remain available.

The final football-worker trace sampled 7.21 seconds with 4.77 seconds idle. Source attempts occupied about 6 ms inclusively. This supports the cache removing a repeated-work hotspot in that capture, but different collector workloads prevent a controlled live speed claim. Games and source responses were successful, with headers ranging roughly 218 to 647 ms. Unauthenticated readiness-route requests returned 404 in 2 to 8 ms; they were not successful health checks. Matching and detail-evidence decoding still consume time. No further change had a demonstrated benefit sufficient to justify expanding this pass.

Final evidence includes tests-final.log, typecheck-final.log, lint-final.log, native-freeze-electron-green.log, direct-playback-final.log, final-navigation.json, final-sources.json, final-app-check.json, and profile-final/ under the run directory. The audit correction in the canonical log points to pause-reproduction-red.log because the later green run replaced the original JSON reproduction file.

## Attention

Review used available Codex agents from the same model family. The configured other-provider reviewers could not run. Review caught and corrected the PiP exit race and the overwritten red-evidence pointer. The original spontaneous pause trigger remains unconfirmed. Recovery for the reproduced cases is verified; this report does not claim every upstream interruption is eliminated.
