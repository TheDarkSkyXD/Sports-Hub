use crate::{
    html::{HtmlDoc, attr, select, text},
    registry::SourceRegistry,
    types::{BrowserCategory, League},
};
use scraper::ElementRef;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use url::Url;

pub const SPORTSURGE_MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
pub const STREAMEAST_MAX_PAGE_BYTES: usize = 4_000_000;
pub const MAX_CHECKPOINT_BYTES: usize = 8_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub enum BrowserKind {
    #[serde(rename = "sportsurge-v2")]
    Sportsurge,
    #[serde(rename = "streameast")]
    Streameast,
}

impl BrowserKind {
    pub fn source_id(self) -> &'static str {
        match self {
            Self::Sportsurge => "sportsurge-v2",
            Self::Streameast => "streameast",
        }
    }

    pub fn origin(self) -> &'static str {
        match self {
            Self::Sportsurge => "https://v2.sportsurge.net",
            Self::Streameast => "https://v2.streameast.ga",
        }
    }

    pub fn page_cap(self) -> usize {
        match self {
            Self::Sportsurge => SPORTSURGE_MAX_PAGE_BYTES,
            Self::Streameast => STREAMEAST_MAX_PAGE_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserFailure {
    Blocked,
    RateLimited,
    Timeout,
    ParserChanged,
    Unavailable,
    InvalidDetailUrl,
    Limit,
}

impl BrowserFailure {
    pub fn from_message(message: &str, kind: BrowserKind) -> Self {
        match message {
            "blocked" => Self::Blocked,
            "rate-limited" => Self::RateLimited,
            "timeout" => Self::Timeout,
            "parser-changed" => Self::ParserChanged,
            "invalid-detail-url" if kind == BrowserKind::Sportsurge => Self::InvalidDetailUrl,
            "limit" => Self::Limit,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CategoryState {
    Pending,
    Collected { at: i64 },
    Failed { at: i64, reason: BrowserFailure },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CatalogState {
    Collecting,
    Complete { at: i64 },
    Partial { at: i64, reason: BrowserFailure },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SportsurgeDestination {
    Link {
        url: String,
    },
    Rejected {
        reason: DestinationRejection,
        display: Option<String>,
    },
    Malformed {
        reason: MalformedDestination,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationRejection {
    Insecure,
    Credentials,
    PrivateHost,
    CredentialQuery,
    Oversized,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MalformedDestination {
    Missing,
    InvalidUrl,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SportsurgeProvider {
    pub id: String,
    pub label: String,
    pub observed_at: i64,
    pub destination: SportsurgeDestination,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SportsurgeDetail {
    Pending,
    Collected {
        at: i64,
        #[serde(rename = "retainedFromRunId", skip_serializing_if = "Option::is_none")]
        retained_from_run_id: Option<String>,
        providers: Vec<SportsurgeProvider>,
    },
    Failed {
        at: i64,
        reason: BrowserFailure,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceStatus {
    Live,
    Upcoming,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SportsurgeEvent {
    pub id: String,
    pub url: String,
    pub league: League,
    pub title: String,
    pub teams: Option<[String; 2]>,
    pub source_status: SourceStatus,
    pub kickoff: Option<i64>,
    pub advertised_link_count: Option<u32>,
    pub detail: SportsurgeDetail,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedGame {
    pub league: League,
    pub title: String,
    pub reason: RejectionReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RejectionReason {
    InvalidDetailUrl,
    DuplicateGameId,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogIssue {
    pub league: League,
    pub title: String,
    pub reason: RejectionReason,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CategoryResult<Event> {
    pub failure: Option<BrowserFailure>,
    pub events: Vec<Event>,
    pub rejected_games: Vec<RejectedGame>,
    pub catalog_issues: Vec<CatalogIssue>,
}

fn category(
    registry: &SourceRegistry,
    kind: BrowserKind,
    league: League,
) -> Option<&BrowserCategory> {
    registry.browser_category(kind.source_id(), league)
}

fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clipped(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn league_name(league: League) -> String {
    serde_json::to_string(&league)
        .unwrap()
        .trim_matches('"')
        .to_owned()
}

fn has_class(node: ElementRef<'_>, class_name: &str) -> bool {
    node.value().classes().any(|class| class == class_name)
}

fn first<'a>(node: ElementRef<'a>, selector: &str) -> Option<ElementRef<'a>> {
    select(node, selector).into_iter().next()
}

fn first_text(node: ElementRef<'_>, selector: &str) -> String {
    first(node, selector).map(text).unwrap_or_default()
}

fn parse_url(value: &str, origin: &str) -> Option<Url> {
    let base = Url::parse(origin).ok()?;
    base.join(value).ok()
}

fn clean_browser_url(url: &Url, kind: BrowserKind) -> bool {
    url.origin().ascii_serialization() == kind.origin()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.as_str().len() <= 400
}

fn blocked_reason(html: &str) -> BrowserFailure {
    let lowered = html.to_ascii_lowercase();
    if lowered.contains("<title>just a moment")
        || lowered.contains("verify you are human")
        || lowered.contains("checking your browser")
    {
        BrowserFailure::Blocked
    } else {
        BrowserFailure::ParserChanged
    }
}

pub fn sportsurge_detail_url(
    value: &str,
    league: League,
    registry: &SourceRegistry,
) -> Option<(String, String)> {
    let url = parse_url(value, BrowserKind::Sportsurge.origin())?;
    if !clean_browser_url(&url, BrowserKind::Sportsurge) {
        return None;
    }
    let path = cached_regex!(r"^/watch-(\d{1,12})-([a-z0-9]+)-[a-z0-9]+(?:-[a-z0-9]+)*/$").unwrap();
    let groups = path.captures(url.path())?;
    if category(registry, BrowserKind::Sportsurge, league)?
        .path_code
        .as_deref()?
        != groups.get(2)?.as_str()
    {
        return None;
    }
    Some((
        format!("{}:{}", league_name(league), groups.get(1)?.as_str()),
        url.to_string(),
    ))
}

pub fn sportsurge_destination(value: &str) -> SportsurgeDestination {
    if value.trim().is_empty() {
        return SportsurgeDestination::Malformed {
            reason: MalformedDestination::Missing,
        };
    }
    let Ok(url) = Url::parse(value) else {
        return SportsurgeDestination::Malformed {
            reason: MalformedDestination::InvalidUrl,
        };
    };
    let display = url.host_str().map(|host| clipped(host, 240));
    let rejected = |reason| SportsurgeDestination::Rejected {
        reason,
        display: display.clone(),
    };
    if url.scheme() != "https" {
        return rejected(DestinationRejection::Insecure);
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return rejected(DestinationRejection::Credentials);
    }
    let host = url.host_str().unwrap_or_default();
    if host.is_empty()
        || host
            .trim_matches(&['[', ']'][..])
            .parse::<std::net::IpAddr>()
            .is_ok()
        || matches!(host, "localhost")
        || [".localhost", ".local", ".internal"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return rejected(DestinationRejection::PrivateHost);
    }
    let credential = cached_regex!(
        r"(?i)^(?:token|access_token|auth|authorization|key|signature|sig|st|e|x-amz-.+)$",
    )
    .unwrap();
    if url.query_pairs().any(|(key, _)| credential.is_match(&key))
        || url.fragment().is_some_and(|fragment| {
            let fragment = fragment.to_ascii_lowercase();
            [
                "token=",
                "access_token=",
                "auth=",
                "authorization=",
                "key=",
                "signature=",
                "sig=",
                "st=",
                "e=",
                "x-amz-",
            ]
            .iter()
            .any(|key| {
                fragment.starts_with(key)
                    || fragment.contains(&format!("&{key}"))
                    || fragment.contains(&format!("?{key}"))
            })
        })
    {
        return rejected(DestinationRejection::CredentialQuery);
    }
    if url.as_str().len() > 2000 {
        return rejected(DestinationRejection::Oversized);
    }
    SportsurgeDestination::Link {
        url: url.to_string(),
    }
}

pub fn sportsurge_category(
    html: &str,
    league: League,
    registry: &SourceRegistry,
) -> CategoryResult<SportsurgeEvent> {
    let failed = |reason| CategoryResult {
        failure: Some(reason),
        events: Vec::new(),
        rejected_games: Vec::new(),
        catalog_issues: Vec::new(),
    };
    if category(registry, BrowserKind::Sportsurge, league).is_none() {
        return failed(BrowserFailure::ParserChanged);
    }
    let doc = HtmlDoc::parse(html);
    let Some(container) = doc.select("#match-list-container").into_iter().next() else {
        return failed(blocked_reason(html));
    };
    let rows = select(container, "a.match-row");
    if rows.is_empty() {
        let empty = select(container, ":scope > .watch-empty-state")
            .into_iter()
            .any(|node| {
                !has_class(node, "match-filter-empty")
                    && !cached_regex!(r"(?i)display\s*:\s*none")
                        .unwrap()
                        .is_match(attr(node, "style").unwrap_or_default())
                    && normalize(&text(node))
                        .to_ascii_lowercase()
                        .contains("no live or upcoming games")
            });
        return if empty {
            failed_category_none()
        } else {
            failed(blocked_reason(html))
        };
    }
    let mut result = failed_category_none();
    let mut ids = HashSet::new();
    let mut urls = HashSet::new();
    for row in rows {
        let row_text = normalize(&text(row));
        let Some((id, url)) =
            sportsurge_detail_url(attr(row, "href").unwrap_or_default(), league, registry)
        else {
            result.rejected_games.push(RejectedGame {
                league,
                title: clipped(&row_text, 240),
                reason: RejectionReason::InvalidDetailUrl,
            });
            result.failure = Some(BrowserFailure::ParserChanged);
            continue;
        };
        if !urls.insert(url.clone()) {
            continue;
        }
        if !ids.insert(id.clone()) {
            result.catalog_issues.push(CatalogIssue {
                league,
                title: clipped(&row_text, 240),
                reason: RejectionReason::DuplicateGameId,
            });
        }
        let names: Vec<_> = select(row, ".match-row-team-name")
            .into_iter()
            .map(|node| normalize(&text(node)))
            .collect();
        let teams = if names.len() == 2
            && names
                .iter()
                .all(|name| !name.is_empty() && name.chars().count() <= 120)
        {
            Some([names[0].clone(), names[1].clone()])
        } else {
            None
        };
        let raw_time = first(row, ".match-time[data-timestamp]")
            .and_then(|node| attr(node, "data-timestamp"))
            .unwrap_or_default();
        let epoch = match raw_time.len() {
            10 if raw_time.bytes().all(|byte| byte.is_ascii_digit()) => raw_time
                .parse::<i64>()
                .ok()
                .and_then(|time| time.checked_mul(1000)),
            13 if raw_time.bytes().all(|byte| byte.is_ascii_digit()) => {
                raw_time.parse::<i64>().ok()
            }
            _ => None,
        };
        let kickoff = epoch.filter(|time| (946_684_800_000..4_102_444_800_000).contains(time));
        let count = cached_regex!(r"(?i)\b(\d{1,5})\s+Streams?\b")
            .unwrap()
            .captures(&row_text)
            .and_then(|captures| captures.get(1)?.as_str().parse().ok());
        let title = if let Some(teams) = &teams {
            clipped(&format!("{} vs {}", teams[0], teams[1]), 240)
        } else {
            let fallback = format!(
                "Sportsurge {} {}",
                league_name(league).to_uppercase(),
                id.split(':').nth(1).unwrap_or_default()
            );
            let joined = names.join(" ");
            clipped(
                attr(row, "title")
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        if joined.is_empty() {
                            &fallback
                        } else {
                            &joined
                        }
                    })
                    .trim(),
                240,
            )
        };
        result.events.push(SportsurgeEvent {
            id,
            url,
            league,
            title,
            teams,
            source_status: if !select(row, ".live-badge").is_empty() {
                SourceStatus::Live
            } else if kickoff.is_some() {
                SourceStatus::Upcoming
            } else {
                SourceStatus::Unknown
            },
            kickoff,
            advertised_link_count: count,
            detail: SportsurgeDetail::Pending,
        });
    }
    result
}

fn failed_category_none<Event>() -> CategoryResult<Event> {
    CategoryResult {
        failure: None,
        events: Vec::new(),
        rejected_games: Vec::new(),
        catalog_issues: Vec::new(),
    }
}

pub fn sportsurge_detail(html: &str, event: &SportsurgeEvent, at: i64) -> SportsurgeDetail {
    let doc = HtmlDoc::parse(html);
    let Some(list) = doc.select(".stream-list").into_iter().next() else {
        return SportsurgeDetail::Failed {
            at,
            reason: blocked_reason(html),
        };
    };
    let rows = select(list, ".stream-item");
    if rows.is_empty()
        && !["no streams available", "no streams found"]
            .iter()
            .any(|needle| text(list).to_ascii_lowercase().contains(needle))
    {
        return SportsurgeDetail::Failed {
            at,
            reason: BrowserFailure::ParserChanged,
        };
    }
    let mut ids = HashMap::<String, usize>::new();
    let providers = rows
        .into_iter()
        .map(|row| {
            let label = clipped(&normalize(&first_text(row, ".stream-row-site-name")), 160);
            let label = if label.is_empty() {
                "Unnamed provider".to_owned()
            } else {
                label
            };
            let raw = attr(row, "data-href").unwrap_or_default();
            let vote = first(row, ".stream-vote[id]")
                .and_then(|node| attr(node, "id"))
                .unwrap_or_default();
            let stream_id = cached_regex!(r"^stream-\d{1,20}$").unwrap();
            let base = if stream_id.is_match(vote) {
                vote.to_owned()
            } else {
                let identity = format!("{}|{label}|{raw}", event.id);
                format!(
                    "row-{}",
                    hex::encode(Sha256::digest(identity.as_bytes()))[..16].to_owned()
                )
            };
            let occurrence = ids.entry(base.clone()).or_insert(0);
            let id = format!("{base}-{occurrence}");
            *occurrence += 1;
            SportsurgeProvider {
                id,
                label,
                observed_at: at,
                destination: sportsurge_destination(raw),
            }
        })
        .collect();
    SportsurgeDetail::Collected {
        at,
        retained_from_run_id: None,
        providers,
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ServerPlayer {
    Channel {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    Wikisport {
        section: String,
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    Page {
        url: String,
    },
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ServerAvailability {
    FreeChannel {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    FreeWikisport {
        section: String,
        #[serde(rename = "playerId")]
        player_id: String,
    },
    FreePage,
    FreeUnsupported,
    FreeUnresolved,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct StreameastServer {
    pub id: String,
    pub label: String,
    pub url: String,
    pub availability: ServerAvailability,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Publication {
    pub premium: usize,
    pub unknown: usize,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StreameastDetail {
    Pending,
    Collected {
        at: i64,
        #[serde(rename = "retainedFromRunId", skip_serializing_if = "Option::is_none")]
        retained_from_run_id: Option<String>,
        servers: Vec<StreameastServer>,
        #[serde(skip_serializing_if = "Option::is_none")]
        publication: Option<Publication>,
    },
    Failed {
        at: i64,
        reason: BrowserFailure,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreameastEvent {
    pub id: String,
    pub url: String,
    pub league: League,
    pub title: String,
    pub teams: Option<[String; 2]>,
    pub kickoff: Option<i64>,
    pub espn_event_id: Option<String>,
    pub detail: StreameastDetail,
}

pub fn streameast_event_url(
    value: &str,
    league: League,
    registry: &SourceRegistry,
) -> Option<String> {
    let url = parse_url(value, BrowserKind::Streameast.origin())?;
    if !clean_browser_url(&url, BrowserKind::Streameast) {
        return None;
    }
    let pattern = cached_regex!(r"^/([a-z0-9-]+)/([a-z0-9]+(?:-[a-z0-9]+)*)/$").unwrap();
    let groups = pattern.captures(url.path())?;
    if category(registry, BrowserKind::Streameast, league)?
        .path_code
        .as_deref()?
        != groups.get(1)?.as_str()
    {
        return None;
    }
    Some(url.to_string())
}

pub fn streameast_server_url(value: &str, event: &StreameastEvent) -> Option<(String, String)> {
    let url = parse_url(value, BrowserKind::Streameast.origin())?;
    if !clean_browser_url(&url, BrowserKind::Streameast) {
        return None;
    }
    let event_url = Url::parse(&event.url).ok()?;
    let suffix = url.path().strip_prefix(event_url.path())?;
    if !(1..=4).contains(&suffix.len()) || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((url.to_string(), suffix.to_owned()))
}

pub fn streameast_category(
    html: &str,
    league: League,
    registry: &SourceRegistry,
) -> CategoryResult<StreameastEvent> {
    let doc = HtmlDoc::parse(html);
    let cards = doc.select(".m-card");
    let category = category(registry, BrowserKind::Streameast, league);
    let valid_empty = doc
        .select("#m-schedule-empty.m-empty")
        .into_iter()
        .any(|node| {
            let heading = first_text(node, ".m-empty__title")
                .trim()
                .to_ascii_lowercase();
            category
                .and_then(|category| category.empty_titles.as_ref())
                .is_some_and(|titles| {
                    titles
                        .iter()
                        .any(|title| title.to_ascii_lowercase() == heading)
                })
        });
    if cards.is_empty() && !valid_empty {
        return CategoryResult {
            failure: Some(BrowserFailure::ParserChanged),
            events: Vec::new(),
            rejected_games: Vec::new(),
            catalog_issues: Vec::new(),
        };
    }
    let mut result = failed_category_none();
    let mut seen_urls = HashSet::new();
    let mut seen_ids = HashSet::new();
    for card in cards {
        let link = first(card, "a.m-card__link");
        let title = clipped(
            link.and_then(|link| attr(link, "aria-label"))
                .unwrap_or_default()
                .trim(),
            240,
        );
        let url = link
            .and_then(|link| attr(link, "href"))
            .and_then(|url| streameast_event_url(url, league, registry));
        let Some(url) = url else {
            result.rejected_games.push(RejectedGame {
                league,
                title,
                reason: RejectionReason::InvalidDetailUrl,
            });
            continue;
        };
        if !seen_urls.insert(url.clone()) {
            result.rejected_games.push(RejectedGame {
                league,
                title,
                reason: RejectionReason::DuplicateGameId,
            });
            continue;
        }
        let source_id = attr(card, "data-match-id").unwrap_or_default();
        if !(1..=12).contains(&source_id.len())
            || !source_id.bytes().all(|byte| byte.is_ascii_digit())
        {
            result.rejected_games.push(RejectedGame {
                league,
                title,
                reason: RejectionReason::InvalidDetailUrl,
            });
            continue;
        }
        if !seen_ids.insert(source_id.to_owned()) {
            result.rejected_games.push(RejectedGame {
                league,
                title,
                reason: RejectionReason::DuplicateGameId,
            });
            continue;
        }
        let names: Vec<_> = attr(card, "data-team-names")
            .unwrap_or_default()
            .split('|')
            .map(str::trim)
            .map(str::to_owned)
            .collect();
        let teams = if names.len() == 2
            && names
                .iter()
                .all(|name| !name.is_empty() && name.chars().count() <= 120)
        {
            Some([names[0].clone(), names[1].clone()])
        } else {
            None
        };
        let raw_time = attr(card, "data-time").unwrap_or_default();
        let kickoff = if raw_time.len() == 10 && raw_time.bytes().all(|byte| byte.is_ascii_digit())
        {
            raw_time
                .parse::<i64>()
                .ok()
                .and_then(|value| value.checked_mul(1000))
        } else {
            None
        };
        let raw_espn = attr(card, "data-espn-event-id").unwrap_or_default();
        let espn_event_id = if attr(card, "data-espn-path")
            == category.and_then(|category| category.espn_path.as_deref())
            && (5..=12).contains(&raw_espn.len())
            && raw_espn.bytes().all(|byte| byte.is_ascii_digit())
        {
            Some(raw_espn.to_owned())
        } else {
            None
        };
        let title = if !title.is_empty() {
            title
        } else if !names.join(" vs ").is_empty() {
            clipped(&names.join(" vs "), 240)
        } else {
            "Unknown matchup".to_owned()
        };
        if league == League::Ufc && !crate::combat::is_ufc_card_title(&title) {
            continue;
        }
        if league == League::Boxing && crate::combat::is_ufc_card_title(&title) {
            continue;
        }
        result.events.push(StreameastEvent {
            id: format!("{}:{source_id}", league_name(league)),
            url,
            league,
            title,
            teams,
            kickoff,
            espn_event_id,
            detail: StreameastDetail::Pending,
        });
    }
    result
}

fn free_rows<'a>(doc: &'a HtmlDoc) -> Vec<ElementRef<'a>> {
    doc.select(".stream-alt-list a.stream-alt-item")
        .into_iter()
        .filter(|node| {
            !has_class(*node, "stream-alt-item-pro")
                && select(*node, ".stream-alt-pro-icon").is_empty()
                && !select(*node, ".stream-alt-free-badge").is_empty()
        })
        .collect()
}

pub fn streameast_free_server_urls(html: &str, event: &StreameastEvent) -> Vec<String> {
    let doc = HtmlDoc::parse(html);
    free_rows(&doc)
        .into_iter()
        .filter_map(|row| {
            attr(row, "href")
                .and_then(|url| streameast_server_url(url, event))
                .map(|pair| pair.0)
        })
        .collect()
}

pub fn streameast_active_free_server_url(html: &str, event: &StreameastEvent) -> Option<String> {
    let doc = HtmlDoc::parse(html);
    free_rows(&doc)
        .into_iter()
        .find(|row| has_class(*row, "active"))
        .and_then(|row| attr(row, "href"))
        .and_then(|url| streameast_server_url(url, event))
        .map(|pair| pair.0)
}

pub fn streameast_free_player(html: &str) -> ServerPlayer {
    let doc = HtmlDoc::parse(html);
    let mut matches = Vec::new();
    for frame in doc.select("iframe[src]") {
        let Some(url) =
            attr(frame, "src").and_then(|src| parse_url(src, BrowserKind::Streameast.origin()))
        else {
            continue;
        };
        if !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            continue;
        }
        if url.origin().ascii_serialization() == "https://streame.center" {
            let channel = cached_regex!(r"^/stream-east/ch(\d{1,4})\.php$").unwrap();
            if let Some(id) = channel.captures(url.path()).and_then(|group| group.get(1)) {
                matches.push(ServerPlayer::Channel {
                    id: id.as_str().to_owned(),
                    url: None,
                });
            }
        } else if url.origin().ascii_serialization() == "https://wikisport.info" {
            let wiki = cached_regex!(r"^/(0nhl|strm)/(\d{1,4})\.php$").unwrap();
            if let Some(groups) = wiki.captures(url.path()) {
                matches.push(ServerPlayer::Wikisport {
                    section: groups[1].to_owned(),
                    id: groups[2].to_owned(),
                    url: None,
                });
            }
        }
    }
    if matches.len() == 1 {
        matches.remove(0)
    } else {
        ServerPlayer::Unsupported
    }
}

pub fn streameast_published_free_player(
    html: &str,
    event: &StreameastEvent,
    selected_url: &str,
) -> ServerPlayer {
    let doc = HtmlDoc::parse(html);
    let source_id = event.id.split(':').nth(1).unwrap_or_default();
    let board = doc.select(".se-board[data-match-id]");
    let active = doc.select(".stream-alt-list a.stream-alt-item.active");
    let root = doc.select("#se-player-root.se-player");
    let selected_valid = streameast_server_url(selected_url, event).is_some();
    if !selected_valid
        || doc.select(".streameast-video-page").is_empty()
        || board.len() != 1
        || attr(board[0], "data-match-id") != Some(source_id)
        || root.len() != 1
        || active.len() != 1
        || has_class(active[0], "stream-alt-item-pro")
        || !select(active[0], ".stream-alt-pro-icon").is_empty()
        || select(active[0], ".stream-alt-free-badge").len() != 1
        || attr(active[0], "href")
            .and_then(|url| streameast_server_url(url, event))
            .map(|pair| pair.0)
            .as_deref()
            != Some(selected_url)
    {
        return ServerPlayer::Unsupported;
    }
    let frames = select(root[0], ":scope > iframe[src]");
    if frames.len() != 1 {
        return ServerPlayer::Unsupported;
    }
    let Some(url) = attr(frames[0], "src").and_then(|src| Url::parse(src).ok()) else {
        return ServerPlayer::Unsupported;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > 400
    {
        return ServerPlayer::Unsupported;
    }
    let origin = url.origin().ascii_serialization();
    let path = url.path();
    if origin == "https://streame.center" {
        let channel = cached_regex!(r"^/stream-east/ch(\d{1,4})\.php$").unwrap();
        if let Some(id) = channel.captures(path).and_then(|group| group.get(1)) {
            return ServerPlayer::Channel {
                id: id.as_str().to_owned(),
                url: Some(url.to_string()),
            };
        }
    }
    if origin == "https://wikisport.info" {
        let wiki = cached_regex!(r"^/(0nhl|strm)/(\d{1,4})\.php$").unwrap();
        if let Some(groups) = wiki.captures(path) {
            return ServerPlayer::Wikisport {
                section: groups[1].to_owned(),
                id: groups[2].to_owned(),
                url: Some(url.to_string()),
            };
        }
    }
    let supported = (origin == "https://wikisport.info"
        && cached_regex!(r"^/ch/[1-9]\d{0,3}\.php$")
            .unwrap()
            .is_match(path))
        || (origin == "https://dlive.sx"
            && cached_regex!(r"^/stream/stream-\d{1,4}\.php$")
                .unwrap()
                .is_match(path))
        || (origin == "https://flyembed.click"
            && cached_regex!(r"^/embed/\d{1,4}\.php$")
                .unwrap()
                .is_match(path))
        || (origin == "https://fsportshdz.xyz"
            && cached_regex!(r"^/embed/[a-z0-9]+(?:-[a-z0-9]+)*-live-streams\.php$")
                .unwrap()
                .is_match(path));
    if supported {
        ServerPlayer::Page {
            url: url.to_string(),
        }
    } else {
        ServerPlayer::Unsupported
    }
}

pub fn streameast_server_player(
    html: &str,
    event: &StreameastEvent,
    selected_url: &str,
) -> ServerPlayer {
    if !HtmlDoc::parse(html)
        .select(".streameast-video-page")
        .is_empty()
    {
        streameast_published_free_player(html, event, selected_url)
    } else {
        streameast_free_player(html)
    }
}

pub fn streameast_detail(
    html: &str,
    event: &StreameastEvent,
    at: i64,
    free_pages: &HashMap<String, ServerPlayer>,
) -> StreameastDetail {
    let doc = HtmlDoc::parse(html);
    let rows = doc.select(".stream-alt-list a.stream-alt-item");
    if rows.is_empty() {
        let source_id = event.id.split(':').nth(1).unwrap_or_default();
        if !doc.select(".streameast-video-page").is_empty()
            && doc
                .select(".se-board[data-match-id]")
                .into_iter()
                .next()
                .and_then(|node| attr(node, "data-match-id"))
                == Some(source_id)
            && !doc
                .select(".se-streams--share-only .se-streams__list")
                .is_empty()
            && doc.select(".se-streams__list a.se-stream__link").is_empty()
            && doc
                .select(".se-countdown__title")
                .into_iter()
                .next()
                .map(text)
                .unwrap_or_default()
                .trim()
                == "Stream starting soon"
        {
            return StreameastDetail::Collected {
                at,
                retained_from_run_id: None,
                servers: Vec::new(),
                publication: Some(Publication {
                    premium: 0,
                    unknown: 0,
                }),
            };
        }
        let heading = doc
            .select(".se-progate__match")
            .into_iter()
            .next()
            .map(|node| normalize(&text(node)))
            .unwrap_or_default();
        let published: Vec<_> =
            doc.select("#se-streams-list.se-streams__list .se-stream:not(.se-stream--share)");
        if !doc.select(".streameast-video-page").is_empty()
            && heading == event.title
            && !published.is_empty()
            && published.iter().all(|row| {
                has_class(*row, "is-pro")
                    && first(*row, "a.se-stream__link")
                        .and_then(|node| attr(node, "href"))
                        .and_then(|url| streameast_server_url(url, event))
                        .is_some()
            })
        {
            return StreameastDetail::Collected {
                at,
                retained_from_run_id: None,
                servers: Vec::new(),
                publication: Some(Publication {
                    premium: published.len(),
                    unknown: 0,
                }),
            };
        }
        return StreameastDetail::Failed {
            at,
            reason: BrowserFailure::ParserChanged,
        };
    }
    let mut servers = Vec::new();
    for row in free_rows(&doc) {
        let Some((url, id)) =
            attr(row, "href").and_then(|value| streameast_server_url(value, event))
        else {
            return StreameastDetail::Failed {
                at,
                reason: BrowserFailure::ParserChanged,
            };
        };
        let label = first_text(row, ".stream-alt-name");
        let label = if label.is_empty() {
            format!("Server {id}")
        } else {
            label.trim().to_owned()
        };
        let label = clipped(&label, 120);
        let availability = match free_pages.get(&url) {
            Some(ServerPlayer::Channel { id, .. }) => ServerAvailability::FreeChannel {
                channel_id: id.clone(),
            },
            Some(ServerPlayer::Wikisport { section, id, .. }) => {
                ServerAvailability::FreeWikisport {
                    section: section.clone(),
                    player_id: id.clone(),
                }
            }
            Some(ServerPlayer::Page { .. }) => ServerAvailability::FreePage,
            Some(ServerPlayer::Unsupported) => ServerAvailability::FreeUnsupported,
            _ => ServerAvailability::FreeUnresolved,
        };
        servers.push(StreameastServer {
            id,
            label,
            url,
            availability,
        });
    }
    let premium = rows
        .iter()
        .filter(|row| {
            has_class(**row, "stream-alt-item-pro")
                || !select(**row, ".stream-alt-pro-icon").is_empty()
        })
        .count();
    let unknown = rows.len().saturating_sub(premium + servers.len());
    StreameastDetail::Collected {
        at,
        retained_from_run_id: None,
        servers,
        publication: Some(Publication { premium, unknown }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn frozen_browser_categories_match_all_seven_cases() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        for case in corpus["inputs"]["browser"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let league: League = serde_json::from_value(case["league"].clone()).unwrap();
            let html = case["html"].as_str().unwrap();
            let actual = if case["kind"] == "surge-category" {
                let result = sportsurge_category(html, league, &registry);
                let mut value = json!({"kind": if result.failure.is_some() { "failed" } else { "collected" },
                    "events": result.events, "rejectedGames": result.rejected_games, "catalogIssues": result.catalog_issues});
                if let Some(reason) = result.failure {
                    value["reason"] = serde_json::to_value(reason).unwrap();
                }
                value
            } else {
                let result = streameast_category(html, league, &registry);
                let mut value = json!({"kind": if result.failure.is_some() { "failed" } else { "collected" },
                    "events": result.events, "rejectedGames": result.rejected_games});
                if let Some(reason) = result.failure {
                    value["reason"] = serde_json::to_value(reason).unwrap();
                }
                value
            };
            assert_eq!(actual, corpus["expected"]["browser"][id], "{id}");
        }
    }

    #[test]
    fn frozen_detail_parsers_preserve_published_locators() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let surge_case = corpus["inputs"]["browser"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["id"] == "surge-cfb")
            .unwrap();
        let surge_event = sportsurge_category(
            surge_case["html"].as_str().unwrap(),
            League::Ncaaf,
            &registry,
        )
        .events
        .remove(0);
        let at = corpus["at"].as_i64().unwrap();
        assert_eq!(
            serde_json::to_value(sportsurge_detail(
                corpus["inputs"]["surgeDetail"].as_str().unwrap(),
                &surge_event,
                at
            ))
            .unwrap(),
            corpus["expected"]["browser"]["surge-detail"]
        );
        let duplicate = r#"<div class="stream-list"><div class="stream-item" data-href="https://example.com/one"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div><div class="stream-item" data-href="https://example.com/two"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div><div class="stream-item" data-href="https://127.0.0.1/private"></div></div>"#;
        assert_eq!(
            serde_json::to_value(sportsurge_detail(duplicate, &surge_event, at)).unwrap(),
            corpus["expected"]["browser"]["surge-duplicate-providers"]
        );

        let east_url =
            "https://v2.streameast.ga/cfb/montana-state-bobcats-vs-idaho-vandals-1790994600/";
        let event = StreameastEvent {
            id: "ncaaf:12345".into(),
            url: east_url.into(),
            league: League::Ncaaf,
            title: "Montana State Bobcats vs Idaho Vandals".into(),
            teams: Some(["Montana State Bobcats".into(), "Idaho Vandals".into()]),
            kickoff: Some(at),
            espn_event_id: None,
            detail: StreameastDetail::Pending,
        };
        let detail = format!(
            "<div class=\"stream-alt-list\"><a class=\"stream-alt-item\" href=\"{east_url}1\"><span class=\"stream-alt-name\">Free 1</span><span class=\"stream-alt-free-badge\">Free</span></a><a class=\"stream-alt-item stream-alt-item-pro\" href=\"{east_url}2\"><span class=\"stream-alt-name\">Paid</span><span class=\"stream-alt-pro-icon\"></span></a></div>"
        );
        let pages = HashMap::from([(
            format!("{east_url}1"),
            ServerPlayer::Channel {
                id: "33".into(),
                url: None,
            },
        )]);
        assert_eq!(
            serde_json::to_value(streameast_detail(&detail, &event, at, &pages)).unwrap(),
            corpus["expected"]["browser"]["east-detail"]
        );
        assert_eq!(
            serde_json::to_value(streameast_detail(
                "<div></div>",
                &event,
                at,
                &HashMap::new()
            ))
            .unwrap(),
            corpus["expected"]["browser"]["east-detail-missing"]
        );
        assert_eq!(
            serde_json::to_value(streameast_free_server_urls(&detail, &event)).unwrap(),
            corpus["expected"]["browser"]["east-free-urls"]
        );
        assert_eq!(
            serde_json::to_value(streameast_active_free_server_url(&detail, &event)).unwrap(),
            corpus["expected"]["browser"]["east-active-free"]
        );
        let published = format!(
            "<main class=\"streameast-video-page\"><div class=\"se-board\" data-match-id=\"12345\"></div><div class=\"stream-alt-list\"><a class=\"stream-alt-item active\" href=\"{east_url}1\"><span class=\"stream-alt-free-badge\">Free</span></a></div><div id=\"se-player-root\" class=\"se-player\"><iframe src=\"https://streame.center/stream-east/ch33.php\"></iframe></div></main>"
        );
        assert_eq!(
            serde_json::to_value(streameast_published_free_player(
                &published,
                &event,
                &format!("{east_url}1")
            ))
            .unwrap(),
            corpus["expected"]["browser"]["east-published-player"]
        );
        let wrong_match = published.replace("data-match-id=\"12345\"", "data-match-id=\"99999\"");
        assert_eq!(
            streameast_published_free_player(&wrong_match, &event, &format!("{east_url}1")),
            ServerPlayer::Unsupported
        );
        let wrong_frame = published.replace(
            "https://streame.center/stream-east/ch33.php",
            "https://private.example/player",
        );
        assert_eq!(
            streameast_published_free_player(&wrong_frame, &event, &format!("{east_url}1")),
            ServerPlayer::Unsupported
        );
        let published_page = published.replace(
            "https://streame.center/stream-east/ch33.php",
            "https://dlive.sx/stream/stream-42.php",
        );
        assert_eq!(
            streameast_published_free_player(&published_page, &event, &format!("{east_url}1")),
            ServerPlayer::Page {
                url: "https://dlive.sx/stream/stream-42.php".into()
            }
        );
        assert_eq!(
            streameast_free_player("<iframe src=\"https://wikisport.info/strm/27.php\"></iframe>"),
            ServerPlayer::Wikisport {
                section: "strm".into(),
                id: "27".into(),
                url: None
            }
        );
        assert!(matches!(
            sportsurge_destination("https://[::1]/watch"),
            SportsurgeDestination::Rejected {
                reason: DestinationRejection::PrivateHost,
                ..
            }
        ));
    }
}
