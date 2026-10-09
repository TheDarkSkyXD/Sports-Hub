use crate::{
    event_policy::valid_event_page_pair,
    html::{HtmlDoc, attr, clean_text, inner_html, select, text, text_without_excluded},
    listing_json::catalog_teams,
    registry::SourceRegistry,
    time::{digest, parse_kickoff, player_id},
    types::{CandidateLocator, League, MissingPlayerReason, Observation, ResolvedPlayer},
};
use regex::Regex;
use scraper::ElementRef;
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};
use url::Url;

macro_rules! pattern {
    ($expression:literal, $value:expr $(,)?) => {
        cached_regex!($expression)
            .expect("fixed detail expression")
            .is_match($value)
    };
}

fn first_attr(doc: &HtmlDoc, selector: &str, name: &str) -> Option<String> {
    doc.select(selector)
        .first()
        .and_then(|node| attr(*node, name))
        .map(str::to_string)
}

fn normalized(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn identity(teams: &[String; 2]) -> String {
    let mut names = teams.clone().map(|name| normalized(&name.to_lowercase()));
    names.sort();
    names.join("|")
}

fn event_page(
    game_id: &str,
    event_url: &str,
    server_url: &str,
    label: String,
) -> Option<ResolvedPlayer> {
    if !valid_event_page_pair(event_url, server_url) {
        return None;
    }
    let key = serde_json::to_string(&(game_id, event_url, server_url)).expect("string identity");
    Some(ResolvedPlayer {
        id: format!("event-page:{}", digest(&key)),
        label,
        locator: CandidateLocator::EventPage {
            game_id: game_id.to_string(),
            event_url: event_url.to_string(),
            server_url: server_url.to_string(),
        },
    })
}

fn gooz_players(body: &str) -> Vec<ResolvedPlayer> {
    static NON_CONTENT: OnceLock<Regex> = OnceLock::new();
    static FRAME: OnceLock<Regex> = OnceLock::new();
    static SRC: OnceLock<Regex> = OnceLock::new();
    static SWITCH: OnceLock<Regex> = OnceLock::new();
    let visible = NON_CONTENT
        .get_or_init(|| {
            cached_regex!(r"(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)\s*>").unwrap()
        })
        .replace_all(body, "");
    let mut ids = Vec::<String>::new();
    let mut seen = HashSet::new();
    for frame in FRAME
        .get_or_init(|| cached_regex!(r"(?is)<iframe\b[^>]*>").unwrap())
        .find_iter(&visible)
    {
        let Some(source) = SRC.get_or_init(|| cached_regex!(r#"(?i)(?:^|\s)src\s*=\s*(['"])(https://gooz\.aapmains\.net/new-stream-embed/(\d+))(['"])"#).unwrap()).captures(frame.as_str()) else { continue; };
        if source[1] != source[4] {
            continue;
        }
        let id = source[3].to_string();
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return vec![];
    }
    for switched in SWITCH
        .get_or_init(|| cached_regex!(r"changeStream\((\d+)\)").unwrap())
        .captures_iter(&visible)
    {
        let id = switched[1].to_string();
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    ids.into_iter()
        .enumerate()
        .map(|(index, id)| ResolvedPlayer {
            id: format!("gooz-{id}"),
            label: if index == 0 {
                "Primary".into()
            } else {
                format!("Backup {index}")
            },
            locator: CandidateLocator::Gooz { player_id: id },
        })
        .collect()
}

fn vipbox_source(row: &Observation) -> bool {
    row.source_id.starts_with("vipbox-")
        || row.source_id.starts_with("vipboxtv-")
        || row.source_id.starts_with("strikeout-")
        || row.source_id == "mlbbox-mlb"
}

fn vipbox_config(body: &str) -> String {
    let doc = HtmlDoc::parse(body);
    doc.select("script")
        .into_iter()
        .map(inner_html)
        .find(|script| pattern!(r"\bconst\s+siteConfig\s*=\s*\{", script))
        .unwrap_or_default()
}

fn vipbox_kickoff(config: &str) -> Option<(String, i64)> {
    let raw = cached_regex!(r#""event_start_ts"\s*:\s*(\d{10}(?:\d{3})?)\b"#)
        .unwrap()
        .captures(config)?
        .get(1)?
        .as_str()
        .to_string();
    Some((raw.clone(), parse_kickoff(&raw)?))
}

fn generic_enrichment(row: &Observation, body: &str) -> Observation {
    let doc = HtmlDoc::parse(body);
    if vipbox_source(row)
        && first_attr(&doc, "meta[property='og:url']", "content").as_deref() == Some(&row.url)
    {
        let config = vipbox_config(body);
        if pattern!(r#""loaded_page"\s*:\s*"stream""#, &config)
            && let Some((raw, kickoff)) = vipbox_kickoff(&config)
        {
            let mut enriched = row.clone();
            enriched.raw_time = raw;
            enriched.kickoff = Some(kickoff);
            return enriched;
        }
    }
    let text = doc
        .select("body")
        .first()
        .map(|node| text_without_excluded(*node))
        .unwrap_or_default();
    let time = first_attr(&doc, "[datetime]", "datetime")
        .or_else(|| first_attr(&doc, "[data-utc]", "data-utc"))
        .or_else(|| {
            cached_regex!(r"(?i)\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}\s*(?:AM|PM)?\s*ET\b")
                .unwrap()
                .find(&normalized(&text))
                .map(|value| value.as_str().to_string())
        })
        .unwrap_or_else(|| row.raw_time.clone());
    let mut enriched = row.clone();
    enriched.kickoff = parse_kickoff(&time);
    enriched.raw_time = time;
    enriched
}

pub fn enrich_html_observation(row: &Observation, body: &str) -> Option<Observation> {
    let source = row.source_id.as_str();
    if source == "livetv" {
        return Some(enrich_livetv(row, body));
    }
    if source == "nflstreams"
        || source.starts_with("buffstream-")
        || matches!(
            source,
            "streamcenter"
                | "streamcenter-nba"
                | "streamcenter-nhl"
                | "streamcenter-mlb"
                | "ppv"
                | "tvapp"
                | "tvapp-nba"
                | "tvapp-nhl"
                | "tvapp-mlb"
                | "swac"
        )
    {
        return Some(row.clone());
    }
    Some(generic_enrichment(row, body))
}

fn future_reason(row: &Observation) -> MissingPlayerReason {
    if row.kickoff.is_some_and(|kickoff| kickoff > row.observed_at) {
        MissingPlayerReason::NotYetPublished
    } else {
        MissingPlayerReason::NoPublishedPlayer
    }
}

fn generic_missing(row: &Observation, body: &str) -> MissingPlayerReason {
    let source = row.source_id.as_str();
    let doc = HtmlDoc::parse(body);
    let text = normalized(
        &doc.select("body")
            .first()
            .map(|node| text_without_excluded(*node))
            .unwrap_or_default(),
    );
    if source == "livetv" {
        let has_player = doc.select("a[href]").iter().any(|node| {
            attr(*node, "href").is_some_and(|url| pattern!(r"(?i)webplayer\.php", url))
        });
        return if !has_player
            && pattern!(
                r"(?i)Live streams will be available approximately 30 minutes before the broadcast's start\.",
                &text,
            ) {
            MissingPlayerReason::NotYetPublished
        } else {
            MissingPlayerReason::NoCompatibleMedia
        };
    }
    if pattern!(
        r"(?i)(?:this |the )?stream (?:will be|is going to be) available (?:shortly|soon)|stream (?:has not|hasn't) started yet",
        &text,
    ) {
        return MissingPlayerReason::NotYetPublished;
    }
    if pattern!(r"(?i)no channels? (?:is |are )?available", &text) {
        return MissingPlayerReason::NoPublishedPlayer;
    }
    if source == "sportsurge"
        && doc.select("iframe").len() == 1
        && first_attr(&doc, "iframe", "src").as_deref()
            == Some("https://gooz.aapmains.net/new-stream-embed/")
        && doc.select("video[src],audio[src],source[src]").is_empty()
        && !pattern!(r#"\bchangeStream\s*\(\s*['"]?\d+"#, body)
    {
        return MissingPlayerReason::NoPublishedPlayer;
    }
    MissingPlayerReason::NoCompatibleMedia
}

pub fn missing_html_reason(row: &Observation, body: &str) -> Option<MissingPlayerReason> {
    if row.source_id == "crichd" {
        return Some(crichd_missing(row, body));
    }
    if matches!(
        row.source_id.as_str(),
        "livetv"
            | "sportsurge"
            | "methstreams"
            | "methstreams-nba"
            | "methstreams-nhl"
            | "methstreams-mlb"
            | "methstreams-f1"
            | "crackstreams-st"
            | "crackstreams-nba"
            | "crackstreams-nhl"
            | "crackstreams-mlb"
            | "crackstreams-f1"
    ) {
        return Some(generic_missing(row, body));
    }
    Some(MissingPlayerReason::NoCompatibleMedia)
}

pub fn compatible_html_players(
    game_id: &str,
    row: &Observation,
    body: &str,
    registry: &SourceRegistry,
) -> Option<Vec<ResolvedPlayer>> {
    let source = row.source_id.as_str();
    let players = if source == "livetv" {
        livetv_players(game_id, row, body)
    } else if source == "nflstreams" {
        nflstreams_players(game_id, row, body)
    } else if source.starts_with("buffstream-") || source == "crackstreams-cfb" {
        buffstream_players(game_id, row, body)
    } else if matches!(
        source,
        "streamcenter" | "streamcenter-nba" | "streamcenter-nhl" | "streamcenter-mlb"
    ) {
        streamcenter_players(game_id, row, body)
    } else if source.starts_with("methstreams") || source.starts_with("crackstreams") {
        channel_players(game_id, row, body)
    } else if vipbox_source(row) {
        vipbox_players(game_id, row, body, registry)
    } else {
        gooz_players(body)
    };
    Some(players)
}

pub fn resolved_html_players(
    game_id: &str,
    row: &Observation,
    body: &str,
) -> Option<Vec<ResolvedPlayer>> {
    (row.source_id == "crichd").then(|| crichd_players(game_id, row, body))
}

fn crichd_event_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    value == url.as_str()
        && url.scheme() == "https"
        && matches!(url.host_str(), Some("crichd.pk" | "m.crichd.pk"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && pattern!(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", url.path())
}

fn crichd_identity(row: &Observation, doc: &HtmlDoc) -> bool {
    let Some(countdown) = doc.select(".data-countdown[data-start]").first().copied() else {
        return false;
    };
    let kickoff = attr(countdown, "data-start")
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|at| at.timestamp_millis());
    let heading = doc
        .select("h1")
        .first()
        .map(|node| normalized(&text(*node)))
        .unwrap_or_default();
    let heading = heading
        .strip_suffix(" Live Streaming Online - Crichd")
        .unwrap_or(&heading);
    let teams = countdown
        .parent()
        .and_then(ElementRef::wrap)
        .into_iter()
        .flat_map(|parent| select(parent, ".flex-col.items-center > div"))
        .map(|node| text(node).trim().to_string())
        .collect::<Vec<_>>();
    crichd_event_url(&row.url)
        && kickoff == row.kickoff
        && match &row.teams {
            Some(expected) => teams.len() == 2 && teams.join("|") == expected.join("|"),
            None => heading == row.title,
        }
}

fn crichd_missing(row: &Observation, body: &str) -> MissingPlayerReason {
    let doc = HtmlDoc::parse(body);
    if doc.select("h1").is_empty() || doc.select(".data-countdown[data-start]").is_empty() {
        return MissingPlayerReason::ParserChanged;
    }
    if !crichd_identity(row, &doc) {
        return MissingPlayerReason::ConflictingGame;
    }
    if doc
        .select("a[href]")
        .iter()
        .any(|node| text(*node).trim() == "Watch")
    {
        MissingPlayerReason::UnsupportedPlayer
    } else {
        future_reason(row)
    }
}

fn crichd_players(game_id: &str, row: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    let doc = HtmlDoc::parse(body);
    if !crichd_identity(row, &doc) {
        return vec![];
    }
    let mut players = Vec::new();
    let mut keys = HashMap::new();
    for anchor in doc.select("a[href]") {
        let url = attr(anchor, "href").unwrap_or("");
        if text(anchor).trim() != "Watch" || !valid_event_page_pair(&row.url, url) {
            continue;
        }
        let key =
            serde_json::to_string(&(game_id, "crichd", &row.url, url)).expect("string identity");
        let player = ResolvedPlayer {
            id: player_id("event-page", &key),
            label: format!("CricHD · Link {}", players.len() + 1),
            locator: CandidateLocator::EventPage {
                game_id: game_id.into(),
                event_url: row.url.clone(),
                server_url: url.into(),
            },
        };
        if let Some(index) = keys.get(url) {
            players[*index] = player;
        } else {
            keys.insert(url.to_string(), players.len());
            players.push(player);
        }
    }
    players
}

fn streamcenter_players(game_id: &str, row: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    let Ok(url) = Url::parse(&row.url) else {
        return vec![];
    };
    let link = cached_regex!(r"^/api/stream-link/iframe/event-espn-league-(football-college-football|basketball-(?:nba|wnba)|hockey-nhl|baseball-mlb)-(\d{5,12})/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$").unwrap();
    let Some(link) = link.captures(url.path()) else {
        return vec![];
    };
    let league = match &link[1] {
        "football-college-football" => "ncaaf",
        "hockey-nhl" => "nhl",
        "baseball-mlb" => "mlb",
        "basketball-nba" => "nba",
        "basketball-wnba" => "wnba",
        _ => return vec![],
    };
    if game_id != format!("{}-{}", league, &link[2]) {
        return vec![];
    }
    let doc = HtmlDoc::parse(body);
    let player = cached_regex!(
        r"^(?:https:)?//streame\.center/embed/(?:hls|hls2)\.php\?stream=[A-Za-z0-9]{1,40}$",
    )
    .unwrap();
    if !doc
        .select("iframe[src]")
        .iter()
        .any(|node| attr(*node, "src").is_some_and(|url| player.is_match(url)))
    {
        return vec![];
    }
    let locator_league = match league {
        "nba" => Some(League::Nba),
        "wnba" => Some(League::Wnba),
        "nhl" => Some(League::Nhl),
        "mlb" => Some(League::Mlb),
        _ => None,
    };
    vec![ResolvedPlayer {
        id: format!("streamcenter-{}-{}", &link[2], &link[3]),
        label: "Streamcenter".into(),
        locator: CandidateLocator::Streamcenter {
            event_id: link[2].into(),
            link_id: link[3].into(),
            league: locator_league,
        },
    }]
}

fn slug(value: &str) -> String {
    let lower = value.to_lowercase();
    let separated = cached_regex!(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&lower, "-");
    separated.trim_matches('-').to_string()
}

fn buffstream_players(game_id: &str, row: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    let league = match (&*row.source_id, row.league) {
        ("buffstream-nfl", Some(League::Nfl)) => "NFL",
        ("buffstream-cfb" | "crackstreams-cfb", Some(League::Ncaaf)) => "CFB",
        ("buffstream-nba", Some(League::Nba)) => "NBA",
        ("buffstream-nhl", Some(League::Nhl)) => "NHL",
        ("buffstream-mlb", Some(League::Mlb)) => "MLB",
        _ => return vec![],
    };
    let Some(teams) = row.teams.as_ref() else {
        return vec![];
    };
    if !row.url.starts_with(&format!(
        "https://ms.buffstream.io/{}-streams/",
        league.to_lowercase()
    )) {
        return vec![];
    }
    let doc = HtmlDoc::parse(body);
    let canonical = first_attr(&doc, "link[rel=canonical]", "href");
    if canonical.as_deref() != Some(&row.url)
        && canonical.as_deref() != Some(&row.url.replacen("https:", "http:", 1))
    {
        return vec![];
    }
    let names = teams.clone().map(|name| slug(&name));
    let mut players = Vec::new();
    let mut keys = HashMap::new();
    let number =
        cached_regex!(r"/(?:american-football|basketball|ice-hockey|baseball)/(.+)-stream-([12])$")
            .unwrap();
    for frame in doc.select("iframe[src]") {
        let server = attr(frame, "src").unwrap_or("");
        if !valid_event_page_pair(&row.url, server) {
            continue;
        }
        let Ok(url) = Url::parse(server) else {
            continue;
        };
        let Some(found) = number.captures(url.path()) else {
            continue;
        };
        if found[1] != format!("{}-vs-{}", names[0], names[1])
            && found[1] != format!("{}-vs-{}", names[1], names[0])
        {
            continue;
        }
        if let Some(player) = event_page(
            game_id,
            &row.url,
            server,
            format!("Buffstream {league} · Server {}", &found[2]),
        ) {
            if let Some(index) = keys.get(server) {
                players[*index] = player;
            } else {
                keys.insert(server.to_string(), players.len());
                players.push(player);
            }
        }
    }
    players
}

fn livetv_event_id(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if value != url.as_str()
        || url.scheme() != "https"
        || url.host_str() != Some("livetv.sx")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = cached_regex!(r"^/enx/eventinfo/([1-9]\d{0,19})_[a-z0-9_]*/$").unwrap();
    Some(path.captures(url.path())?.get(1)?.as_str().to_string())
}

fn title_teams(value: &str) -> Option<[String; 2]> {
    let delimiter = cached_regex!(r"\s*[-–—]\s*").unwrap();
    let names = delimiter.split(value).map(normalized).collect::<Vec<_>>();
    (names.len() == 2 && names.iter().all(|name| !name.is_empty()))
        .then(|| [names[0].clone(), names[1].clone()])
}

#[derive(Deserialize)]
struct LiveTeam {
    name: String,
}

#[derive(Deserialize)]
struct LiveEvent {
    #[serde(rename = "@type")]
    event_type: String,
    url: String,
    name: String,
    #[serde(rename = "startDate")]
    start_date: String,
    #[serde(rename = "broadcastOfEvent")]
    nested: LiveSport,
}

#[derive(Deserialize)]
struct LiveSport {
    #[serde(rename = "@type")]
    event_type: String,
    name: String,
    competitor: [LiveTeam; 2],
}

fn livetv_detail(row: &Observation, body: &str) -> Option<(i64, String)> {
    let id = livetv_event_id(&row.url)?;
    let teams = row.teams.as_ref()?;
    let doc = HtmlDoc::parse(body);
    let canonical_value = first_attr(&doc, "link[rel=canonical]", "href")?;
    let og_value = first_attr(&doc, "meta[property='og:url']", "content")?;
    let base = Url::parse(&row.url).ok()?;
    let canonical = base.join(&canonical_value).ok()?;
    let og = base.join(&og_value).ok()?;
    if livetv_event_id(canonical.as_str()).as_deref() != Some(&id) || og != canonical {
        return None;
    }
    let mut matches = Vec::new();
    for script in doc.select("script[type='application/ld+json']") {
        let Ok(event) = serde_json::from_str::<LiveEvent>(&text(script)) else {
            continue;
        };
        if event.event_type != "BroadcastEvent"
            || event.nested.event_type != "SportsEvent"
            || event.url.is_empty()
            || event.name.is_empty()
            || event.nested.name.is_empty()
            || event
                .nested
                .competitor
                .iter()
                .any(|team| team.name.is_empty())
            || !pattern!(
                r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$",
                &event.start_date,
            )
        {
            continue;
        }
        let (Some(named), Some(nested)) =
            (title_teams(&event.name), title_teams(&event.nested.name))
        else {
            continue;
        };
        let competitor = [
            &event.nested.competitor[0].name,
            &event.nested.competitor[1].name,
        ]
        .map(|name| name.to_string());
        let Ok(event_url) = base.join(&event.url) else {
            continue;
        };
        if event_url != canonical
            || identity(&named) != identity(teams)
            || identity(&nested) != identity(teams)
            || identity(&competitor) != identity(teams)
        {
            continue;
        }
        if let Ok(date) = chrono::DateTime::parse_from_rfc3339(&event.start_date) {
            matches.push((date.timestamp_millis(), event.start_date));
        }
    }
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}

fn enrich_livetv(row: &Observation, body: &str) -> Observation {
    let Some((kickoff, raw_time)) = livetv_detail(row, body) else {
        return row.clone();
    };
    let mut enriched = row.clone();
    enriched.kickoff = Some(kickoff);
    enriched.raw_time = raw_time;
    enriched
}

fn livetv_players(game_id: &str, row: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    let Some((kickoff, _)) = livetv_detail(row, body) else {
        return vec![];
    };
    if row.kickoff != Some(kickoff) {
        return vec![];
    }
    let doc = HtmlDoc::parse(body);
    let Ok(base) = Url::parse(&row.url) else {
        return vec![];
    };
    let Some(event_id) = livetv_event_id(&row.url) else {
        return vec![];
    };
    let mut players = Vec::new();
    let mut seen = HashSet::new();
    for anchor in doc.select("a[href]") {
        let Some(url) = attr(anchor, "href").and_then(|href| base.join(href).ok()) else {
            continue;
        };
        if !valid_event_page_pair(&row.url, url.as_str()) || !seen.insert(url.to_string()) {
            continue;
        }
        let Some(id) = url
            .query_pairs()
            .find(|(name, _)| name == "c")
            .map(|(_, value)| value.to_string())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        players.push(ResolvedPlayer {
            id: format!("livetv:{event_id}:{id}"),
            label: format!("LiveTV · Server {}", players.len() + 1),
            locator: CandidateLocator::EventPage {
                game_id: game_id.into(),
                event_url: row.url.clone(),
                server_url: url.to_string(),
            },
        });
    }
    players
}

fn nfl_team_url(value: &str, base: &str) -> Option<String> {
    let base = Url::parse(base).ok()?;
    let url = base.join(value).ok()?;
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

fn nfl_published_time(raw: &str, dates: &[String]) -> Option<i64> {
    if !pattern!(r"^\d{13}$", raw) || dates.is_empty() {
        return None;
    }
    let kickoff: i64 = raw.parse().ok()?;
    if !(1_577_836_800_000..=4_102_444_800_000).contains(&kickoff) {
        return None;
    }
    if dates.iter().any(|date| {
        !pattern!(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", date)
            || chrono::DateTime::parse_from_rfc3339(date)
                .ok()
                .map(|value| value.timestamp_millis())
                != Some(kickoff)
    }) {
        return None;
    }
    Some(kickoff)
}

fn nfl_active_detail(row: &Observation, body: &str) -> bool {
    let (Some(teams), Some(kickoff)) = (&row.teams, row.kickoff) else {
        return false;
    };
    if nfl_team_url(&row.url, &row.url).is_none() {
        return false;
    }
    let doc = HtmlDoc::parse(body);
    if first_attr(&doc, "link[rel=canonical]", "href").as_deref() != Some(&row.url)
        || first_attr(&doc, "meta[property='og:url']", "content").as_deref() != Some(&row.url)
    {
        return false;
    }
    let active = doc.select(".home__team-fixture-matche.fixture-active");
    if active.len() != 1 {
        return false;
    }
    let node = active[0];
    if attr(node, "href")
        .and_then(|href| nfl_team_url(href, &row.url))
        .as_deref()
        != Some(&row.url)
        || attr(node, "data-away-slug") != Some(slug(&teams[0]).as_str())
        || attr(node, "data-home-slug") != Some(slug(&teams[1]).as_str())
        || !attr(node, "data-espn-id").is_some_and(|id| pattern!(r"^\d{5,12}$", id))
    {
        return false;
    }
    let dates = select(node, "[datetime],[data-datetime]")
        .into_iter()
        .map(|node| {
            attr(node, "datetime")
                .or_else(|| attr(node, "data-datetime"))
                .unwrap_or("")
                .to_string()
        })
        .collect::<Vec<_>>();
    nfl_published_time(attr(node, "data-kickoff-ts").unwrap_or(""), &dates) == Some(kickoff)
}

fn nflstreams_players(game_id: &str, row: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    if !nfl_active_detail(row, body) {
        return vec![];
    }
    let doc = HtmlDoc::parse(body);
    let tab = cached_regex!(r"^player([1-6])$").unwrap();
    let mut players: Vec<ResolvedPlayer> = Vec::new();
    let mut numbers: HashMap<u8, usize> = HashMap::new();
    for anchor in doc.select(".theatre1 a[data-tab]") {
        let Some(number) = attr(anchor, "data-tab")
            .and_then(|value| tab.captures(value))
            .and_then(|match_| match_[1].parse::<u8>().ok())
        else {
            continue;
        };
        if normalized(&text(anchor)) != format!("Link {number}") {
            return vec![];
        }
        let scripts = doc.select(&format!("#tab-{number} script[type='text/template']"));
        if scripts.len() != 1 {
            return vec![];
        }
        let fragment = HtmlDoc::parse(&text(scripts[0]));
        let frames = fragment.select("iframe[src]");
        if frames.len() != 1 {
            return vec![];
        }
        let server = attr(frames[0], "src").unwrap_or("");
        let Some(player) = event_page(
            game_id,
            &row.url,
            server,
            format!("NFLStreams · Link {number}"),
        ) else {
            return vec![];
        };
        if let Some(index) = numbers.get(&number) {
            if players[*index].locator != player.locator {
                return vec![];
            }
            players[*index] = player;
        } else {
            numbers.insert(number, players.len());
            players.push(player);
        }
    }
    players
}

#[derive(Deserialize)]
struct ChannelTeam {
    name: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
enum Price {
    Text(String),
    Number(f64),
}

#[derive(Deserialize)]
struct ChannelOffer {
    price: Price,
}

#[derive(Deserialize)]
struct ChannelEvent {
    #[serde(rename = "@type")]
    event_type: String,
    url: String,
    name: String,
    #[serde(rename = "startDate")]
    start_date: String,
    offers: ChannelOffer,
    sport: Option<String>,
    #[serde(rename = "homeTeam")]
    home_team: Option<ChannelTeam>,
    #[serde(rename = "awayTeam")]
    away_team: Option<ChannelTeam>,
    performer: Option<Vec<ChannelTeam>>,
}

fn valid_channel_event(event: &ChannelEvent) -> bool {
    let _ = &event.offers.price;
    event.event_type == "SportsEvent"
        && Url::parse(&event.url).is_ok()
        && match (&event.home_team, &event.away_team, &event.performer) {
            (Some(_), Some(_), _) => true,
            (None, None, Some(performer)) => performer.len() == 1,
            _ => false,
        }
}

fn channel_players(game_id: &str, row: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    let host = if row.source_id.starts_with("methstreams") {
        "methstreams.st"
    } else {
        "crackstreams.st"
    };
    let Ok(event_url) = Url::parse(&row.url) else {
        return vec![];
    };
    if event_url.host_str() != Some(host)
        || row.kickoff.is_none()
        || row.teams.is_none()
            && !matches!(
                row.league,
                Some(
                    League::F1
                        | League::NascarCup
                        | League::NascarTruck
                        | League::Motogp
                        | League::Motorsport
                )
            )
    {
        return vec![];
    }
    let doc = HtmlDoc::parse(body);
    if first_attr(&doc, "link[rel=canonical]", "href").as_deref() != Some(row.url.as_str())
        || first_attr(&doc, "meta[property='og:url']", "content").as_deref()
            != Some(row.url.as_str())
    {
        return vec![];
    }
    let events = doc
        .select("script[type='application/ld+json']")
        .into_iter()
        .filter_map(|script| serde_json::from_str::<ChannelEvent>(&text(script)).ok())
        .filter(valid_channel_event)
        .collect::<Vec<_>>();
    let event = events.into_iter().find(|event| {
        if event.url != row.url
            || chrono::DateTime::parse_from_rfc3339(&event.start_date)
                .ok()
                .map(|date| date.timestamp_millis())
                != row.kickoff
        {
            return false;
        }
        match &row.teams {
            None => {
                event.name == row.title
                    && event.home_team.is_none()
                    && event.away_team.is_none()
                    && event.performer.as_ref().is_some_and(|performer| {
                        performer.len() == 1 && performer[0].name == event.name
                    })
                    && event.sport.as_deref()
                        == Some(match row.league {
                            Some(League::F1) => "Formula 1",
                            Some(League::Motogp) => "MotoGP",
                            Some(League::NascarCup) => "NASCAR Cup Series",
                            Some(League::NascarTruck) => "NASCAR Truck Series",
                            _ => "Motorsport",
                        })
            }
            Some(teams) => {
                let name = if row.league == Some(League::Mlb) {
                    cached_regex!(r"(?i)\s*\((?:ALDS|NLDS|ALCS|NLCS|World Series) Game \d+\)\s*$")
                        .unwrap()
                        .replace(&event.name, "")
                        .to_string()
                } else {
                    event.name.clone()
                };
                let Some(named) = catalog_teams(&name) else {
                    return false;
                };
                if identity(&named) != identity(teams) {
                    return false;
                }
                match (&event.home_team, &event.away_team, &event.performer) {
                    (Some(home), Some(away), _) => {
                        identity(&[home.name.clone(), away.name.clone()]) == identity(teams)
                    }
                    (_, _, Some(performer)) => performer
                        .first()
                        .is_some_and(|team| team.name == event.name),
                    _ => false,
                }
            }
        }
    });
    let Some(event) = event else {
        return vec![];
    };
    let mut players = Vec::new();
    let mut keys = HashMap::new();
    for link in doc.select("a.sl-row[href]") {
        let label = select(link, ".sl-nm")
            .first()
            .map(|node| text(*node).trim().to_string())
            .unwrap_or_default();
        if label.is_empty()
            || !attr(link, "aria-label").is_some_and(|value| {
                value.starts_with(&format!("Watch {} on {label} ", event.name))
            })
        {
            continue;
        }
        let url = attr(link, "href").unwrap_or("");
        let name = if row.source_id.starts_with("methstreams") {
            "Methstreams"
        } else {
            "Crackstreams"
        };
        if let Some(player) = event_page(game_id, &row.url, url, format!("{name} · {label}")) {
            if let Some(index) = keys.get(url) {
                players[*index] = player;
            } else {
                keys.insert(url.to_string(), players.len());
                players.push(player);
            }
        }
    }
    players
}

fn vipbox_page_teams(row: &Observation, doc: &HtmlDoc) -> Option<[String; 2]> {
    let title = doc
        .select("h1")
        .first()
        .map(|node| clean_text(*node))
        .unwrap_or_default();
    let matcher = if row.source_id.starts_with("vipbox-") {
        cached_regex!(r"(?i)^(.*?) Streaming Online$").unwrap()
    } else if row.source_id.starts_with("vipboxtv-") {
        cached_regex!(r"(?i)^Watch (.*?) Online$").unwrap()
    } else if row.source_id.starts_with("strikeout-") {
        cached_regex!(r"(?i)^Live (.*?) Streams Online$").unwrap()
    } else {
        cached_regex!(r"(?i)^MLB Live: (.*?) Online$").unwrap()
    };
    let matched = matcher.captures(&title)?.get(1)?.as_str();
    let matchup = if matches!(row.source_id.as_str(), "vipbox-nfl" | "strikeout-nfl") {
        matched
            .strip_prefix("MNF with Peyton and Eli-")
            .unwrap_or(matched)
    } else {
        matched
    };
    let divider = cached_regex!(r"(?i)\s+vs\.?\s+").unwrap();
    let names = divider.split(matchup).map(str::trim).collect::<Vec<_>>();
    (names.len() == 2 && names.iter().all(|name| !name.is_empty()))
        .then(|| [names[0].to_string(), names[1].to_string()])
}

fn vipbox_players(
    game_id: &str,
    row: &Observation,
    body: &str,
    registry: &SourceRegistry,
) -> Vec<ResolvedPlayer> {
    let generic = gooz_players(body);
    let doc = HtmlDoc::parse(body);
    let config = vipbox_config(body);
    let kickoff = vipbox_kickoff(&config).map(|(_, at)| at);
    let teams = vipbox_page_teams(row, &doc);
    if first_attr(&doc, "meta[property='og:url']", "content").as_deref() != Some(row.url.as_str())
        || !pattern!(r#""loaded_page"\s*:\s*"stream""#, &config)
        || kickoff != row.kickoff
        || teams
            .as_ref()
            .zip(row.teams.as_ref())
            .is_none_or(|(page, expected)| identity(page) != identity(expected))
    {
        return if row.source_id == "mlbbox-mlb" {
            vec![]
        } else {
            generic
        };
    }
    let mut pages = Vec::new();
    let mut keys = HashMap::new();
    if row.source_id == "mlbbox-mlb" {
        let embed = cached_regex!(
            r#"(?i)<iframe\b[^>]*\bsrc=['"](https://embedsports\.me/baseball/[a-z0-9-]+)['"][^>]*>"#
        )
        .unwrap();
        for textarea in doc.select("textarea") {
            let content = text(textarea);
            let Some(url) = embed.captures(&content).and_then(|match_| match_.get(1)) else {
                continue;
            };
            if let Some(player) = event_page(game_id, &row.url, url.as_str(), "MLBBox".into()) {
                if let Some(index) = keys.get(url.as_str()) {
                    pages[*index] = player;
                } else {
                    keys.insert(url.as_str().to_string(), pages.len());
                    pages.push(player);
                }
            }
        }
    }
    let Ok(base) = Url::parse(&row.url) else {
        return generic;
    };
    let name = registry
        .get(&row.source_id)
        .and_then(|source| source.name.clone())
        .unwrap_or_else(|| row.source_id.replace('-', " "));
    for node in doc.select("[data-uri]") {
        let label = clean_text(node);
        let Some(url) = attr(node, "data-uri").and_then(|value| base.join(value).ok()) else {
            continue;
        };
        if let Some(player) =
            event_page(game_id, &row.url, url.as_str(), format!("{name} · {label}"))
        {
            if let Some(index) = keys.get(url.as_str()) {
                pages[*index] = player;
            } else {
                keys.insert(url.to_string(), pages.len());
                pages.push(player);
            }
        }
    }
    pages.extend(generic);
    pages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_details_match_the_frozen_collector() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        for case in [
            "sportsurge",
            "buffstream",
            "livetv",
            "vipbox",
            "nflstreams",
            "event",
            "motorsports",
            "streamcenter",
            "crichd",
        ] {
            let input = golden["inputs"]["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == case)
                .unwrap();
            let expected = &golden["expected"]["listings"][case];
            let enriched: Observation =
                serde_json::from_value(expected["enriched"].clone()).unwrap();
            let parsed: crate::types::ListingResult =
                serde_json::from_value(expected["parsed"].clone()).unwrap();
            let original = parsed
                .observations
                .iter()
                .find(|row| row.id == enriched.id)
                .unwrap();
            let body = input["detail"].as_str().unwrap();
            let game_id = input["gameId"].as_str().unwrap_or("ncaaf-1");
            assert_eq!(
                enrich_html_observation(original, body),
                Some(enriched.clone()),
                "{case} enriched"
            );
            let compatible = compatible_html_players(game_id, &enriched, body, &registry).unwrap();
            assert_eq!(
                serde_json::to_value(compatible).unwrap(),
                expected["compatible"],
                "{case} compatible"
            );
            assert_eq!(
                serde_json::to_value(missing_html_reason(&enriched, body).unwrap()).unwrap(),
                expected["missing"],
                "{case} missing"
            );
            if let Some(resolved) = resolved_html_players(game_id, &enriched, body) {
                assert_eq!(
                    serde_json::to_value(resolved).unwrap(),
                    expected["resolved"],
                    "{case} resolved"
                );
            }
        }
    }

    #[test]
    fn published_buffstream_and_channel_links_keep_game_identity() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let buff: Observation = serde_json::from_value(
            golden["expected"]["listings"]["buffstream"]["enriched"].clone(),
        )
        .unwrap();
        let server = "https://embedsports.me/american-football/montana-state-vs-idaho-stream-1";
        let body = format!(
            "<link rel='canonical' href='{}'><iframe src='{server}'></iframe><iframe src='{server}'></iframe>",
            buff.url
        );
        let players = compatible_html_players("ncaaf-1", &buff, &body, &registry).unwrap();
        assert_eq!(players.len(), 1);
        assert_eq!(players[0].label, "Buffstream CFB · Server 1");
        assert!(
            matches!(&players[0].locator, CandidateLocator::EventPage { server_url, .. } if server_url == server)
        );
        assert!(
            compatible_html_players(
                "ncaaf-1",
                &buff,
                &body.replace("montana-state-vs-idaho", "montana-state-vs-other"),
                &registry
            )
            .unwrap()
            .is_empty()
        );

        let channel: Observation =
            serde_json::from_value(golden["expected"]["listings"]["event"]["enriched"].clone())
                .unwrap();
        let stream = "https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005";
        let event = serde_json::json!({
            "@type":"SportsEvent", "url":channel.url, "name":channel.title,
            "startDate":"2026-10-05T00:20:00Z", "offers":{"price":0},
            "homeTeam":{"name":"Carolina Panthers"}, "awayTeam":{"name":"Detroit Lions"}
        });
        let body = format!(
            "<link rel='canonical' href='{}'><meta property='og:url' content='{}'><script type='application/ld+json'>{event}</script><a class='sl-row' href='{stream}' aria-label='Watch Detroit Lions vs Carolina Panthers on Server 1 free'><span class='sl-nm'>Server 1</span></a>",
            channel.url, channel.url
        );
        let players = compatible_html_players("nfl-1", &channel, &body, &registry).unwrap();
        assert_eq!(players.len(), 1);
        assert_eq!(players[0].label, "Crackstreams · Server 1");
        assert!(
            matches!(&players[0].locator, CandidateLocator::EventPage { server_url, .. } if server_url == stream)
        );
        assert!(
            compatible_html_players(
                "nfl-1",
                &channel,
                &body.replace("Carolina Panthers\"", "Other Team\""),
                &registry
            )
            .unwrap()
            .is_empty()
        );
    }
}
