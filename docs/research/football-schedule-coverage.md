# Football schedule coverage and lifecycle evidence

## Follow-up during implementation

On September 26, 2026, fresh Node requests exposed two query failures in the first implementation. A date range such as `dates=20260925-20261003` returned HTTP 400 with `Failed to get events endpoint.` Single-day dates worked. With `dates=20260926`, `limit=1000` returned only 25 FBS events, while `limit=200` returned 65. The implementation must use the verified limit and daily windows. A successful response with fewer than 1,000 rows would have concealed missing games.

Using `dates=20260926&limit=200`, group 80 returned 65 events and group 81 returned 63. Their union contained 116 distinct event IDs. Group 90 returned the same 116 IDs, with no missing or extra events. This verifies a representative schedule union against ESPN's Division I partition. It does not establish that ESPN contains every real-world game. [FBS day](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=200&dates=20260926), [FCS day](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=81&limit=200&dates=20260926), [Division I day](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=90&limit=200&dates=20260926).

The season-specific core API supplied separate membership collections. Group 80 identified itself as FBS and returned 148 team references. Group 81 identified itself as FCS and returned 130. Each response reported one page and returned its declared count. The collections had no shared team IDs. Pittsburgh appeared only in FBS. Bucknell and Harvard appeared only in FCS. All 116 scheduled events had at least one participant in these collections. Twelve were FBS/FCS crossovers, and three had one participant outside both collections. These records support season-keyed affiliation with provider provenance, not exact dates of within-season transitions. The similarly named site API `teams?groups=80` and `teams?groups=81` requests both returned 762 teams and did not provide the required filtering. [FBS membership](https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/80/teams?limit=1000), [FCS membership](https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/81/teams?limit=1000).

The counts and comparison are preserved in [the implementation coverage probe](football-schedule-implementation-probe.json).

## Initial research

Research ticket: [Verify schedule identities and NFL, FBS, and FCS coverage](https://github.com/TheDarkSkyXD/Sports-Hub/issues/12). Parent map: [Reliable football stream pipeline](https://github.com/TheDarkSkyXD/Sports-Hub/issues/6). Observation window: 2026-09-26 04:34-04:41 UTC, September 25 in America/Chicago. This report records source facts and recommendations separately. No application code changed.

## Result

ESPN exposes event and team identities suitable for namespaced matching, and the two college group queries overlap. Their current browser-retrieved JSON contains the same Bucknell-Pittsburgh event ID. They are query partitions, not separate leagues or unique game namespaces. Fresh PowerShell requests returned 403, including one using the app's configured headers. Follow-up requests using Node and the actual Electron executable in server mode returned HTTP 200 for all three current partitions. The fresh result is detailed below; full-slate coverage and sustained availability remain unproven.

The completed sample below checks specific official games. It does not establish complete NFL, FBS or FCS coverage, or a contractual guarantee that ESPN IDs never change.

## Follow-up in the application runtimes

The parent session ran the application's exact `fetch` options: `cache: no-store`, `redirect: error`, a ten-second abort timeout, `User-Agent: SundayRoom/1.0`, and `Accept: application/json,text/html`. Each runtime requested the current undated NFL, group 80, and group 81 endpoints once. No browser impersonation, cookie, alternate IP, or access-control workaround was used.

| Runtime and observation UTC | NFL | College group 80 | College group 81 |
|---|---|---|---|
| Node 24.14.0, 04:40:08.218-04:40:08.266 | HTTP 200; 16 events | HTTP 200; 71 events | HTTP 200; 65 events |
| Electron 44.4.3 / Node 24.21.0 with `ELECTRON_RUN_AS_NODE=1`, 04:40:32.826-04:40:32.994 | HTTP 200; 16 events | HTTP 200; 71 events | HTTP 200; 65 events |

Both fresh sets had 13 shared college event IDs: `401858236`, `401866427`, `401858237`, `401858244`, `401866426`, `401866428`, `401868188`, `401862781`, `401860892`, `401867909`, `401870745`, `401862783`, and `401858468`. Their union contains 123 distinct college events. These are response counts, not an independent denominator or a guarantee of 123 in-scope, fully classified games. The fetched current union still needs team/subdivision validation and comparison against a complete expected slate.

This follow-up establishes fresh access using the same Electron/Node mode that launches the local Next server, and independently confirms cross-group overlap. It does not exercise a running Next route or the whole desktop UI. Dated historical query access, raw cancelled/postponed mappings, continued availability, and whole-slate completeness remain open. The PowerShell failures below are client-specific observations and do not describe the Node fetch outcome.

## Retrieval log

The base is `https://site.api.espn.com/apis/site/v2/sports/football/`.

| UTC observation | Request after base | Client and outcome |
| --- | --- | --- |
| 04:34:48.086 | `college-football/scoreboard?groups=80&limit=200&dates=20250906` | Windows PowerShell `Invoke-WebRequest -UseBasicParsing -TimeoutSec 15`, default headers; 403 Forbidden. |
| 04:34:48.250 | `college-football/scoreboard?groups=81&limit=200&dates=20250906` | Same client and options; 403 Forbidden. |
| 04:34:48.371 | `nfl/scoreboard?dates=20250907&limit=100` | Same client and options; 403 Forbidden. |
| 04:36:52.833 | `college-football/scoreboard?groups=80&limit=200` | Same client, ten-second timeout, no redirects, explicit `User-Agent: SundayRoom/1.0` and `Accept: application/json,text/html`; 403 Forbidden. |
| During observation window | Undated NFL, college group 80 and group 81 scoreboard URLs | Web research tool returned indexed/browser-retrieved JSON labelled "Crawled: today". No trustworthy origin response timestamp or fresh application HTTP success was established. |
| During observation window | Three dated URLs above | Web research tool reported inaccessible URLs. |
| During observation window | `college-football/summary?event=401640992` | Web research tool returned an internal retrieval error; cancellation JSON unavailable. |

Each fresh PowerShell request ran once. No alternate IP, cookie, browser impersonation or access-control workaround was attempted. Those failures describe that client/environment, not a universal ESPN outage. The separate Node/Electron follow-up above verifies the application's fetch stack successfully.

Primary endpoint references: [college group 80](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=200), [college group 81](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=81&limit=200), [NFL](https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard). These URLs are mutable snapshots. The minimal derived evidence below preserves what was observed without copying a full response.

## Identity and overlapping groups

The browser-retrieved group 80 response contained the following fields. Group 81 independently contained the same event and kickoff. Its team entries supplied the same application-relevant identities. [Group 80 JSON](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=200), [group 81 JSON](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=81&limit=200).

```json
{
  "observedAtUtc": "2026-09-26T04:34:00Z/2026-09-26T04:37:00Z",
  "retrieval": "web tool, indexed/browser-retrieved; origin freshness unverified",
  "queryGroupsContainingEvent": ["80", "81"],
  "eventId": "401858236",
  "eventUid": "s:20~l:23~e:401858236",
  "kickoff": "2026-09-26T16:00Z",
  "home": { "teamId": "221", "teamUid": "s:20~l:23~t:221", "name": "Pittsburgh" },
  "away": { "teamId": "2083", "teamUid": "s:20~l:23~t:2083", "name": "Bucknell" },
  "wholeSlateCounts": null,
  "wholeSlateCompletenessVerified": false
}
```

Both schools list Bucknell at Pittsburgh on September 26 at noon. Bucknell's game preview also identifies its player in FCS awards. This supports a specific crossover observation, not the inference that every opponent in group 81 is an FCS team. [Bucknell schedule](https://bucknellbison.com/sports/football/schedule/text), [Pitt schedule](https://pittsburghpanthers.com/sports/football/schedule), [Bucknell preview](https://bucknellbison.com/news/2026/9/22/football-travels-to-face-pitt-in-acrisure-stadium).

ESPN labels group 80 FBS and group 81 FCS on its scoreboard pages. [FBS page](https://www.espn.com/college-football/scoreboard?group=80&seasontype=2&week=1&year=2025), [FCS page](https://www.espn.com/college-football/scoreboard/_/week/1/year/2025/seasontype/2/group/81). These HTML pages are evidence of labels, not proof that every JSON filter response is complete. Later text lookup against these historical pages returned only a three-line document, so no historical full-page census is claimed.

The current NFL excerpt exposes `eventId=401872948`, `eventUid=s:20~l:28~e:401872948`, kickoff `2026-09-25T00:15Z`, and Green Bay's team ID `9` with `teamUid=s:20~l:28~t:9`. College uses league namespace `23`; NFL uses `28`. Preserve the provider and sport/league namespace rather than assuming a numeric team ID is globally unique. [NFL JSON](https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard).

No longitudinal mutation study was performed. The verified claim is identity consistency for the observed crossover across two query responses. Stable application IDs should therefore wrap provider IDs and allow explicit provider-ID corrections, with no dependence on display names or current group membership.

## Small official schedule comparison

| Sample | Official evidence | ESPN evidence | What passed |
| --- | --- | --- | --- |
| August 30, 2025, Montana State at Oregon | Oregon's 2025 schedule gives a 59-13 Oregon win. Montana State's preview confirms the matchup. [Oregon](https://goducks.com/sports/football/schedule/2025), [Montana State](https://msubobcats.com/news/2025/8/28/football-game-1-montana-state-opens-2025-against-perennial-powerhouse-oregon). | Event `401752804` has the same teams/date/result. [ESPN](https://www.espn.com/college-football/matchup?gameId=401752804). | Past crossover exists under an ESPN event ID; historical scoreboard group coverage remains unproven. |
| September 6, 2025, Oklahoma State at Oregon | Oregon lists 69-3. [Official game center](https://goducks.com/game-center/23669). | Event `401752824`, 69-3 final. [ESPN](https://www.espn.com/college-football/game/_/gameId/401752824/oklahoma-st-oregon). | Specific FBS matchup and result agree. |
| September 6, 2025, Rhode Island at Stony Brook | Both schools list 31-17 Rhode Island. Their displayed start times differ: Rhode Island 8:45 PM, Stony Brook 6:00 PM. [Rhode Island](https://gorhody.com/sports/football/schedule/2025), [Stony Brook](https://stonybrookathletics.com/sports/football/schedule/2025). Both appear in Rhode Island's FCS preseason ranking report. [Classification evidence](https://gorhody.com/news/2025/8/4/football-ranked-ninth-in-stats-perform-preseason-top-25.aspx). | Event `401767317`, 31-17 final; ESPN reports a thunderstorm delay. [ESPN](https://www.espn.com/college-football/game/_/gameId/401767317/rhode-island-stony-brook). | Specific FCS matchup/result agree; kickoff strings must retain provenance and rescheduling evidence. |
| September 26, 2026, Bucknell at Pittsburgh | Both schools list noon in Pittsburgh. See sources above. | Same event `401858236` in both current group queries. | Concrete cross-group duplicate established. |
| September 24, 2026, Atlanta at Green Bay | Packers' official highlights identify the Thursday matchup. [Packers](https://www.packers.com/video/game-highlights-packers-vs-falcons-week-3-2026). | Event `401872948`, kickoff September 25 in UTC, final state. [NFL JSON](https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard). | NFL event identity/date conversion corroborated; no full NFL slate count. |

This is five matched examples, not a coverage percentage. The inaccessible dated JSON prevents checking the complete September 6, 2025 union, its overlap count, or whether `limit=200` truncates any partition. One official schedule can also retain the original kickoff while another reflects a delay; a narrow timestamp equality rule would reject a valid match in the Rhode Island sample.

## Subdivision membership

The June 2025 NCAA committee report distinguishes active FBS membership from the FCS-to-FBS transition process. It recommended active status for Kennesaw State effective August 1, 2025 and advanced Delaware and Missouri State to transition year two. This is evidence that subdivision membership needs effective dates and transitional status, rather than one permanent boolean on a school. It does not by itself establish the current status of every school. [NCAA report, page 1](https://ncaaorg.s3.amazonaws.com/committees/d1/fbsfboc/JUN2025D1FBSOC_JUN16Report.pdf).

Recommendation: maintain season/effective-date team classification with provenance. Retain an explicit unknown and transitioning state. Record every query partition that supplied an event, but do not derive each team's membership from those partitions. Keep one college event for a crossover and allow both relevant views to select it.

## Final, cancelled and postponed semantics

Observed raw ESPN final status in the NFL JSON:

```json
{"id":"3","name":"STATUS_FINAL","state":"post","completed":true,"description":"Final","detail":"Final","shortDetail":"Final"}
```

The current college response also showed `STATUS_HALFTIME`, `state=in`, `completed=false`, and `STATUS_SCHEDULED`, `state=pre`, `completed=false`. These fields carry more meaning than the app's retained `pre/in/post` value. [NFL JSON](https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard), [college JSON](https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=200), [existing parser](https://github.com/TheDarkSkyXD/Sports-Hub/blob/229fd78dbcb7f208f7c3c538a6eca45167825e2c/lib/sunday.ts#L63).

Cancellation is a distinct real state. App State announced that its September 28, 2024 Liberty game was cancelled and would not be rescheduled. ESPN's indexed event `401640992` labels it cancelled. [App State announcement](https://appstatesports.com/news/2024/9/27/app-state-liberty-football-game-canceled.aspx), [ESPN event](https://insider.espn.com/college-football/game/_/gameId/401640992/liberty-appalachian-st). The event-summary JSON was inaccessible, so its raw `state`, `completed`, numeric ID and enum spelling remain unverified. Do not invent those mappings.

Suspension/postponement must not immediately imply a played final. The NFL describes Bills-Bengals as postponed before its eventual cancellation. [NFL account](https://www.nfl.com/_amp/proposed-afc-playoff-contingencies-what-you-need-to-know). This report did not retrieve a raw postponed/suspended ESPN football JSON fixture. That enum mapping remains an explicit implementation gate.

Recommendation: preserve the full provider status and map only verified combinations to distinct scheduled, live, halftime, delayed, suspended, postponed, final and cancelled states. Unknown combinations stay unknown. A clock at zero, elapsed wall time, stream ending, or missing scoreboard row cannot establish final. For a verified final, remove live discovery immediately and allow the user's short existing-viewer grace before cleanup. A cancelled game should not appear as a completed scored matchup. Rescheduled games need updated kickoff evidence while retaining their identity when the authority retains it.

## Recommended schedule authority and failure behavior

1. Treat ESPN as the existing candidate schedule authority. The fresh Node/Electron-mode access check passed; a running application integration and full-slate check are still required. Query NFL and both college partitions for a bounded explicit date/week window; do not rely on an undated default remaining on the needed slate. Deduplicate by namespaced event ID and preserve all partition observations.
2. Validate responses structurally and retain fetched-at time, provider time if present, requested window, adapter version and coverage outcome. A 403, timeout, malformed payload or partial parse is a failed refresh, not an empty schedule. Do not reset source freshness when assembling a new board from old data.
3. On temporary failure, show bounded last-good schedules with age and degraded coverage. Per the latest user decision in [issue 10](https://github.com/TheDarkSkyXD/Sports-Hub/issues/10), retain unmatched stream listings internally for later reconciliation and pipeline debugging, and hide them from normal UI. A failed refresh never authorizes final-game cleanup.
4. Apply bounded backoff and an explicit retry control. Keep collection inside the app-owned runtime while open, including the chosen minimized-window behavior; reconcile immediately on resume and stop owned work on close. A cold start with no authoritative schedule should show schedule unavailable; unmatched observations remain internal rather than becoming guessed canonical matchups.
5. Official team/conference schedules are corroboration and possible separately implemented fallback adapters. They are not already a uniform replacement API. A fallback requires its own fresh access, parsing, team-ID mapping, time zone, status and coverage tests. If no fallback meets those gates, retain degraded behavior rather than silently calling provider stream titles authoritative.
6. Finalization consumes fresh explicit lifecycle evidence under a configured policy. Resource TTL cleanup may retire unusable URLs during an outage, but it must not relabel the game final. Retain enough compact evidence to explain matching, rescheduling and finalization decisions.

## Gates still open

- Exercise the requests through the running Next/desktop application and record relevant response headers, validated events, and repeated refresh behavior. The fresh runtime-mode probe above already returned successful statuses and counts for all three partitions; sustained operation remains unproven.
- A known-slate union compared with an independently enumerated official sample large enough to cover FBS-only, FCS-only and crossover games. Record absent IDs, overlapping IDs, date-window boundaries, postponed rows and pagination/truncation behavior. `limit=200` is a request parameter, not proof of completeness.
- Verified raw football fixtures for final after overtime, cancellation, postponement, suspension, delayed kickoff and correction/reopen. Neither `state=post` alone nor `completed=true` alone has been proven sufficient for every terminal case here.
- A season-versioned team membership source and alias table that account for transitions and same-name schools. This report verifies only selected identities, not the complete team census.
- Longitudinal identity checks across schedule changes and source corrections. Stable provider ID usage is supported by the observed sample, not guaranteed by a located public API contract.
- An explicit fallback adapter, if the product requires authoritative schedule coverage during ESPN access failure. No fallback was implemented or operationally certified by this research.

No application tests ran for this documentation-only follow-up. Verification consisted of primary-source comparisons, the logged normal HTTP requests in PowerShell and Node/Electron server mode, and inspection of the existing parser contract. Access success in Node is recorded separately from PowerShell failures and browser-cached evidence.
