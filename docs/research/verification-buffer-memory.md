# Verification player buffer measurement

The two-slot playback verifier needs two seconds of advancing video and three presented frames before it closes each player. Both verification jobs produced playable proof with a smaller HLS buffer. Viewing keeps its 45-second forward and 90-second back buffers.

I ran the native Electron verifier page against a local 35-second, 1920 × 1080, 30 fps HLS fixture encoded at 6 Mbps. Each run opened two independent verification slots. The server counted completed media responses. Electron `app.getAppMetrics()` and the page's video elements were sampled every 100 ms until both proofs finished. The first baseline included page compilation, so the warm baseline and second candidate are the comparison below.

| Measure | Warm baseline | Verification buffer | Change |
| --- | ---: | ---: | ---: |
| Playable proofs | 2 of 2 | 2 of 2 | Same |
| Media segment requests | 70 | 14 | 56 fewer |
| Media bytes | 51.8 MiB | 10.8 MiB | 41.0 MiB less |
| Maximum buffered time ahead | 34.5 s | 4.9 s | 29.6 s less |
| Peak sum of Electron process working sets | 799.8 MiB | 652.5 MiB | 147.3 MiB less |
| Peak verifier renderer working set | 385.6 MiB | 279.1 MiB | 106.5 MiB less |

An earlier baseline and candidate pair produced 51.8 MiB versus 11.6 MiB of media and 852.7 MiB versus 659.7 MiB peak Electron working set. The initial baseline's larger memory and duration included the first page compilation. The fixture is synthetic and the process totals exclude the Next server. These numbers show the buffer's effect on the native verifier, not total desktop memory under live providers.

The existing relay smoke flow also passed with the new buffer: two simultaneous playable proofs, a frozen source classified unavailable, cancellation classified deferred, a revoked media token returning 404, and the next queued source admitted after the first two slots closed. TypeScript checking, targeted ESLint, and the browser quality suite passed.
