use crate::{
    time::digest,
    types::{League, ListingOutcome, ListingResult, ListingSource, Observation},
};
use chrono::{DateTime, LocalResult, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::America::Chicago;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const FIRST_DATE: i64 = 946_684_800_000;
const LAST_DATE: i64 = 4_102_444_800_000;
const WEEK: i64 = 7 * 86_400_000;

fn result(outcome: ListingOutcome, observations: Vec<Observation>) -> ListingResult {
    ListingResult {
        observations,
        outcome,
    }
}

fn invalid() -> ListingResult {
    result(ListingOutcome::ParserChanged, Vec::new())
}

fn complete(observations: Vec<Observation>) -> ListingResult {
    let outcome = if observations.is_empty() {
        ListingOutcome::Empty
    } else {
        ListingOutcome::Parsed
    };
    result(outcome, observations)
}

fn iso(millis: i64) -> Option<String> {
    Some(
        Utc.timestamp_millis_opt(millis)
            .single()?
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

fn words() -> &'static Regex {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    WORDS.get_or_init(|| Regex::new(r"\s+").expect("fixed whitespace expression"))
}

fn normalized(value: &str) -> String {
    words().replace_all(value, " ").trim().to_string()
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct NamedTeam {
    pub name: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Teams {
    pub home: NamedTeam,
    pub away: NamedTeam,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TvappCategory {
    AmericanFootball,
    Basketball,
    Hockey,
    Baseball,
}

#[derive(Deserialize)]
struct TvappMatch {
    id: String,
    title: String,
    category: TvappCategory,
    date: i64,
    teams: Option<Teams>,
}

pub(crate) fn catalog_teams(title: &str) -> Option<[String; 2]> {
    static DIVIDER: OnceLock<Regex> = OnceLock::new();
    let divider = DIVIDER
        .get_or_init(|| Regex::new(r"(?i)\s+(?:vs\.?|at|-)\s+").expect("fixed matchup expression"));
    let parts: Vec<String> = divider
        .split(title)
        .map(str::trim)
        .map(ToString::to_string)
        .collect();
    if parts.len() == 2 && parts.iter().all(|part| !part.is_empty()) {
        Some([parts[0].clone(), parts[1].clone()])
    } else {
        None
    }
}

fn related(left: &str, right: &str) -> bool {
    static PUNCTUATION: OnceLock<Regex> = OnceLock::new();
    let punctuation = PUNCTUATION
        .get_or_init(|| Regex::new(r"[^a-z0-9 ]").expect("fixed punctuation expression"));
    let clean = |name: &str| normalized(&punctuation.replace_all(&name.to_ascii_lowercase(), " "));
    let a = clean(left);
    let b = clean(right);
    a.contains(&b) || b.contains(&a) || same_unique_college_owner(left, right)
}

#[derive(Deserialize)]
struct CollegeAliasEntry {
    id: String,
    aliases: Vec<String>,
}

fn college_alias_owners() -> &'static HashMap<String, Option<String>> {
    static OWNERS: OnceLock<HashMap<String, Option<String>>> = OnceLock::new();
    OWNERS.get_or_init(|| {
        let text = include_str!("../../../lib/football/domain/college-teams.generated.ts");
        let start = text.find(" = [").expect("generated college catalog array") + 3;
        let end = text
            .rfind("];")
            .expect("generated college catalog terminator")
            + 1;
        let entries: Vec<CollegeAliasEntry> =
            serde_json::from_str(&text[start..end]).expect("generated college catalog JSON array");
        let mut owners = HashMap::<String, Option<String>>::new();
        for team in entries {
            for alias in team.aliases {
                let name = normalized(&alias.to_lowercase());
                match owners.get(&name) {
                    None => {
                        owners.insert(name, Some(team.id.clone()));
                    }
                    Some(Some(owner)) if owner == &team.id => {}
                    Some(_) => {
                        owners.insert(name, None);
                    }
                }
            }
        }
        owners
    })
}

fn same_unique_college_owner(left: &str, right: &str) -> bool {
    let owners = college_alias_owners();
    let left = owners.get(&normalized(&left.to_lowercase()));
    let right = owners.get(&normalized(&right.to_lowercase()));
    matches!((left, right), (Some(Some(a)), Some(Some(b))) if a == b)
}

pub(crate) fn preferred_catalog_teams(
    title: &str,
    structured: Option<[String; 2]>,
) -> Option<[String; 2]> {
    let titled = catalog_teams(title);
    let (Some(titled), Some(structured)) = (titled.clone(), structured.clone()) else {
        return titled.or(structured);
    };
    let aligned = (related(&titled[0], &structured[0]) && related(&titled[1], &structured[1]))
        || (related(&titled[0], &structured[1]) && related(&titled[1], &structured[0]));
    if !aligned {
        return None;
    }
    if titled.join("").encode_utf16().count() > structured.join("").encode_utf16().count() {
        Some(titled)
    } else {
        Some(structured)
    }
}

fn add(
    rows: &mut Vec<Observation>,
    indices: &mut HashMap<String, usize>,
    row: Observation,
) -> bool {
    if let Some(index) = indices.get(&row.id) {
        let previous = &rows[*index];
        let teams_identity =
            |teams: &Option<[String; 2]>| teams.as_ref().map(|pair| pair.join("|"));
        if previous.title != row.title
            || previous.kickoff != row.kickoff
            || previous.url != row.url
            || teams_identity(&previous.teams) != teams_identity(&row.teams)
        {
            return false;
        }
        rows[*index] = row;
    } else {
        indices.insert(row.id.clone(), rows.len());
        rows.push(row);
    }
    true
}

fn parse_tvapp(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let Ok(input) = serde_json::from_str::<Vec<TvappMatch>>(body) else {
        return invalid();
    };
    let mut observations = Vec::new();
    let mut indices = HashMap::new();
    for event in input {
        if event.id.is_empty()
            || event.title.is_empty()
            || event
                .teams
                .as_ref()
                .is_some_and(|teams| teams.home.name.is_empty() || teams.away.name.is_empty())
        {
            return invalid();
        }
        if matches!(
            (&*event.id, &*event.title, event.date),
            ("ppv-nfl-network", "NFL Network", 0)
                | ("ppv-nhl-network", "NHL Network", 0)
                | ("nflstreams_live", "NFL Streams Schedule", 0)
        ) {
            continue;
        }
        let category = match source.id.as_str() {
            "tvapp-nba" => TvappCategory::Basketball,
            "tvapp-nhl" => TvappCategory::Hockey,
            "tvapp-mlb" => TvappCategory::Baseball,
            _ => TvappCategory::AmericanFootball,
        };
        if std::mem::discriminant(&event.category) != std::mem::discriminant(&category) {
            continue;
        }
        if !(FIRST_DATE..LAST_DATE).contains(&event.date) {
            return invalid();
        }
        if event.date > now + WEEK {
            continue;
        }
        let title = normalized(&event.title);
        let structured = event.teams.map(|teams| {
            [
                teams.home.name.trim().to_string(),
                teams.away.name.trim().to_string(),
            ]
        });
        let teams = preferred_catalog_teams(&title, structured);
        if teams.is_none() && catalog_teams(&title).is_none() {
            continue;
        }
        let slug = if event.id.starts_with("ppv-")
            || event.id.bytes().all(|byte| byte.is_ascii_digit())
        {
            event.id.as_str()
        } else {
            event
                .id
                .rsplit_once('-')
                .map(|(_, tail)| tail)
                .filter(|tail| !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()))
                .unwrap_or("")
        };
        if slug.is_empty()
            || slug.len() > 120
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return invalid();
        }
        let league = match source.id.as_str() {
            "tvapp-mlb" => Some(League::Mlb),
            "tvapp-nhl" if event.id.starts_with("live_ncaa-women_") => Some(League::Ncaawh),
            "tvapp-nhl" if event.id.starts_with("live_college_") => Some(League::Ncaah),
            _ => None,
        };
        let Some(raw_time) = iso(event.date) else {
            return invalid();
        };
        let row = Observation {
            id: format!("{}:{}", source.id, digest(&event.id)),
            source_id: source.id.clone(),
            url: format!("https://tvapp1.pk/watch/{slug}"),
            title,
            teams,
            league,
            kickoff: Some(event.date),
            raw_time,
            observed_at: now,
            parser_version: 3,
            legacy_id: None,
            kickoff_lineage: None,
        };
        if !add(&mut observations, &mut indices, row) {
            return invalid();
        }
    }
    complete(observations)
}

#[derive(Deserialize)]
struct PpvCatalog {
    success: bool,
    streams: Vec<PpvGroup>,
}

#[derive(Deserialize)]
struct PpvGroup {
    category: String,
    streams: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct PpvEvent {
    id: i64,
    name: String,
    tag: String,
    uri_name: String,
    starts_at: i64,
}

fn parse_ppv(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let Ok(catalog) = serde_json::from_str::<PpvCatalog>(body) else {
        return invalid();
    };
    if !catalog.success {
        return invalid();
    }
    let mut categories = HashSet::new();
    let mut observations = Vec::new();
    let mut indices = HashMap::new();
    for group in catalog.streams {
        if !matches!(
            group.category.as_str(),
            "American Football" | "Basketball" | "Ice Hockey" | "Baseball" | "Motorsports"
        ) {
            continue;
        }
        if !categories.insert(group.category) {
            return invalid();
        }
        for value in group.streams {
            let Ok(event) = serde_json::from_value::<PpvEvent>(value) else {
                return invalid();
            };
            if event.id <= 0 || event.name.is_empty() {
                return invalid();
            }
            let league = match event.tag.as_str() {
                "College Football" => League::Ncaaf,
                "NFL" => League::Nfl,
                "NBA" => League::Nba,
                "WNBA" => League::Wnba,
                "NHL" => League::Nhl,
                "MLB" => League::Mlb,
                "Formula 1" => League::F1,
                _ => continue,
            };
            let prefix = match league {
                League::Ncaaf => "cfb",
                League::Nfl => "nfl",
                League::Nba => "nba",
                League::Wnba => "wnba",
                League::Nhl => "nhl",
                League::Mlb => "mlb",
                League::F1 => "f1",
                _ => unreachable!(),
            };
            if !event.uri_name.starts_with(&format!("{prefix}/")) {
                continue;
            }
            if !valid_ppv_path(&event.uri_name, league) {
                return invalid();
            }
            if event.starts_at <= 0 {
                continue;
            }
            let Some(kickoff) = event.starts_at.checked_mul(1000) else {
                return invalid();
            };
            if !(FIRST_DATE..LAST_DATE).contains(&kickoff) {
                return invalid();
            }
            if kickoff > now + WEEK {
                continue;
            }
            let title = normalized(&event.name);
            let teams = if league == League::F1 {
                None
            } else {
                catalog_teams(&title).map(|pair| {
                    if title.to_ascii_lowercase().contains(" at ") {
                        [pair[1].clone(), pair[0].clone()]
                    } else {
                        pair
                    }
                })
            };
            let Some(raw_time) = iso(kickoff) else {
                return invalid();
            };
            let row = Observation {
                id: format!("{}:{}", source.id, event.id),
                source_id: source.id.clone(),
                url: format!("https://ppv.st/live/{}", event.uri_name),
                title,
                teams,
                league: Some(league),
                kickoff: Some(kickoff),
                raw_time,
                observed_at: now,
                parser_version: 2,
                legacy_id: None,
                kickoff_lineage: None,
            };
            if !add(&mut observations, &mut indices, row) {
                return invalid();
            }
        }
    }
    if categories.is_empty() {
        return invalid();
    }
    complete(observations)
}

fn valid_ppv_path(path: &str, league: League) -> bool {
    static NORMAL: OnceLock<Regex> = OnceLock::new();
    static F1: OnceLock<Regex> = OnceLock::new();
    let normal = NORMAL.get_or_init(|| {
        Regex::new(r"^(?:cfb|nfl|nba|wnba|nhl|mlb)/\d{4}-\d{2}-\d{2}/[a-z0-9-]+$")
            .expect("fixed PPV route")
    });
    let f1 = F1.get_or_init(|| {
        Regex::new(r"^f1/\d{4}/[a-z0-9-]+/(?:fp[123]|sprint-q|sprint|qualifying|race)$")
            .expect("fixed F1 route")
    });
    if league == League::F1 {
        f1.is_match(path)
    } else {
        normal.is_match(path)
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct StreamRef {
    pub source: String,
    pub id: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct StreamedEvent {
    pub id: String,
    pub title: String,
    pub category: String,
    pub date: i64,
    pub teams: Option<Teams>,
    pub sources: Vec<StreamRef>,
}

pub(crate) fn valid_streamed_event(event: &StreamedEvent) -> bool {
    !event.id.is_empty()
        && event.id.len() <= 160
        && !event.title.is_empty()
        && event
            .teams
            .as_ref()
            .is_none_or(|teams| !teams.home.name.is_empty() && !teams.away.name.is_empty())
        && event.sources.iter().all(|reference| {
            !reference.source.is_empty()
                && reference.source.len() <= 40
                && !reference.id.is_empty()
                && reference.id.len() <= 160
        })
}

pub(crate) fn valid_streamed_id(id: &str) -> bool {
    static ID: OnceLock<Regex> = OnceLock::new();
    ID.get_or_init(|| {
        Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$").expect("fixed event ID expression")
    })
    .is_match(id)
}

pub(crate) fn streamed_event_url(source_id: &str, id: &str) -> String {
    if source_id == "streamed" {
        format!("https://streamed.st/watch/{id}")
    } else {
        format!("https://api.kultsport.com/api/matches/all#{id}")
    }
}

fn streamed_league(category: &str, title: &str) -> Option<League> {
    if category != "motor-sports" {
        return None;
    }
    let label = title.to_ascii_lowercase();
    if label.starts_with("formula 1") || label.starts_with("f1 ") {
        Some(League::F1)
    } else if label.contains("motogp") {
        Some(League::Motogp)
    } else if ["supercars", "super formula", "elms", "moto2", "moto3"]
        .iter()
        .any(|word| label.contains(word))
    {
        Some(League::Motorsport)
    } else {
        None
    }
}

fn parse_streamed(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let Ok(events) = serde_json::from_str::<Vec<StreamedEvent>>(body) else {
        return invalid();
    };
    let mut observations = Vec::new();
    let mut seen = HashMap::<String, (String, i64, Option<[String; 2]>)>::new();
    for event in events {
        if !valid_streamed_event(&event) {
            return invalid();
        }
        if event.date < FIRST_DATE || event.date > now + WEEK || !valid_streamed_id(&event.id) {
            continue;
        }
        let teams = event
            .teams
            .as_ref()
            .map(|teams| [teams.home.name.clone(), teams.away.name.clone()]);
        let key = (event.title.clone(), event.date, teams.clone());
        if let Some(previous) = seen.get(&event.id) {
            if previous != &key {
                return invalid();
            }
            continue;
        }
        seen.insert(event.id.clone(), key);
        let title = event.title.trim().to_string();
        let league = streamed_league(&event.category, &title);
        if teams.is_none() && league.is_none() {
            continue;
        }
        let Some(raw_time) = iso(event.date) else {
            return invalid();
        };
        observations.push(Observation {
            id: format!("{}:{}", source.id, event.id),
            source_id: source.id.clone(),
            url: streamed_event_url(&source.id, &event.id),
            title,
            teams,
            league,
            kickoff: Some(event.date),
            raw_time,
            observed_at: now,
            parser_version: 1,
            legacy_id: None,
            kickoff_lineage: None,
        });
    }
    complete(observations)
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SportsbiteStream {
    pub id: String,
    #[serde(rename = "manifest_url")]
    pub manifest_url: String,
    pub format: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SportsbiteEvent {
    pub event_key: String,
    pub title: String,
    pub start: String,
    #[serde(rename = "kickoffMs")]
    pub kickoff_ms: i64,
    pub category: String,
    pub teams: Option<Teams>,
    pub streams: Vec<SportsbiteStream>,
}

pub(crate) fn valid_sportsbite_event(event: &SportsbiteEvent) -> bool {
    !event.title.is_empty()
        && event
            .teams
            .as_ref()
            .is_none_or(|teams| !teams.home.name.is_empty() && !teams.away.name.is_empty())
        && event
            .streams
            .iter()
            .all(|stream| url::Url::parse(&stream.manifest_url).is_ok())
}

#[derive(Deserialize)]
struct SportsbiteDay {
    date: String,
    events: Vec<SportsbiteEvent>,
}

#[derive(Deserialize)]
struct SportsbiteCatalog {
    scraped_at: String,
    days: Vec<SportsbiteDay>,
}

pub(crate) fn sportsbite_event_url(key: &str) -> Option<String> {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| {
        Regex::new(r"^fg-[a-z0-9]+(?:-[a-z0-9]+)*$").expect("fixed SportsBite key expression")
    })
    .is_match(key)
    .then(|| format!("https://sportsbite.org/event/{key}"))
}

fn sportsbite_league(event: &SportsbiteEvent) -> Option<League> {
    if event.category != "motor-sports" {
        return None;
    }
    let title = event.title.to_ascii_lowercase();
    if title.starts_with("f1 ")
        || title.starts_with("formula 1")
        || title.starts_with("singapore grand prix")
    {
        Some(League::F1)
    } else if title.contains("motogp") {
        Some(League::Motogp)
    } else if title.starts_with("nascar") {
        if title.contains(" cup ") {
            Some(League::NascarCup)
        } else if title.contains(" truck ") {
            Some(League::NascarTruck)
        } else {
            Some(League::Motorsport)
        }
    } else if ["supercars", "super formula", "elms", "moto2", "moto3"]
        .iter()
        .any(|word| title.contains(word))
    {
        Some(League::Motorsport)
    } else {
        None
    }
}

fn parse_sportsbite(body: &str, now: i64) -> ListingResult {
    let Ok(catalog) = serde_json::from_str::<SportsbiteCatalog>(body) else {
        return invalid();
    };
    static SCRAPE: OnceLock<Regex> = OnceLock::new();
    if !SCRAPE
        .get_or_init(|| {
            Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
                .expect("fixed scrape time expression")
        })
        .is_match(&catalog.scraped_at)
    {
        return invalid();
    }
    let Some(scraped_at) = DateTime::parse_from_rfc3339(&catalog.scraped_at)
        .ok()
        .map(|date| date.timestamp_millis())
    else {
        return invalid();
    };
    if scraped_at > now + 60_000 || now - scraped_at >= 30 * 60_000 {
        return invalid();
    }
    let mut observations = Vec::new();
    let mut seen = HashMap::<String, (String, i64, Option<[String; 2]>)>::new();
    for day in catalog.days {
        let _ = day.date;
        for event in day.events {
            if !valid_sportsbite_event(&event) {
                return invalid();
            }
            if event.kickoff_ms < FIRST_DATE || event.kickoff_ms > now + WEEK {
                continue;
            }
            let Some(url) = sportsbite_event_url(&event.event_key) else {
                return invalid();
            };
            if DateTime::parse_from_rfc3339(&event.start)
                .ok()
                .map(|date| date.timestamp_millis())
                != Some(event.kickoff_ms)
            {
                return invalid();
            }
            let teams = event
                .teams
                .as_ref()
                .map(|teams| [teams.home.name.clone(), teams.away.name.clone()]);
            let league = sportsbite_league(&event);
            if teams.is_none() && league.is_none() {
                continue;
            }
            let key = (event.title.clone(), event.kickoff_ms, teams.clone());
            if let Some(previous) = seen.get(&event.event_key) {
                if previous != &key {
                    return invalid();
                }
                continue;
            }
            seen.insert(event.event_key.clone(), key);
            observations.push(Observation {
                id: format!("sportsbite:{}", event.event_key),
                source_id: "sportsbite".to_string(),
                url,
                title: event.title,
                teams,
                league,
                kickoff: Some(event.kickoff_ms),
                raw_time: event.start,
                observed_at: now,
                parser_version: 1,
                legacy_id: None,
                kickoff_lineage: None,
            });
        }
    }
    complete(observations)
}

#[derive(Deserialize)]
pub(crate) struct SwacEvent {
    pub id: String,
    title: String,
    #[serde(rename = "type")]
    event_type: String,
    live: bool,
    #[serde(rename = "freeBehavior")]
    free_behavior: String,
    description: String,
    #[serde(rename = "goLiveTime")]
    go_live_time: Option<String>,
}

pub(crate) fn swac_matchup(event: &SwacEvent) -> Option<([String; 2], i64)> {
    static ID: OnceLock<Regex> = OnceLock::new();
    static TITLE: OnceLock<Regex> = OnceLock::new();
    static TIME: OnceLock<Regex> = OnceLock::new();
    if !ID
        .get_or_init(|| Regex::new(r"^[a-f0-9]{32}$").expect("fixed SWAC ID expression"))
        .is_match(&event.id)
        || event.event_type != "video"
        || !event.live
        || !matches!(event.free_behavior.as_str(), "allow" | "allow_ads")
    {
        return None;
    }
    let title = TITLE
        .get_or_init(|| {
            Regex::new(r"^Football \((\d{1,2})/(\d{1,2})/(\d{2})\) (.+?) vs (.+?)\s*$")
                .expect("fixed SWAC title expression")
        })
        .captures(&event.title)?;
    let time = TIME
        .get_or_init(|| {
            Regex::new(
                r"^([A-Za-z]+)\s+(\d{1,2}),\s+(20\d{2})\s*\|\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+CT\b",
            )
            .expect("fixed SWAC time expression")
        })
        .captures(event.description.trim())?;
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let month = MONTHS.iter().position(|value| *value == &time[1])? as u32 + 1;
    let day: u32 = time[2].parse().ok()?;
    let year: i32 = time[3].parse().ok()?;
    let hour: u32 = time[4].parse().ok()?;
    let minute: u32 = time[5].parse().ok()?;
    if title[1].parse::<u32>().ok()? != month
        || title[2].parse::<u32>().ok()? != day
        || 2000 + title[3].parse::<i32>().ok()? != year
        || !(1..=12).contains(&hour)
        || minute > 59
    {
        return None;
    }
    let hour24 = hour % 12 + if &time[6] == "PM" { 12 } else { 0 };
    let local = NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour24, minute, 0)?;
    let kickoff = match Chicago.from_local_datetime(&local) {
        LocalResult::Single(date) => date.timestamp_millis(),
        _ => return None,
    };
    let preroll = DateTime::parse_from_rfc3339(event.go_live_time.as_deref()?)
        .ok()?
        .timestamp_millis();
    if preroll > kickoff || kickoff - preroll > 3_600_000 {
        return None;
    }
    Some((
        [title[4].trim().to_string(), title[5].trim().to_string()],
        kickoff,
    ))
}

fn parse_swac(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let Ok(input) = serde_json::from_str::<Vec<serde_json::Value>>(body) else {
        return invalid();
    };
    let mut observations = Vec::new();
    let mut indices = HashMap::new();
    for value in input {
        let Ok(event) = serde_json::from_value::<SwacEvent>(value) else {
            continue;
        };
        let Some((teams, kickoff)) = swac_matchup(&event) else {
            continue;
        };
        if kickoff > now + WEEK || kickoff < now - 12 * 3_600_000 {
            continue;
        }
        let Some(raw_time) = iso(kickoff) else {
            continue;
        };
        let row = Observation {
            id: format!("{}:{}", source.id, event.id),
            source_id: source.id.clone(),
            url: format!(
                "https://tv.swac.org/program-group/e1dbe7ec9a7e686b42b53ab33c3e30e4/program/{}",
                event.id
            ),
            title: format!("{} vs {}", teams[0], teams[1]),
            teams: Some(teams),
            league: Some(League::Ncaaf),
            kickoff: Some(kickoff),
            raw_time,
            observed_at: now,
            parser_version: 1,
            legacy_id: None,
            kickoff_lineage: None,
        };
        if !add(&mut observations, &mut indices, row) {
            return invalid();
        }
    }
    complete(observations)
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SportsfeedLink {
    #[serde(rename = "websiteLink")]
    pub website_link: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streamer: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SportsfeedGame {
    #[serde(rename = "teamA")]
    pub team_a: String,
    #[serde(rename = "teamB")]
    pub team_b: String,
    #[serde(rename = "matchDate")]
    pub match_date: String,
    #[serde(rename = "sourceLink")]
    pub source_link: String,
    #[serde(rename = "streamerLinks")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streamer_links: Option<Vec<SportsfeedLink>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player2: Option<String>,
    #[serde(rename = "websiteLink")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_link: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct SportsfeedGroup {
    #[serde(rename = "subCategoryName")]
    name: String,
    games: Vec<SportsfeedGame>,
}

#[derive(Deserialize, Serialize)]
struct SportsfeedCategory {
    #[serde(rename = "categoryName")]
    name: String,
    #[serde(rename = "subCategories")]
    groups: Vec<SportsfeedGroup>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SportsfeedInput {
    Categories(Vec<SportsfeedCategory>),
    Envelope {
        categories: Vec<SportsfeedCategory>,
        complete: bool,
    },
}

pub(crate) fn component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub(crate) fn sportsfeed_event_url(team_a: &str, team_b: &str) -> String {
    format!(
        "https://sportsfeed24.st/fixture/{}-vs-{}",
        component(team_a),
        component(team_b)
    )
}

pub(crate) fn sportsfeed_link_id(value: &str) -> Option<String> {
    static PATH: OnceLock<Regex> = OnceLock::new();
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("totalsportek1.is" | "links.totalsportek1.is")
        )
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != value
    {
        return None;
    }
    let path = PATH.get_or_init(|| {
        Regex::new(r"^/(?:game/)?[a-z0-9]+(?:-[a-z0-9]+)*/(\d{1,10})/$")
            .expect("fixed SportsFeed24 event route")
    });
    Some(path.captures(url.path())?.get(1)?.as_str().to_string())
}

pub(crate) fn sportsfeed_kickoff(value: &str) -> Option<i64> {
    static FORMAT: OnceLock<Regex> = OnceLock::new();
    if !FORMAT.get_or_init(|| Regex::new(r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$")
        .expect("fixed GMT expression")).is_match(value) { return None; }
    let millis = NaiveDateTime::parse_from_str(value, "%a, %d %b %Y %H:%M:%S GMT")
        .ok()?
        .and_utc()
        .timestamp_millis();
    (FIRST_DATE..LAST_DATE).contains(&millis).then_some(millis)
}

fn sportsfeed_league(category: &str, team_a: &str) -> Option<League> {
    let label = category.to_ascii_lowercase();
    match label.as_str() {
        "nfl" => Some(League::Nfl),
        "nba" => Some(League::Nba),
        "wnba" => Some(League::Wnba),
        "nhl" => Some(League::Nhl),
        "mlb" => Some(League::Mlb),
        "f1" if team_a.to_ascii_lowercase().starts_with("f1 ") => Some(League::F1),
        "f1" if team_a.to_ascii_lowercase().starts_with("nascar") => {
            let name = team_a.to_ascii_lowercase();
            if name.contains(" cup ") {
                Some(League::NascarCup)
            } else if name.contains(" truck ") {
                Some(League::NascarTruck)
            } else {
                Some(League::Motorsport)
            }
        }
        "motogp" if team_a.to_ascii_lowercase().contains("motogp") => Some(League::Motogp),
        _ => None,
    }
}

fn parse_sportsfeed(body: &str, now: i64) -> ListingResult {
    let Ok(input) = serde_json::from_str::<SportsfeedInput>(body) else {
        return invalid();
    };
    let categories = match input {
        SportsfeedInput::Categories(value) => value,
        SportsfeedInput::Envelope {
            categories,
            complete,
        } => {
            let _ = complete;
            categories
        }
    };
    let mut observations = Vec::<Observation>::new();
    let mut indices = HashMap::<String, usize>::new();
    for category in categories {
        for group in category.groups {
            for game in group.games {
                if game.team_a.is_empty()
                    || game.team_b.is_empty()
                    || url::Url::parse(&game.source_link).is_err()
                {
                    return invalid();
                }
                let Some(kickoff) = sportsfeed_kickoff(&game.match_date) else {
                    continue;
                };
                let league = sportsfeed_league(&group.name, &game.team_a);
                let Some(link_id) = sportsfeed_link_id(&game.source_link) else {
                    continue;
                };
                if kickoff > now + WEEK
                    || matches!(
                        game.team_b.to_ascii_lowercase().as_str(),
                        "live" | "network" | "redzone"
                    ) && !matches!(
                        league,
                        Some(
                            League::F1
                                | League::NascarCup
                                | League::NascarTruck
                                | League::Motogp
                                | League::Motorsport
                        )
                    )
                {
                    continue;
                }
                let teams = if matches!(
                    league,
                    Some(
                        League::F1
                            | League::NascarCup
                            | League::NascarTruck
                            | League::Motogp
                            | League::Motorsport
                    )
                ) {
                    None
                } else {
                    Some([game.team_a.clone(), game.team_b.clone()])
                };
                let row = Observation {
                    id: format!("sportsfeed24:{link_id}"),
                    source_id: "sportsfeed24".to_string(),
                    url: sportsfeed_event_url(&game.team_a, &game.team_b),
                    title: format!("{} vs {}", game.team_a, game.team_b),
                    teams,
                    league,
                    kickoff: Some(kickoff),
                    raw_time: game.match_date,
                    observed_at: now,
                    parser_version: 1,
                    legacy_id: None,
                    kickoff_lineage: None,
                };
                if let Some(index) = indices.get(&row.id) {
                    let previous = &observations[*index];
                    if previous.title != row.title
                        || previous.url != row.url
                        || previous
                            .kickoff
                            .is_none_or(|date| (date - kickoff).abs() > 3_600_000)
                    {
                        return invalid();
                    }
                    if group.name.eq_ignore_ascii_case(&category.name) {
                        observations[*index] = row;
                    }
                } else {
                    indices.insert(row.id.clone(), observations.len());
                    observations.push(row);
                }
            }
        }
    }
    complete(observations)
}

pub fn parse_sportsfeed_category(body: &str) -> Result<serde_json::Value, String> {
    let category: SportsfeedCategory =
        serde_json::from_str(body).map_err(|_| "parser-changed".to_string())?;
    if category
        .groups
        .iter()
        .flat_map(|group| &group.games)
        .any(|game| {
            game.team_a.is_empty()
                || game.team_b.is_empty()
                || url::Url::parse(&game.source_link).is_err()
        })
    {
        return Err("parser-changed".to_string());
    }
    serde_json::to_value(category).map_err(|_| "parser-changed".to_string())
}

pub fn select_streamed_event(catalog: &str, _variant: &str, id: &str) -> Result<String, String> {
    let events: Vec<StreamedEvent> =
        serde_json::from_str(catalog).map_err(|_| "parser-changed".to_string())?;
    if events.iter().any(|event| !valid_streamed_event(event)) {
        return Err("parser-changed".to_string());
    }
    let mut matches = events
        .into_iter()
        .filter(|event| event.id == id && valid_streamed_id(&event.id));
    let event = matches.next().ok_or_else(|| "parser-changed".to_string())?;
    if matches.next().is_some() {
        return Err("parser-changed".to_string());
    }
    serde_json::to_string(&event).map_err(|_| "parser-changed".to_string())
}

pub fn select_sportsbite_event(catalog: &str, key: &str) -> Result<String, String> {
    let parsed: SportsbiteCatalog =
        serde_json::from_str(catalog).map_err(|_| "parser-changed".to_string())?;
    if parsed
        .days
        .iter()
        .flat_map(|day| &day.events)
        .any(|event| !valid_sportsbite_event(event))
    {
        return Err("parser-changed".to_string());
    }
    let mut matches = parsed
        .days
        .into_iter()
        .flat_map(|day| day.events)
        .filter(|event| event.event_key == key);
    let event = matches.next().ok_or_else(|| "parser-changed".to_string())?;
    if matches.next().is_some() {
        return Err("parser-changed".to_string());
    }
    serde_json::to_string(&event).map_err(|_| "parser-changed".to_string())
}

pub fn parse_json(source: &ListingSource, body: &str, now: i64) -> Option<ListingResult> {
    match source.family.as_str() {
        "tvapp" => Some(parse_tvapp(source, body, now)),
        "ppv" => Some(parse_ppv(source, body, now)),
        "streamed" | "livesportpro" => Some(parse_streamed(source, body, now)),
        "sportsbite" => Some(parse_sportsbite(body, now)),
        "sportsfeed24" => Some(parse_sportsfeed(body, now)),
        "swac" => Some(parse_swac(source, body, now)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::SourceRegistry;

    #[test]
    fn json_listings_match_the_frozen_collector() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        for case in [
            "tvapp",
            "tvapp-empty",
            "tvapp-malformed",
            "ppv",
            "swac",
            "streamed",
            "livesportpro",
            "sportsbite",
            "sportsfeed24",
        ] {
            let input = &golden["inputs"]["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == case)
                .unwrap();
            let source = registry.get(input["sourceId"].as_str().unwrap()).unwrap();
            let expected: ListingResult =
                serde_json::from_value(golden["expected"]["listings"][case]["parsed"].clone())
                    .unwrap();
            let now = input["at"]
                .as_i64()
                .unwrap_or_else(|| golden["at"].as_i64().unwrap());
            assert_eq!(
                parse_json(source, input["body"].as_str().unwrap(), now),
                Some(expected),
                "{case}"
            );
        }
    }

    #[test]
    fn college_aliases_use_one_unique_team_owner() {
        assert!(same_unique_college_owner("Auburn", "Auburn Tigers"));
        assert!(!same_unique_college_owner("Auburn", "Troy Trojans"));
    }

    #[test]
    fn catalog_selectors_return_one_typed_event_and_reject_duplicates() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let input = golden["inputs"]["cases"].as_array().unwrap();
        let streamed = input.iter().find(|item| item["id"] == "streamed").unwrap();
        let catalog = streamed["body"].as_str().unwrap();
        let id = "buffalo-sabres-vs-dallas-stars-2591545";
        let selected: serde_json::Value =
            serde_json::from_str(&select_streamed_event(catalog, "streamed", id).unwrap()).unwrap();
        assert_eq!(selected["id"], id);
        assert_eq!(selected["sources"].as_array().unwrap().len(), 2);
        assert!(selected.get("poster").is_none());
        let mut rows: Vec<serde_json::Value> = serde_json::from_str(catalog).unwrap();
        rows.push(rows[0].clone());
        assert!(
            select_streamed_event(&serde_json::to_string(&rows).unwrap(), "streamed", id).is_err()
        );

        let bite = input
            .iter()
            .find(|item| item["id"] == "sportsbite")
            .unwrap();
        let selected: serde_json::Value = serde_json::from_str(
            &select_sportsbite_event(
                bite["body"].as_str().unwrap(),
                "fg-buffalo-sabres-vs-dallas-stars",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(selected["title"], "Buffalo Sabres vs Dallas Stars");
        assert!(selected.get("poster").is_none());
        assert!(select_sportsbite_event(bite["body"].as_str().unwrap(), "missing").is_err());

        let feed = input
            .iter()
            .find(|item| item["id"] == "sportsfeed24")
            .unwrap();
        let categories: Vec<serde_json::Value> =
            serde_json::from_str(feed["body"].as_str().unwrap()).unwrap();
        let selected = parse_sportsfeed_category(&categories[0].to_string()).unwrap();
        assert!(selected["categoryName"].is_string());
        assert!(selected["subCategories"].is_array());
        assert!(
            parse_sportsfeed_category(r#"{"categoryName":"NFL","subCategories":null}"#).is_err()
        );
    }
}
