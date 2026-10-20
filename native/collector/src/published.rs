use crate::{
    html::{HtmlDoc, attr, clean_text, closest, select, text},
    listing_json::catalog_teams,
    time::{digest, parse_kickoff},
    types::{League, ListingOutcome, ListingResult, ListingSource, Observation},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

fn league(category: &str, title: &str, path: &str) -> Option<League> {
    match category {
        "nfl" => Some(League::Nfl),
        "cfb" | "ncaaf" | "college-football" => Some(League::Ncaaf),
        "nba" | "basketball" => Some(if cached_regex!(r"(?i)\bWNBA\b").unwrap().is_match(title) {
            League::Wnba
        } else {
            League::Nba
        }),
        "wnba" => Some(League::Wnba),
        "nhl" | "hockey" | "ice-hockey" => Some(League::Nhl),
        "mlb" | "baseball" => Some(League::Mlb),
        "american-football" => None,
        "wwe" | "wrestling" => Some(crate::wrestling::league(title).unwrap_or(League::Wrestling)),
        "ufc" | "mma" | "boxing" | "fight" | "mma-boxing" => crate::listing_json::streamed_league(
            if category == "mma" || category == "mma-boxing" {
                "fight"
            } else {
                category
            },
            title,
            path,
        ),
        "f1" | "motor-sports" | "motorsport" | "motogp" => {
            crate::listing_json::streamed_league("motor-sports", title, path).or_else(|| {
                title
                    .to_ascii_lowercase()
                    .starts_with("nascar")
                    .then_some(League::Motorsport)
            })
        }
        _ => None,
    }
}

fn supported(category: &str) -> bool {
    matches!(
        category,
        "nfl"
            | "cfb"
            | "ncaaf"
            | "college-football"
            | "nba"
            | "wnba"
            | "nhl"
            | "mlb"
            | "american-football"
            | "basketball"
            | "hockey"
            | "ice-hockey"
            | "baseball"
            | "wwe"
            | "wrestling"
            | "ufc"
            | "mma"
            | "boxing"
            | "fight"
            | "mma-boxing"
            | "f1"
            | "motor-sports"
            | "motorsport"
            | "motogp"
    )
}

fn observation(
    source: &ListingSource,
    url: String,
    title: String,
    category: &str,
    kickoff: Option<i64>,
    now: i64,
) -> Option<Observation> {
    if !supported(category) || title.is_empty() {
        return None;
    }
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let continuous = cached_regex!(r"(?i)\b24\s*(?:/|x|-)\s*7\b")
        .unwrap()
        .is_match(&title);
    let league = if continuous {
        None
    } else {
        league(category, &title, &url)
    };
    if league.is_some_and(|league| !source.leagues.contains(&league)) {
        return None;
    }
    let teams = if continuous
        || matches!(
            league,
            Some(
                League::F1
                    | League::NascarCup
                    | League::NascarTruck
                    | League::Motogp
                    | League::Motorsport
                    | League::Ufc
                    | League::Boxing
                    | League::Wwe
                    | League::Tna
                    | League::Aew
                    | League::Wrestling
            )
        ) {
        None
    } else if league == Some(League::Wnba) {
        catalog_teams(
            &cached_regex!(r"(?i)\s*\(WNBA\b[^)]*\)\s*$")
                .unwrap()
                .replace(&title, ""),
        )
    } else {
        catalog_teams(&title)
    };
    if teams.is_none() && league.is_none() && !continuous {
        return None;
    }
    if teams.is_none()
        && matches!(
            league,
            Some(
                League::Nfl
                    | League::Ncaaf
                    | League::Nba
                    | League::Wnba
                    | League::Nhl
                    | League::Mlb
            )
        )
    {
        return None;
    }
    Some(Observation {
        id: format!("{}:{}", source.id, digest(&url)),
        source_id: source.id.clone(),
        url,
        title,
        teams,
        league,
        kickoff,
        ends_at: None,
        raw_time: kickoff.map(|at| at.to_string()).unwrap_or_default(),
        observed_at: now,
        parser_version: 3,
        legacy_id: None,
        kickoff_lineage: None,
    })
}

fn complete(observations: Vec<Observation>, recognized: bool) -> ListingResult {
    let outcome = if !observations.is_empty() {
        ListingOutcome::Parsed
    } else if recognized {
        ListingOutcome::Empty
    } else {
        ListingOutcome::ParserChanged
    };
    ListingResult {
        observations,
        outcome,
    }
}

#[derive(Deserialize)]
struct ScheduledEvent {
    t: String,
    #[serde(rename = "pathPart")]
    path: String,
    start: i64,
}

pub fn events(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let mut observations = Vec::new();
    let mut seen = HashSet::new();
    let mut recognized = Url::parse(&source.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .as_deref()
        == Some("mlbbite.org")
        && doc
            .select("h2.panel-title")
            .iter()
            .any(|heading| clean_text(*heading).contains("Streams"));
    for script in doc.select("script") {
        let script = text(script);
        let Some(raw) = script
            .split_once("var EVENTS=")
            .map(|(_, tail)| tail)
            .or_else(|| {
                script
                    .lines()
                    .find_map(|line| line.trim_start().strip_prefix("events:"))
            })
        else {
            continue;
        };
        let Some(Ok(schedule)) = serde_json::Deserializer::from_str(raw.trim_start())
            .into_iter::<Value>()
            .next()
        else {
            continue;
        };
        let Some(days) = schedule["byDate"].as_object() else {
            continue;
        };
        recognized = true;
        let watch_hosts = script
            .lines()
            .find_map(|line| line.trim_start().strip_prefix("watchBaseByCat:"))
            .and_then(|value| {
                serde_json::Deserializer::from_str(value.trim_start())
                    .into_iter::<Value>()
                    .next()?
                    .ok()
            });
        for day in days.values().filter_map(Value::as_object) {
            for (category, events) in day {
                for value in events.as_array().into_iter().flatten() {
                    let Ok(event) = serde_json::from_value::<ScheduledEvent>(value.clone()) else {
                        continue;
                    };
                    let Some(kickoff) = parse_kickoff(&event.start.to_string()) else {
                        continue;
                    };
                    if kickoff > now + 7 * 86_400_000
                        || !cached_regex!(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
                            .unwrap()
                            .is_match(&event.path)
                    {
                        continue;
                    }
                    let origin = watch_hosts
                        .as_ref()
                        .and_then(|hosts| hosts[category].as_str())
                        .unwrap_or(&source.url);
                    let Ok(base) = Url::parse(origin) else {
                        continue;
                    };
                    if !matches!(
                        base.host_str(),
                        Some("trend48.st" | "foxtrend.app" | "foxiy.st" | "fxtrend.st")
                    ) {
                        continue;
                    }
                    let Ok(url) = base.join(&format!("/event/{}", event.path)) else {
                        continue;
                    };
                    if let Some(row) = observation(
                        source,
                        url.to_string(),
                        event.t,
                        category,
                        Some(kickoff),
                        now,
                    ) {
                        if seen.insert(row.url.clone()) {
                            observations.push(row);
                        }
                    }
                }
            }
        }
    }
    let base = Url::parse(&source.url).expect("validated registry URL");
    for card in doc.select(
        "a.hr[data-start][href],a.ev[data-start][href],a.event-card[data-href],a.gc[data-ts][href]",
    ) {
        recognized = true;
        let Some(href) = attr(card, "data-href").or_else(|| attr(card, "href")) else {
            continue;
        };
        let Ok(url) = base.join(href) else {
            continue;
        };
        if url.origin() != base.origin()
            || !(cached_regex!(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$")
                .unwrap()
                .is_match(url.path())
                || base.host_str() == Some("mlbbite.org")
                    && cached_regex!(r"^/[a-z0-9]+(?:-[a-z0-9]+)*$")
                        .unwrap()
                        .is_match(url.path()))
        {
            continue;
        }
        let title = attr(card, "title")
            .map(str::to_string)
            .or_else(|| select(card, "h3,.ev-t").first().copied().map(clean_text))
            .unwrap_or_default();
        let section = closest(card, "section[id]")
            .and_then(|section| attr(section, "id"))
            .unwrap_or("");
        let category = section
            .strip_prefix("s-")
            .or_else(|| section.strip_prefix("g-lg-"))
            .or_else(|| section.strip_prefix("g-cat-"))
            .map(|value| {
                cached_regex!(r"-\d{8}$")
                    .unwrap()
                    .replace(value, "")
                    .to_string()
            })
            .unwrap_or_else(|| {
                select(card, "div > span")
                    .iter()
                    .map(|span| clean_text(*span).to_lowercase().replace(' ', "-"))
                    .find(|value| supported(value))
                    .unwrap_or_else(|| base.path().trim_matches('/').to_lowercase())
            });
        let kickoff = attr(card, "data-start")
            .or_else(|| attr(card, "data-ts"))
            .and_then(parse_kickoff);
        if let Some(mut row) = observation(source, url.to_string(), title, &category, kickoff, now)
        {
            let names = select(card, ".gc-name,.nm-l,.hr-nm")
                .iter()
                .map(|name| clean_text(*name))
                .collect::<Vec<_>>();
            if names.len() == 2 {
                row.teams = Some([names[0].clone(), names[1].clone()]);
            }
            if seen.insert(row.url.clone()) {
                observations.push(row);
            }
        }
    }
    complete(observations, recognized)
}

pub fn linked_cards(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let base = Url::parse(&source.url).expect("validated registry URL");
    let mut observations = Vec::new();
    let mut recognized = false;
    let mut seen = HashSet::new();
    for card in doc.select("a[href]") {
        let teams = select(
            card,
            ".team-name,.txt-team,[class*='text-right'] > span,[class*='text-left'] > span",
        )
        .iter()
        .map(|team| clean_text(*team))
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
        if teams.is_empty() || teams.len() > 2 {
            continue;
        }
        recognized = true;
        let Ok(url) = base.join(attr(card, "href").unwrap_or("")) else {
            continue;
        };
        if url.origin() != base.origin()
            || !cached_regex!(r"^/[A-Za-z0-9-]+/[1-9][0-9]{0,11}$")
                .unwrap()
                .is_match(url.path())
        {
            continue;
        }
        let league = source.leagues.first().copied();
        let title = if teams.len() == 1 || teams.get(1).is_some_and(|name| name == "Live") {
            teams[0].clone()
        } else {
            teams.join(" vs ")
        };
        let category = match league {
            Some(League::Nba) => "nba",
            Some(League::Nfl) => "nfl",
            Some(League::Nhl) => "nhl",
            Some(League::Mlb) => "mlb",
            Some(League::F1) => "f1",
            Some(League::Motogp) => "motogp",
            Some(League::Ufc | League::Boxing) => {
                if crate::combat::is_ufc_card_title(&title) {
                    "ufc"
                } else {
                    "boxing"
                }
            }
            _ => continue,
        };
        let content = clean_text(card);
        let datetime = cached_regex!(r"(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)")
            .unwrap()
            .captures(&content);
        let kickoff = datetime.and_then(|parts| {
            let hour = parts[2].parse::<u32>().ok()? % 12 + if &parts[4] == "PM" { 12 } else { 0 };
            parse_kickoff(&format!("{}T{hour:02}:{}:00Z", &parts[1], &parts[3]))
        });
        if kickoff.is_some_and(|date| date < now - 86_400_000 || date > now + 7 * 86_400_000) {
            continue;
        }
        if let Some(row) = observation(source, url.to_string(), title, category, kickoff, now) {
            if seen.insert(row.url.clone()) {
                observations.push(row);
            }
        }
    }
    complete(
        observations,
        recognized || doc.select(".match-card,.div-main-box").len() > 0,
    )
}

fn category_for_source(source: &ListingSource) -> &'static str {
    match source.leagues.first() {
        Some(League::Nfl) => "nfl",
        Some(League::Ncaaf) => "cfb",
        Some(League::Nba) => "nba",
        Some(League::Wnba) => "wnba",
        Some(League::Nhl) => "nhl",
        Some(League::Mlb) => "mlb",
        Some(League::F1) => "f1",
        Some(League::Motogp) => "motogp",
        Some(League::NascarCup | League::NascarTruck) => "motor-sports",
        Some(League::Ufc) => "ufc",
        Some(League::Boxing) => "boxing",
        Some(League::Wwe | League::Tna | League::Aew | League::Wrestling) => "wrestling",
        _ => "",
    }
}

#[derive(Clone, Deserialize, serde::Serialize)]
pub(crate) struct WordpressCategory {
    pub id: i64,
    pub slug: String,
    pub name: String,
}
#[derive(Clone, Deserialize, serde::Serialize)]
pub(crate) struct WordpressTitle {
    pub rendered: String,
}
#[derive(Clone, Deserialize, serde::Serialize)]
pub(crate) struct WordpressPost {
    pub id: i64,
    pub link: String,
    pub title: WordpressTitle,
    pub categories: Vec<i64>,
}
#[derive(Deserialize, serde::Serialize)]
pub(crate) struct WordpressListing {
    pub category: WordpressCategory,
    pub posts: Vec<WordpressPost>,
}

pub(crate) fn wordpress_slug(value: &str) -> Option<&str> {
    let slug = value
        .strip_prefix("https://dudestream1.com/category/")?
        .strip_suffix('/')?;
    cached_regex!(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
        .unwrap()
        .is_match(slug)
        .then_some(slug)
}

pub(crate) fn valid_wordpress_posts(posts: &[WordpressPost], category: i64) -> bool {
    posts.len() <= 300
        && posts.iter().all(|post| {
            post.id > 0
                && post.categories.contains(&category)
                && post.title.rendered.len() <= 2000
                && cached_regex!(r"^https://dudestream1[.]com/[a-z0-9]+(?:-[a-z0-9]+)*/$")
                    .unwrap()
                    .is_match(&post.link)
        })
        && posts
            .iter()
            .map(|post| post.id)
            .collect::<HashSet<_>>()
            .len()
            == posts.len()
        && posts
            .iter()
            .map(|post| &post.link)
            .collect::<HashSet<_>>()
            .len()
            == posts.len()
}

pub fn wordpress(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let Ok(input) = serde_json::from_str::<WordpressListing>(body) else {
        return complete(vec![], false);
    };
    if wordpress_slug(&source.url) != Some(input.category.slug.as_str())
        || input.category.id <= 0
        || !valid_wordpress_posts(&input.posts, input.category.id)
    {
        return complete(vec![], false);
    }
    let mut rows = Vec::new();
    for post in input.posts {
        let doc = HtmlDoc::parse(&post.title.rendered);
        let title = doc
            .select("body")
            .first()
            .copied()
            .map(clean_text)
            .unwrap_or_default();
        if let Some(row) = observation(
            source,
            post.link,
            title,
            category_for_source(source),
            None,
            now,
        ) {
            rows.push(row);
        }
    }
    complete(rows, true)
}

pub fn cards(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let base = Url::parse(&source.url).expect("validated registry URL");
    let mut rows = Vec::new();
    let sport = base
        .query_pairs()
        .find(|(key, _)| key == "sport")
        .map(|(_, value)| value.into_owned());
    let empty_archive = base.host_str() == Some("dudestream1.com")
        && base
            .path()
            .strip_prefix("/category/")
            .and_then(|path| path.strip_suffix('/'))
            .filter(|category| {
                cached_regex!(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
                    .unwrap()
                    .is_match(category)
            })
            .is_some_and(|category| {
                doc.select("body.archive.category").iter().any(|body| {
                    attr(*body, "class").is_some_and(|classes| {
                        classes
                            .split_whitespace()
                            .any(|class| class == format!("category-{category}"))
                    })
                }) && doc
                    .select(".mg-breadcrumb-title h1.title")
                    .iter()
                    .any(|heading| {
                        clean_text(*heading).to_ascii_uppercase()
                            == format!("CATEGORY: {}", category.to_ascii_uppercase())
                    })
                    && doc
                        .select("#content.archive-class .mg-posts-sec-inner")
                        .iter()
                        .any(|posts| {
                            select(*posts, "article").is_empty() && clean_text(*posts).is_empty()
                        })
            });
    let mut recognized = empty_archive
        || base.host_str() == Some("ihdstreams.top")
            && sport.as_ref().is_some_and(|sport| {
                doc.select("main#streams").iter().any(|main| {
                    select(*main, ".sec-title").iter().any(|heading| {
                        clean_text(*heading)
                            .to_ascii_uppercase()
                            .ends_with(&format!("{} STREAMS", sport.to_ascii_uppercase()))
                    }) && select(*main, ".sec-count")
                        .iter()
                        .any(|count| clean_text(*count) == "0 EVENTS")
                        && select(*main, ".empty[role=status] .empty-txt")
                            .iter()
                            .any(|message| {
                                clean_text(*message)
                                    .starts_with(&format!("No {sport} games right now."))
                            })
                })
            });
    for card in doc.select("article.game-card,article.hentry,article.category-schedule") {
        recognized = true;
        let anchor = select(card, "h4.entry-title a[href]")
            .first()
            .copied()
            .or_else(|| select(card, "a[href]").first().copied());
        let Some(anchor) = anchor else {
            continue;
        };
        let title = select(card, "meta[itemprop=name]")
            .first()
            .and_then(|meta| attr(*meta, "content"))
            .map(str::to_string)
            .unwrap_or_else(|| clean_text(anchor));
        let Ok(url) = base.join(attr(anchor, "href").unwrap_or("")) else {
            continue;
        };
        if url.origin() != base.origin() {
            continue;
        }
        let kickoff = select(card, "[data-event-time]")
            .first()
            .and_then(|node| attr(*node, "data-event-time"))
            .and_then(parse_kickoff);
        if let Some(row) = observation(
            source,
            url.to_string(),
            title,
            category_for_source(source),
            kickoff,
            now,
        ) {
            rows.push(row);
        }
    }
    complete(rows, recognized)
}

pub fn legacy(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for anchor in doc.select("a[href]") {
        let Some(heading) = select(anchor, "h4").first().copied() else {
            continue;
        };
        let Some(url) = attr(anchor, "href").and_then(|url| Url::parse(url).ok()) else {
            continue;
        };
        if !matches!(url.host_str(),Some("ms.buffstream.io"|"streameasthd.app"|"the.buffstream.io"))
            || url.scheme()!="https" || url.query().is_some() || url.fragment().is_some()
            || !cached_regex!(r"^/(?:nfl|cfb|nba|nhl|mlb|mma|boxing|f1|motor|wwe)-streams/[a-z0-9]+(?:-[a-z0-9]+)*-live-stream$").unwrap().is_match(url.path()) {continue;}
        let title = cached_regex!(r"(?i)\s+CH\s*\d+$")
            .unwrap()
            .replace(&clean_text(heading), "")
            .to_string();
        if title.contains("Watch Live Stream") || title.contains("Stream Online") {
            continue;
        }
        let kickoff = select(anchor, "p")
            .first()
            .and_then(|time| parse_kickoff(&clean_text(*time)));
        if let Some(row) = observation(
            source,
            url.to_string(),
            title,
            category_for_source(source),
            kickoff,
            now,
        ) {
            if row.teams.as_ref().is_some_and(|teams| teams[0] == teams[1]) {
                continue;
            }
            if seen.insert(row.url.clone()) {
                rows.push(row);
            }
        }
    }
    let recognized = doc
        .select("h1,h2")
        .iter()
        .any(|title| clean_text(*title).contains("Schedule"));
    complete(rows, recognized)
}

pub fn players(
    game_id: &str,
    row: &Observation,
    body: &str,
    name: &str,
) -> Vec<crate::types::ResolvedPlayer> {
    let doc = HtmlDoc::parse(body);
    let base = Url::parse(&row.url).expect("validated observation URL");
    let mut seen = HashSet::new();
    let mut players = Vec::new();
    for node in
        doc.select("iframe[src],a[href],button[data-url],input[type=hidden][id^=linkk][value]")
    {
        let Some(raw) = attr(node, "src")
            .or_else(|| attr(node, "data-url"))
            .or_else(|| attr(node, "value"))
            .or_else(|| attr(node, "href"))
        else {
            continue;
        };
        let Ok(url) = base.join(raw) else {
            continue;
        };
        if let Some(player) = crate::detail_html::event_page(
            game_id,
            &row.url,
            url.as_str(),
            format!("{name} · Server {}", players.len() + 1),
        ) {
            if seen.insert(url.to_string()) {
                players.push(player);
            }
        }
    }
    if base.host_str() == Some("ihdstreams.top")
        && doc
            .select(".match-title")
            .iter()
            .any(|heading| clean_text(*heading) == row.title)
    {
        for script in doc.select("script:not([src])") {
            let content = text(script);
            for encoded in
                cached_regex!(r#"\bvar\s+_(?:raw|e[12])\s*=\s*"([A-Za-z0-9+/]{1,512}={0,2})""#)
                    .unwrap()
                    .captures_iter(&content)
            {
                let Some(path) = STANDARD
                    .decode(&encoded[1])
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                else {
                    continue;
                };
                if !path.starts_with("/embed/") {
                    continue;
                }
                let Ok(url) = base.join(&path) else {
                    continue;
                };
                if url.origin() != base.origin() {
                    continue;
                }
                if let Some(player) = crate::detail_html::event_page(
                    game_id,
                    &row.url,
                    url.as_str(),
                    format!("{name} · Server {}", players.len() + 1),
                ) {
                    if seen.insert(url.to_string()) {
                        players.push(player);
                    }
                }
            }
        }
    }
    players
}
