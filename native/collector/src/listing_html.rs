use crate::{
    html::{HtmlDoc, attr, clean_text, closest, select, text},
    http::allowed_discovery_url,
    registry::SourceRegistry,
    time::{digest, parse_kickoff},
    types::{League, ListingOutcome, ListingResult, ListingSource, Observation},
};
use scraper::ElementRef;
use std::collections::HashSet;
use url::Url;

macro_rules! pattern {
    ($expression:literal, $value:expr $(,)?) => {
        cached_regex!($expression)
            .expect("fixed listing expression")
            .is_match($value)
    };
}

#[cfg(test)]
#[path = "watch_parser_gap_tests.rs"]
mod watch_parser_gap_tests;

fn result(observations: Vec<Observation>, empty: bool) -> ListingResult {
    let outcome = if !observations.is_empty() {
        ListingOutcome::Parsed
    } else if empty {
        ListingOutcome::Empty
    } else {
        ListingOutcome::ParserChanged
    };
    ListingResult {
        observations,
        outcome,
    }
}

fn content(element: ElementRef<'_>) -> String {
    text(element)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn team_identity(names: &[String; 2]) -> String {
    let mut names = names.clone().map(|name| {
        name.to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    });
    names.sort();
    names.join("|")
}

fn nfl_identity(names: &[String; 2]) -> String {
    names
        .iter()
        .map(|name| {
            name.to_lowercase()
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn live_tv_team_pair(value: &str) -> Option<[String; 2]> {
    let split = cached_regex!(r"\s*[-–—]\s*").unwrap();
    let teams: Vec<String> = split
        .split(value)
        .map(|part| part.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    (teams.len() == 2 && teams.iter().all(|part| !part.is_empty()))
        .then(|| [teams[0].clone(), teams[1].clone()])
}

fn live_tv(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let path = cached_regex!(r"^/enx/eventinfo/([1-9][0-9]{0,19})_[a-z0-9_]*/$").unwrap();
    let mut observations: Vec<Observation> = Vec::new();
    let mut conflicting = false;
    for anchor in doc.select("a[href]") {
        let marker = closest(anchor, "tr")
            .and_then(|row| select(row, "img[alt]").first().copied())
            .and_then(|image| attr(image, "alt"))
            .unwrap_or("");
        let league = match marker {
            "USA. NFL" => League::Nfl,
            "NCAA" => League::Ncaaf,
            _ => continue,
        };
        let href = attr(anchor, "href").unwrap_or("");
        let (Some(event), Some(teams)) = (path.captures(href), live_tv_team_pair(&text(anchor)))
        else {
            continue;
        };
        let Ok(url) = Url::parse(&source.url).and_then(|base| base.join(href)) else {
            continue;
        };
        let id = format!("{}:{}", source.id, &event[1]);
        if let Some(previous) = observations.iter().find(|row| row.id == id) {
            if previous.url != url.as_str()
                || previous
                    .teams
                    .as_ref()
                    .is_some_and(|old| team_identity(old) != team_identity(&teams))
            {
                conflicting = true;
            }
            continue;
        }
        observations.push(Observation {
            id,
            source_id: source.id.clone(),
            url: url.to_string(),
            title: teams.join(" vs "),
            teams: Some(teams),
            league: Some(league),
            kickoff: None,
            ends_at: None,
            raw_time: String::new(),
            observed_at: now,
            parser_version: 2,
            legacy_id: None,
            kickoff_lineage: None,
        });
    }
    if conflicting {
        return result(Vec::new(), false);
    }
    let body_text = doc
        .select("body")
        .first()
        .copied()
        .map(content)
        .unwrap_or_default();
    result(
        observations,
        pattern!(
            r"(?i)no (?:upcoming )?(?:matches|broadcasts|events)",
            &body_text,
        ),
    )
}

fn team_url(value: &str, base: &str) -> Option<String> {
    let url = Url::parse(base).ok()?.join(value).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some("nflstreams.org")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && pattern!(r"^/teams/[a-z0-9]+(?:-[a-z0-9]+)*-live/$", url.path()))
    .then(|| url.to_string())
}

fn slug(name: &str) -> String {
    let lower = name.to_lowercase();
    cached_regex!(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&lower, "-")
        .trim_matches('-')
        .to_string()
}

fn published_time(card: ElementRef<'_>) -> Option<(i64, String)> {
    let raw = attr(card, "data-kickoff-ts")?;
    if raw.len() != 13 || !raw.bytes().all(|part| part.is_ascii_digit()) {
        return None;
    }
    let kickoff: i64 = raw.parse().ok()?;
    if !(1_577_836_800_000..=4_102_444_800_000).contains(&kickoff) {
        return None;
    }
    let dates: Vec<&str> = select(card, "[datetime],[data-datetime]")
        .into_iter()
        .map(|element| {
            attr(element, "datetime")
                .or_else(|| attr(element, "data-datetime"))
                .unwrap_or("")
        })
        .collect();
    if dates.is_empty()
        || dates.iter().any(|date| {
            !pattern!(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", date)
                || parse_kickoff(date) != Some(kickoff)
        })
    {
        return None;
    }
    Some((kickoff, dates[0].to_string()))
}

fn nflstreams(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let mut observations: Vec<Observation> = Vec::new();
    let mut conflicting = false;
    for card in doc.select(".fixture_main_container") {
        let anchors: Vec<_> = select(card, "a[href]")
            .into_iter()
            .filter(|anchor| {
                !attr(*anchor, "class")
                    .unwrap_or("")
                    .split_whitespace()
                    .any(|class| matches!(class, "home_watch_btn" | "home_hd_btn"))
                    && attr(*anchor, "href")
                        .and_then(|href| team_url(href, &source.url))
                        .is_some()
            })
            .collect();
        let watches = select(card, "a.home_watch_btn[href]");
        let time = published_time(card);
        let espn_id = attr(card, "data-espn-id").unwrap_or("");
        if anchors.len() != 2
            || watches.len() != 1
            || time.is_none()
            || !pattern!(r"^\d{5,12}$", espn_id)
        {
            conflicting = true;
            continue;
        }
        let teams: Vec<String> = anchors
            .iter()
            .map(|anchor| {
                select(*anchor, "span:not(.mobile-abbr)")
                    .first()
                    .copied()
                    .map(content)
                    .unwrap_or_default()
            })
            .collect();
        let team_urls: Vec<Option<String>> = anchors
            .iter()
            .map(|anchor| attr(*anchor, "href").and_then(|href| team_url(href, &source.url)))
            .collect();
        let url = attr(watches[0], "href").and_then(|href| team_url(href, &source.url));
        if teams.iter().any(String::is_empty)
            || url.is_none()
            || !team_urls.contains(&url)
            || attr(card, "data-away-slug") != Some(slug(&teams[0]).as_str())
            || attr(card, "data-home-slug") != Some(slug(&teams[1]).as_str())
        {
            conflicting = true;
            continue;
        }
        let url = url.unwrap();
        let (kickoff, raw_time) = time.unwrap();
        let pair = [teams[0].clone(), teams[1].clone()];
        let id = format!("{}:{}", source.id, digest(&url));
        let row = Observation {
            id: id.clone(),
            source_id: source.id.clone(),
            url,
            title: pair.join(" vs "),
            teams: Some(pair),
            league: Some(League::Nfl),
            kickoff: Some(kickoff),
            ends_at: None,
            raw_time,
            observed_at: now,
            parser_version: 2,
            legacy_id: None,
            kickoff_lineage: None,
        };
        if let Some(previous) = observations.iter_mut().find(|previous| previous.id == id) {
            if previous.kickoff != row.kickoff
                || previous.teams.as_ref().map(nfl_identity) != row.teams.as_ref().map(nfl_identity)
            {
                conflicting = true;
            } else {
                *previous = row;
            }
        } else {
            observations.push(row);
        }
    }
    if conflicting {
        return result(Vec::new(), false);
    }
    let body_text = doc
        .select("body")
        .first()
        .copied()
        .map(content)
        .unwrap_or_default();
    result(
        observations,
        pattern!(
            r"(?i)no (?:live )?(?:games|matches) (?:available|scheduled)",
            &body_text,
        ),
    )
}

fn foxtrend(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let mut observations = Vec::new();
    let mut seen = HashSet::new();
    let mut recognized = false;
    for script in doc.select("script") {
        let script = text(script);
        if !script
            .trim_start()
            .starts_with("window.FOXTREND_SCHEDULE_BOOT = {")
        {
            continue;
        }
        let property = |name: &str| {
            let value = script
                .lines()
                .find_map(|line| line.trim_start().strip_prefix(name))?;
            serde_json::Deserializer::from_str(value.trim_start())
                .into_iter::<serde_json::Value>()
                .next()?
                .ok()
        };
        let Some(hosts) = property("watchBaseByCat:") else {
            continue;
        };
        if hosts["motor-sports"].as_str() != Some("https://foxiy.st") {
            continue;
        }
        let Some(events) = property("events:") else {
            continue;
        };
        let Some(days) = events["byDate"].as_object() else {
            continue;
        };
        recognized = true;
        for day in days.values() {
            let Some(rows) = day["motor-sports"].as_array() else {
                continue;
            };
            for row in rows {
                if row["cat"].as_str() != Some("motor-sports") {
                    continue;
                }
                let Some(path) = row["pathPart"].as_str() else {
                    continue;
                };
                let Some(route) = cached_regex!(
                    r"^([a-z0-9]+(?:-[a-z0-9]+)*)-nascar-(cup|truck)-series-([0-9]{10})$"
                )
                .expect("fixed FoxTrend route")
                .captures(path) else {
                    continue;
                };
                let Some(kickoff) = row["start"].as_i64().filter(|time| {
                    route[3]
                        .parse::<i64>()
                        .ok()
                        .and_then(|seconds| seconds.checked_mul(1000))
                        == Some(*time)
                }) else {
                    continue;
                };
                let title = row["t"]
                    .as_str()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if title.is_empty()
                    || row["slug"].as_str() != Some(&route[1])
                    || slug(&title) != route[1]
                {
                    continue;
                }
                let url = format!("https://foxiy.st/event/{path}");
                let conflicting_card = doc
                    .select("a.card.watch.card-sport-motor-sports")
                    .into_iter()
                    .any(|card| {
                        let card_title = select(card, ".card-title")
                            .first()
                            .copied()
                            .map(clean_text)
                            .unwrap_or_default();
                        let href = attr(card, "href");
                        let label = attr(card, "aria-label");
                        (href == Some(url.as_str())
                            || card_title == title
                            || label == Some(title.as_str()))
                            && (href != Some(url.as_str())
                                || card_title != title
                                || label != Some(title.as_str()))
                    });
                if conflicting_card || !seen.insert(url.clone()) {
                    continue;
                }
                observations.push(Observation {
                    id: format!("{}:{}", source.id, digest(&url)),
                    source_id: source.id.clone(),
                    url,
                    title,
                    teams: None,
                    league: Some(if &route[2] == "cup" {
                        League::NascarCup
                    } else {
                        League::NascarTruck
                    }),
                    kickoff: Some(kickoff),
                    ends_at: None,
                    raw_time: kickoff.to_string(),
                    observed_at: now,
                    parser_version: 2,
                    legacy_id: None,
                    kickoff_lineage: None,
                });
            }
        }
    }
    result(observations, recognized)
}

fn motorsports(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let mut observations = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in doc.select("a.ev[data-start][href]") {
        let title = attr(row, "title")
            .map(str::to_string)
            .or_else(|| select(row, ".ev-t").first().copied().map(clean_text))
            .unwrap_or_default();
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        let section = closest(row, "section.lg")
            .and_then(|section| attr(section, "id"))
            .unwrap_or("");
        let league = if pattern!(r"^g-lg-f1-\d{8}$", section) {
            Some(League::F1)
        } else if pattern!(r"^g-lg-nascar-truck-\d{8}$", section) {
            Some(League::NascarTruck)
        } else if pattern!(r"^g-lg-nascar-premier-\d{8}$", section) {
            Some(League::NascarCup)
        } else if pattern!(r"^g-cat-motogp-\d{8}$", section) {
            Some(League::Motogp)
        } else if pattern!(r"^g-cat-motorsport-\d{8}$", section) {
            Some(League::Motorsport)
        } else {
            None
        };
        let Some(league) = league.filter(|_| !title.is_empty()) else {
            continue;
        };
        let Ok(base) = Url::parse(&source.url) else {
            continue;
        };
        let Ok(url) = base.join(attr(row, "href").unwrap_or("")) else {
            continue;
        };
        if url.host_str() != base.host_str()
            || !pattern!(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", url.path())
            || url.query().is_some()
            || url.fragment().is_some()
        {
            continue;
        }
        let raw_time = attr(row, "data-start").unwrap_or("");
        let Some(kickoff) = parse_kickoff(raw_time) else {
            continue;
        };
        if !seen.insert(url.to_string()) {
            continue;
        }
        observations.push(Observation {
            id: format!("{}:{}", source.id, digest(url.as_str())),
            source_id: source.id.clone(),
            url: url.to_string(),
            title,
            teams: None,
            league: Some(league),
            kickoff: Some(kickoff),
            ends_at: None,
            raw_time: raw_time.to_string(),
            observed_at: now,
            parser_version: 2,
            legacy_id: None,
            kickoff_lineage: None,
        });
    }
    let channels = doc.select("section.lg#g-247 a.ev.ev-plain[href]");
    let channel_only = doc.select("h1").iter().any(|heading| {
        let title = clean_text(*heading);
        title.starts_with("F1 ") && title.contains("Streams")
    }) && !channels.is_empty()
        && channels.iter().all(|channel| {
            select(*channel, ".ev-chip")
                .iter()
                .any(|chip| clean_text(*chip) == "24/7")
                && attr(*channel, "href")
                    .is_some_and(|href| pattern!(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", href))
        });
    result(
        observations,
        !doc.select("a.ev[data-start]").is_empty() || channel_only,
    )
}

fn first_attr(element: ElementRef<'_>, selector: &str, name: &str) -> Option<String> {
    select(element, selector)
        .first()
        .and_then(|child| attr(*child, name))
        .map(str::to_string)
}

fn section_league(section: &str, hockey: bool, baseball: bool) -> Option<League> {
    if hockey {
        if pattern!(r"^g-lg-nhl-\d{8}$", section) {
            Some(League::Nhl)
        } else {
            None
        }
    } else if baseball {
        pattern!(r"^g-(?:cat|lg)-mlb-\d{8}$", section).then_some(League::Mlb)
    } else {
        None
    }
}

fn path_allowed(source_id: &str, path: &str) -> bool {
    if match source_id {
        "buffstream-cfb" => !path.starts_with("/cfb-streams/"),
        "buffstream-nfl" => !path.starts_with("/nfl-streams/"),
        "buffstream-nba" => !path.starts_with("/nba-streams/"),
        "buffstream-nhl" => !path.starts_with("/nhl-streams/"),
        "buffstream-mlb" => !path.starts_with("/mlb-streams/"),
        "vipbox-nhl" => !path.starts_with("/onair/nhl/"),
        "strikeout-nhl" => !path.starts_with("/nhl/"),
        "strikeout-mlb" => !path.starts_with("/mlb/"),
        "mlbbox-mlb" => !pattern!(r"^/mlb/[a-z0-9-]+-stream$", path),
        "methstreams-nhl" | "crackstreams-nhl" | "methstreams-mlb" | "crackstreams-mlb" => {
            !path.starts_with("/event/")
        }
        _ => false,
    } {
        return false;
    }
    !pattern!(r"(?i)^/(?:nfl|cfb|nba|nhl|mlb)/livestreams\d*/?$", path)
        && pattern!(
            r"(?i)/(?:watch/(?:nfl|cfb|nba(?:-preseason)?|nhl|mlb-playoffs)/|onair/(?:nfl|ncaaf|nba|nhl)/|(?:nfl|cfb|nba|nhl|mlb|college-football)/.*(?:live|stream)|(?:nfl|cfb|nba|nhl|mlb)-streams/.+-live-stream|event/)",
            path,
        )
}

fn isportsurge_nascar(url: &Url, anchor: ElementRef<'_>) -> Option<(League, String)> {
    if url.scheme() != "https"
        || url.host_str() != Some("isportsurge.ws")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = cached_regex!(
        r"^/event/(nascar|nascar-cup-series)/([a-z0-9]+(?:-[a-z0-9]+)*)-live-streaming-links$"
    )
    .unwrap()
    .captures(url.path())?;
    let headings = select(anchor, "h4");
    if headings.len() != 1 {
        return None;
    }
    let title = clean_text(headings[0]);
    if slug(&title) != path[2] || pattern!(r"(?i)\b(?:xfinity|motogp|formula\s*1|f1)\b", &title) {
        return None;
    }
    let cup = pattern!(r"(?i)\bnascar cup series\b", &title);
    let truck = pattern!(r"(?i)\b(?:nascar truck series|truck playoff)\b", &title);
    let league = match (cup, truck) {
        (true, false) => League::NascarCup,
        (false, true) if &path[1] == "nascar" => League::NascarTruck,
        _ => return None,
    };
    Some((league, title))
}

fn general(
    source: &ListingSource,
    body: &str,
    now: i64,
    registry: &SourceRegistry,
) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let Ok(base) = Url::parse(&source.url) else {
        return result(Vec::new(), false);
    };
    let mut observations: Vec<Observation> = Vec::new();
    let mut conflicting_teams = HashSet::new();
    let mut conflicting_times = HashSet::new();
    let matchup_separator = cached_regex!(r"(?i)\s+(?:vs\.?|versus|at|@)\s+").unwrap();
    let time_expression = cached_regex!(
        r"(?i)\d{4}-\d{2}-\d{2}(?:,\s*[a-z]+)?(?:\s*-\s*|[ T])\d{1,2}:\d{2}\s*(?:AM|PM)?\s*ET\b",
    )
    .unwrap();
    for anchor in doc.select("a[href]") {
        let href = attr(anchor, "href").unwrap_or("");
        let Ok(mut published) = base.join(href) else {
            continue;
        };
        if source.family == "buffstream"
            && published.scheme() == "http"
            && published.host_str() == Some("ms.buffstream.io")
            && published.username().is_empty()
            && published.password().is_none()
            && published.port().is_none()
            && published.query().is_none()
            && published.fragment().is_none()
            && pattern!(
                r"^/(?:nfl|cfb|nba|nhl|mlb)-streams/[a-z0-9-]+-live-stream$",
                published.path(),
            )
        {
            let _ = published.set_scheme("https");
        }
        let url = published.to_string();
        if !allowed_discovery_url(&url, registry) || !path_allowed(&source.id, published.path()) {
            continue;
        }
        let row = if source.family == "sportsurge" {
            anchor
        } else {
            closest(anchor, "tr,[data-start],article,li,.event,.match,.card").unwrap_or(anchor)
        };
        let nascar = if source.id == "sportsurge" && published.path().starts_with("/event/nascar") {
            let Some(race) = isportsurge_nascar(&published, anchor) else {
                continue;
            };
            Some(race)
        } else {
            None
        };
        let title = if let Some((_, title)) = &nascar {
            title.clone()
        } else if source.id == "mlbbox-mlb" {
            select(anchor, "h2")
                .first()
                .copied()
                .map(clean_text)
                .unwrap_or_default()
        } else {
            clean_text(anchor)
        };
        let title: String = title.chars().take(300).collect();
        let image_names: Vec<String> = select(anchor, ".team-name-event-row img[alt]")
            .iter()
            .filter_map(|image| attr(*image, "alt").map(str::to_string))
            .collect();
        let text_time = time_expression
            .find(&title)
            .map(|found| found.as_str())
            .unwrap_or("");
        let cleaned = title.replacen(text_time, "", 1);
        let cleaned = cached_regex!(r"(?i)\d{1,2}:\d{2}\s*UTC.*$")
            .unwrap()
            .replace(&cleaned, "");
        let cleaned = cached_regex!(r"(?i)(?:Live)?Watch\s*→?\s*$")
            .unwrap()
            .replace(&cleaned, "");
        let cleaned = cached_regex!(r"^\s*(?:\d{1,2}:\d{2}\s*)?")
            .unwrap()
            .replace(&cleaned, "");
        let cleaned = cached_regex!(r"(?i)\s*\bCH\s*\d+\s*$")
            .unwrap()
            .replace(&cleaned, "")
            .to_string();
        let wnba_event =
            source.family == "event" && cached_regex!(r"(?i)\bWNBA\b").unwrap().is_match(&cleaned);
        if wnba_event && !source.leagues.contains(&League::Wnba) {
            continue;
        }
        let matchup = if matches!(source.id.as_str(), "methstreams-mlb" | "crackstreams-mlb") {
            cached_regex!(r"(?i)\s*\((?:ALDS|NLDS|ALCS|NLCS|World Series) Game \d+\)\s*$")
                .unwrap()
                .replace(&cleaned, "")
                .to_string()
        } else if wnba_event {
            cached_regex!(r"(?i)\s*\(WNBA\b[^)]*\)\s*$")
                .unwrap()
                .replace(&cleaned, "")
                .to_string()
        } else {
            cleaned.clone()
        };
        let matchup = if matches!(source.id.as_str(), "vipbox-nfl" | "strikeout-nfl") {
            matchup
                .strip_prefix("MNF with Peyton and Eli-")
                .unwrap_or(&matchup)
                .to_string()
        } else {
            matchup
        };
        let pair: Vec<String> = matchup_separator
            .split(&matchup)
            .map(|part| {
                cached_regex!(r"^#?\d+\s+")
                    .unwrap()
                    .replace(part, "")
                    .trim()
                    .to_string()
            })
            .collect();
        let structured_names: Vec<String> = if source.family == "event" {
            select(anchor, ".ev-side .nm-l")
                .into_iter()
                .map(|item| content(item).trim().to_string())
                .collect()
        } else {
            Vec::new()
        };
        let row_teams: Vec<String> = if source.family == "buffstream" {
            select(row, "a[href]").into_iter().filter_map(|item| {
                let href = attr(item, "href")?;
                if pattern!(r"^https?://ms\.buffstream\.io/(?:nfl|cfb|nba|nhl|mlb)-streams/[a-z0-9-]+-live-stream$", href) {
                    Some(cached_regex!(r"(?i)\s+Live Stream\s*$").unwrap().replace(&content(item), "").trim().to_string())
                } else {
                    None
                }
            }).collect()
        } else {
            Vec::new()
        };
        let full_names = if !structured_names.is_empty() {
            structured_names
        } else if row_teams.len() == 2 {
            row_teams
        } else {
            Vec::new()
        };
        let teams = if nascar.is_some() {
            None
        } else if full_names.len() == 2 && full_names.iter().all(|part| !part.is_empty()) {
            Some([full_names[0].clone(), full_names[1].clone()])
        } else if !full_names.is_empty() {
            None
        } else if image_names.len() == 2 {
            Some([image_names[0].clone(), image_names[1].clone()])
        } else if pair.len() == 2 && pair.iter().all(|part| !part.is_empty()) {
            Some([pair[0].clone(), pair[1].clone()])
        } else {
            None
        };
        let buffstream_dated = if matches!(source.id.as_str(), "buffstream-nhl" | "buffstream-mlb")
        {
            select(row, "h4")
                .into_iter()
                .map(content)
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            String::new()
        };
        let raw_time = attr(row, "datetime")
            .map(str::to_string)
            .or_else(|| first_attr(row, "[datetime]", "datetime"))
            .or_else(|| attr(row, "data-utc").map(str::to_string))
            .or_else(|| first_attr(row, "[data-utc]", "data-utc"))
            .or_else(|| attr(row, "data-start").map(str::to_string))
            .or_else(|| first_attr(row, "[data-start]", "data-start"))
            .or_else(|| attr(row, "content").map(str::to_string))
            .or_else(|| first_attr(row, "[content]", "content"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                if !buffstream_dated.is_empty() {
                    return buffstream_dated.clone();
                }
                if !text_time.is_empty() {
                    return text_time.to_string();
                }
                if source.family == "buffstream" {
                    return select(row, "td")
                        .into_iter()
                        .map(content)
                        .find(|value| {
                            pattern!(r"(?i)^(?:0?[1-9]|1[0-2]):[0-5]\d\s*(?:am|pm)\s*ET$", value)
                        })
                        .unwrap_or_default();
                }
                String::new()
            });
        let path = published.path();
        let inferred_league = if let Some((league, _)) = nascar {
            Some(league)
        } else if pattern!(
            r"(?i)/(?:watch/cfb|cfb|ncaaf|college-football)(?:/|-)",
            path,
        ) {
            Some(League::Ncaaf)
        } else if pattern!(r"(?i)/(?:watch/nfl|nfl)(?:/|-)", path) {
            Some(League::Nfl)
        } else if pattern!(r"(?i)/(?:watch/nba|nba)(?:/|-)", path) {
            Some(League::Nba)
        } else if pattern!(r"(?i)/(?:watch/nhl|nhl)(?:/|-)", path) {
            Some(League::Nhl)
        } else if pattern!(r"(?i)/(?:watch/mlb-playoffs|mlb)(?:/|-)", path) {
            Some(League::Mlb)
        } else {
            None
        };
        let section = if source.family == "event" {
            closest(anchor, "section.lg")
                .and_then(|item| attr(item, "id"))
                .unwrap_or("")
        } else {
            ""
        };
        let hockey_event = matches!(source.id.as_str(), "methstreams-nhl" | "crackstreams-nhl");
        let baseball_event = matches!(source.id.as_str(), "methstreams-mlb" | "crackstreams-mlb");
        let event_league = section_league(section, hockey_event, baseball_event);
        if (hockey_event || baseball_event) && event_league.is_none() {
            continue;
        }
        let league = if hockey_event {
            event_league
        } else if baseball_event || source.id.ends_with("-mlb") {
            Some(League::Mlb)
        } else if source.id.ends_with("-nhl") {
            Some(League::Nhl)
        } else if section.contains("college-football") {
            Some(League::Ncaaf)
        } else if wnba_event {
            Some(League::Wnba)
        } else if source.family == "event" {
            None
        } else {
            inferred_league
        };
        let id = format!("{}:{}", source.id, digest(&url));
        let numeric = cached_regex!(r"^/watch/(nfl|cfb|nba|nhl)/[^/]+/(\d+)$")
            .unwrap()
            .captures(path);
        let legacy_id = numeric.and_then(|parts| {
            (!matches!(&parts[1], "nba" | "nhl")).then(|| {
                format!(
                    "{}source-{}",
                    if &parts[1] == "cfb" { "ncaaf-" } else { "" },
                    &parts[2]
                )
            })
        });
        let kickoff = parse_kickoff(&raw_time);
        if let Some(previous) = observations.iter_mut().find(|row| row.id == id) {
            let team_conflict = previous
                .teams
                .as_ref()
                .zip(teams.as_ref())
                .is_some_and(|(old, new)| team_identity(old) != team_identity(new));
            let time_conflict = previous
                .kickoff
                .zip(kickoff)
                .is_some_and(|(old, new)| (old - new).abs() > 60_000);
            if team_conflict {
                conflicting_teams.insert(id.clone());
            }
            if time_conflict {
                conflicting_times.insert(id.clone());
            }
            let had_teams = previous.teams.is_some();
            previous.teams = if conflicting_teams.contains(&id) {
                None
            } else {
                previous.teams.clone().or(teams.clone())
            };
            previous.title = if had_teams {
                previous.title.clone()
            } else if let Some(ref teams) = teams {
                teams.join(" vs ")
            } else {
                previous.title.clone()
            };
            previous.raw_time = if time_conflict {
                format!("{} | {}", previous.raw_time, raw_time)
            } else if (previous.kickoff.is_none() && kickoff.is_some())
                || previous.raw_time.is_empty()
            {
                raw_time.clone()
            } else {
                previous.raw_time.clone()
            };
            previous.kickoff = if conflicting_times.contains(&id) {
                None
            } else {
                previous.kickoff.or(kickoff)
            };
            continue;
        }
        observations.push(Observation {
            id,
            source_id: source.id.clone(),
            url,
            title: if matchup != cleaned {
                cleaned
            } else if let Some(ref teams) = teams {
                teams.join(" vs ")
            } else {
                title
            },
            teams,
            league,
            raw_time,
            kickoff,
            ends_at: None,
            observed_at: now,
            parser_version: 2,
            legacy_id,
            kickoff_lineage: None,
        });
    }
    if !observations.is_empty() {
        return result(observations, false);
    }
    let body_text = doc
        .select("body")
        .first()
        .copied()
        .map(clean_text)
        .unwrap_or_default();
    let known_empty = pattern!(
        r"(?i)no matches available right now|sorry, no games scheduled on this date|no (?:live )?(?:games|events) (?:available|scheduled|found)",
        &body_text,
    );
    let college_empty = source.id == "vipbox-cfb"
        && doc
            .select("meta[property='og:url']")
            .first()
            .and_then(|meta| attr(*meta, "content"))
            == Some(source.url.as_str())
        && (doc
            .select("h3.card-header")
            .first()
            .copied()
            .is_some_and(|heading| {
                pattern!(r"(?i)^No Match'?s Today for NCAAF$", &content(heading))
            })
            || pattern!(
                r"(?i)Not able to find any match/event on NCAAF today\.",
                &body_text,
            ));
    if known_empty || college_empty {
        result(Vec::new(), true)
    } else if source.family == "unknown" {
        ListingResult {
            observations: Vec::new(),
            outcome: ListingOutcome::Unsupported,
        }
    } else {
        result(Vec::new(), false)
    }
}

fn crichd_event_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    value == url.as_str()
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.host_str(), Some("crichd.pk" | "m.crichd.pk"))
        && pattern!(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", url.path())
}

fn crichd_title(value: &str) -> Option<(String, Option<[String; 2]>, Option<League>)> {
    let title = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let separator = cached_regex!(r"(?i)\s+(?:vs\.?|at)\s+").unwrap();
    let parts: Vec<_> = separator.split(&title).collect();
    let teams = (parts.len() == 2 && parts.iter().all(|part| !part.is_empty()))
        .then(|| [parts[0].to_string(), parts[1].to_string()]);
    let league = if pattern!(r"(?i)^MotoGP\b", &title) {
        Some(League::Motogp)
    } else if pattern!(r"(?i)^(?:Formula 1|F1)\b", &title) {
        Some(League::F1)
    } else if pattern!(r"(?i)^NASCAR\b", &title) {
        Some(League::NascarCup)
    } else {
        None
    };
    (teams.is_some() || league.is_some()).then_some((title, teams, league))
}

fn crichd(body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    if doc.select("body").is_empty() || doc.select(".data-countdown[data-start]").is_empty() {
        return result(Vec::new(), false);
    }
    let mut observations = Vec::new();
    let mut seen = std::collections::HashMap::<String, (String, i64, String)>::new();
    let mut conflicting = false;
    for anchor in doc.select("a[href*='/event/']") {
        let url = attr(anchor, "href").unwrap_or("");
        if !crichd_event_url(url) {
            continue;
        }
        let raw_time = select(anchor, ".data-countdown[data-start]")
            .first()
            .and_then(|item| attr(*item, "data-start"))
            .unwrap_or("");
        let kickoff = parse_kickoff(raw_time);
        if !pattern!(
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$",
            raw_time,
        ) || kickoff.is_none_or(|value| value < 946_684_800_000 || value > now + 7 * 86_400_000)
        {
            continue;
        }
        let kickoff = kickoff.unwrap();
        let Some(container) = select(anchor, ".flex-col.justify-center").first().copied() else {
            continue;
        };
        let names: Vec<String> = container
            .children()
            .filter_map(ElementRef::wrap)
            .filter(|child| child.value().name() == "div")
            .map(content)
            .collect();
        let title = if names.len() == 2 && names.iter().all(|name| !name.is_empty()) {
            format!("{} vs {}", names[0], names[1])
        } else {
            text(container)
                .trim()
                .split('\n')
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let parsed = if names.len() == 2
            && names.iter().all(|name| !name.is_empty())
            && !pattern!(r"(?:Live|MotoGP|Formula 1|F1)$", &names[1])
        {
            Some((
                title.clone(),
                Some([names[0].clone(), names[1].clone()]),
                None,
            ))
        } else {
            crichd_title(names.first().map(String::as_str).unwrap_or(&title))
        };
        let Some((event_title, teams, league)) = parsed else {
            continue;
        };
        let path = Url::parse(url).unwrap();
        let id = format!("crichd:{}", path.path().trim_start_matches("/event/"));
        let key = (title, kickoff, url.to_string());
        if let Some(previous) = seen.get(&id) {
            if *previous != key {
                conflicting = true;
            }
            continue;
        }
        seen.insert(id.clone(), key);
        observations.push(Observation {
            id,
            source_id: "crichd".into(),
            url: url.into(),
            title: event_title,
            league,
            teams,
            kickoff: Some(kickoff),
            ends_at: None,
            raw_time: raw_time.into(),
            observed_at: now,
            parser_version: 1,
            legacy_id: None,
            kickoff_lineage: None,
        });
    }
    if conflicting {
        result(Vec::new(), false)
    } else {
        result(observations, true)
    }
}

pub fn parse_html(
    source: &ListingSource,
    body: &str,
    now: i64,
    registry: &SourceRegistry,
) -> Option<ListingResult> {
    match (source.id.as_str(), source.family.as_str()) {
        (_, "published-events") => Some(crate::published::events(source, body, now)),
        (_, "linked-cards") => Some(crate::published::linked_cards(source, body, now)),
        (_, "microdata" | "wordpress") => Some(crate::published::cards(source, body, now)),
        (_, "legacy-schedule") => Some(crate::published::legacy(source, body, now)),
        ("foxtrend", _) => Some(foxtrend(source, body, now)),
        ("livetv", _) => Some(live_tv(source, body, now)),
        ("nflstreams", _) => Some(nflstreams(source, body, now)),
        ("crichd", _) => Some(crichd(body, now)),
        (_, "motorsports") => Some(motorsports(source, body, now)),
        _ if matches!(
            source.kind,
            Some(crate::types::SourceKind::Catalog | crate::types::SourceKind::BrowserCatalog)
        ) || matches!(
            source.id.as_str(),
            "sportsbite" | "sportsfeed24" | "streamed" | "livesportpro"
        ) =>
        {
            None
        }
        _ => Some(general(source, body, now, registry)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::SourceRegistry;

    #[test]
    fn first_html_families_match_frozen_type_script_outputs() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let now = fixture["at"].as_i64().unwrap();
        for case_id in [
            "sportsurge",
            "buffstream",
            "vipbox",
            "event",
            "livetv",
            "nflstreams",
            "motorsports",
            "crichd",
        ] {
            let case = fixture["inputs"]["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["id"] == case_id)
                .unwrap();
            let source_id = case["sourceId"].as_str().unwrap();
            let source = registry.get(source_id).unwrap();
            let result =
                parse_html(source, case["body"].as_str().unwrap(), now, &registry).unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                fixture["expected"]["listings"][case_id]["parsed"],
                "{case_id}"
            );
        }
    }
}
