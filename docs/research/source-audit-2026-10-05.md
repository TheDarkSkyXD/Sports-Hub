# Football source audit on October 5, 2026

All 19 registered sources were checked for catalog parsing, game identity, player extraction, and the latest available playback results. The production fixes are loaded in the open Electron app.

Today's NFL game is Atlanta Falcons at New Orleans Saints, ESPN ID `401872979`. Kickoff is October 5 at 7:15 p.m. America/Chicago. Tomorrow's college game is Southern Miss at Troy, ESPN ID `ncaaf-401871090`.

The app snapshot at October 6, 00:29 UTC has 79 verified working choices for Falcons at Saints across twelve sources. Four candidates are still checking. Tomorrow's two published candidates failed their latest media checks. These counts describe this snapshot, not a promise that an external stream stays online. The earlier October 5, 23:20 UTC snapshot had 28 working choices.

| Source | Catalog and matching result | Playback result or remaining limit |
| --- | --- | --- |
| Sportsurge legacy | Matches today's NFL game and extracts all five published HTTPS players. | Five working choices. |
| Crackstreams college | Parses the catalog. Its dated games are from October 3. | No verified match in today's or tomorrow's window. |
| Buffstream college | Parses 144 links, including duplicate matchup routes. The listing has no dates. | No verified current matchup. |
| LiveTV | Matches today's NFL game. Eight players appeared during the audit and were collected automatically. | Eight working choices. |
| VIPBox college | Fixed recognition of the canonical site's explicit empty schedule. | No published college games on this schedule. |
| VIPBox NFL | Matches the standard and Peyton/Eli broadcasts. Fixed the broadcast prefix being treated as a team name. | All seven published choices have media proof. A selected HD feed also played in the main app. |
| VIPBoxTV college | Recognizes the published empty schedule. | No published college games. |
| Strikeout NFL | Matches the standard and Peyton/Eli broadcasts after the prefix fix. | All seven published choices have media proof. |
| Strikeout college | Parses Southern Miss versus Troy and extracts three player routes. | The short name Troy matches both Trojans and Vikings in the team catalog. The source lacks a full identifier, so the app does not attach an uncertain feed. |
| NFLStreams | Matches today's NFL game. Fixed an accidental 22-character limit that rejected all six Saints player identifiers. | Five working choices. One other link failed its latest playback check. |
| StreamEast | Matches today's NFL game. A player appeared during the audit and was collected automatically. | One working choice. |
| Buffstream NFL | Parses the matchup pages and player links. Kickoff includes a time but no date. | Two candidates are checking after admission within the existing near-kickoff window. |
| Methstreams | Matches today's NFL game and tomorrow's college game. Extracts all 12 NFL routes and one college route. | Six working choices in this snapshot. Main 1's sustained playback defect is described below. |
| Crackstreams ST | Matches the same two games and extracts their published routes. | Six working choices. Shares the Methstreams embed destinations. |
| TVApp | Fixed a standalone ManningCast broadcast aborting the catalog. The current catalog produces 66 game observations. Ten distinct non-PPV players are collected for today's game. | Seven working choices, three failed checks, and one check in progress, including the retained watch-page candidate. Golf/2 decoded frames advanced across a 103-second observation in the main app. |
| PPV | Parses the catalog and verifies today's NFL matchup. | One choice has media proof. The ordinary page check did not establish decoded video. |
| Streamcenter | Parses the currently empty catalog. | No published event cards. |
| Sportsurge v2 | Matches today's NFL game. Collects every published HTTPS provider row. Two HTTP rows are excluded by the existing policy. | Twenty-six working choices, two failed checks, and one check in progress. |
| SWAC TV | Parses five free events and verifies their game identities. Their games are on October 10. | No games in the current check window. |

The retry interval is restored to five minutes. The existing settings retain working proof, retry failed candidates automatically, and stop checks when a game finishes. The user's finished-game retention preference remains 30 minutes.

The initial source fixes and subsequent retry, player-activation, TVApp-choice, and Main 1 changes have regressions reproduced before production fixes. The final applicable suite passes 443 tests. ESLint, TypeScript, and the production build pass. The pre-existing packaged-installer check is excluded because the local installer version is 1.0.6 and the project version is 1.0.10; this task does not rebuild that installer. An earlier unrestricted run reproduced that mismatch.

`scripts/audit-source-health.mjs` reads the running app without modifying it. It validates both API snapshots and reports every registered source, eligible game, match count, and playback state. The local audit captures are retained in `.desktop-runtime/all-source-health-before.json`, `.desktop-runtime/all-source-health-after.json`, and the three `.desktop-runtime/audit-*` directories. Captures are local because provider pages may contain temporary tokens.

To repeat the app snapshot, supply its actual loopback origin.

```powershell
node --experimental-strip-types scripts/audit-source-health.mjs --origin=http://127.0.0.1:51931
```

## Follow-up on the reported unavailable feeds

The user reported 60 unavailable or checking choices across eight source families. Comparing the actual source players with the app found a local network blocker and separate app defects. The earlier failed checks did not establish that those source feeds were offline.

At the user's request, Portmaster's core service was stopped and disabled, and its Windows startup value was removed. A separate OS check confirmed no Portmaster processes remained. Before this change, `embed.st` and `embedindia.st` resolved to Portmaster sinkhole addresses. Afterward, they resolved to public addresses. With the saved five-minute interval unchanged and no manual retry, the app recovered from 28 to 53 working choices, then reached 59 during the next automatic checks.

All fourteen reported VIPBox and Strikeout choices played on their source websites after Portmaster stopped. Each advanced roughly ten seconds and decoded more than 100 frames. The app observer still failed because it never activated their published SD0 Play control. The fix targets one visible paused video and its unique Play control under the verified source player. The same observer probe changed from a 20-second failure to supported media in about four seconds. The Peyton/Eli alternate also passed.

Methstreams and Crackstreams Main 1 use a virtual playlist in their browser player. Their published HTML also contains current HLS renditions with ordinary HTTPS segments. The new adapter reads those bounded snapshots, refreshes each rendition, and retains the existing public DNS and media request guards. The app's selected `/main/1` URL publishes the base event URL as its canonical. The adapter now validates that relationship instead of requiring identical paths. The exact persisted game locator passed the media probe in 2.6 seconds. Three earlier live reads advanced playlist sequences and returned valid MPEG-TS bytes.

Concurrent playlist refreshes must not retarget an already issued segment token. The relay now includes the child's resource identity in that token's lookup key. Regression coverage verifies overlapping snapshots and preserves both old and fresh signed resource destinations. The first adapter version also fingerprinted the whole rendition in its identity. Real app instrumentation showed that this changed overlapping segment paths on every refresh, causing HLS media-sequence errors and a fatal reset after 51 seconds. Rendition identity must remain stable while the live sequence advances.

TVApp's watch page publishes eleven buttons, including its PPV backup. Its catalog and stream APIs publish ten distinct non-PPV source tuples. The old adapter collapsed those choices into one watch-page candidate. The new source locators identify each published tuple without persisting an embed URL. Opening a locator revalidates the current game, kickoff, source membership, and stream API response. A separate ordinary browser check proved the golf/2 source played.

TVApp discovery and playback share normalized catalog identity validation. A failed stream API prevents an incomplete source list from being cached as complete. Cancellation is checked again before saving detail evidence. The observer's higher frame limit applies only to exact TVApp embed routes. The actual app database records ten resolved players. The main app kept golf/2 selected for 150.5 seconds. Two playback samples 103.5 seconds apart both had readyState 4 at 1280 by 720, with decoded frames increasing from 2,592 to 8,905.

The coordinator previously skipped detail discovery forever once all existing feeds had working proof. It now repeats discovery after the selected interval, allowing newly published players to appear. A regression starts with one working feed, publishes another, and verifies discovery at five minutes while retaining the first feed's original media proof. Retention tests preserve cold restore, active selection, and no repeated media probe assertions while allowing scheduled detail reads.

Future ad-shaped Main 1 snapshots remain unsupported and fail closed. The inspected snapshots contained only content segments. An external source may also remain unavailable before kickoff or fail later. Counts are observations at the stated times.

The final Main 1 check ran in the rebuilt main app at 1920 by 1080. From 00:40:14 to 00:44:08 UTC, decoded frames increased from 23 to 7,044. The selected source and session generation stayed unchanged. HLS reported no errors and the player did not restart. The stable-identity fix therefore passed 234 seconds of actual playback after the earlier 51-second fatal reset.

At 00:42:36 UTC, the saved five-minute interval was active and the app had 82 verified NFL choices. Eight current candidates still reported an upstream failure. All nineteen registered sources remained covered by the audit. The final Portmaster OS check again found its service stopped and disabled, no startup value, and no running Portmaster processes.
