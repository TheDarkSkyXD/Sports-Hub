# Football source audit on October 5, 2026

All 19 registered sources were checked for catalog parsing, game identity, player extraction, and the latest available playback results. The production fixes are loaded in the open Electron app.

Today's NFL game is Atlanta Falcons at New Orleans Saints, ESPN ID `401872979`. Kickoff is October 5 at 7:15 p.m. America/Chicago. Tomorrow's college game is Southern Miss at Troy, ESPN ID `ncaaf-401871090`.

The app snapshot at 23:20 UTC has 28 verified working choices for Falcons at Saints across five sources. Three additional candidates are still checking. Tomorrow's two published candidates failed their latest media checks. These counts describe this snapshot, not a promise that an external stream stays online.

| Source | Catalog and matching result | Playback result or remaining limit |
| --- | --- | --- |
| Sportsurge legacy | Matches today's NFL game and extracts all five published HTTPS players. | Five working choices. |
| Crackstreams college | Parses the catalog. Its dated games are from October 3. | No verified match in today's or tomorrow's window. |
| Buffstream college | Parses 144 links, including duplicate matchup routes. The listing has no dates. | No verified current matchup. |
| LiveTV | Matches today's NFL game. Eight players appeared during the audit and were collected automatically. | Eight working choices. |
| VIPBox college | Fixed recognition of the canonical site's explicit empty schedule. | No published college games on this schedule. |
| VIPBox NFL | Matches the standard and Peyton/Eli broadcasts. Fixed the broadcast prefix being treated as a team name. | Seven candidates failed their latest playback checks. |
| VIPBoxTV college | Recognizes the published empty schedule. | No published college games. |
| Strikeout NFL | Matches the standard and Peyton/Eli broadcasts after the prefix fix. | Seven candidates failed their latest playback checks. |
| Strikeout college | Parses Southern Miss versus Troy and extracts three player routes. | The short name Troy matches both Trojans and Vikings in the team catalog. The source lacks a full identifier, so the app does not attach an uncertain feed. |
| NFLStreams | Matches today's NFL game. Fixed an accidental 22-character limit that rejected all six Saints player identifiers. | Two working choices. Four other links failed their latest playback checks. |
| StreamEast | Matches today's NFL game. A player appeared during the audit and was collected automatically. | One working choice. |
| Buffstream NFL | Parses the matchup pages and player links. Kickoff includes a time but no date. | The app cannot verify the date before its existing near-kickoff admission window. |
| Methstreams | Matches today's NFL game and tomorrow's college game. Extracts all 12 NFL routes and one college route. | Latest checks failed. The post-countdown NFL routes include an unresolvable embed domain and a custom WebSocket transport that the current HTTP media player cannot load. |
| Crackstreams ST | Matches the same two games and extracts their published routes. | Shares the Methstreams embed destinations and transport limits. |
| TVApp | Fixed a standalone ManningCast broadcast aborting the entire catalog. The saved catalog now produces 65 game observations and today's matched NFL player. | The published NFL candidate failed its latest playback check. |
| PPV | Parses the catalog and verifies today's NFL matchup. | The published candidate failed its latest playback check. |
| Streamcenter | Parses the currently empty catalog. | No published event cards. |
| Sportsurge v2 | Matches today's NFL game. Collects all 28 HTTPS provider rows. Two HTTP rows are excluded by the existing policy. | Twelve working choices, 13 failed checks, and three checks in progress. |
| SWAC TV | Parses five free events and verifies their game identities. Their games are on October 10. | No games in the current check window. |

The retry interval is restored to five minutes. The existing settings retain working proof, retry failed candidates automatically, and stop checks when a game finishes. The user's finished-game retention preference remains 30 minutes.

The four fixes have regression tests reproduced before the production changes. The final run passes 430 tests. ESLint and the production build pass. The pre-existing packaged-installer check is excluded because the local installer version is 1.0.6 and the project version is 1.0.10.

`scripts/audit-source-health.mjs` reads the running app without modifying it. It validates both API snapshots and reports every registered source, eligible game, match count, and playback state. The local audit captures are retained in `.desktop-runtime/all-source-health-before.json`, `.desktop-runtime/all-source-health-after.json`, and the three `.desktop-runtime/audit-*` directories. Captures are local because provider pages may contain temporary tokens.

To repeat the app snapshot, supply its actual loopback origin.

```powershell
node --experimental-strip-types scripts/audit-source-health.mjs --origin=http://127.0.0.1:51931
```
