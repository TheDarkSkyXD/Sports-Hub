use crate::registry::SourceRegistry;
use crate::{
    CatalogSnapshot, CollectorState, SportsfeedEvent,
    error::CollectorError,
    types::{FetchFailure, ListingOutcome, ListingResult, ReadOutcome},
};
use futures_util::{StreamExt, future::join_all};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
use url::Url;

pub const SWAC_CATALOG_URL: &str = "https://ott.gideo.video/api/legacy?cmd=getCategoryChildren&AccountID=Southwestern-Athletic-Conference&CategoryID=e1dbe7ec9a7e686b42b53ab33c3e30e4";
const SWAC_API: &str = "https://ott.gideo.video/api/legacy";
const SWAC_TENANT: &str = "Southwestern-Athletic-Conference";
const SWAC_CATEGORY: &str = "e1dbe7ec9a7e686b42b53ab33c3e30e4";

fn matches(expression: &'static str, value: &str) -> bool {
    static PATTERNS: OnceLock<Mutex<HashMap<&'static str, Regex>>> = OnceLock::new();
    let cache = PATTERNS.get_or_init(|| Mutex::new(HashMap::new()));
    let compiled = cache
        .lock()
        .entry(expression)
        .or_insert_with(|| Regex::new(expression).expect("fixed discovery expression"))
        .clone();
    compiled.is_match(value)
}

fn invalid_fixture_escape(value: &str) -> bool {
    value.match_indices('%').any(|(at, _)| {
        value
            .get(at + 1..at + 3)
            .is_none_or(|escape| !escape.eq_ignore_ascii_case("20"))
    })
}

pub fn swac_program_url(id: &str) -> String {
    format!("https://tv.swac.org/program-group/{SWAC_CATEGORY}/program/{id}")
}

pub fn swac_program_id(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let id = url.path_segments()?.next_back()?;
    (matches(r"^[a-f0-9]{32}$", id) && value == swac_program_url(id)).then(|| id.to_string())
}

pub fn swac_api_url(command: &str, id: &str) -> Option<String> {
    if !matches(r"^[a-f0-9]{32}$", id) {
        return None;
    }
    Some(if command == "getVideoUrls" {
        format!("{SWAC_API}?cmd={command}&accountId={SWAC_TENANT}&videoId={id}")
    } else if command == "getVideo" {
        format!("{SWAC_API}?cmd={command}&AccountID={SWAC_TENANT}&VideoID={id}")
    } else {
        return None;
    })
}

pub fn allowed_discovery_url(value: &str, registry: &SourceRegistry) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    match host {
        "streamed.st" => {
            value == "https://streamed.st/api/matches/all"
                || matches(
                    r"^https://streamed\.st/api/stream/[a-z][a-z0-9-]{0,39}/[a-zA-Z0-9_-]{1,160}$",
                    value,
                )
                || matches(r"^https://streamed\.st/watch/[a-zA-Z0-9_-]{1,160}$", value)
        }
        "api.kultsport.com" => {
            value == "https://api.kultsport.com/api/matches/all"
                || matches(
                    r"^https://api\.kultsport\.com/api/matches/all#[a-zA-Z0-9_-]{1,160}$",
                    value,
                )
                || !value.to_ascii_lowercase().contains("%25")
                    && matches(
                        r"^https://api\.kultsport\.com/api/stream/[a-zA-Z0-9%:-]{1,80}/[a-zA-Z0-9%_-]{1,160}$",
                        value,
                    )
        }
        "bestfreestreaming.app" => {
            matches!(
                value,
                "https://bestfreestreaming.app/api/xhr" | "https://bestfreestreaming.app/api/xrhs"
            )
        }
        "sportsfeed24.st" => {
            matches(
                r"^https://sportsfeed24\.st/fixture/[A-Za-z0-9%._~-]+-vs-[A-Za-z0-9%._~-]+$",
                value,
            ) && !invalid_fixture_escape(value)
                && value == url.as_str()
        }
        "totalsportek1.is" | "links.totalsportek1.is" => {
            url.query().is_none()
                && url.fragment().is_none()
                && matches(
                    r"^/(?:game/)?[a-z0-9]+(?:-[a-z0-9]+)*/[0-9]{1,10}/$",
                    url.path(),
                )
                && value == url.as_str()
        }
        "crichd.pk" | "m.crichd.pk" => {
            url.query().is_none()
                && url.fragment().is_none()
                && (url.path() == "/" || matches(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", url.path()))
                && value == url.as_str()
        }
        "sportsbite.org" => {
            value == "https://sportsbite.org/matches"
                || matches(
                    r"^https://sportsbite\.org/event/fg-[a-z0-9]+(?:-[a-z0-9]+)*$",
                    value,
                )
        }
        "ott.gideo.video" => {
            value == SWAC_CATALOG_URL
                || url
                    .query_pairs()
                    .find(|(key, _)| key == "VideoID")
                    .is_some_and(|(_, id)| {
                        matches(r"^[a-f0-9]{32}$", &id)
                            && swac_api_url("getVideo", &id).as_deref() == Some(value)
                    })
        }
        "tv.swac.org" => swac_program_id(value).is_some(),
        _ => {
            registry.contains_host(host)
                || host == "gooz.aapmains.net"
                || host == "streame.center"
                || url.query().is_none()
                    && url.fragment().is_none()
                    && match host {
                        "tvapp1.pk" => matches(r"^/watch/[a-zA-Z0-9-]{1,120}$", url.path()),
                        "ppv.st" => {
                            matches(
                                r"^/live/(?:cfb|nfl|nba|wnba|nhl|mlb)/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-z0-9-]+$",
                                url.path(),
                            ) || matches(
                                r"^/live/f1/[0-9]{4}/[a-z0-9-]+/(?:fp[123]|sprint-q|sprint|qualifying|race)$",
                                url.path(),
                            )
                        }
                        _ => false,
                    }
        }
    }
}

pub struct PageResponse {
    pub status: u16,
    pub location: Option<String>,
    pub retry_after: Option<String>,
    pub body: Option<Vec<u8>>,
}

#[allow(async_fn_in_trait)]
pub(crate) trait PageReader: Send + Sync {
    async fn request(
        &self,
        url: &str,
        body: Option<&str>,
        accept: &str,
        cancel: &CancellationToken,
    ) -> Result<PageResponse, FetchFailure>;
}

#[derive(Clone)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, CollectorError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| {
                CollectorError::InvalidState(format!("collector HTTP client unavailable: {error}"))
            })?;
        Ok(Self { client })
    }
}

fn failure(message: impl Into<String>) -> FetchFailure {
    FetchFailure {
        message: message.into(),
        retry_after_ms: None,
    }
}

impl PageReader for ReqwestTransport {
    async fn request(
        &self,
        url: &str,
        body: Option<&str>,
        accept: &str,
        cancel: &CancellationToken,
    ) -> Result<PageResponse, FetchFailure> {
        if cancel.is_cancelled() {
            return Err(failure("aborted"));
        }
        let request = self
            .client
            .request(
                if body.is_some() {
                    reqwest::Method::POST
                } else {
                    reqwest::Method::GET
                },
                url,
            )
            .header(reqwest::header::USER_AGENT, "SundayRoom/1.0")
            .header(reqwest::header::ACCEPT, accept);
        let request = if let Some(body) = body {
            request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_string())
        } else {
            request
        };
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(failure("aborted")),
            response = request.send() => response.map_err(|error| if error.is_timeout() { failure("timed out") } else { failure("fetch failed") })?,
        };
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if !(200..300).contains(&status) || status == 204 {
            return Ok(PageResponse {
                status,
                location,
                retry_after,
                body: None,
            });
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        loop {
            let part = tokio::select! {
                _ = cancel.cancelled() => return Err(failure("aborted")),
                part = stream.next() => part,
            };
            match part {
                Some(Ok(chunk)) => {
                    if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                        return Err(failure("response-too-large"));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Some(Err(error)) => {
                    return Err(if error.is_timeout() {
                        failure("timed out")
                    } else {
                        failure("fetch failed")
                    });
                }
                None => break,
            }
        }
        Ok(PageResponse {
            status,
            location,
            retry_after,
            body: Some(bytes),
        })
    }
}

fn retry_after_ms(header: Option<&str>) -> Option<u64> {
    let header = header?;
    if header.is_empty() {
        return None;
    }
    let delay = if header.bytes().all(|byte| byte.is_ascii_digit()) {
        header.parse::<u64>().unwrap_or(86_400).saturating_mul(1000)
    } else {
        let deadline = httpdate::parse_http_date(header).ok().or_else(|| {
            chrono::DateTime::parse_from_rfc3339(header)
                .ok()
                .map(SystemTime::from)
        })?;
        deadline
            .duration_since(SystemTime::now())
            .unwrap_or_default()
            .as_millis() as u64
    };
    Some(delay.min(86_400_000))
}

async fn read_page<R: PageReader>(
    reader: &R,
    registry: &SourceRegistry,
    url: &str,
    body: Option<&str>,
    accept: &str,
    cancel: &CancellationToken,
) -> Result<String, FetchFailure> {
    let original = Url::parse(url).map_err(|_| failure("unsupported-discovery-address"))?;
    let mut current = original.clone();
    for _ in 0..=3 {
        if cancel.is_cancelled() {
            return Err(failure("aborted"));
        }
        if !allowed_discovery_url(current.as_str(), registry)
            || (current.host_str() != original.host_str()
                && !(original.host_str() == Some("crichd.pk")
                    && current.host_str() == Some("m.crichd.pk")))
        {
            return Err(failure("unsupported-discovery-address"));
        }
        let page = tokio::time::timeout(
            Duration::from_secs(10),
            reader.request(current.as_str(), body, accept, cancel),
        )
        .await
        .map_err(|_| failure("timed out"))??;
        if (300..400).contains(&page.status) {
            let location = page
                .location
                .ok_or_else(|| failure("redirect-without-location"))?;
            let next = current
                .join(&location)
                .map_err(|_| failure("unsupported-discovery-address"))?;
            if body.is_some() && next != original {
                return Err(failure("unsupported-discovery-address"));
            }
            current = next;
            continue;
        }
        if !(200..300).contains(&page.status) {
            return Err(FetchFailure {
                message: format!("http-{}", page.status),
                retry_after_ms: retry_after_ms(page.retry_after.as_deref()),
            });
        }
        let bytes = page.body.ok_or_else(|| failure("empty-response"))?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(failure("response-too-large"));
        }
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    Err(failure("redirect-limit"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn failed(error: FetchFailure) -> ReadOutcome {
    ReadOutcome::Failed(error)
}

fn error_message(message: impl Into<String>) -> ReadOutcome {
    failed(failure(message))
}

fn catalog_body(
    state: &Arc<Mutex<CollectorState>>,
    source_id: &str,
) -> Result<String, FetchFailure> {
    let state = state.lock();
    let snapshot = state
        .catalogs
        .get(source_id)
        .ok_or_else(|| failure("catalog-expired"))?;
    if now_ms() - snapshot.at > 30 * 60_000 {
        return Err(failure("catalog-expired"));
    }
    Ok(snapshot.body.clone())
}

pub fn remember_listing(
    state: &Arc<Mutex<CollectorState>>,
    source_id: &str,
    body: &str,
    result: &ListingResult,
) {
    if !matches!(
        result.outcome,
        ListingOutcome::Parsed | ListingOutcome::Empty
    ) {
        return;
    }
    let at = now_ms();
    let mut state = state.lock();
    if matches!(source_id, "streamed" | "livesportpro" | "sportsbite") {
        state.catalogs.insert(
            source_id.to_string(),
            CatalogSnapshot {
                body: body.to_string(),
                at,
            },
        );
    } else if source_id == "sportsfeed24" {
        let complete = serde_json::from_str::<Value>(body)
            .ok()
            .is_some_and(|input| input.get("complete") == Some(&Value::Bool(true)));
        if complete {
            state.sportsfeed_events.clear();
        }
        for observation in &result.observations {
            if let Some((team_a, team_b)) = observation.title.rsplit_once(" vs ") {
                if !team_a.is_empty() {
                    state.sportsfeed_events.insert(
                        observation.url.clone(),
                        SportsfeedEvent {
                            team_a: team_a.to_string(),
                            team_b: team_b.to_string(),
                            at,
                        },
                    );
                }
            }
        }
    }
}

pub(crate) async fn read_html_with<R: PageReader>(
    reader: &R,
    state: &Arc<Mutex<CollectorState>>,
    url: &str,
    cancel: &CancellationToken,
) -> ReadOutcome {
    if cancel.is_cancelled() {
        return error_message("aborted");
    }
    let registry = { state.lock().registry.clone() };
    if url == "https://bestfreestreaming.app/api/xhr" {
        let names = ["", "NFL", "NBA", "NHL", "MLB", "F1", "motogp"];
        let futures = names.iter().map(|name| {
            let registry = registry.clone();
            async move {
                let body = if name.is_empty() {
                    "{}".to_string()
                } else {
                    json!({"categoryName":name}).to_string()
                };
                let page = read_page(
                    reader,
                    &registry,
                    url,
                    Some(&body),
                    "application/json",
                    cancel,
                )
                .await?;
                crate::listing_json::parse_sportsfeed_category(&page).map_err(failure)
            }
        });
        let settled = join_all(futures).await;
        if cancel.is_cancelled() {
            return error_message("aborted");
        }
        let mut categories = Vec::new();
        let mut errors = Vec::new();
        for item in settled {
            match item {
                Ok(category) => categories.push(category),
                Err(error) => errors.push(error),
            }
        }
        let complete = errors.is_empty();
        let body = json!({"categories":categories,"complete":complete}).to_string();
        if complete {
            return ReadOutcome::Complete(body);
        }
        let mut first = errors.remove(0);
        return if categories.is_empty() {
            failed(first)
        } else {
            let retry = errors
                .iter()
                .filter_map(|error| error.retry_after_ms)
                .chain(first.retry_after_ms)
                .max()
                .unwrap_or(0);
            first.retry_after_ms = Some(retry);
            ReadOutcome::Partial {
                body,
                failure: first,
            }
        };
    }
    if url == "https://streamed.st/api/matches/all"
        || url == "https://api.kultsport.com/api/matches/all"
        || url == "https://sportsbite.org/matches"
    {
        return match read_page(reader, &registry, url, None, "application/json", cancel).await {
            Ok(body) => ReadOutcome::Complete(body),
            Err(error) => failed(error),
        };
    }
    if let Some(id) = url.strip_prefix("https://streamed.st/watch/") {
        return match catalog_body(state, "streamed").and_then(|body| {
            crate::listing_json::select_streamed_event(&body, "streamed", id).map_err(failure)
        }) {
            Ok(body) => ReadOutcome::Complete(body),
            Err(error) => failed(error),
        };
    }
    if let Some(id) = url.strip_prefix("https://api.kultsport.com/api/matches/all#") {
        return match catalog_body(state, "livesportpro").and_then(|body| {
            crate::listing_json::select_streamed_event(&body, "livesportpro", id).map_err(failure)
        }) {
            Ok(body) => ReadOutcome::Complete(body),
            Err(error) => failed(error),
        };
    }
    if let Some(id) = url.strip_prefix("https://sportsbite.org/event/") {
        return match catalog_body(state, "sportsbite").and_then(|body| {
            crate::listing_json::select_sportsbite_event(&body, id).map_err(failure)
        }) {
            Ok(body) => ReadOutcome::Complete(body),
            Err(error) => failed(error),
        };
    }
    if url.starts_with("https://sportsfeed24.st/fixture/") && allowed_discovery_url(url, &registry)
    {
        let event = {
            let state = state.lock();
            state.sportsfeed_events.get(url).and_then(|event| {
                (now_ms() - event.at <= 30 * 60_000)
                    .then(|| (event.team_a.clone(), event.team_b.clone()))
            })
        };
        let Some((team_a, team_b)) = event else {
            return error_message("catalog-expired");
        };
        let body = json!({"teamA":team_a,"teamB":team_b}).to_string();
        return match read_page(
            reader,
            &registry,
            "https://bestfreestreaming.app/api/xrhs",
            Some(&body),
            "application/json",
            cancel,
        )
        .await
        {
            Ok(body) => ReadOutcome::Complete(body),
            Err(error) => failed(error),
        };
    }
    if let Some(id) = swac_program_id(url) {
        let Some(api) = swac_api_url("getVideo", &id) else {
            return error_message("unsupported-discovery-address");
        };
        return match read_page(reader, &registry, &api, None, "application/json", cancel).await {
            Ok(body) => ReadOutcome::Complete(body),
            Err(error) => failed(error),
        };
    }
    if allowed_discovery_url(url, &registry)
        && Url::parse(url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .as_deref()
            == Some("ppv.st")
    {
        let body = match read_page(
            reader,
            &registry,
            "https://api.ppv.st/api/streams",
            None,
            "application/json",
            cancel,
        )
        .await
        {
            Ok(body) => body,
            Err(error) => return failed(error),
        };
        let Ok(catalog) = serde_json::from_str::<Value>(&body) else {
            return error_message("parser-changed");
        };
        let Some(groups) = catalog.get("streams").and_then(Value::as_array) else {
            return error_message("parser-changed");
        };
        if catalog.get("success") != Some(&Value::Bool(true))
            || groups.iter().any(|group| {
                group.get("category").and_then(Value::as_str).is_none()
                    || group.get("streams").and_then(Value::as_array).is_none()
            })
        {
            return error_message("parser-changed");
        }
        let path = Url::parse(url)
            .ok()
            .map(|url| url.path().trim_start_matches("/live/").to_string())
            .unwrap_or_default();
        let categories = [
            "American Football",
            "Basketball",
            "Ice Hockey",
            "Baseball",
            "Motorsports",
        ];
        let events: Vec<&Value> = groups
            .iter()
            .filter(|group| {
                group
                    .get("category")
                    .and_then(Value::as_str)
                    .is_some_and(|name| categories.contains(&name))
            })
            .flat_map(|group| group["streams"].as_array().into_iter().flatten())
            .filter(|event| {
                event
                    .get("id")
                    .and_then(Value::as_i64)
                    .is_some_and(|id| id > 0)
                    && event
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| !name.is_empty())
                    && event.get("tag").and_then(Value::as_str).is_some()
                    && event.get("uri_name").and_then(Value::as_str) == Some(path.as_str())
                    && event
                        .get("starts_at")
                        .and_then(Value::as_i64)
                        .is_some_and(|at| at > 0)
            })
            .collect();
        return if events.len() == 1 {
            ReadOutcome::Complete(events[0].to_string())
        } else {
            error_message("parser-changed")
        };
    }
    if url == "https://isportsurge.ws/index6" {
        let categories = [
            "https://isportsurge.ws/nfl/livestreams3",
            "https://isportsurge.ws/cfb/livestreams2",
            "https://isportsurge.ws/nba/livestreams3",
            "https://isportsurge.ws/nhl/livestreams3",
            "https://isportsurge.ws/mlb/livestreams2",
        ];
        let settled = join_all(
            categories
                .iter()
                .map(|url| read_page(reader, &registry, url, None, "text/html", cancel)),
        )
        .await;
        if cancel.is_cancelled() {
            return error_message("aborted");
        }
        let mut pages = Vec::new();
        let mut errors = Vec::new();
        for item in settled {
            match item {
                Ok(body) => {
                    let doc = crate::html::HtmlDoc::parse(&body);
                    pages.push(
                        doc.select("body")
                            .first()
                            .map(|body| body.inner_html())
                            .unwrap_or_default(),
                    );
                }
                Err(error) => errors.push(error),
            }
        }
        let body = format!("<main>{}</main>", pages.join(""));
        if errors.is_empty() {
            return ReadOutcome::Complete(body);
        }
        let retry = errors
            .iter()
            .filter_map(|error| error.retry_after_ms)
            .max()
            .unwrap_or(0);
        let selected = errors
            .iter()
            .find(|error| matches!(error.message.as_str(), "http-429" | "rate-limited"))
            .unwrap_or(&errors[0]);
        let failure = FetchFailure {
            message: selected.message.clone(),
            retry_after_ms: Some(retry),
        };
        return if pages.is_empty() {
            failed(failure)
        } else {
            ReadOutcome::Partial { body, failure }
        };
    }
    let accept = if matches!(
        url,
        "https://api-backups.handleapi.win/matches/sport/american-football"
            | "https://api-backups.handleapi.win/matches/sport/basketball"
            | "https://api-backups.handleapi.win/matches/sport/hockey"
            | "https://api-backups.handleapi.win/matches/sport/baseball"
            | "https://api.ppv.st/api/streams"
    ) || url == SWAC_CATALOG_URL
    {
        "application/json"
    } else {
        "text/html"
    };
    match read_page(reader, &registry, url, None, accept, cancel).await {
        Ok(body) => ReadOutcome::Complete(body),
        Err(error) => failed(error),
    }
}

fn get_method() -> String {
    "GET".to_string()
}
fn ok_status() -> u16 {
    200
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureChunk {
    pub body: String,
    #[serde(default)]
    pub delay_ms: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureScript {
    pub url: String,
    #[serde(default = "get_method")]
    pub method: String,
    #[serde(default)]
    pub request_body: Option<String>,
    #[serde(default = "ok_status")]
    pub status: u16,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub chunks: Option<Vec<FixtureChunk>>,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub failure: Option<FetchFailure>,
}

#[derive(Clone, serde::Serialize)]
pub struct FixtureRequest {
    pub method: String,
    pub url: String,
    pub body: Option<String>,
    pub accept: String,
}

enum FixtureReply {
    Ready(Result<PageResponse, FetchFailure>),
    Script(FixtureScript),
}

#[derive(Default)]
pub struct FixtureTransport {
    responses: Mutex<HashMap<(String, String, Option<String>), VecDeque<FixtureReply>>>,
    requests: Mutex<Vec<FixtureRequest>>,
    cancels: Mutex<Vec<String>>,
}

impl FixtureTransport {
    pub fn enqueue(
        &self,
        url: &str,
        body: Option<&str>,
        response: Result<PageResponse, FetchFailure>,
    ) {
        let method = if body.is_some() { "POST" } else { "GET" };
        self.responses
            .lock()
            .entry((method.into(), url.into(), body.map(str::to_string)))
            .or_default()
            .push_back(FixtureReply::Ready(response));
    }

    pub fn enqueue_script(&self, script: FixtureScript) -> Result<(), CollectorError> {
        if !matches!(script.method.as_str(), "GET" | "POST")
            || script.method == "GET" && script.request_body.is_some()
        {
            return Err(CollectorError::InvalidInput(
                "invalid fixture method".into(),
            ));
        }
        let key = (
            script.method.clone(),
            script.url.clone(),
            script.request_body.clone(),
        );
        self.responses
            .lock()
            .entry(key)
            .or_default()
            .push_back(FixtureReply::Script(script));
        Ok(())
    }

    pub fn requests(&self) -> Vec<FixtureRequest> {
        self.requests.lock().clone()
    }
    pub fn cancels(&self) -> Vec<String> {
        self.cancels.lock().clone()
    }

    async fn pause(
        &self,
        url: &str,
        delay_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<(), FetchFailure> {
        if cancel.is_cancelled() {
            self.cancels.lock().push(url.to_string());
            return Err(failure("aborted"));
        }
        if delay_ms > 0 {
            tokio::select! {
                _ = cancel.cancelled() => {
                    self.cancels.lock().push(url.to_string());
                    return Err(failure("aborted"));
                }
                _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
            }
        }
        Ok(())
    }
}

impl PageReader for FixtureTransport {
    async fn request(
        &self,
        url: &str,
        body: Option<&str>,
        accept: &str,
        cancel: &CancellationToken,
    ) -> Result<PageResponse, FetchFailure> {
        let method = if body.is_some() { "POST" } else { "GET" };
        self.requests.lock().push(FixtureRequest {
            method: method.into(),
            url: url.into(),
            body: body.map(str::to_string),
            accept: accept.into(),
        });
        self.pause(url, 0, cancel).await?;
        let reply = self
            .responses
            .lock()
            .get_mut(&(method.into(), url.into(), body.map(str::to_string)))
            .and_then(VecDeque::pop_front)
            .ok_or_else(|| failure("fixture-missing"))?;
        match reply {
            FixtureReply::Ready(response) => response,
            FixtureReply::Script(script) => {
                self.pause(url, script.delay_ms, cancel).await?;
                if script.pending {
                    cancel.cancelled().await;
                    self.cancels.lock().push(url.to_string());
                    return Err(failure("aborted"));
                }
                if let Some(error) = script.failure {
                    return Err(error);
                }
                let bytes = if let Some(chunks) = script.chunks {
                    let mut bytes = Vec::new();
                    for chunk in chunks {
                        self.pause(url, chunk.delay_ms, cancel).await?;
                        bytes.extend_from_slice(chunk.body.as_bytes());
                        if bytes.len() > 2 * 1024 * 1024 {
                            return Err(failure("response-too-large"));
                        }
                    }
                    Some(bytes)
                } else {
                    script.body.map(String::into_bytes)
                };
                let header = |key: &str| {
                    script
                        .headers
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(key))
                        .map(|(_, value)| value.clone())
                };
                Ok(PageResponse {
                    status: script.status,
                    location: header("location"),
                    retry_after: header("retry-after"),
                    body: bytes,
                })
            }
        }
    }
}

#[derive(Clone)]
pub enum HttpBackend {
    Native(ReqwestTransport),
    Fixture(Arc<FixtureTransport>),
}

impl HttpBackend {
    pub fn new(fixture_mode: bool) -> Result<Self, CollectorError> {
        if fixture_mode {
            Ok(Self::Fixture(Arc::new(FixtureTransport::default())))
        } else {
            Ok(Self::Native(ReqwestTransport::new()?))
        }
    }

    pub fn fixture(&self) -> Option<&Arc<FixtureTransport>> {
        match self {
            Self::Fixture(fixture) => Some(fixture),
            Self::Native(_) => None,
        }
    }
}

impl PageReader for HttpBackend {
    async fn request(
        &self,
        url: &str,
        body: Option<&str>,
        accept: &str,
        cancel: &CancellationToken,
    ) -> Result<PageResponse, FetchFailure> {
        match self {
            Self::Native(native) => native.request(url, body, accept, cancel).await,
            Self::Fixture(fixture) => fixture.request(url, body, accept, cancel).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_policy_keeps_source_specific_paths() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        assert!(allowed_discovery_url(
            "https://ms.buffstream.io/cfb-streams/montana-state-live-stream",
            &registry
        ));
        assert!(allowed_discovery_url(
            "https://streamed.st/watch/event_123",
            &registry
        ));
        assert!(!allowed_discovery_url(
            "https://streamed.st/other",
            &registry
        ));
        assert!(!allowed_discovery_url("https://example.com/", &registry));
    }

    #[tokio::test]
    async fn scripted_transport_exercises_status_retry_redirect_and_body_cap() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let transport = FixtureTransport::default();
        let url = "https://ms.buffstream.io/cfb-streams-live-26";
        transport.enqueue(
            url,
            None,
            Ok(PageResponse {
                status: 302,
                location: Some("/cfb-streams/montana-state-live-stream".into()),
                retry_after: None,
                body: None,
            }),
        );
        transport.enqueue(
            "https://ms.buffstream.io/cfb-streams/montana-state-live-stream",
            None,
            Ok(PageResponse {
                status: 200,
                location: None,
                retry_after: None,
                body: Some(b"page".to_vec()),
            }),
        );
        assert_eq!(
            read_page(
                &transport,
                &registry,
                url,
                None,
                "text/html",
                &CancellationToken::new()
            )
            .await
            .unwrap(),
            "page"
        );
        transport.enqueue(
            url,
            None,
            Ok(PageResponse {
                status: 429,
                location: None,
                retry_after: Some("5".into()),
                body: None,
            }),
        );
        assert_eq!(
            read_page(
                &transport,
                &registry,
                url,
                None,
                "text/html",
                &CancellationToken::new()
            )
            .await
            .unwrap_err(),
            FetchFailure {
                message: "http-429".into(),
                retry_after_ms: Some(5000)
            }
        );
        transport.enqueue(
            url,
            None,
            Ok(PageResponse {
                status: 200,
                location: None,
                retry_after: None,
                body: Some(vec![b'x'; 2 * 1024 * 1024 + 1]),
            }),
        );
        assert_eq!(
            read_page(
                &transport,
                &registry,
                url,
                None,
                "text/html",
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .message,
            "response-too-large"
        );
    }
}
