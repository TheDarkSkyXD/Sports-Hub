# Future NFL and NCAA feed discovery

Scope: live games and scheduled games on today's or tomorrow's America/Chicago calendar date. The user confirmed this window on October 5. Every registered source uses the same feed eligibility policy and saved check interval. Five minutes remains the default. A published player is a candidate; working status requires a successful media check. A future event with no published player remains eligible for later discovery.

The audit replayed saved public source responses, traced all nineteen adapters/collectors, and inspected the running app. It found two exclusions for tomorrow's Southern Miss Golden Eagles at Troy Trojans game, ESPN `ncaaf-401871090`, scheduled for October 6 at 7 p.m. Central (`2026-10-07T00:00Z`).

Strikeout publishes an undated listing and an exact dated detail containing three servers. Its short `Troy` label belongs to both Troy Trojans and Troy Vikings in the full college catalog. Global collision rejection prevented even the detail request. The revised matcher keeps those global owners and requires a globally unique official college opponent plus one dated official matchup. Undated contextual candidates authorize a detail request only; a source live badge cannot promote them. Synthetic opponents, two ambiguous labels, conflicting dates, stale observations and genuinely competing games remain excluded.

TVApp publishes the same future game with `Southern Mississippi Golden Eagles` in its title and `Southern Miss Golden Eagles` in its structured team field. Its parser treated those reviewed names as contradictory. Listing and playback identity now share an exact alias comparison requiring the same globally unique college owner. Conflicting schools remain rejected. The generated catalog remains the sole alias dataset; ESLint permits only the domain and source parser to read that immutable data, without allowing UI access to domain behavior.

| Source | Supported football listings | Future discovery evidence or limit |
| --- | --- | --- |
| Sportsurge | NFL, NCAA | Both category routes and dated detail/player extraction are present. Saved scheduled NFL detail produces five players. |
| Sportsurge v2 | NFL, NCAA | Both category routes accept upcoming cards and retry details. The saved catalog has no published future card. |
| StreamEast | NFL, NCAA | Both category routes accept scheduled cards and enumerate published free choices. A starting-soon page with no free rows remains listing-only. |
| Methstreams | NFL, NCAA | Its `/NFL` listing includes NCAA sections. Saved future NFL/NCAA detail pages publish twelve/one choices. |
| Crackstreams ST | NFL, NCAA | The same section/date/detail checks collect the future NFL/NCAA rows. |
| Crackstreams CFB | NCAA | The saved page is dated October 3, outside this window. No requested-day event was available to replay. |
| Buffstream CFB | NCAA | The saved team links lack an absolute date and its heading is stale. No future event/date is inferred from those links. |
| Buffstream NFL | NFL | Saved matched team pages each publish one player but no absolute date. Its verified live-channel exception applies after the official game is live. |
| LiveTV | NFL, NCAA | Upcoming event and detail identity are supported. Its saved scheduled NFL page has no player before the site's pregame publication window. |
| VIPBox CFB | NCAA | Dated details and server extraction are covered. The saved listing explicitly has no NCAAF events. |
| VIPBox NFL | NFL | Saved scheduled details publish five standard and two alternate choices. |
| VIPBoxTV CFB | NCAA | Detail and server grammar is covered. The saved listing explicitly has no events. |
| Strikeout CFB | NCAA | The Southern Miss–Troy short-name exclusion is reproduced and fixed through contextual matching and dated detail admission. |
| Strikeout NFL | NFL | Saved scheduled details publish five standard and two alternate choices. |
| NFLStreams | NFL | Dated WATCH cards and all six saved game-specific detail routes are supported. |
| TVApp | NFL, NCAA | The future Southern Miss/Mississippi title-field disagreement is reproduced and fixed in both listing and playback identity. |
| PPV | NFL, NCAA | Machine dates and category filtering support future rows; parent and published SkyCast identity are checked. No saved Southern Miss–Troy row exists. |
| Streamcenter | NCAA | Machine-dated ESPN-bound cards are supported. The saved catalog is empty. |
| SWAC TV | SWAC NCAA games | Free future events are parsed; the saved October 10 events fall outside the confirmed window. |

An empty or undated upstream listing does not establish an app parser failure, and discovering a future player does not prove that its media is live. The app keeps checking eligible games automatically; finished games stop new checks under the existing cleanup preference.

The shared window, scheduled admission, retry and retained browser-detail suites passed twenty-eight focused tests before these changes. Test-only commits `1ee87c3` and `30be083` capture the two observed exclusions before their production fixes. Commit `138966e` adds the failing coordinator detail-admission case before the shared matcher changes.

During the audit, Electron process 45428 displayed a native `Error` window; CDP on port 9222 timed out and both browser catalogs stopped updating. The backend continued ordinary source checks. The native inspection helper was unavailable after retries, so the dialog's underlying exception could not be established. The owned app was stopped for the rebuild; this observation does not justify a speculative collector watchdog change.

## Verification

The expanded future regression suite passes six cases: dated Strikeout player preservation; genuinely competing Troy games; undated-listing detail admission; refusal of contextual source-live promotion and a wrong date; preservation of ordinary unique-name live promotion; and newly published future players discovered after five minutes without a manual retry. TVApp passes its real title-field disagreement and conflicting-school check. The existing all-775-team alias test and off-week ambiguity checks pass unchanged.

Replaying 1,266 observations from the actual app database against the previous matcher retained all 242 prior matches, with zero lost or changed matches. It identified two newly eligible observations and one newly dated match. Independent review passed fifty-five additional focused checks, including a competing strict NFL/contextual NCAA result and the enforced import boundaries. Comment review found no introduced comments or suppressions.

All 475 applicable tests, full ESLint, TypeScript and the production build pass. The same pre-existing local packaged-installer check remains excluded: its installer is version 1.0.6 while this project is version 1.0.10. No new installer was built.

After the rebuild, Electron process 68652 launched with persistent output logs. Electron MCP could inspect the main window again, and both browser collectors reported complete fresh checkpoints. At `2026-10-06T03:29:30.079Z`, the live app automatically showed ten choices from five sources for tomorrow's Southern Miss–Troy game: three Strikeout, three VIPBoxTV, two TVApp, one Methstreams, and one Crackstreams. The pre-fix snapshot had two choices from two sources. No manual retry was invoked. All nineteen registered sources and the saved five-minute interval remained present.

The actual Settings → Sources → NCAA CFB → Games view lists all five source links and their ten check results. Initial checks reported upstream media unavailable approximately twenty hours before kickoff; those results are not mislabeled as working feeds. The finished NFL game subsequently disappeared from the eligible automatic-check snapshot, leaving the future NCAA game eligible.

The next actual automatic cycle is verified at `2026-10-06T03:35:08.719Z`. Both browser collectors produced new complete checkpoints just over five minutes after their previous completions. Strikeout Stream 3 and VIPBoxTV Stream Link 3 completed new media checks; two other future choices were actively checking. Their unavailable results received another five-minute retry deadline. No retry, reload-status, or forced source-check command was invoked. This verifies ongoing discovery and retry in the rebuilt app rather than only its startup scan.

The later main-process Error dialog was traced to Electron returning null frame entries during iframe teardown. The observer and desktop shutdown fixes are documented in the [observer crash audit](observer-crash-audit-2026-10-06.md).
