# Source API review

Research date: October 14, 2026. The research below led to the StreamCenter and Dudestream acquisition changes described in the implementation status. It does not claim that every source was playing video.

The strongest new opportunity is StreamCenter's documented public JSON API. Dudestream's public WordPress REST API can also replace its large category pages. Most other known JSON catalogs are already integrated. An API can remove page scripts from discovery without removing the need for an isolated player when the API returns an embed URL.

## Implementation status

StreamCenter's four registry URLs now use sport-specific JSON catalogs. Detail acquisition binds the stored catalog event to its advertised API group. Playback revalidates the exact event and selected stream UUID before requesting the known player. Empty, conflicting and unavailable responses do not fall back to the old catalog page or stream redirect. HTTP 429 preserves its bounded retry interval.

Dudestream category acquisition now uses its public REST category and narrow post fields. It admits at most three pages and rejects a full final page, duplicate posts, wrong categories and external post links. Event kickoff remains absent when the source has not published one. Detail pages still pass through the existing player validation. Fetched title HTML is parsed as inert text. An API HTTP 403 cannot reopen the category as a browser page; browser recovery remains available for supported detail pages.

The public [response fixture](../../tests/fixtures/source-api-review.json) records exact capture URLs, UTC time, response types and SHA-256 values. [Behavior tests](../../tests/source-api-acquisition.test.ts) cover the acquisition chain, wrong identities, private player addresses, retries and pagination. Ninety focused Node tests and 55 native unit tests pass. Typecheck and scoped lint pass. The acquisition contract and REST-403 browser restriction each failed before their fixes. Final Electron verification belongs to the parent task and is recorded there.

The obsolete StreamCenter HTML listing parser was deleted. The old detail parser and restricted stream-link redirect remain in use for persisted observations. [Store.observations](../../lib/football/adapters/store.ts) reloads earlier version 2 observations, and `saveListingAttempt` adds new rows without deleting previous observation IDs. [Coordinator.resolveObservations](../../lib/football/runtime/coordinator.ts) can therefore read an earlier observation's stream-link URL and call the legacy detail parser during its normal eligibility window. The existing [detail redirect test](../../tests/streamcenter-detail-redirect.test.ts) exercises that saved shape. Playback still resolves and validates the exact stream UUID through the current JSON API. Stored listing HTML has no caller or persistence path and does not justify keeping its parser.

## Scope and method

The [source registry](../../lib/football/source-registry.json) contains 129 source rows across 21 parser families and 36 catalog hosts. Mirrors and sport categories share adapters. Before this change, ten rows used JSON catalogs: TVApp had four; PPV, LiveSportPro, SportsFeed24 and SportsBite had one each; Streamed and Sportsupa had one each. The implementation adds JSON acquisition for four StreamCenter rows and twelve Dudestream categories. SWAC's API adapter exists but there is no SWAC registry row.

I read the registry, native listing/detail/resolver/HTTP code and playback adapters. I searched provider-owned sites for documentation and inspected representative registry pages as text. Research requests used static HTTP, finite timeouts and body limits, without site JavaScript, logins or browser automation. Redirects were inspected rather than followed automatically. Current responses are observations, not availability guarantees. A search finding no documentation means only that no documented API was found in this review.

## APIs already used

| Source family and rows | Classification and endpoint | Returned information and current behavior | Current observation or limit |
| --- | --- | --- | --- |
| `streamed`, 2 | Documented public API: [Streamed docs](https://streamed.st/docs), [matches](https://streamed.st/docs/matches), [streams](https://streamed.st/docs/streams). `streamed.st` and `streamed.pk` expose `/api/matches/all` and `/api/stream/{source}/{id}`. | No authentication is documented. Matches carry event ID, title, millisecond date, teams and source references. Stream rows carry numbered embed URLs. Native discovery already uses JSON; playback revalidates the event and selected source before observing its embed. | Both catalogs returned 258 rows and 140,712 bytes. The docs also offer sport/live/today selectors. Do not replace the complete catalog with `live` without preserving upcoming games. |
| `livesportpro`, 1 | Observed website API: [LiveSportPro](https://livesportpro.com/) reads [Kultsport's catalog](https://api.kultsport.com/api/matches/all) and `/api/stream/{source}/{id}`. No separate provider API contract found. | The page's own static script names the API origin. Already integrated through the catalog adapter. Some validated responses supply direct HLS; others supply an embed. Signed relay URLs remain temporary credentials and must not enter logs. | Catalog returned 269 rows and 191,314 bytes. Static page code also uses `/api/matches/live`; its existence does not establish an equivalent complete event set. |
| `tvapp`, 4 | Observed website API: [TVApp](https://tvapp1.pk/) and [`api-backups.handleapi.win/matches/sport/american-football`](https://api-backups.handleapi.win/matches/sport/american-football), plus basketball, hockey and baseball; `/streams/{source}/{id}`. No public documentation found. | Already uses JSON catalogs and stream references. It retains exact watch-page, title, date, team and selected embed checks. Returned players still need isolated observation. The website explicitly describes external providers. | Football returned 77 rows and 33,621 bytes. Public response required no authentication. A similarly branded TV site is not evidence that it uses this API. |
| `ppv`, 1 | Observed provider API: [`api.ppv.st/api/streams`](https://api.ppv.st/api/streams), linked to the [PPV site](https://ppv.st/). | Already parses event groups, dates, primary iframe and substreams without executing the catalog page. The detail reader selects the event from the JSON catalog. API reachability does not validate any arbitrary iframe. | Returned 11 groups and 113,140 bytes. Its `READ_ME` asks API users to contact the operator. No separate public integration/rate-limit contract found. Do not expand usage assumptions from an anonymous successful request. |
| `sportsfeed24`, 1 | Observed website JSON endpoint: [`bestfreestreaming.app/api/xhr`](https://bestfreestreaming.app/api/xhr), used for [SportsFeed24](https://sportsfeed24.st/). | Already sends JSON POST bodies for categories, then uses `/api/xrhs` for details. Parser checks event ID, teams, event time and published links. No public API documentation found. | POST `{}` returned a category object with `categoryName` and `subCategories`, 28,379 bytes. Production also requests eight named categories. Those nine reads already avoid scripts; changing their concurrency needs measurement and provider limits. |
| `sportsbite`, 1 | Observed website JSON catalog: [`sportsbite.org/matches`](https://sportsbite.org/matches). No public API documentation found. | Already selects a typed event from catalog days, then admits supported iframe streams by event identity. | This research request returned HTTP 403 with nine bytes. Do not infer a new working endpoint or execute challenge scripts outside the existing sandbox. |
| SWAC, dormant | Observed first-party platform API: [SWAC TV](https://tv.swac.org/) uses Gideo. [`ott.gideo.video/api/legacy`](https://ott.gideo.video/api/legacy?cmd=getCategoryChildren&AccountID=Southwestern-Athletic-Conference&CategoryID=e1dbe7ec9a7e686b42b53ab33c3e30e4) supports `getCategoryChildren`, `getVideo` and `getVideoUrls`. | Existing adapter already obtains supported free live football HLS without executing SWAC's site. Account and category values are public tenant identifiers. It checks free behavior, event ID, dates and a narrow media path. | Catalog returned HTTP 200 and 78,480 bytes. No API integration documentation found. Adding the source back is a coverage decision, not an API extraction fix; the catalog also includes sports outside the adapter's football contract. |

Local implementations: [native HTTP acquisition](../../native/collector/src/http.rs), [JSON listing parser](../../native/collector/src/listing_json.rs), [JSON detail parser](../../native/collector/src/detail_json.rs), [resolver](../../native/collector/src/resolver.rs), [catalog playback](../../lib/playback/providers/catalog-stream.ts), [TVApp playback](../../lib/playback/providers/tvapp.ts), [SWAC playback](../../lib/playback/providers/swac.ts).

TVApp's current page imports [`leagues.BkPoF-kP.js`](https://tvapp1.pk/_astro/leagues.BkPoF-kP.js), which imports [`render.-zF-m85h.js`](https://tvapp1.pk/_astro/render.-zF-m85h.js). Static inspection confirms the latter's `api-backups.handleapi.win` origin. The former merges the upstream matches with PPV's public catalog and calls source-specific stream endpoints. These versioned script URLs are provenance for this observation, not integration endpoints. Sports-Hub already has an independent PPV source, so copying the website's merger would add duplicate feeds without proving new coverage.

## Supported changes

### StreamCenter

StreamCenter publishes [API documentation](https://streamcenter.st/docs), a [match contract](https://streamcenter.st/docs/matches), a [stream contract](https://streamcenter.st/docs/streams) and an [OpenAPI 3.1 document](https://streamcenter.st/api/openapi.json). Endpoints are anonymous. Catalogs support conditional reads; stream resolution is `no-store` and limited to 60 requests per minute per client IP, with `Retry-After` for HTTP 429.

Before this change, four registry rows read `/game-cards/embed?sport=...` HTML and the [playback adapter](../../lib/playback/providers/streamcenter.ts) followed `/api/stream-link/iframe/{eventId}/{linkId}` redirects. The implementation now uses the advertised JSON event/source chain. It keeps the existing direct player parser and isolated fallback.

Verified public responses:

| Read | Result |
| --- | --- |
| [`/api/sports`](https://streamcenter.st/api/sports) | HTTP 200, four sports, 156 bytes. `football` means American Football in this response; do not assume soccer. |
| [`/api/matches/football`](https://streamcenter.st/api/matches/football) | HTTP 200, four events, 1,751 bytes. The current HTML football cards response was 33,855 bytes. |
| [`/api/matches/all`](https://streamcenter.st/api/matches/all) | HTTP 200, ten events, 4,213 bytes. The documented cap is 200; all-sports selection can omit events when capped. Prefer the existing sport-specific coverage. |
| [`/api/stream/iframe/event-espn-league-football-college-football-401862800`](https://streamcenter.st/api/stream/iframe/event-espn-league-football-college-football-401862800) | HTTP 200, one row, 256 bytes, `Cache-Control: private,no-store`. |
| [`/api/stream/iframe/event-espn-league-basketball-nba-401918011`](https://streamcenter.st/api/stream/iframe/event-espn-league-basketball-nba-401918011) | HTTP 404. The catalog listing alone does not guarantee a currently usable stream. |

The successful real response binds event `401862800` to this row. These values are public identifiers, not invented example data:

```json
{
  "id": "999f2d14-a516-42cc-847d-d9ce8e83e6dd",
  "streamNo": 1,
  "language": "English",
  "hd": false,
  "embedUrl": "https://streame.center/embed/ch31.php",
  "webUrl": "https://streamcenter.st/watch/event-espn-league-football-college-football-401862800",
  "source": "iframe"
}
```

The match has title `East Carolina Pirates at UAB Blazers`, date `1792107000000`, home `UAB Blazers`, away `East Carolina Pirates`, and the advertised source/group ID used above. Preserve the distinction between the group ID and individual UUID. Validate both against the stored event and stream choice. The OpenAPI limits the stream array to 24. A missing, conflicting or unavailable authoritative JSON result must not revive an older HTML player. Transport failure should remain an incomplete check with bounded retry. Do not introduce a second cache or scheduler.

### Dudestream

The [NBA category page](https://dudestream1.com/category/nba/) advertises its own WordPress REST category link. WordPress documents [category filtering](https://developer.wordpress.org/rest-api/reference/categories/), [post retrieval](https://developer.wordpress.org/rest-api/reference/posts/) and [`_fields`](https://developer.wordpress.org/rest-api/using-the-rest-api/global-parameters/). Public reads below needed no authentication.

- [`/wp-json/wp/v2/categories?slug=nba&_fields=id,slug,name`](https://dudestream1.com/wp-json/wp/v2/categories?slug=nba&_fields=id,slug,name) returned `[{"id":4,"name":"NBA","slug":"nba"}]`, 36 bytes.
- [`/wp-json/wp/v2/posts?categories=4&per_page=10&_fields=id,link,title,content,date_gmt,categories`](https://dudestream1.com/wp-json/wp/v2/posts?categories=4&per_page=10&_fields=id,link,title,content,date_gmt,categories) returned seven posts, 4,982 bytes. The corresponding category HTML was 805,769 bytes.
- The implemented [narrow listing request](https://dudestream1.com/wp-json/wp/v2/posts?categories=4&per_page=100&page=1&_fields=id,link,title,categories) returned the same seven posts in 938 bytes, without content or publication timestamps.
- Real post `478`, link `https://dudestream1.com/nba3/`, has title `Charlotte Hornets vs Boston Celtics` and publication timestamp `2026-10-14T06:52:00`. Its inert content contains `https://embedsports.me/basketball/boston-celtics-vs-charlotte-hornets-stream-1` and an alternate form pointing to a different matchup. This is a useful rejection fixture.

Replace category acquisition with bounded public REST listing reads for the existing twelve categories. Resolve each category slug using its returned category ID; do not assume all categories' numeric IDs. Bound pagination and reject an incomplete listing instead of declaring it complete. Preserve a missing kickoff as missing: WordPress `date_gmt` is post publication, not the event time. Continue current event matching and strict detail/player validation. Treat `title.rendered` and `content.rendered` as hostile text or inert parser input, never application HTML or executable script. REST detail content can be considered later only with an explicit identity contract; omitting the page's title/date/canonical checks would be a regression.

## Remaining registered families

No documented public event/player API was found for these families in this review. Public HTML can still be read without executing its scripts; that is already the default native acquisition path. Only the two browser catalogs intentionally start with browser acquisition. A 403 or timeout limits the evidence and does not prove an API does not exist.

| Family, row count | Provider-owned pages inspected or searched | Finding and action |
| --- | --- | --- |
| `sportsurge`, 2 | [isportsurge](https://isportsurge.ws/index6), [Sportsurge v2](https://v2.sportsurge.net/watch-cfb-streams/) | First page redirected to `/index9`; v2 returned 403. Keep catalog behavior and ownership validation. |
| `buffstream`, 6 | [Buffstream](https://ms.buffstream.io/cfb-streams-live-26), [Crackstreams](https://ws.crackstreams.me/cfb-streams-live42) | Research reads failed or timed out. No supported API replacement established. |
| `livetv`, 1 | [LiveTV](https://livetv.sx/enx/allupcomingsports/27/) | Static HTML returned 200. Search hits containing a team's name "API Mobile" are not API documentation. |
| `vipbox`, 11 | [Vipbox](https://vipbox.fm/hockey-schedule), [VipboxTV](https://www.vipboxtv.sk/ncaaf-stream), [Strikeout](https://strikeout.im/mlb), [MLBBox](https://mlbbox.me/mlb-streams) | HTML returned 200; no provider API contract found. Keep source-specific parsing. |
| `nflstreams`, 1 | [NFLStreams](https://nflstreams.org/) | The page names public `wp-content/uploads/arenaflex/live-games.json`, `scoreboard.json` and `teams.json`. The 1,317-byte live-games response had no events and only continuous channels. It cannot establish the game-to-player mapping. Keep as a research candidate, not a substitute source of game players. |
| `streameast`, 1 | [StreamEast](https://v2.streameast.ga/cfb-streams/) | HTTP 403. No documented public API found. Keep isolated catalog acquisition. |
| `event`, 8 | [Methstreams](https://methstreams.st/NFL), [Crackstreams](https://crackstreams.st/NFL) | Static pages and related fight pages expose published links. Shared Streamed image URLs do not prove their event/player catalogs are interchangeable with Streamed. |
| `motorsports`, 5 | [Methstreams](https://methstreams.st/F1), [Crackstreams](https://crackstreams.st/F1), [Foxtrend](https://foxtrend.app/Motor-Sports), [Buffstreams](https://buffstreams.ch/F1), [Methstreams VG](https://methstreams.vg/F1) | Keep exact event/session identity and published-player rules. No supported JSON replacement found. |
| `crichd`, 1 | [CricHD](https://crichd.pk/) | Redirect to `m.crichd.pk`. No public API contract found. |
| `published-events`, 11 | [Buffstreams](https://buffstreams.ch/), [Trend48](https://trend48.st/), [Foxtrend](https://foxtrend.app/home), [Iohit](https://iohit.st/), [MLBBite](https://mlbbite.org/MLB), Methstreams/Crackstreams fight pages | Static pages returned 200 in representative reads. Do not replace their unique links with a shared upstream based on common artwork. |
| `linked-cards`, 9 | [NBABitez](https://nbabitez.com/), [Sportsurgei](https://sportsurgei.is/nfl) | HTML returned 200. No API contract found. |
| `microdata`, 10 | [IHDStreams](https://ihdstreams.top/index.php?sport=NBA) | Representative WWE request returned 403. Keep static microdata parser and incomplete states. |
| `legacy-schedule`, 37 | [Markkystreams](https://markkystreams.me/nbastreams), [Ecrackstreams](https://ecrackstreams.me/nbastreams), [Crackstreams SO](https://crackstreams.so/nba-regular-2), [Crackstreams WS](https://ws.crackstreams.me/nfl-streams-live52), [StreamEastHD](https://streameasthd.app/nbastreams14), Buffstream motorsports | Several reads timed out; StreamEastHD returned HTML. No public API contract found. Avoid guessed AJAX routes. |

The specialized Gooz, Wikisport, Topstreamer, StreamEast and Dlive playback paths already parse known player data without evaluating arbitrary JavaScript when the expected format exists. That code is not a documented API and must retain its host/path/stream checks. No third-party scraping service or credential-dependent API is recommended. Such a service would add a new trust boundary, cost and availability dependency without proving the event is correct.

## Security and performance requirements for integrations

Keep requests in the existing bounded public-network reader, with public DNS validation, redirect checks, cancellation, response-size limits and Retry-After behavior. Prefer application JSON and reject unexpected response types. Never treat API fields as IPC commands, filesystem paths, shell text or trusted HTML. Admit only the intended event/source/player, and keep ad, private-network and download blocking on any browser fallback.

Fetch data and media into bounded memory or the controlled playback session. Do not save source responses, scripts, player packages or media to user-selected files. An installer/update download belongs to the separately verified GitHub updater; a feed response never grants update authority. Local extraction still runs on the user's computer, so calling it a script or worker does not remove the need for process isolation and narrow privileges.

The response-size comparisons above are single current reads, not measured app-wide speedups. Both proposed changes reduce parser input and avoid fetching page chrome. Existing static HTTP already avoids loading those pages' scripts and images, so do not claim that replacing it with JSON alone removes an existing browser process. The prior audit's main cost was browser checks and long incomplete probes, which these APIs cannot all eliminate.
