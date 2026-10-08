# Hockey sources

Public responses checked on October 8, 2026, at 04:40 UTC. Listings and player availability change throughout the day.

## Schedules

The ESPN scoreboard endpoints returned HTTP 200 with real scheduled games. All three use the shared schedule adapter and its seven-day horizon.

| League | ESPN scoreboard |
| --- | --- |
| NHL | [hockey/nhl](https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard) |
| NCAA Hockey, men | [hockey/mens-college-hockey](https://site.api.espn.com/apis/site/v2/sports/hockey/mens-college-hockey/scoreboard) |
| NCAA Women's Hockey | [hockey/womens-college-hockey](https://site.api.espn.com/apis/site/v2/sports/hockey/womens-college-hockey/scoreboard) |

## Existing providers

| Provider | Verified listing | Observed coverage and route |
| --- | --- | --- |
| TVApp | [Hockey catalog](https://api-backups.handleapi.win/matches/sport/hockey) | NHL and both NCAA leagues. College IDs start with `live_college_` or `live_ncaa-women_`. Watch pages use `/watch/<numeric suffix>`. |
| Methstreams | [NHL page](https://methstreams.st/NHL) | NHL and separate NCAA men's and women's sections. Section IDs contain `nhl`, `mens-college-hockey`, or `womens-college-hockey`. |
| Crackstreams | [NHL page](https://crackstreams.st/NHL) | The same three hockey sections, with relative `/event/` links. |
| PPV | [Streams API](https://api.ppv.st/api/streams) | `Ice Hockey` category and `NHL` tag. Game routes use `/live/nhl/<date>/<matchup>`. The NHL Network channel has no game start time. |
| Streamcenter | [Hockey cards](https://streamcenter.st/game-cards/embed?sport=hockey) | NHL cards. Links contain `event-espn-league-hockey-nhl-<ESPN ID>/<UUID>`. `sport=nhl` returns mixed sports. |
| Buffstream | [NHL listing](https://ms.buffstream.io/nhl-streams-live-29) | Paired team links under `/nhl-streams/`. The published player uses `embedsports.me/ice-hockey/<matchup>-stream-1` or `stream-2`. |
| VIPBox | [Hockey schedule](https://vipbox.fm/hockey-schedule) | NHL links use `/onair/nhl/` and published servers use `/live/nhl/`. Other hockey leagues use `/onair/hockey/` and must stay outside NHL matching. |
| Strikeout | [NHL listing](https://strikeout.im/nhl) | NHL event routes use `/nhl/stream-<matchup>-live`. Servers use `/nhl/<number>/<matchup>-stream`. |
| Sportsurge | [NHL listing](https://isportsurge.ws/nhl/livestreams3) | NHL links use `/watch/nhl/<matchup>/<numeric ID>`. The global index also includes NHL, but discovery fetches league pages explicitly. |

Methstreams and Crackstreams published NHL FXTrend server links. Their sampled NCAA event pages had valid matchup metadata but no server links yet. TVApp's sampled NCAA watch pages existed, while their `delta` stream endpoints returned empty arrays. These are source listings, not proof of playable media.

Sportsurge v2's NHL route returned HTTP 403 and StreamEast's NHL route returned HTTP 429 with browser challenges. Their browser collectors retain their existing coverage.

## Verification

`tests/nhl-support.test.ts` checks schedules, league identity, source parsing, matching, and player validation. `node tests/nhl.electron.mjs` checks real hockey schedules and source links in Electron, filters all three leagues, adds a game, checks source inventory, and decodes a local video through an NHL playback session.

The local response bodies and their hashes are in `.scratch/nhl/source-audit/`. Electron screenshots and its result are in `.scratch/nhl/` after the desktop check.
