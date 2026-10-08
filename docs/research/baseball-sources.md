# Baseball sources

Public responses checked on October 8, 2026, at 05:17 UTC. This audit records listings and published player routes. It does not establish that live media plays.

## MLB schedule

The [ESPN MLB scoreboard for October 8](https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261008) returned HTTP 200. Its event `401907993` is Cleveland Guardians at Chicago White Sox, scheduled for `2026-10-09T00:00Z`.

TVApp, PPV, and Streamcenter list that matchup at `2026-10-08T21:00Z`. Streamcenter includes the same ESPN event ID. The three-hour difference is within the existing matcher's tolerance. ESPN remains the schedule authority.

## Existing providers

| Provider | Verified listing | Observed data |
| --- | --- | --- |
| TVApp | [Baseball catalog](https://api-backups.handleapi.win/matches/sport/baseball) | Three rows with category `baseball`. IDs include `san-diego-padres-vs-milwaukee-brewers-2615996` and `ppv-cleveland-guardians-vs-chicago-white-sox`. The latter watch page exists at `/watch/ppv-cleveland-guardians-vs-chicago-white-sox`. |
| PPV | [Streams API](https://api.ppv.st/api/streams) | Category `Baseball`, category ID `36`, and tag `MLB`. The Cleveland game uses `mlb/2026-10-08/cle-chw` and publishes `https://embedindia.st/embed/mlb/2026-10-08/cle-chw`. |
| Streamcenter | [Baseball cards](https://streamcenter.st/game-cards/embed?sport=baseball) | Cards have the league label `MLB`. The Cleveland link is `/api/stream-link/iframe/event-espn-league-baseball-mlb-401907993/b953ed0c-6da3-4d0a-ae35-7e7db3e8072e`. |
| Methstreams | [MLB page](https://methstreams.st/MLB) | The section ID is `g-cat-mlb-20261008`. Event anchors provide `data-start` and structured team names. The sampled event is Milwaukee Brewers vs San Diego Padres. |
| Crackstreams | [MLB page](https://crackstreams.st/MLB) | The same section shape and matchup, with `/event/m-milwaukee-brewers-vs-san-diego-padres-nlds-game-4-1008`. |
| Buffstream | [MLB listing](https://ms.buffstream.io/mlb-streams-live-29) | The homepage publishes this catalog route. Paired team links use `/mlb-streams/<team>-live-stream`. Date and Eastern time appear in separate `h4` elements. |
| Strikeout | [MLB page](https://strikeout.im/mlb) | Includes `/mlb/stream-san-diego-padres-vs-milwaukee-brewers-live` and a separate MLB Network channel. The matchup detail publishes `event_start_ts` in `siteConfig`. |
| Sportsurge | [MLB listing](https://isportsurge.ws/mlb/livestreams2) | The index publishes this route. Playoff links use `/watch/mlb-playoffs/<matchup>/<numeric ID>`. The Cleveland detail supplies `2026-10-08 17:00ET`. |
| VIPBox | [Homepage](https://vipbox.fm/) | Baseball links to `https://mlbbox.me`. The guessed `/baseball-schedule` route returns HTTP 404. |
| MLBBox | [MLB listing](https://mlbbox.me/mlb-streams) | Reached through VIPBox. Event routes use `/mlb/<matchup>-stream`. The sampled detail uses the same `siteConfig` metadata as VIPBox and publishes an Embedsports baseball embed in a textarea. |

## Player and matching evidence

Streamcenter's Cleveland link redirects to `https://streame.center/embed/ch15.php`. That page includes `//streame.center/embed/hls.php?stream=dazhfiach15`.

Buffstream's Cleveland detail publishes `https://embedsports.me/baseball/chicago-white-sox-vs-cleveland-guardians-stream-2`. Its canonical URL uses HTTP although the page responds over HTTPS. The catalog dates the matchup October 7 at 4 p.m. Eastern. That stale listing must not attach to the October 8 schedule game.

Sportsurge's Cleveland detail includes an iframe whose URL ends with `/new-stream-embed/` and lacks a player ID. That response supplies a listing, but no usable Gooz player.

MLBBox's sampled Padres detail has the heading `MLB Live: San Diego Padres vs Milwaukee Brewers Online`. Its `siteConfig` declares `loaded_page` as `stream` and `event_start_ts` as `1791424800`. The published textarea embed is `https://embedsports.me/baseball/san-diego-padres-vs-milwaukee-brewers-stream-1`.

## Unavailable responses

The Sportsurge v2 homepage returned HTTP 403. The StreamEast homepage returned HTTP 429. LiveTV's upcoming-events request failed before a response arrived. This audit establishes no MLB event or player routes for those collectors.

The existing NFLStreams catalog targets football. SWAC TV's existing adapter filters football events. This audit establishes no MLB coverage for either source.

## Local evidence

Response bodies are in `.scratch/mlb/source-audit/`. `manifest.json` records the audit time, file sizes, and SHA-256 hashes.
