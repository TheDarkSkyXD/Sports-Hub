# Desktop restart memory

Ordinary local desktop launches now reuse a compiled server. `npm run desktop:dev` and `--dev` retain live development. A normal launch builds once when its source identity changes, then stops the compiler before it starts the standalone server.

The previous default retained Next development and its compilation workers while the app collected sources and checked playback. Content hashes include dirty and untracked runtime inputs. Each completed artifact has a payload inventory, source identity, and matching build IDs. Missing or corrupt completion metadata causes a rebuild. A failed build cannot replace the last completed artifact. Shadow build configuration preserves the checkout's TypeScript configuration.

## Native observations

The Windows measurement sums private bytes across the app's process tree every two seconds for one minute. The saved room has no selected video. Live source pages change between runs, so these observations do not isolate every contributor.

| Interval | Mean private memory | Peak private memory |
| --- | ---: | ---: |
| Development, after about three minutes | 2,280.15 MiB | 2,553.78 MiB |
| Compiled, after about three minutes | 1,813.36 MiB | 2,071.57 MiB |
| Compiled with bounded verification buffers, warm cached restart | 1,717.56 MiB | 2,108.65 MiB |
| Compiled with bounded verification buffers, first minute of cached restart | 1,973.54 MiB | 2,603.24 MiB |

The warm development and final compiled means differ by 562.59 MiB, or 24.7 percent. The cold peak still exceeds 2 GiB. This change removes the retained compiler and excessive verification buffers. It does not establish a total memory ceiling or a CPU improvement.

The remaining cold peak includes 21 renderer processes holding 1,374.93 MiB. A single source capture creates 38 to 45 frames across eight OS processes. Request ancestry identifies `https://embed.st/ad.html` as the parent of rotating advertising frames. Each catalog window has one frame. Closing idle catalog windows removed about 168 MiB from those renderers but increased the following whole-app mean, so that experiment did not earn a lifecycle change.

The separate [verification buffer measurement](verification-buffer-memory.md) records two advancing playback proofs with 10.8 MiB of media instead of 51.8 MiB. Viewer buffering and quality controls retain their existing behavior.

## Verification

The real Windows checkout built with Turbopack and launched its custom standalone artifact. An unchanged restart reused the same artifact and reached readiness in about 2.4 seconds without a compiler process. Its inventory contains 3,368 regular files and no links. The prepared worker also ran outside the checkout with 47 registered sources and 14 league scopes.

A six-minute native run recorded 36 successful board and source snapshots, no schedule warnings, and no request failures. The largest board request took 466 ms. The largest source request took 655 ms. Five Available choices had fresh advancing playback proof, and none lacked proof. The saved room remained byte-identical across restarts.

The test suite passed 777 tests with one existing skip. Type checking and lint passed. Twenty-four independent focused checks covered lifecycle, artifact validation, output tracing, and preparation. A real Windows failed-build fixture confirmed that shutdown killed the owned compiler child.

Raw process and frame traces remain under the ignored `.desktop-runtime` directory. They include private source request context and are not published. The [advertising-document follow-up](source-advertising-memory.md) records the remaining frame root cause, preserved playback, and a cached-restart peak of 1,789.98 MiB.
