# Motorsports sources

Checked on October 8, 2026.

## Schedules and listings

ESPN's [F1 scoreboard](https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard) groups several sessions under one Grand Prix event. Each competition has its own ID, date, status, and session type. The Singapore weekend has Practice 1, Sprint Qualifying, Sprint, Qualifying, and Race. The board uses each competition as a separate session.

ESPN also publishes [NASCAR Cup Series](https://site.api.espn.com/apis/site/v2/sports/racing/nascar-premier/scoreboard) and [NASCAR Truck Series](https://site.api.espn.com/apis/site/v2/sports/racing/nascar-truck/scoreboard) events. Their competitions lack the F1 session type and represent the race. The inspected Charlotte race dates are October 11 for Cup and October 9 for Truck.

The existing [PPV catalog](https://api.ppv.st/api/streams) has a Motorsports category. Its Formula 1 listings include all five Singapore sessions, with start times that match ESPN. Each listing has a primary feed and eight language or broadcaster alternatives. Main event paths use `f1/{season}/{round}/{session}`. Alternative feeds use flat slugs containing the round and session.

The existing [MethStreams](https://methstreams.st/F1) and [Crackstreams](https://crackstreams.st/F1) catalogs group timed event links by series. Their `/F1` pages include F1, NASCAR Cup Series, NASCAR Truck Series, MotoGP, and Motorsport. The `section.lg` IDs distinguish those groups. The same pages also advertise continuous channels without start times. Those channels do not identify a scheduled session.

MotoGP and other Motorsport cards use the providers' timed listings. The inspected ESPN MotoGP endpoint returned HTTP 400. A timed source listing establishes an advertised start, but does not establish a live or final result.

The final packaged Electron run observed Methstreams and Crackstreams links for F1 Practice, Sprint, and Race, plus MotoGP and Motorsport listings. Their catalogs no longer contained NASCAR rows at that time, and PPV timed out. NASCAR cards still used ESPN's schedule. The source inventory showed the missing links and provider failures.

## Matching limits

F1 links require the same round, session, and a close start time. A generic Grand Prix weekend link cannot identify qualifying or the race. A practice link without a session number can identify a session only when its time resolves to one practice session.

Some NASCAR provider times differ from ESPN. The inspected Truck listing starts one hour after ESPN's Charlotte schedule. One Cup playoff listing has the same difference. Another Cup listing advertises a ROVAL broadcast more than ten hours before the ESPN race. A match requires the correct series, track, race session, and a unique event within 90 minutes. The distant ROVAL listing remains unmatched.

The existing [Sportsurge motorsports catalog](https://isportsurge.ws/f1/livestreams2) contains a generic Singapore Grand Prix weekend link. Its detail page published an empty Gooz embed path during this inspection. That link does not supply a verified session or playable feed.

## Series logos

The F1 image came from the existing Sportsurge listing assets. The Cup and Truck logos came from [NASCAR Cup Series](https://en.wikipedia.org/wiki/NASCAR_Cup_Series) and [NASCAR Craftsman Truck Series](https://en.wikipedia.org/wiki/NASCAR_Craftsman_Truck_Series). MotoGP uses its [2024 logo](https://commons.wikimedia.org/wiki/File:MotoGP_logo_(2024).svg), displayed in white on the dark background. Local files avoid a dependency on the listing site's image availability. The generic Motorsport image is a checkered flag.

## Verification

`node tests/f1.electron.mjs` checks real schedule and source data, the Motorsports filter, series logos, race cards, the source inventory, room persistence, and local video decoding in Electron. Pass a packaged executable path to check the production desktop build. The result records source failures and published link counts separately from UI checks. Providers can time out or remove listings. Local video decoding does not prove that an upcoming remote broadcast is live or playable.
