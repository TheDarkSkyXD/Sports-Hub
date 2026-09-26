# NFL stream source research

Researched 2026-09-26, starting at 04:23:57 UTC, which was September 25 in America/Chicago. Scope is the nine exact NFL URLs supplied for the football pipeline. The pipeline is to run while the desktop app is open.

## Method and limits

I opened every exact URL with the web reader, then made ordinary public HTTP GET requests to the eight readable origins with PowerShell `Invoke-WebRequest`. All eight returned HTTP 200 HTML. I sampled publicly linked detail pages and inspected their text and HTML attributes. I did not play video, fetch media, download software, log in, bypass an access control, or follow the refused authentication redirect.

The web reader sometimes returned cached content. Its reported crawl ages ranged from today to three months ago. Direct HTTP observations below take precedence over cached listing details, but neither proves that a video plays. HTTP 200 establishes that a page answered, not that the page has current games or healthy streams. The inaccessible origin remains unverified, not dead.

## Exact source observations

| Requested source | Access at research time | Verified source shape | Adapter status |
| --- | --- | --- | --- |
| [VIPBox NFL](https://vipbox.lc/nfl-schedule) | HTTP 200 | Channel and program listing | Listing readable; game identity and playback unverified |
| [Crackstreams.me NFL](https://ws.crackstreams.me/nfl-streams-live52) | HTTP 200 | Matchup links to Buffstream | Listing readable; stale dates require quarantine |
| [Strikeout NFL](https://strikeout.im/nfl) | HTTP 200 | Dated event list mixed with programs | Listing readable; timezone unresolved |
| [NFLHunter](https://nflhunter.com/home-1/) | HTTP 200 | Empty schedule and channel section | Empty result observed; event adapter unverified |
| [NFLStreams.org](https://nflstreams.org/) | HTTP 200 | Empty schedule and channel section | Empty result observed; event adapter unverified |
| [StreamEast](https://v2.streameast.ga/nfl-streams/) | Web reader refused an authentication redirect | No schedule inspected | Access blocked in this research tool; unverified |
| [Buffstream NFL](https://ms.buffstream.io/nfl-streams-live-31) | HTTP 200 | Away/home table and persistent team pages | Listing readable; stale schedule requires quarantine |
| [MethStreams.st NFL](https://methstreams.st/NFL) | HTTP 200 | Mixed football leagues, event detail pages | Listing and one feed destination inspected |
| [CrackStreams.st NFL](https://crackstreams.st/NFL) | HTTP 200 | Mixed football leagues, event detail pages | Listing and one feed destination inspected |

### VIPBox

The exact schedule showed six channel/program links and no matchup rows in the direct response. Its page clock lacked an explicit timezone. The linked [RedZone page](https://vipbox.lc/onair/nfl/nfl-redzone) returned HTTP 200 and displayed seven video choices. Static HTML contained no iframe. These are choices exposed by the page, not seven verified independent servers. No event ID, kickoff, score, terminal status, or playback health was established. Separate channels and shows from games; an empty game section must not delete channel records. [Source](https://vipbox.lc/nfl-schedule)

### Crackstreams.me

The listing contains full team names, dates and ET times. Its snapshot listed September 17 fixtures, already past at research time, and paired normal rows with reversed-team CH2 rows. A Bills/Lions link led to a persistent Bills page on `ms.buffstream.io`. The list also contains network channels and a premium promotion. Its Washington label uses an older team name. The page claims links appear a day before events; that timing was not measured. No stable event identifier or completed-game signal was observed. Preserve CH2 as a feed label, match the unordered team pair, and obtain home/away roles from the authoritative game record. [Source](https://ws.crackstreams.me/nfl-streams-live52)

### Strikeout

The direct response showed September 27 and 28 rows, including pregame programs, RedZone, and games. Cleveland/Carolina appeared at 18:00, with no explicit timezone in the inspected text. The web reader had older September 25 content. It linked a [Packers/Falcons detail page](https://strikeout.im/nfl/stream-green-bay-packers-vs-atlanta-falcons-live) whose direct response still returned HTTP 200 with a waiting message and no iframe. That is not evidence of a live or dead video. Matchup slugs lack a visible year. Do not treat the slug or displayed clock alone as canonical game identity. Current event alternatives and machine-readable kickoff semantics need verification. [Source](https://strikeout.im/nfl)

### NFLHunter

Direct HTML and web text showed an empty schedule, an ET/Auto setting, and a live-channel section. The page advertises multiple links, but no event rows or alternatives were available to inspect. It claims third-party embeds. No event IDs, feed IDs, timestamps, scores, or cleanup transitions were verified. An adapter must distinguish a successfully parsed empty schedule from a failed fetch or missing expected markup. It also needs a populated fixture before its matching behavior can be accepted. [Source](https://nflhunter.com/home-1/)

### NFLStreams.org

The web reader returned a three-month-old layout with a GMT-offset selector. Direct HTTP showed an EDT/Auto control, an empty schedule, and `data-rollover-ts="1790413200"`. That attribute is not proven to represent a game time or terminal status. Cached navigation exposed team pages, but there were no current event rows to verify their relationship to games. Playback alternatives, home/away claims, and commentary options remain marketing claims. The current DOM needs its own fixture; do not implement from the older extracted layout. [Source](https://nflstreams.org/)

### StreamEast

Opening the exact URL produced a reader error reporting a redirect to `auth.streamea.st/SsoHandoff.php` with a return URL for `v2.streameast.ga/connect.php`. The tool refused that destination as unsafe to open. Its diagnostic included 500, which must not be recorded as an observed origin HTTP 500. No authentication flow was attempted and no schedule, IDs, alternatives, timezone, upstream, or lifecycle behavior was inspected. Keep this source registered with an unverified/access-restricted research status. [Requested source](https://v2.streameast.ga/nfl-streams/)

### Buffstream

The schedule mixes an away/home table with channels and older special programs. Its heading says March 18, 2026, while some program labels reference 2024. It exposes ET times and team names, including an older Washington name. The linked [Bills page](https://ms.buffstream.io/nfl-streams/buffalo-bills-live-stream) describes reuse for successive Bills games and exposes an iframe link on `embedsports.me`. That page claims video appears an hour before kickoff; no timing or playback was verified. A persistent team URL is a source locator, not a game ID. Keep collection provenance when Crackstreams.me discovers the same destination. [Schedule source](https://ms.buffstream.io/nfl-streams-live-31)

### MethStreams.st

The NFL route includes college football and CFL, channel rows, live labels, and NFL groups. One group labels a Hillsdale/Thomas More entry NFL, so category text requires validation against the team registry. The page displays UTC times while its explanatory text says ET. Direct HTML includes `data-start="1790438400"`, `datetime="2026-09-26T16:00:00Z"`, and `data-utc` with that same ISO value. Preserve and validate these values instead of deriving a timezone from prose. The page claims finished games disappear; this was not observed over time. A listing row does not establish a playable feed. [Source](https://methstreams.st/NFL)

Its [Cleveland/Carolina detail](https://methstreams.st/event/m-carolina-panthers-vs-cleveland-browns-0927) displayed September 27 at 17:00 UTC and one feed row. Static HTML linked that row to `https://foxxy.st/event/m-carolina-panthers-vs-cleveland-browns-0927`. The detail explicitly hands playback to a separate page. The slug reverses the displayed team order and includes month/day but no visible year. Treat it as a provider-scoped locator with an observation time. This single-feed example does not verify the advertised backup behavior.

### CrackStreams.st

The exact page returned HTTP 200 with the same observed time attributes and mixed football grouping as MethStreams.st. Keep a separate configured source and observation trail even if the parser can share tested logic. Similar branding and markup alone do not prove identical infrastructure. The claimed finished-game removal still needs a measured transition. [Source](https://crackstreams.st/NFL)

Its [Cleveland/Carolina detail](https://crackstreams.st/event/m-carolina-panthers-vs-cleveland-browns-0927) exposed the same one-feed destination on `foxxy.st` as MethStreams.st, verified from both HTML responses. This confirms a shared downstream URL for this sampled game. It does not establish that every event or backup shares an upstream. The page describes named alternative channel families, but this sample provided only one feed. Do not count the two branded listings as two independent failover options for that destination.

## Proposed adapter and normalization requirements

These are design recommendations from the observations above, not claims that the current application already implements them.

1. Keep source collection, event matching, feed resolution, playback health, and game lifecycle as separate records. Record the requested URL, final URL when available, fetched-at time, parser version, source locator, and source field values. A blocked fetch must never masquerade as a successful empty snapshot.
2. Model `game`, `channel`, and `program` separately. The mixed pages make a URL category insufficient to identify NFL, NCAA, FBS, or FCS. Resolve league and season-specific subdivision through the canonical game/team data. Keep unknown classifications unresolved.
3. Match a provider event to a canonical schedule game using normalized team identities and an acceptable kickoff window. Preserve provider team ordering without assuming that the first name is home. Use explicit aliases for historical names. Never let broad fuzzy matching silently decide an ambiguous game.
4. Store UTC kickoff plus the original timestamp and its interpretation. Prefer validated machine-readable UTC fields. Resolve explicit ET through a date-aware Eastern timezone, not a permanent numeric offset. Leave unspecified timezones unresolved until an adapter has evidence. Test midnight and daylight-saving boundaries.
5. Use provider-scoped IDs or locators for observations, the canonical schedule ID for games, and a separate destination identity for feeds. Team pages and yearless slugs must not bind future games to an old record. Preserve URL query parameters unless their semantics have been verified; a token may be necessary for playback.
6. Retain all discovery provenance when multiple sources reach one destination. Deduplicate the known same downstream before ranking failover choices. Hostname equality alone is weaker evidence than identical destination identity; distinct hosts do not prove independence.
7. Classify discovery failure, empty listing, waiting page, access restriction, parser failure, failed playback, and expired candidate separately. Use retryable quarantine before deleting a candidate. Confirmed terminal game state should stop collection and remove active game resources; listing disappearance alone cannot establish the game ended.
8. On app startup and resume, reconcile stored candidates against current game status and expiry before presenting them. Pause/cancel polling when the app closes. A restart must not resurrect a completed game's active links or erase unrelated channel subscriptions.

## Required verification before claiming coverage

- Capture current successful fixtures for each enabled adapter, including populated NFL and college schedules, an empty schedule, changed markup, and an access error. The empty NFLHunter and NFLStreams observations are insufficient for event-parser acceptance.
- Compare matched games against an independent canonical schedule. Include reversed team order, old team names, a shared team page, a yearless slug reused in another season, unrelated programs, FBS/FCS cross-subdivision games, and ambiguous abbreviations.
- Validate real player startup and progress in the application's actual desktop playback path. Test one failed alternative followed by a distinct healthy destination, shared-downstream deduplication, exhaustion of all alternatives, late-appearing feeds, and retry cooldown. HTTP success and feed labels cannot substitute for playback evidence.
- Observe one full game lifecycle with discovery before kickoff, active playback, a feed failure, verified terminal state, cleanup, and app restart/resume. Also test delayed or postponed games so an estimated duration cannot end an active game. None of the nine sources supplied a verified terminal transition in this research.
- Report coverage as counts of registered, accessible, parsed, matched, resolved, and playback-verified sources/candidates. This research establishes accessible listing pages and selected detail structures; it does not establish that every game has a working stream.
