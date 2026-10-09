# Advertising frames and playback

Source captures loaded `https://embed.st/ad.html`, which created the rotating advertising documents beneath both event and ingest pages. One capture reached 45 frames across eight OS processes. Blocking the shared advertising document removes its descendants without guessing their changing hostnames.

`isSourceAdvertisement` cancels only HTTPS, default-port `embed.st/ad.html` subframe requests. The existing observer listener runs its security, selected-player, navigation, and request-budget checks first. Canceled advertisements never acquire media evidence ownership. Player, ingest, challenge, and media requests retain their existing admission rules. The policy adds no dependency, filter download, process, or session. All intentional frame limits and both media-check slots remain intact.

The exact document also appears in [EasyList](https://easylist.to/easylist/easylist.txt). Request ancestry and native experiments established its role in this app. This policy covers that proven advertising document. It does not claim to classify every advertisement on every provider.

## Native comparisons

Four alternating fresh Electron runs used the real observer, the same two live source URLs, equivalent fresh profiles, and 30-second intervals. Every run had two simultaneous captures.

| Measure | Baseline A1 | Block B2 | Baseline A3 | Block B4 |
| --- | ---: | ---: | ---: | ---: |
| Peak frames | 60 | 12 | 60 | 12 |
| Peak processes | 16 | 10 | 19 | 10 |
| Peak private memory | 884.49 MiB | 523.14 MiB | 1,023.89 MiB | 535.54 MiB |

Both live sources failed capture in all variants. These runs prove lower frame and memory costs, not live playback preservation.

The normal compiled app's first minute after a cached restart averaged 1,455.52 MiB and peaked at 1,789.98 MiB of process-tree private memory. The earlier cached restart averaged 1,973.54 MiB and peaked at 2,603.24 MiB. The observed peak fell 31.2 percent, and peak process count fell from 28 to 18. Live provider work varies, so this observation does not impose a memory ceiling or establish a CPU improvement.

## Playback verification

A controlled native HTTPS fixture exercised the frozen production observer with two concurrent players. Both baseline and candidate captured both players and replayed both HLS playlists and media segments. All cookie and full-referrer checks passed. Before capture, each player advanced at least two seconds of wall and media time and presented 48 to 49 decoded frames. The production guard canceled all 40 advertising-document requests. Peak fixture frames fell from 84 to 44. The remaining blank iframe nodes do not load advertising documents.

The real app produced fresh advancing-video proof for both a Streamed NBA feed and a Streamed NHL feed. The NHL foreground viewer advanced 2.51 seconds and rendered 146 more frames over the same observation. It remained playing with readyState 4 and no media error. Removing the test game restored the saved room byte for byte. The final check found 11 Available choices with fresh advancing proof and none unconfirmed.

A six-minute native refresh check passed 36 snapshots across 47 sources and 14 league scopes. It recorded no schedule warnings, request failures, or requests above three seconds. The largest board and source requests took 177 ms and 815 ms.

The suite passed 779 tests with one existing skip. Type checking and lint passed. Independent review passed 28 observer, selected-player, outcome, and media fixtures. Native experiment processes exited and the local fixture listener closed. The normal app remains open without instrumentation.

Raw measurements and rerunnable native instruments remain in the ignored `.desktop-runtime` directories. They are local verification artifacts. They are not an additional production pipeline.
