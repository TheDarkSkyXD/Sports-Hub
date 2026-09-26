# College football source research

[Research ticket #7](https://github.com/TheDarkSkyXD/Sports-Hub/issues/7), part of [the football pipeline map #6](https://github.com/TheDarkSkyXD/Sports-Hub/issues/6).

Observed on 2026-09-26 between 04:23 and 04:26 UTC, which was September 25 in the application's America/Chicago timezone. Scope is discovery and normalization for an app-open runtime. No stream was played, no media was downloaded, and no access restriction was bypassed.

The eight supplied URLs provide evidence for candidate discovery, but this pass does not establish complete coverage or working playback. Source pages mix games, channels, show listings, aliases, inconsistent dates, and unspecified timezones. The pipeline must reconcile candidates against a separate schedule and retain uncertain records outside the playable game output.

## Method and evidence limits

I opened every supplied URL with the web tool, then fetched the same public HTML with Node's built-in `fetch`, normal certificate validation, default redirects, and a 15 to 20 second timeout. HTML checks inspected anchors, title text, date attributes, collapse identifiers, and iframe tags. They did not execute page scripts or inspect media traffic.

The web tool returned older crawls for VIPBox and Strikeout. Direct HTTP returned current date groups. That discrepancy belongs to the observation method and does not establish that the sites themselves served stale pages. Record both retrieval time and source content time in adapter evidence. HTML responses and link labels establish candidates only. They do not establish video availability, actual game content, or independent fallback servers.

## Findings for every supplied URL

### Sportsurge

The supplied [index6 URL](https://isportsurge.ws/index6) returned HTTP 200 after redirecting to [index7](https://isportsurge.ws/index7). This is a multi-sport listing, with CFB rows alongside other sports. Its NCAAF navigation leads to [the CFB listing](https://isportsurge.ws/cfb/livestreams2). Both contain event links; the CFB listing is the more specific discovery entry point.

The [California/Clemson detail page](https://isportsurge.ws/watch/cfb/clemson-tigers-california-golden-bears/397359732) exposes numeric URL token `397359732`, full team names, CFB category, stadium, ESPN channel, and `2026-09-25 22:30ET`. Its iframe points to a different host. No alternatives appeared in the inspected detail HTML. The numeric token is a source identifier candidate, with longevity unverified.

The CFB listing includes Brown/Harvard and California/Clemson under the same category. It uses relative time and `In Progress` text. Do not infer FBS versus FCS from `CFB`, use the detail time before relative text, and do not treat the live label as a playback probe. No pagination control or final-game transition was verified. Direct category HTML also contained many more entries than the web tool's earlier crawl.

### CrackStreams CFB

The exact [CFB URL](https://ws.crackstreams.me/cfb-streams-live42) returned HTTP 200. It provides named matchups and explicit ET time strings, but links its game rows to `ms.buffstream.io`. Harvard/Brown and Clemson/California coexist. College GameDay is also present, including a row formatted as if it had an opponent.

This page labels Illinois/Ohio State noon ET as September 25. [NCAA's schedule](https://www.ncaa.com/news/football/article/college-football-tv-schedule-game-times-preview) places it on September 26. Preserve the raw date and flag the conflict rather than shifting every row by a day.

The [Harvard destination](https://ms.buffstream.io/cfb-streams/harvard-live-stream) is a reusable team page, not a dated event identifier. A discovery record must include observation and matched event identity; its URL cannot identify one game forever. The listing claims links appear a day before events, but this was not tested over time. No pagination, final status, or independently verified alternatives were observed. CrackStreams and its Buffstream destinations must not count as separate playback successes.

### Buffstream CFB

The exact [category URL](https://ms.buffstream.io/cfb-streams/) was inaccessible to the web tool. A direct request returned HTTP 404 with a short error document. This establishes a broken supplied discovery path at observation time, not a dead provider.

The [Harvard child page](https://ms.buffstream.io/cfb-streams/harvard-live-stream), reached through CrackStreams, remained accessible and exposed an iframe on `embedsports.me`. Its descriptive text says the team page is reused and video appears before kickoff. The same text contains unrelated team and old playoff references, so it is unsuitable as structured event data. No match date, trustworthy event status, pagination, or server alternatives were verified there. Do not delete all provider candidates because its category path returned 404.

### LiveTV

The exact [American football category URL](https://livetv.sx/enx/allupcomingsports/27/) was inaccessible to the web tool. Direct HTTPS failed certificate verification with `unable to verify the first certificate`. Retrying with Node's system certificate store produced the same failure. Certificate validation remained enabled.

No listing content, identifiers, timezones, coverage, pagination, alternatives, playback, or lifecycle signals were verified. Keep this source in an access-error state with the failure reason. Do not interpret this as an empty successful crawl, dead stream, or proof that the host is down. A normal trusted connection in the target desktop environment is the next required check.

### VIPBox NCAAF

The exact [NCAAF schedule](https://vipbox.lc/ncaaf-schedule) returned HTTP 200 directly with September 26/27 groups. The web tool's crawl showed September 19, so it cannot establish current freshness. Direct rows provide a matchup, local-looking time, offset-free `content` datetime, event slug, and numeric collapse ID. Clemson/California used `665429126`.

The [Clemson detail](https://vipbox.lc/onair/ncaaf/clemson-vs-california) returned two HD-labeled options through `data-uri` attributes ending `clemson-vs-california-1` and `-2`; ordinary `href` extraction alone would miss them. These are page alternatives, not verified media servers.

The schedule includes College GameDay, ranked names, and separate Western Carolina/ETSU and Western Carolina/East Tennessee State rows at the same time. No per-row FBS/FCS marker, explicit timezone, pagination control, or final-game lifecycle signal was verified. Preserve date attributes but do not append `Z` to an offset-free value. Numeric IDs remain source hints, not app game IDs.

### VIPBoxTV NCAAF

The exact [NCAAF listing](https://www.vipboxtv.sk/ncaaf-stream) returned HTTP 200 with September 26/27 groups. It uses the same observed Clemson collapse ID as VIPBox. It includes College GameDay and names such as Kentucky State/Albany State, so the page category cannot establish the requested subdivision scope.

Two separate entries list Western Carolina against [ETSU](https://www.vipboxtv.sk/cfb/western-carolina-vs-etsu-stream-live) and [East Tennessee State](https://www.vipboxtv.sk/cfb/western-carolina-vs-east-tennessee-state-stream-live), both at `20:30`. The first exposes one option; the second exposes three `data-uri` options. The web tool flattened the second page's links to the same `#` target, while direct HTML preserved distinct paths. None was played.

Rows contain offset-free datetime attributes and no verified timezone. Their aliases and alternative pages must be retained beneath one matched event when authoritative identity confirms the match. No pagination or finished-game transition was verified. Shared IDs and shapes suggest correlated listings; they do not prove common ownership or independently hosted video.

### Strikeout football

The exact [football URL](https://strikeout.im/football) returned HTTP 200 directly with September 26 through 28 groups. The web tool showed a July crawl. Direct HTML mixes college games, NFL games, and persistent channels such as NFL Network and RedZone. Treat it as a mixed discovery index.

It links Clemson/California to the same college detail path used by the NCAAF category. Its [Clemson detail](https://strikeout.im/college-football/stream-clemson-vs-california-live) exposes two `data-uri` alternatives, each repeated in another navigation control. Deduplicate repeated paths before counting options.

Date attributes omit an offset. The observed Clemson collapse ID is again `665429126`. `Live Now` and `Upcoming` navigation links exist, but their filtering, pagination, and lifecycle behavior were not tested. No verified per-row FBS/FCS designation or final status was found. Overlap with `/ncaaf` must not create duplicate app games or independent health votes.

### Strikeout NCAAF

The exact [NCAAF URL](https://strikeout.im/ncaaf) returned HTTP 200 directly with September 26/27 groups. Its web crawl was from November 2025 and cannot establish current state. Direct rows have date attributes, source slugs, numeric collapse IDs, and `vs.` punctuation.

It repeats the Western Carolina alias pair and the ranked-name and Miami ambiguities seen in VIPBoxTV. Its college row paths also appear in `/football`, so use one source identity across these two discovery routes. No explicit timezone, FBS/FCS field, pagination mechanism, or finished-game signal was verified. Its accessible listings and alternative-link detail pages are insufficient evidence of working playback.

## FBS/FCS and matching evidence

[NCAA's FCS standings](https://www.ncaa.com/standings/football/fcs) identify Harvard and Brown. [Harvard's official game announcement](https://gocrimson.com/news/2026/6/3/footballs-game-at-brown-moved-to-sept-25-and-centreville-bank-stadium.aspx) confirms the September 25 matchup and describes Harvard's FCS playoff participation. Their presence on Sportsurge and CrackStreams proves that those observed listings are not FBS-only. It does not prove complete FCS coverage or playback. The other accessible college pages contain potential FCS candidates, but no complete classification audit was performed.

[NCAA's schedule](https://www.ncaa.com/news/football/article/college-football-tv-schedule-game-times-preview) distinguishes UConn at Miami, Ohio, from Central Michigan at Miami, Florida, and gives noon Eastern for Illinois/Ohio State on September 26. The streaming lists omit those Miami qualifiers in some rows. Both ambiguous names and the observed date conflict need explicit regression fixtures. A broad fuzzy match on `Miami` would associate a candidate with the wrong game.

The offset-free `17:00` for Illinois/Ohio State in VIPBox-family and Strikeout HTML differs from NCAA's noon Eastern. This is evidence that source clock interpretation requires validation. It does not establish a named timezone. Do not use the workstation timezone or a guessed UTC conversion.

## Proposed adapter and pipeline requirements

These are design recommendations from the observations, not claims about existing application behavior.

- Separate discovery source, listing observation, event match, alternative page, and playback endpoint. Preserve each discovery URL even when several routes resolve to the same alternative.
- Store raw team labels, raw datetime, timezone evidence, source ID or URL, fetched time, source content time when present, parser version, and a reason when a field or match is uncertain.
- Match two canonical team IDs against a dated schedule. Treat display order separately from home/away. Strip rank decorations only in the adapter's parsed name field. Keep identity-bearing qualifiers such as Ohio, Florida, State, and campus names.
- Classify FBS/FCS from season-specific team and competition data. Model cross-subdivision games without duplicating them. Keep unknown and out-of-scope competitions explicit. A CFB category is insufficient evidence.
- Resolve aliases within a source and competition context. Keep both Western Carolina candidate pages after matching them to one event because their observed alternatives differ. Reject ambiguous Miami matches until opponent and schedule evidence resolve them.
- Parse `data-uri` as well as relevant anchors. Scope fallback identity to the actual resolved alternative, and deduplicate repeated controls. Shared collapse IDs across hosts are correlation hints, not a global identifier contract.
- Distinguish successful empty discovery, parse failure, stale observation, HTTP 404, TLS failure, playback failure, and confirmed game completion. A failed fetch cannot erase the prior successful observation or finalize its games.
- Use the schedule's confirmed terminal status for game cleanup, with a defined grace period and idempotent removal of active candidates and player resources. None of the inspected source pages proved reliable final-state signaling. Retain bounded provenance and failure history separately from active playable output.
- While the app is open, reconcile on startup and resume, refresh on bounded intervals, and stop work when the runtime closes. Recheck retained candidates after reopening rather than trusting a previous session's health.

## Required verification before enabling automatic switching

1. Capture fresh HTML fixtures in the desktop runtime for all eight routes, including the existing 404 and TLS failures. Verify source-specific parser completeness against visible game rows and navigation.
2. Verify each site's clock interpretation against several authoritative kickoffs spanning midnight and a daylight-saving transition. Cover the demonstrated incorrect date independently of timezone conversion.
3. Exercise representative NFL, FBS, FCS, and cross-subdivision events against the application's canonical schedule. Include rank prefixes, reversed ordering, alias duplicates, non-game shows, and ambiguous team names.
4. Inspect ordinary alternative selection in the runtime. Establish whether distinct page options actually resolve to distinct endpoints, and whether playback callbacks can detect sustained failure, stalls, and recovery. This research did not test those behaviors.
5. Observe a full game lifecycle and a network interruption. Confirm that source outages preserve active state, dead alternatives receive a bounded retry policy, final games stop polling and release resources, and reopening the app reconciles elapsed games.

There is no measured completeness denominator yet. Define coverage against the application's authoritative schedule, report unmatched games and uncertain candidates, and avoid promising every stream until repeated live observations support that claim.
