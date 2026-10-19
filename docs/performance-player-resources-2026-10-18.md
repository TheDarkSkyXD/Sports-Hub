# Player resource use, October 18, 2026

This pass targets background work that competes with game playback and retained upstream media cache. It keeps viewing quality, HLS buffer settings, worker use, playback proof, and recovery behavior unchanged.

## Resource measurements

The first 30-second sample had two advancing direct videos. Their renderer averaged about 145 MiB of private memory with about 16 MiB of JavaScript heap. GPU, Network Service, and Browser processes accounted for more memory than the JavaScript heap. A separate 75.52-second process-tree capture found background bursts reaching 43 renderer processes and 4,275.71 MiB of total private memory, with a 2,540.99 MiB mean. These are observed workloads, not a memory ceiling or a leak diagnosis.

The app later disappeared. Its log contained a GPU-process exit and media-session cleanup timeouts before closure. The cause of the main app exit was not established. I reopened one local app.

A later renderer profile confirmed that HLS used its installed worker and observed zero evidence frame callbacks during that reporting interval. The NHL game had finished by the later capture, leaving one direct video. That changed workload prevents comparing late whole-app usage with the earlier two-video sample as a performance percentage.

## Transient relay sessions no longer keep an HTTP cache

Observed-media partitions previously used Chromium's default HTTP cache. A local HTTPS fixture ran the actual production relay factory and Electron network stack inside the existing app. It read the same cacheable 2 MiB media segment twice. Both bodies were exact, but the second read came from cache, and 2,098,291 cache bytes remained after lease release.

Session creation now passes cache:false. The failing-first boundary test and native fixture both pass. The native fixture returns the same two bodies, makes two upstream requests, and reports zero cache bytes before and after release. Cookie, referrer, range, and cleanup code stays unchanged. Twelve focused observed-media and wrapped-media tests, scoped lint, and typecheck passed.

This removes retained HTTP cache data. It does not shrink the player's playback buffer or establish a whole-app RAM or CPU percentage. Repeated requests for the same segment now require upstream traffic.

## Smaller check batches protect viewing sessions

The selected design limits new background verification admissions to four while a fresh, non-closed viewing session exists. It retains the full configured limit of sixteen when no viewing session exists, and preserves a smaller injected capacity. Existing jobs drain without cap-driven cancellation. The existing queue keeps first-attempt eligibility, priorities, and fairness. Diagnostics include the active drain, and their cache follows the effective admission limit.

The alternative would split resolution, browser acquisition, decoding, and asynchronous teardown into separate permit pools. That needs new progress and deadline rules because authorization starts before native playback and native release is asynchronous. The current task does not justify that added machinery.

A controlled native experiment ran twelve identical isolated 320 by 180 video jobs per batch. Every job had to advance at least two seconds and present at least three frames. Four rounds used limits eight, four, four, eight in the same Electron app, cleaning up only fixture windows.

| Concurrent fixture jobs | Peak fixture renderer private memory | Batch completion time |
| --- | --- | --- |
| Eight, first round | 232.23 MiB | 4.86 s |
| Four, second round | 122.43 MiB | 6.96 s |
| Four, third round | 121.38 MiB | 6.88 s |
| Eight, fourth round | 237.20 MiB | 6.61 s |

The mean peak across the two four-job rounds was about 48% lower. All jobs completed. Total renderer CPU stayed roughly 1.41 to 1.47 seconds per batch. Smaller batches spread similar CPU work over more time and delay background completion. These measurements exclude GPU, server, and other background processes. They do not establish whole-app energy savings or an end-to-end verification latency percentage.

## Verification

The complete Node suite passed with 1,685 tests and one skip. Full ESLint and TypeScript checks passed. Four new coordinator tests cover natural drain, closing and expiring viewing leases, all 32 distinct first attempts, diagnostic cache changes, and an injected capacity of two. The initial capacity and diagnostic tests failed before implementation; those terminal logs were not saved. The relay test's red and green logs are retained in cache-unit/.

Independent review compared the admission change against the previous compiled coordinator and found no material issues. The reviewer reran all four focused tests and checked the unchanged queue priorities, lease rules, natural drain, and refill paths.

Electron was rebuilt and restarted once for the final source. Build 23b54120-3757-4666-b9f7-917dd94a225a has source identity 0fbc214e232c105b1db62f514e54ca61f9108b83c0426c23efbaab70074e761f, which the final check matched using Electron's Node runtime. One local app remained running with main PID 25756 and its local server.

Actual Electron checks exercised Game schedule, Watch room, and Settings Sources. Saved room preferences stayed byte-for-byte identical. Sources showed 31 of 31 NFL sources; no renderer exceptions occurred during those flows. Returning to the room briefly admitted idle-capacity work before viewing resumed. Existing jobs drained naturally to four active checks and a reported limit of four, with four verifier assignments. The viewer continued advancing during this check.

The final 30.2-second sample had one 960 by 540 video. Media time advanced by 30.21 seconds and presented 1,811 frames, with zero dropped frames, pauses, or media errors. Its renderer averaged 114.78 MiB of private memory, the GPU process 335.32 MiB, and Network Service 41.75 MiB. JavaScript heap fell from 22.04 to 18.01 MiB over the sample. These are current process measurements, not comparable whole-app savings against the earlier two-video workload. The native relay fixture passed again after rebuild with two exact 2 MiB bodies and zero retained cache bytes.

## Limits and follow-up

The viewing budget gates new verification jobs. It does not cancel existing jobs, cap source collection, or promise that all Chromium child processes fit within four processes. Cold startup and a return from schedule navigation can temporarily retain the larger active batch while it drains. Hardware acceleration and video decoding were already enabled. This pass does not change video quality or claim lower total CPU work, a whole-app memory percentage, or a fix for the earlier unexplained app exit.

## Evidence and review

Evidence is under .scratch/performance/player-resources-2026-10-18/. Native cache red and green logs and JSON, cache-unit/, native-batches.json, the controlled comparison script, live-before-summary.json, tree-before.json, and renderer-before.json provide the measured inputs. The canonical append-only trail remains .scratch/performance/pipeline-2026-10-18/decisions.tsv.

Laziness Protocol kept cache retention at its session owner and viewing admission at the existing queue owner. Build the Lever produced rerunnable native comparisons. Type System Discipline kept the existing policy and session shapes. Independent reviews used the available Codex models; other provider families were disabled in the live catalog. No production action, migration, commit, or pull request was performed.
