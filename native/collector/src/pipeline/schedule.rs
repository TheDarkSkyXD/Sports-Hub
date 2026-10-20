use super::model::{Game, GameLifecycle, League, Observation, SeasonMembership};
use crate::http::{HttpBackend, PageReader};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{StreamExt, stream::FuturesUnordered};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

const DAY: i64 = 86_400_000;
type Result<T> = std::result::Result<T, String>;

fn text(value: &Value) -> Option<&str> {
    value.as_str()
}
fn items(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn league_name(league: League) -> String {
    serde_json::to_value(league)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}
fn numeric(value: &str) -> bool {
    cached_regex!(r"^\d{1,20}$").unwrap().is_match(value)
}
fn iso(at: i64) -> Result<String> {
    DateTime::from_timestamp_millis(at)
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| "invalid-time".into())
}
fn day(at: i64) -> Result<String> {
    DateTime::from_timestamp_millis(at)
        .map(|d| d.format("%Y%m%d").to_string())
        .ok_or_else(|| "invalid-time".into())
}
fn status(status: &Value) -> (&'static str, &'static str, bool) {
    let state = status["state"].as_str();
    let final_game =
        status["name"] == "STATUS_FINAL" && status["completed"] == true && state == Some("post");
    let lifecycle = if final_game {
        "final"
    } else if state == Some("in") && status["completed"] != true {
        "live"
    } else if status["name"] == "STATUS_SCHEDULED" && state == Some("pre") {
        "scheduled"
    } else {
        "unknown"
    };
    let state = if final_game {
        "post"
    } else if state == Some("pre") {
        "pre"
    } else if state == Some("in") {
        "in"
    } else {
        "unknown"
    };
    (state, lifecycle, final_game)
}
fn broadcast(competition: &Value) -> Option<String> {
    let names = items(&competition["broadcasts"])
        .first()
        .map(|b| items(&b["names"]))
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    (!names.is_empty()).then(|| names.join(" / "))
}
fn insert_optional(value: &mut Value, key: &str, optional: Option<impl Serialize>) {
    if let Some(optional) = optional {
        value[key] = serde_json::to_value(optional).unwrap();
    }
}
fn scoreboard_team(item: &Value, info: &Value, league: League) -> Value {
    let league = league_name(league);
    let name = info["displayName"].as_str().unwrap_or_default();
    let id = text(&info["id"])
        .filter(|id| !id.is_empty())
        .map(|id| format!("espn:{league}:{id}"));
    let mut aliases = [
        Some(name),
        text(&info["location"]),
        text(&info["shortDisplayName"]),
        text(&info["abbreviation"]),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if id.as_deref() == Some("espn:nfl:28") {
        aliases.push("Washington Redskins".into());
    }
    let short = text(&info["shortDisplayName"])
        .filter(|s| !s.is_empty())
        .or_else(|| {
            if league == "ncaaf" {
                None
            } else {
                text(&info["name"]).filter(|s| !s.is_empty())
            }
        })
        .unwrap_or(name);
    let abbreviation = text(&info["abbreviation"])
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| name.chars().take(3).collect());
    let color = text(&info["color"])
        .filter(|s| cached_regex!("(?i)^[a-f0-9]{6}$").unwrap().is_match(s))
        .unwrap_or("566775");
    let score = match &item["score"] {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    };
    let mut value = json!({"name":name,"aliases":aliases,"short":short,"abbreviation":abbreviation,"color":color,"score":score});
    insert_optional(&mut value, "id", id);
    insert_optional(
        &mut value,
        "logo",
        text(&info["logo"]).filter(|s| s.starts_with("https://")),
    );
    insert_optional(
        &mut value,
        "record",
        items(&item["records"])
            .iter()
            .find(|r| r["type"] == "total")
            .and_then(|r| text(&r["summary"])),
    );
    value
}
pub fn is_ufc_card_name(name: &str) -> bool {
    cached_regex!(r"(?i)^(?:UFC(?:\s+Fight\s+Night|\s+on\s+ESPN|\s+on\s+ABC|\s+\d+)|Dana White['’]?s Contender Series)\b").unwrap().is_match(name.trim())
}
pub fn scoreboard_week(input: &Value) -> Option<f64> {
    input["week"]["number"]
        .as_f64()
        .filter(|n| n.fract() == 0.0)
}
pub fn scoreboard_feed_data(input: &Value, format: &str) -> Result<Value> {
    if format == "site" {
        return Ok(input.clone());
    }
    input["content"]["sbData"]
        .as_object()
        .map(|_| input["content"]["sbData"].clone())
        .ok_or_else(|| "Scoreboard format changed".into())
}
pub fn parse_scoreboard(input: &Value, league: League) -> Result<Vec<Game>> {
    let events = input["events"]
        .as_array()
        .ok_or("Scoreboard format changed")?;
    if matches!(league, League::F1 | League::NascarCup | League::NascarTruck) {
        return parse_race_scoreboard(events, league);
    }
    if league == League::Ufc {
        return parse_ufc_scoreboard(events);
    }
    let mut games = Vec::new();
    for event in events {
        let competition = &event["competitions"][0];
        let competitors = items(&competition["competitors"]);
        let home = competitors.iter().find(|i| i["homeAway"] == "home");
        let away = competitors.iter().find(|i| i["homeAway"] == "away");
        let Some((id, home, away)) = text(&event["id"])
            .filter(|id| numeric(id))
            .zip(home)
            .zip(away)
            .map(|((id, h), a)| (id, h, a))
        else {
            continue;
        };
        let home_team = &home["team"];
        let away_team = &away["team"];
        if text(&home_team["displayName"]).is_none_or(str::is_empty)
            || text(&away_team["displayName"]).is_none_or(str::is_empty)
        {
            continue;
        }
        let event_status = if event["status"].is_object() {
            &event["status"]
        } else {
            &competition["status"]
        };
        let status_type = &event_status["type"];
        let (state, lifecycle, _) = status(status_type);
        let short_detail = text(&status_type["shortDetail"])
            .filter(|s| !s.is_empty())
            .unwrap_or("Status unavailable");
        let detail = if status_type["name"] == "STATUS_SCHEDULED"
            && !matches!(short_detail, "TBD" | "TBA")
        {
            "Scheduled"
        } else {
            short_detail
        };
        let situation = &competition["situation"];
        let no_football = matches!(
            league,
            League::Nba | League::Wnba | League::Nhl | League::Mlb
        );
        let mut game = json!({"id":if league==League::Nfl{id.to_owned()}else{format!("{}-{id}",league_name(league))},"league":league,"lifecycle":lifecycle,"status":state,"name":text(&event["name"]).filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||format!("{} at {}",away_team["displayName"].as_str().unwrap(),home_team["displayName"].as_str().unwrap())),"home":scoreboard_team(home,home_team,league),"away":scoreboard_team(away,away_team,league),"detail":detail,"redzone":!no_football&&situation["isRedZone"]==true&&state=="in"});
        insert_optional(&mut game, "date", text(&event["date"]));
        insert_optional(&mut game, "season", event["season"]["year"].as_f64());
        if !no_football {
            insert_optional(&mut game, "down", text(&situation["downDistanceText"]));
            let possession = if situation.get("possession").is_some()
                && situation["possession"] == home["id"]
            {
                text(&home_team["abbreviation"])
            } else if situation.get("possession").is_some() && situation["possession"] == away["id"]
            {
                text(&away_team["abbreviation"])
            } else {
                None
            };
            insert_optional(&mut game, "possession", possession);
        }
        insert_optional(&mut game, "lastPlay", text(&situation["lastPlay"]["text"]));
        insert_optional(&mut game, "venue", text(&competition["venue"]["fullName"]));
        insert_optional(&mut game, "broadcast", broadcast(competition));
        games.push(serde_json::from_value(game).map_err(|e| e.to_string())?);
    }
    Ok(games)
}
fn parse_ufc_scoreboard(events: &[Value]) -> Result<Vec<Game>> {
    let mut games = Vec::new();
    for event in events {
        let Some(id) = text(&event["id"]).filter(|id| numeric(id)) else {
            continue;
        };
        let Some(name) = text(&event["name"])
            .map(str::trim)
            .filter(|n| !n.is_empty() && is_ufc_card_name(n))
        else {
            continue;
        };
        let Some(date) =
            text(&event["date"]).filter(|d| super::model::parse_game_date(d).is_some())
        else {
            continue;
        };
        let status_type = &event["status"]["type"];
        let (state, lifecycle, final_game) = status(status_type);
        let mut game = json!({"id":format!("ufc-{id}"),"league":"ufc","name":name,"date":date,"combat":{"eventId":id},"status":state,"lifecycle":lifecycle,"detail":if final_game{"Final"}else if lifecycle=="scheduled"{"Scheduled"}else{text(&status_type["shortDetail"]).filter(|s|!s.is_empty()).unwrap_or("Status unavailable")}});
        insert_optional(&mut game, "broadcast", broadcast(&event["competitions"][0]));
        games.push(serde_json::from_value(game).map_err(|e| e.to_string())?);
    }
    Ok(games)
}
fn parse_race_scoreboard(events: &[Value], league: League) -> Result<Vec<Game>> {
    let mut games = Vec::new();
    for event in events {
        let Some(id) = text(&event["id"]).filter(|id| numeric(id)) else {
            continue;
        };
        let Some(name) = text(&event["name"]) else {
            continue;
        };
        let circuit = text(&event["circuit"]["fullName"]);
        let round = if league == League::F1 {
            text(&event["circuit"]["address"]["city"])
                .or(Some(name))
                .map(str::to_owned)
        } else {
            cached_regex!(r"(?i)\bat\s+(.+)$")
                .unwrap()
                .captures(name)
                .map(|c| c[1].to_owned())
        };
        let Some(round) = round.filter(|s| !s.is_empty()) else {
            continue;
        };
        if name.is_empty() || league == League::F1 && circuit.is_none_or(str::is_empty) {
            continue;
        }
        for competition in items(&event["competitions"]) {
            let Some(session_id) = text(&competition["id"]).filter(|id| numeric(id)) else {
                continue;
            };
            let Some(date) =
                text(&competition["date"]).filter(|d| super::model::parse_game_date(d).is_some())
            else {
                continue;
            };
            let session = if league == League::F1 {
                match text(&competition["type"]["abbreviation"]) {
                    Some("FP1") => Some(("practice-1", "Practice 1")),
                    Some("FP2") => Some(("practice-2", "Practice 2")),
                    Some("FP3") => Some(("practice-3", "Practice 3")),
                    Some("SS") => Some(("sprint-qualifying", "Sprint Qualifying")),
                    Some("SR") => Some(("sprint", "Sprint")),
                    Some("Qual") => Some(("qualifying", "Qualifying")),
                    Some("Race") => Some(("race", "Race")),
                    _ => None,
                }
            } else {
                Some(("race", "Race"))
            };
            let Some((session, label)) = session else {
                continue;
            };
            let status_type = &competition["status"]["type"];
            let (state, lifecycle, final_game) = status(status_type);
            let mut game = json!({"id":format!("{}-{session_id}",league_name(league)),"league":league,"name":if league==League::F1{format!("{name} · {label}")}else{name.to_owned()},"date":date,"race":{"eventId":id,"sessionId":session_id,"session":session,"round":round},"status":state,"lifecycle":lifecycle,"detail":if final_game{"Final"}else if lifecycle=="scheduled"{"Scheduled"}else{text(&status_type["shortDetail"]).filter(|s|!s.is_empty()).unwrap_or("Status unavailable")}});
            insert_optional(&mut game["race"], "circuit", circuit);
            insert_optional(&mut game, "season", event["season"]["year"].as_f64());
            insert_optional(&mut game, "broadcast", broadcast(competition));
            games.push(serde_json::from_value(game).map_err(|e| e.to_string())?);
        }
    }
    Ok(games)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleSource {
    pub id: String,
    pub league: League,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sport: Option<String>,
    pub path: String,
    pub group: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleResult {
    pub games: Vec<Game>,
    pub league: League,
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub horizon_errors: Vec<String>,
}
#[derive(Clone)]
struct CachedDay {
    date: String,
    games: Vec<Game>,
    expires_at: i64,
}
type ListingFuture = futures_util::future::Shared<
    futures_util::future::BoxFuture<'static, Result<Vec<Observation>>>,
>;
struct ListingRead {
    at: i64,
    future: ListingFuture,
    cancel: CancellationToken,
    consumers: usize,
}
#[derive(Default)]
struct ListingCache {
    snapshot: Option<(i64, Vec<Observation>)>,
    read: Option<Arc<Mutex<ListingRead>>>,
}
pub struct ScheduleClient {
    transport: HttpBackend,
    registry: Arc<crate::registry::SourceRegistry>,
    collector_state: Arc<Mutex<crate::CollectorState>>,
    queue: Arc<RequestQueue>,
    days: Mutex<HashMap<String, CachedDay>>,
    listings: Mutex<HashMap<String, ListingCache>>,
}
impl ScheduleClient {
    fn state(registry: Arc<crate::registry::SourceRegistry>) -> Arc<Mutex<crate::CollectorState>> {
        Arc::new(Mutex::new(crate::CollectorState {
            registry,
            catalogs: HashMap::new(),
            sportsfeed_events: HashMap::new(),
            inflight: HashMap::new(),
            next_request_id: 0,
            resolvers: HashMap::new(),
            next_resolver_id: 0,
            sweeps: HashMap::new(),
            next_sweep_id: 0,
        }))
    }
    pub fn new(registry: Arc<crate::registry::SourceRegistry>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            transport: HttpBackend::new(false).map_err(|e| e.to_string())?,
            collector_state: Self::state(registry.clone()),
            registry,
            queue: Arc::new(RequestQueue::default()),
            days: Mutex::new(HashMap::new()),
            listings: Mutex::new(HashMap::new()),
        }))
    }
    pub fn fixture(
        registry: Arc<crate::registry::SourceRegistry>,
    ) -> (Arc<Self>, Arc<crate::http::FixtureTransport>) {
        let transport = Arc::new(crate::http::FixtureTransport::default());
        (
            Arc::new(Self {
                transport: HttpBackend::Fixture(transport.clone()),
                collector_state: Self::state(registry.clone()),
                registry,
                queue: Arc::new(RequestQueue::default()),
                days: Mutex::new(HashMap::new()),
                listings: Mutex::new(HashMap::new()),
            }),
            transport,
        )
    }
    async fn request(
        &self,
        url: &str,
        priority: u8,
        cancel: &CancellationToken,
        accept: &str,
    ) -> Result<(u16, Vec<u8>)> {
        let _permit = self.queue.acquire(url, priority, cancel).await?;
        let response = self
            .transport
            .request(url, None, accept, cancel)
            .await
            .map_err(|e| {
                if e.message == "timed out" {
                    "timeout".into()
                } else {
                    e.message
                }
            })?;
        Ok((response.status, response.body.unwrap_or_default()))
    }
    async fn json(
        &self,
        url: &str,
        priority: u8,
        cancel: &CancellationToken,
        prefix: &str,
    ) -> Result<Value> {
        let (status, body) = self
            .request(url, priority, cancel, "application/json")
            .await?;
        if !(200..300).contains(&status) {
            return Err(format!("{prefix}http-{status}"));
        }
        serde_json::from_slice(&body).map_err(|e| e.to_string())
    }
    async fn listing(&self, url: &str, priority: u8, cancel: &CancellationToken) -> Result<String> {
        let _permit = self.queue.acquire(url, priority, cancel).await?;
        match crate::http::read_html_with(&self.transport, &self.collector_state, url, cancel).await
        {
            crate::types::ReadOutcome::Complete(body) => Ok(body),
            crate::types::ReadOutcome::Partial { failure, .. }
            | crate::types::ReadOutcome::Failed(failure) => {
                Err(if failure.message == "timed out" {
                    "timeout".into()
                } else {
                    failure.message
                })
            }
        }
    }
}

#[derive(Default)]
struct RequestQueue {
    state: Mutex<QueueState>,
}
#[derive(Default)]
struct QueueState {
    next: u64,
    queued: Vec<QueuedRequest>,
    active: HashMap<u64, String>,
}
struct QueuedRequest {
    id: u64,
    origin: String,
    priority: u8,
    ready: tokio::sync::oneshot::Sender<()>,
}
struct RequestPermit {
    queue: Arc<RequestQueue>,
    id: u64,
}
impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.queue.state.lock().active.remove(&self.id);
        self.queue.pump();
    }
}
impl RequestQueue {
    fn pump(&self) {
        let mut state = self.state.lock();
        state.queued.sort_by_key(|q| q.priority);
        while state.active.len() < 8 {
            let index = state.queued.iter().position(|q| {
                state
                    .active
                    .values()
                    .filter(|origin| **origin == q.origin)
                    .count()
                    < 6
            });
            let Some(index) = index else {
                break;
            };
            let job = state.queued.remove(index);
            if job.ready.send(()).is_ok() {
                state.active.insert(job.id, job.origin);
            }
        }
    }
    async fn acquire(
        self: &Arc<Self>,
        url: &str,
        priority: u8,
        cancel: &CancellationToken,
    ) -> Result<RequestPermit> {
        if cancel.is_cancelled() {
            return Err("aborted".into());
        }
        let origin = url::Url::parse(url)
            .map_err(|_| "invalid-schedule-url")?
            .origin()
            .ascii_serialization();
        let (send, receive) = tokio::sync::oneshot::channel();
        let id = {
            let mut state = self.state.lock();
            state.next += 1;
            let id = state.next;
            state.queued.push(QueuedRequest {
                id,
                origin,
                priority,
                ready: send,
            });
            id
        };
        if priority != 0 {
            tokio::task::yield_now().await;
        }
        self.pump();
        tokio::select! {
            biased;
            result=receive=>{result.map_err(|_|"schedule-queue-closed")?;Ok(RequestPermit{queue:self.clone(),id})}
            _=cancel.cancelled()=>{let mut state=self.state.lock();state.queued.retain(|q|q.id!=id);state.active.remove(&id);drop(state);self.pump();Err("aborted".into())}
        }
    }
}

pub fn default_schedules() -> Vec<ScheduleSource> {
    let mut sources = Vec::new();
    for (id, league, sport, path, group) in [
        ("nfl", League::Nfl, None, "nfl", None),
        ("fbs", League::Ncaaf, None, "college-football", Some("80")),
        ("fcs", League::Ncaaf, None, "college-football", Some("81")),
        ("d2-d3", League::Ncaaf, None, "college-football", Some("35")),
        ("nba", League::Nba, Some("basketball"), "nba", None),
        ("wnba", League::Wnba, Some("basketball"), "wnba", None),
        ("nhl", League::Nhl, Some("hockey"), "nhl", None),
        ("mlb", League::Mlb, Some("baseball"), "mlb", None),
        ("f1", League::F1, Some("racing"), "f1", None),
        (
            "nascar-cup",
            League::NascarCup,
            Some("racing"),
            "nascar-premier",
            None,
        ),
        (
            "nascar-truck",
            League::NascarTruck,
            Some("racing"),
            "nascar-truck",
            None,
        ),
        (
            "motogp",
            League::Motogp,
            Some("racing"),
            "source-motogp",
            None,
        ),
        (
            "motorsport",
            League::Motorsport,
            Some("racing"),
            "source-motorsport",
            None,
        ),
        ("ufc", League::Ufc, Some("mma"), "ufc", None),
        ("boxing", League::Boxing, None, "source-boxing", None),
        ("wwe", League::Wwe, None, "source-wwe", None),
        ("tna", League::Tna, None, "source-tna", None),
        ("aew", League::Aew, None, "source-aew", None),
        (
            "wrestling",
            League::Wrestling,
            None,
            "source-wrestling",
            None,
        ),
    ] {
        sources.push(ScheduleSource {
            id: id.into(),
            league,
            sport: sport.map(str::to_owned),
            path: path.into(),
            group: group.map(str::to_owned),
        });
    }
    sources
}
pub fn scoreboard_url(source: &ScheduleSource, date: &str) -> Result<String> {
    let mut url = url::Url::parse(&format!(
        "https://site.api.espn.com/apis/site/v2/sports/{}/{}/scoreboard",
        source.sport.as_deref().unwrap_or("football"),
        source.path
    ))
    .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("limit", "200")
        .append_pair("dates", date);
    if let Some(group) = &source.group {
        url.query_pairs_mut().append_pair("groups", group);
    }
    Ok(url.into())
}
async fn fetch_day(
    client: &ScheduleClient,
    source: &ScheduleSource,
    date: &str,
    priority: u8,
    now: i64,
    cancel: &CancellationToken,
) -> Result<(Vec<Game>, Option<f64>)> {
    let url = scoreboard_url(source, date)?;
    let response = client.json(&url, priority, cancel, "").await;
    let input = match response {
        Err(error)
            if priority == 0
                && !cancel.is_cancelled()
                && matches!(error.as_str(), "timeout" | "fetch failed") =>
        {
            client.json(&url, 1, cancel, "").await?
        }
        result => result?,
    };
    let events = input["events"]
        .as_array()
        .ok_or("scoreboard-format-changed")?;
    if events.len() >= 200 {
        return Err("schedule-may-be-truncated".into());
    }
    let mut games = parse_scoreboard(&input, source.league)?;
    let complete = if source.sport.as_deref() == Some("racing") {
        events.iter().all(|event| {
            event["competitions"]
                .as_array()
                .is_some_and(|competitions| {
                    games
                        .iter()
                        .filter(|g| {
                            g.race()
                                .is_some_and(|r| Some(r.event_id.as_str()) == event["id"].as_str())
                        })
                        .count()
                        == competitions.len()
                })
        })
    } else if source.sport.as_deref() == Some("mma") {
        games.len()
            == events
                .iter()
                .filter(|event| text(&event["name"]).is_some_and(is_ufc_card_name))
                .count()
    } else {
        games.len() == events.len()
    };
    let unique = games
        .iter()
        .map(|g| &g.id)
        .collect::<std::collections::HashSet<_>>()
        .len()
        == games.len();
    if !complete || !unique {
        return Err("schedule-incomplete-or-duplicate".into());
    }
    for game in &mut games {
        game.partitions = Some(vec![source.id.clone()]);
        if game.lifecycle == GameLifecycle::Final {
            *game = super::domain::record_final(game, now, 1440);
        }
    }
    Ok((games, scoreboard_week(&input)))
}
fn valid_kickoff(date: Option<&str>) -> bool {
    let Some(date) = date else {
        return false;
    };
    cached_regex!(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$")
        .unwrap()
        .is_match(date)
        && super::model::parse_game_date(date)
            .is_some_and(|at| (946684800000..4102444800000).contains(&at))
}
fn same_team(left: &super::model::Team, right: &super::model::Team) -> bool {
    match (
        left.id.as_deref().filter(|s| !s.is_empty()),
        right.id.as_deref().filter(|s| !s.is_empty()),
    ) {
        (Some(a), Some(b)) => a == b,
        _ => left.name == right.name,
    }
}
fn conflict(a: &Game, b: &Game) -> bool {
    a.league != b.league
        || match (&a.kind, &b.kind) {
            (
                super::model::GameKind::Race { race: a_race },
                super::model::GameKind::Race { race: b_race },
            ) => {
                a_race.event_id != b_race.event_id
                    || a_race.session != b_race.session
                    || a.date != b.date
            }
            (
                super::model::GameKind::Wrestling { wrestling: a },
                super::model::GameKind::Wrestling { wrestling: b },
            ) => a.event_id != b.event_id,
            (
                super::model::GameKind::Combat { combat: a },
                super::model::GameKind::Combat { combat: b },
            ) => a.event_id != b.event_id,
            (
                super::model::GameKind::Matchup {
                    home: a_home,
                    away: a_away,
                    ..
                },
                super::model::GameKind::Matchup {
                    home: b_home,
                    away: b_away,
                    ..
                },
            ) => a_home.id != b_home.id || a_away.id != b_away.id,
            _ => false,
        }
}
fn merge_games(
    history: &[Game],
    current: &[Game],
    future: &[(String, Vec<Game>)],
    errors: &mut Vec<String>,
) -> Result<Vec<Game>> {
    let mut games: Vec<Game> = Vec::new();
    for (daily, date) in [(history, None), (current, None)].into_iter().chain(
        future
            .iter()
            .map(|(date, games)| (games.as_slice(), Some(date))),
    ) {
        for game in daily {
            if let Some(index) = games.iter().position(|g| g.id == game.id) {
                if conflict(&games[index], game) {
                    if let Some(date) = date {
                        errors.push(format!("{date}:schedule-conflicting-event"));
                    } else {
                        return Err("schedule-conflicting-event".into());
                    }
                }
                if date.is_none() {
                    games[index] = game.clone();
                }
            } else {
                games.push(game.clone());
            }
        }
    }
    Ok(games)
}
async fn supplement_dates(
    client: &ScheduleClient,
    source: &ScheduleSource,
    games: &mut [Game],
    cancel: &CancellationToken,
) -> Result<()> {
    if source.league != League::Ncaaf
        || source.group.is_none()
        || !games.iter().any(|g| !valid_kickoff(g.date.as_deref()))
    {
        return Ok(());
    }
    let url = format!(
        "https://cdn.espn.com/core/college-football/scoreboard?xhr=1&limit=500&group={}",
        source.group.as_deref().unwrap()
    );
    let result = async {
        let input = client.json(&url, 0, cancel, "cdn-").await?;
        parse_scoreboard(&scoreboard_feed_data(&input, "cdn")?, League::Ncaaf)
    }
    .await;
    match result {
        Ok(extras) => {
            for extra in extras {
                if let Some(game) = games.iter_mut().find(|g| {
                    g.id == extra.id
                        && !valid_kickoff(g.date.as_deref())
                        && valid_kickoff(extra.date.as_deref())
                        && g.home()
                            .zip(extra.home())
                            .is_some_and(|(a, b)| same_team(a, b))
                        && g.away()
                            .zip(extra.away())
                            .is_some_and(|(a, b)| same_team(a, b))
                }) {
                    game.date = extra.date;
                }
            }
        }
        Err(error) if cancel.is_cancelled() => return Err(error),
        Err(_) => {}
    }
    Ok(())
}
fn horizon_reason(error: &str) -> &str {
    if error == "timeout"
        || cached_regex!(r"^http-\d{3}$").unwrap().is_match(error)
        || matches!(
            error,
            "scoreboard-format-changed"
                | "schedule-may-be-truncated"
                | "schedule-incomplete-or-duplicate"
        )
    {
        error
    } else {
        "future-unavailable"
    }
}
fn history_reason(error: &str) -> &str {
    if error == "timeout" || cached_regex!(r"^http-\d{3}$").unwrap().is_match(error) {
        error
    } else {
        "history-unavailable"
    }
}
fn normalize_snapshots(
    current: &mut [Game],
    history: &mut Option<Result<Vec<Game>>>,
    games: &[Game],
) {
    for game in current {
        if let Some(normalized) = games.iter().find(|g| g.id == game.id) {
            *game = normalized.clone();
        }
    }
    if let Some(Ok(history)) = history {
        for game in history {
            if let Some(normalized) = games.iter().find(|g| g.id == game.id) {
                *game = normalized.clone();
            }
        }
    }
}
pub async fn read_schedule(
    source: ScheduleSource,
    now: i64,
    cancel: CancellationToken,
    client: Arc<ScheduleClient>,
    progress: impl Fn(ScheduleResult) + Send + Sync,
) -> Result<ScheduleResult> {
    if matches!(
        source.league,
        League::Motogp
            | League::Motorsport
            | League::Boxing
            | League::Wwe
            | League::Tna
            | League::Aew
            | League::Wrestling
    ) {
        return read_listing_schedule(source, now, cancel, client, progress).await;
    }
    let today = day(now)?;
    let yesterday = day(now - DAY)?;
    let last = day(now + 7 * DAY)?;
    let key_for = |date: &str| {
        format!(
            "{}|{}|{}|{date}",
            source.sport.as_deref().unwrap_or("football"),
            source.path,
            source.group.as_deref().unwrap_or_default()
        )
    };
    let dates = (1..=7)
        .map(|offset| day(now + offset * DAY))
        .collect::<Result<Vec<_>>>()?;
    let cached = {
        let mut cache = client.days.lock();
        cache.retain(|_, entry| entry.date > today && entry.date <= last);
        dates
            .iter()
            .map(|d| cache.get(&key_for(d)).cloned())
            .collect::<Vec<_>>()
    };
    let history_future = fetch_day(&client, &source, &yesterday, 2, now, &cancel);
    tokio::pin!(history_future);
    let current_future = fetch_day(&client, &source, &today, 0, now, &cancel);
    tokio::pin!(current_future);
    let mut history: Option<Result<Vec<Game>>> = None;
    let current_result = if let Some(result) =
        futures_util::FutureExt::now_or_never(current_future.as_mut())
    {
        result
    } else {
        tokio::select! {
            current=&mut current_future=>current,
            previous=&mut history_future=>{history=Some(previous.map(|(games,_)|games));current_future.await}
        }
    };
    let (mut current, week) = match current_result {
        Ok(current) => current,
        Err(error) => {
            cancel.cancel();
            if history.is_none() {
                let _ = history_future.as_mut().await;
            }
            return Err(error);
        }
    };
    let history_issue = |history: &Option<Result<Vec<Game>>>| match history {
        None => Some(json!({"kind":"loading","day":yesterday})),
        Some(Err(e)) => Some(json!({"kind":"failed","day":yesterday,"reason":history_reason(e)})),
        _ => None,
    };
    let cached_games = dates
        .iter()
        .zip(&cached)
        .filter_map(|(date, entry)| {
            entry
                .as_ref()
                .map(|entry| (date.clone(), entry.games.clone()))
        })
        .collect::<Vec<_>>();
    let mut errors = Vec::new();
    let mut games = merge_games(
        history
            .as_ref()
            .and_then(|h| h.as_ref().ok())
            .map(Vec::as_slice)
            .unwrap_or_default(),
        &current,
        &cached_games,
        &mut errors,
    )?;
    supplement_dates(&client, &source, &mut games, &cancel).await?;
    normalize_snapshots(&mut current, &mut history, &games);
    if history.is_none() {
        if let Some(ready) = futures_util::FutureExt::now_or_never(history_future.as_mut()) {
            history = Some(ready.map(|(g, _)| g));
            games = merge_games(
                history
                    .as_ref()
                    .and_then(|h| h.as_ref().ok())
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
                &current,
                &cached_games,
                &mut errors,
            )?;
            supplement_dates(&client, &source, &mut games, &cancel).await?;
            normalize_snapshots(&mut current, &mut history, &games);
        }
    }
    if cancel.is_cancelled() {
        return Err("aborted".into());
    }
    progress(ScheduleResult {
        games: games.clone(),
        league: source.league,
        at: Utc::now().timestamp_millis(),
        week,
        history: history_issue(&history),
        horizon_errors: Vec::new(),
    });
    let mut future_reads = FuturesUnordered::new();
    let future_limit = Arc::new(Semaphore::new(3));
    for (index, date) in dates.iter().enumerate() {
        if cached[index].as_ref().is_some_and(|e| e.expires_at > now) {
            continue;
        }
        let client = client.clone();
        let source = source.clone();
        let cancel = cancel.clone();
        let date = date.clone();
        let permit = future_limit.clone();
        future_reads.push(async move{let _permit=tokio::select!{_ = cancel.cancelled()=>return(index,date,Err("aborted".into())),permit=permit.acquire_owned()=>match permit{Ok(p)=>p,Err(_)=>return(index,date,Err("aborted".into()))}};let result=fetch_day(&client,&source,&date,3,now,&cancel).await.map(|(g,_)|g);(index,date,result)});
    }
    let mut refreshed: Vec<Option<Vec<Game>>> = vec![None; 7];
    let mut failures: Vec<Option<String>> = vec![None; 7];
    while !future_reads.is_empty() || history.is_none() {
        tokio::select! {
            previous=&mut history_future,if history.is_none()=>{
                history=Some(previous.map(|(games,_)|games));
                if cancel.is_cancelled(){while future_reads.next().await.is_some(){}return Err("aborted".into());}
                let mut progress_errors=Vec::new();
                let mut progress_games=merge_games(history.as_ref().and_then(|h|h.as_ref().ok()).map(Vec::as_slice).unwrap_or_default(),&current,&cached_games,&mut progress_errors)?;
                supplement_dates(&client,&source,&mut progress_games,&cancel).await?;
                normalize_snapshots(&mut current,&mut history,&progress_games);
                progress(ScheduleResult{games:progress_games,league:source.league,at:Utc::now().timestamp_millis(),week,history:history_issue(&history),horizon_errors:progress_errors});
            }
            result=future_reads.next(),if !future_reads.is_empty()=>if let Some((index,date,result))=result {
                match result {Ok(games)=>{client.days.lock().insert(key_for(&date),CachedDay{date,games:games.clone(),expires_at:now+300000});refreshed[index]=Some(games);},Err(error)=>{if cancel.is_cancelled(){while future_reads.next().await.is_some(){}if history.is_none(){let _=history_future.as_mut().await;}return Err(error);}failures[index]=Some(format!("{date}:{}",horizon_reason(&error)));}}
            },
            _=cancel.cancelled()=>{while future_reads.next().await.is_some(){}if history.is_none(){let _=history_future.as_mut().await;}return Err("aborted".into());},
        }
    }
    errors = failures.into_iter().flatten().collect();
    let future = dates
        .iter()
        .enumerate()
        .filter_map(|(index, date)| {
            refreshed[index]
                .as_ref()
                .or_else(|| cached[index].as_ref().map(|c| &c.games))
                .map(|g| (date.clone(), g.clone()))
        })
        .collect::<Vec<_>>();
    let mut games = merge_games(
        history
            .as_ref()
            .and_then(|h| h.as_ref().ok())
            .map(Vec::as_slice)
            .unwrap_or_default(),
        &current,
        &future,
        &mut errors,
    )?;
    supplement_dates(&client, &source, &mut games, &cancel).await?;
    let mut unique = std::collections::HashSet::new();
    errors.retain(|e| unique.insert(e.clone()));
    Ok(ScheduleResult {
        games,
        league: source.league,
        at: Utc::now().timestamp_millis(),
        week,
        history: history_issue(&history),
        horizon_errors: errors,
    })
}

pub fn membership_url(season: i32, group: i32) -> String {
    format!(
        "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/{season}/types/2/groups/{group}/teams?limit=1000"
    )
}
pub fn parse_membership_group(input: &Value, season: i32) -> Result<Vec<String>> {
    let count = input["count"]
        .as_u64()
        .filter(|n| (1..=1000).contains(n))
        .ok_or("membership-incomplete")?;
    if input["pageCount"] != 1
        || input["pageIndex"] != 1
        || input["items"]
            .as_array()
            .is_none_or(|items| items.len() != count as usize)
    {
        return Err("membership-incomplete".into());
    }
    let mut ids = Vec::new();
    let expression = crate::compile_fixed_pattern(&format!(
        r"^/v2/sports/football/leagues/college-football/seasons/{season}/teams/(\d{{1,20}})$"
    ));
    for item in items(&input["items"]) {
        let reference = text(&item["$ref"]).ok_or("membership-invalid-ref")?;
        let url = url::Url::parse(reference).map_err(|_| "membership-invalid-ref")?;
        let captures = expression
            .captures(url.path())
            .ok_or("membership-invalid-ref")?;
        if url.host_str() != Some("sports.core.api.espn.com")
            || !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || ids.iter().any(|id| id == &captures[1])
        {
            return Err("membership-invalid-ref".into());
        }
        ids.push(captures[1].to_owned());
    }
    Ok(ids)
}
pub async fn read_membership(
    season: i32,
    client: Arc<ScheduleClient>,
    cancel: CancellationToken,
) -> Result<SeasonMembership> {
    if !(2000..=2100).contains(&season) {
        return Err("invalid-season".into());
    }
    let mut teams = std::collections::BTreeMap::new();
    for (group, subdivision) in [
        (80, super::model::Subdivision::Fbs),
        (81, super::model::Subdivision::Fcs),
        (35, super::model::Subdivision::D2D3),
    ] {
        let input = client
            .json(&membership_url(season, group), 0, &cancel, "membership-")
            .await?;
        for id in parse_membership_group(&input, season)? {
            if teams.insert(id, subdivision).is_some() {
                return Err("membership-overlapping-groups".into());
            }
        }
    }
    Ok(SeasonMembership {
        season,
        at: Utc::now().timestamp_millis(),
        teams,
    })
}
pub fn listing_schedule_group(league: League) -> &'static str {
    if matches!(
        league,
        League::Wwe | League::Tna | League::Aew | League::Wrestling
    ) {
        "wrestling"
    } else if league == League::Boxing {
        "boxing"
    } else {
        "motorsports"
    }
}
fn normalized_title(value: &str) -> String {
    let folded = value
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect::<String>()
        .to_lowercase();
    cached_regex!("[^a-z0-9]+")
        .unwrap()
        .replace_all(&folded, " ")
        .trim()
        .to_owned()
}
fn numeric_identity(value: &str) -> String {
    let hash = hex::encode(Sha256::digest(value.as_bytes()));
    u64::from_str_radix(&hash[..12], 16).unwrap().to_string()
}
pub fn listing_schedule_from_observations(
    source: &ScheduleSource,
    now: i64,
    observations: &[Observation],
) -> Result<ScheduleResult> {
    let mut games: Vec<Game> = Vec::new();
    for observation in observations {
        let Some(kickoff) = observation.kickoff else {
            continue;
        };
        if observation.league != Some(source.league)
            || kickoff < now - DAY
            || kickoff > now + 7 * DAY
        {
            continue;
        }
        let title = &observation.title;
        let wrestling = matches!(
            source.league,
            League::Wwe | League::Tna | League::Aew | League::Wrestling
        );
        let league = league_name(source.league);
        if source.league == League::Boxing || wrestling {
            let key = if wrestling {
                super::matching::wrestling_event_key(source.league, title, kickoff)
            } else {
                Some(format!(
                    "{league}|{}|{}",
                    normalized_title(title),
                    DateTime::from_timestamp_millis(kickoff)
                        .ok_or("invalid-time")?
                        .format("%Y-%m-%d")
                ))
            };
            let Some(key) = key else {
                continue;
            };
            let event_id = numeric_identity(&key);
            let ends_at = if wrestling { observation.ends_at } else { None };
            let state = if kickoff > now {
                "pre"
            } else if source.league == League::Boxing || ends_at.is_some_and(|ends| now < ends) {
                "in"
            } else {
                "unknown"
            };
            let mut value = json!({"id":format!("{league}-{event_id}"),"league":source.league,"name":title,"date":iso(kickoff)?,"status":state,"lifecycle":if state=="pre"{"scheduled"}else if state=="in"{"live"}else{"unknown"},"detail":if state=="pre"{"Scheduled"}else if state=="in"{"In progress"}else{"Status unavailable"},"partitions":[source.id]});
            if wrestling {
                value["wrestling"] = json!({"eventId":event_id});
                insert_optional(&mut value["wrestling"], "endsAt", ends_at);
            } else {
                value["combat"] = json!({"eventId":event_id});
            }
            let game: Game = serde_json::from_value(value).map_err(|e| e.to_string())?;
            if let Some(index) = games.iter().position(|g| g.id == game.id) {
                if games[index]
                    .kickoff()
                    .zip(game.kickoff())
                    .is_some_and(|(a, b)| (a - b).abs() > 90 * 60000)
                {
                    return Err("source-schedule-conflicting-event".into());
                }
                if games[index]
                    .wrestling()
                    .is_some_and(|w| w.ends_at.is_some())
                    && ends_at.is_none()
                {
                    continue;
                }
                games[index] = game;
            } else {
                games.push(game);
            }
        } else {
            let pattern =
                cached_regex!(r"(?i)\b(?:free\s+)?practice\s*([1-4])\b|\bfp([1-4])\b").unwrap();
            let practice = pattern
                .captures(title)
                .and_then(|c| c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_owned()));
            let session = if cached_regex!(r"(?i)sprint[\s-]*(?:qualifying|quali|shootout)")
                .unwrap()
                .is_match(title)
            {
                "sprint-qualifying"
            } else if cached_regex!(r"(?i)\bsprint\b").unwrap().is_match(title) {
                "sprint"
            } else if cached_regex!(r"(?i)\bqualifying\b|\bquali\b")
                .unwrap()
                .is_match(title)
            {
                "qualifying"
            } else {
                match practice.as_deref() {
                    Some("1") => "practice-1",
                    Some("2") => "practice-2",
                    Some("3") => "practice-3",
                    Some("4") => "practice-4",
                    _ => {
                        if cached_regex!(r"(?i)\bpractice\b").unwrap().is_match(title) {
                            "practice"
                        } else {
                            "race"
                        }
                    }
                }
            };
            let round=cached_regex!(r"(?i)\s*[-—]\s*(?:free\s+)?(?:practice\s*[1-4]?|sprint(?:\s+qualifying)?|qualifying|race)$").unwrap().replace(title,"").trim().to_owned();
            let event_id = numeric_identity(&format!("{league}|{round}"));
            let session_id = numeric_identity(&format!("{league}|{title}|{kickoff}"));
            let state = if kickoff > now { "pre" } else { "unknown" };
            let value = json!({"id":format!("{league}-{session_id}"),"league":source.league,"name":title,"date":iso(kickoff)?,"race":{"eventId":event_id,"sessionId":session_id,"session":session,"round":round},"status":state,"lifecycle":if state=="pre"{"scheduled"}else{"unknown"},"detail":if state=="pre"{"Scheduled"}else{"Status unavailable"},"partitions":[source.id]});
            let game: Game = serde_json::from_value(value).map_err(|e| e.to_string())?;
            if let Some(index) = games.iter().position(|g| g.id == game.id) {
                games[index] = game;
            } else {
                games.push(game);
            }
        }
    }
    Ok(ScheduleResult {
        games,
        at: Utc::now().timestamp_millis(),
        league: source.league,
        week: None,
        history: None,
        horizon_errors: Vec::new(),
    })
}
async fn fetch_listing_observations(
    client: Arc<ScheduleClient>,
    group: String,
    now: i64,
    cancel: CancellationToken,
) -> Result<Vec<Observation>> {
    let sources = client
        .registry
        .sources()
        .iter()
        .filter(|source| {
            if group == "motorsports" {
                source.family == "motorsports"
                    && source
                        .leagues
                        .iter()
                        .any(|l| matches!(l, League::Motogp | League::Motorsport))
            } else {
                matches!(source.id.as_str(), "livesportpro" | "streamed")
                    || group == "wrestling" && source.id == "ppv"
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut reads = FuturesUnordered::new();
    for (index, source) in sources.into_iter().enumerate() {
        let client = client.clone();
        let cancel = cancel.clone();
        let group = group.clone();
        reads.push(async move {
            let mut response = client.listing(&source.url, 0, &cancel).await;
            if response.as_ref().is_err_and(|e| e == "timeout") && !cancel.is_cancelled() {
                response = client.listing(&source.url, 1, &cancel).await;
            }
            let body = response?;
            let result = crate::listing_json::parse_json(&source, &body, now)
                .or_else(|| crate::listing_html::parse_html(&source, &body, now, &client.registry))
                .unwrap_or(crate::types::ListingResult {
                    observations: Vec::new(),
                    outcome: crate::types::ListingOutcome::Unsupported,
                });
            if result.outcome == crate::types::ListingOutcome::ParserChanged
                || group != "motorsports"
                    && result.outcome == crate::types::ListingOutcome::Unsupported
            {
                return Err("source-schedule-unavailable".to_string());
            }
            let observations = if group == "motorsports" {
                result.observations
            } else {
                result
                    .observations
                    .into_iter()
                    .filter(|o| {
                        o.league.is_some_and(|l| {
                            matches!(
                                l,
                                League::Boxing
                                    | League::Wwe
                                    | League::Tna
                                    | League::Aew
                                    | League::Wrestling
                            )
                        })
                    })
                    .collect()
            };
            Ok((index, observations))
        });
    }
    let mut collected = Vec::new();
    while let Some(result) = reads.next().await {
        if let Ok(result) = result {
            collected.push(result);
        }
    }
    if cancel.is_cancelled() {
        return Err("aborted".into());
    }
    if collected.is_empty() {
        return Err("source-schedule-unavailable".into());
    }
    collected.sort_by_key(|(index, _)| *index);
    Ok(collected
        .into_iter()
        .flat_map(|(_, observations)| observations)
        .collect())
}
async fn read_listing_schedule(
    source: ScheduleSource,
    now: i64,
    cancel: CancellationToken,
    client: Arc<ScheduleClient>,
    progress: impl Fn(ScheduleResult) + Send + Sync,
) -> Result<ScheduleResult> {
    use futures_util::FutureExt;
    if cancel.is_cancelled() {
        return Err("aborted".into());
    }
    let group = listing_schedule_group(source.league).to_owned();
    let snapshot = client
        .listings
        .lock()
        .get(&group)
        .and_then(|c| c.snapshot.as_ref())
        .filter(|(at, _)| now - *at < 60000)
        .map(|(_, observations)| observations.clone());
    let observations = if let Some(observations) = snapshot {
        observations
    } else {
        let active = {
            let mut caches = client.listings.lock();
            let cache = caches.entry(group.clone()).or_default();
            if cache.read.as_ref().is_none_or(|r| r.lock().at != now) {
                let read_cancel = CancellationToken::new();
                let token = read_cancel.clone();
                let reader = client.clone();
                let group_read = group.clone();
                let future =
                    async move { fetch_listing_observations(reader, group_read, now, token).await }
                        .boxed()
                        .shared();
                cache.read = Some(Arc::new(Mutex::new(ListingRead {
                    at: now,
                    future,
                    cancel: read_cancel,
                    consumers: 0,
                })));
            }
            let read = cache.read.as_ref().unwrap().clone();
            read.lock().consumers += 1;
            read
        };
        let future = active.lock().future.clone();
        let result =
            tokio::select! {result=future=>result,_=cancel.cancelled()=>Err("aborted".into())};
        let finished = {
            let mut read = active.lock();
            read.consumers = read.consumers.saturating_sub(1);
            if read.consumers == 0 {
                read.cancel.cancel();
                true
            } else {
                false
            }
        };
        if finished {
            let settling = active.lock().future.clone();
            let _ = settling.await;
        }
        let mut caches = client.listings.lock();
        let cache = caches.entry(group.clone()).or_default();
        if finished
            && cache
                .read
                .as_ref()
                .is_some_and(|read| Arc::ptr_eq(read, &active))
        {
            cache.read = None;
        }
        if let Ok(observations) = &result {
            cache.snapshot = Some((Utc::now().timestamp_millis(), observations.clone()));
        }
        result?
    };
    let result = listing_schedule_from_observations(&source, now, &observations)?;
    progress(result.clone());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scoreboard_preserves_teams_scores_and_final_state() {
        let input = json!({"events":[{"id":"9","name":"Away at Home","date":"2026-10-08T22:00:00Z","status":{"type":{"state":"in","shortDetail":"Q2"}},"competitions":[{"competitors":[{"id":"a","homeAway":"away","team":{"id":"2","displayName":"Away","name":"Away","abbreviation":"AWY","color":"ffffff"}},{"id":"h","homeAway":"home","score":"7","team":{"id":"1","displayName":"Home","name":"Home","abbreviation":"HME","color":"000000"}}],"situation":{"isRedZone":true,"possession":"h"}}]}]});
        let games = parse_scoreboard(&input, League::Nfl).unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].id, "9");
        assert_eq!(games[0].home().unwrap().id.as_deref(), Some("espn:nfl:1"));
        assert_eq!(games[0].home().unwrap().score.as_deref(), Some("7"));
        assert_eq!(games[0].away().unwrap().score, None);
        assert_eq!(games[0].lifecycle, super::super::model::GameLifecycle::Live);
        let encoded = serde_json::to_value(&games[0]).unwrap();
        assert_eq!(encoded["redzone"], true);
        assert_eq!(encoded["possession"], "HME");
        assert_eq!(encoded["detail"], "Q2");
        let mut final_input = input;
        final_input["events"][0]["status"]["type"] =
            json!({"state":"post","name":"STATUS_FINAL","completed":true});
        assert_eq!(
            parse_scoreboard(&final_input, League::Nfl).unwrap()[0].lifecycle,
            super::super::model::GameLifecycle::Final
        );
        final_input["events"][0]["status"]["type"]["completed"] = json!(false);
        assert_eq!(
            parse_scoreboard(&final_input, League::Nfl).unwrap()[0].lifecycle,
            super::super::model::GameLifecycle::Unknown
        );
    }

    #[test]
    fn frozen_typescript_scoreboard_contract() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-store.json"
        ))
        .unwrap();
        for (index, case) in fixture["scoreboards"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let league: League = serde_json::from_value(case["league"].clone()).unwrap();
            let games = parse_scoreboard(&case["data"], league).unwrap();
            assert_eq!(
                serde_json::to_value(games).unwrap(),
                case["expected"],
                "scoreboard {index}"
            );
        }
    }

    fn empty_registry() -> Arc<crate::registry::SourceRegistry> {
        Arc::new(crate::registry::SourceRegistry::parse("[]").unwrap())
    }
    fn enqueue(
        transport: &crate::http::FixtureTransport,
        url: String,
        body: Value,
        delay: u64,
        status: u16,
    ) {
        transport
            .enqueue_script(
                serde_json::from_value(
                    json!({"url":url,"body":body.to_string(),"delayMs":delay,"status":status}),
                )
                .unwrap(),
            )
            .unwrap();
    }

    #[tokio::test]
    async fn current_progress_precedes_future_reads_and_future_cache_is_shared() {
        let (client, transport) = ScheduleClient::fixture(empty_registry());
        let now = 1_791_496_800_000;
        let source = default_schedules().remove(0);
        for offset in -1..=7 {
            enqueue(
                &transport,
                scoreboard_url(&source, &day(now + offset * DAY).unwrap()).unwrap(),
                json!({"events":[]}),
                if offset == -1 {
                    10
                } else if offset > 0 {
                    20
                } else {
                    0
                },
                200,
            );
        }
        let published = Arc::new(Mutex::new(Vec::new()));
        let captures = published.clone();
        let requests = transport.clone();
        let today = day(now).unwrap();
        let result = read_schedule(
            source.clone(),
            now,
            CancellationToken::new(),
            client.clone(),
            move |result| {
                if captures.lock().is_empty() {
                    assert!(requests.requests().iter().all(|r| {
                        url::Url::parse(&r.url)
                            .unwrap()
                            .query_pairs()
                            .find(|(key, _)| key == "dates")
                            .is_none_or(|(_, day)| day.as_ref() <= today.as_str())
                    }));
                }
                captures.lock().push(result);
            },
        )
        .await
        .unwrap();
        assert_eq!(result.games.len(), 0);
        assert!(result.horizon_errors.is_empty());
        assert!(
            published
                .lock()
                .first()
                .unwrap()
                .history
                .as_ref()
                .is_some_and(|h| h["kind"] == "loading")
        );
        assert_eq!(transport.requests().len(), 9);
        for offset in [-1, 0] {
            enqueue(
                &transport,
                scoreboard_url(&source, &day(now + offset * DAY).unwrap()).unwrap(),
                json!({"events":[]}),
                0,
                200,
            );
        }
        read_schedule(source, now + 1000, CancellationToken::new(), client, |_| {})
            .await
            .unwrap();
        assert_eq!(transport.requests().len(), 11);
    }

    #[tokio::test]
    async fn future_failure_is_reported_and_cancellation_is_not_a_schedule_failure() {
        let (client, transport) = ScheduleClient::fixture(empty_registry());
        let now = 1_791_496_800_000;
        let source = default_schedules().remove(0);
        for offset in -1..=7 {
            enqueue(
                &transport,
                scoreboard_url(&source, &day(now + offset * DAY).unwrap()).unwrap(),
                json!({"events":[]}),
                0,
                if offset == 1 { 503 } else { 200 },
            );
        }
        let result = read_schedule(
            source.clone(),
            now,
            CancellationToken::new(),
            client.clone(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(
            result.horizon_errors,
            vec![format!("{}:http-503", day(now + DAY).unwrap())]
        );
        for offset in [-1, 0] {
            enqueue(
                &transport,
                scoreboard_url(&source, &day(now + offset * DAY).unwrap()).unwrap(),
                json!({"events":[]}),
                0,
                200,
            );
        }
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let result = read_schedule(source, now + 1000, cancel, client, move |_| {
            trigger.cancel()
        })
        .await;
        assert_eq!(result.unwrap_err(), "aborted");
    }

    #[tokio::test]
    async fn fixture_gate_keeps_history_and_horizon_pending_until_released() {
        let (client, transport) = ScheduleClient::fixture(empty_registry());
        let now = 1_791_496_800_000;
        let source = default_schedules().remove(0);
        for offset in -1..=7 {
            transport.enqueue_script(serde_json::from_value(json!({"url":scoreboard_url(&source,&day(now+offset*DAY).unwrap()).unwrap(),"body":"{\"events\":[]}","gate":if offset==0{None}else{Some("remaining")}})).unwrap()).unwrap();
        }
        let task = tokio::spawn(read_schedule(
            source,
            now,
            CancellationToken::new(),
            client,
            |_| {},
        ));
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert!(
            !task.is_finished(),
            "fixture bodies must wait for their release gate"
        );
        transport.release_gate("remaining");
        assert!(task.await.unwrap().is_ok());
    }

    #[test]
    fn membership_rejects_incomplete_duplicate_and_wrong_season_refs() {
        let valid = json!({"count":1,"pageCount":1,"pageIndex":1,"items":[{"$ref":"http://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/teams/12"}]});
        assert_eq!(parse_membership_group(&valid, 2026).unwrap(), vec!["12"]);
        assert_eq!(
            parse_membership_group(&valid, 2025).unwrap_err(),
            "membership-invalid-ref"
        );
        let mut duplicate = valid.clone();
        duplicate["count"] = json!(2);
        duplicate["items"]
            .as_array_mut()
            .unwrap()
            .push(valid["items"][0].clone());
        assert_eq!(
            parse_membership_group(&duplicate, 2026).unwrap_err(),
            "membership-invalid-ref"
        );
        duplicate["pageCount"] = json!(2);
        assert_eq!(
            parse_membership_group(&duplicate, 2026).unwrap_err(),
            "membership-incomplete"
        );
    }

    #[test]
    fn listing_events_preserve_chicago_day_identity_and_longer_wrestling_publication() {
        let source = default_schedules()
            .into_iter()
            .find(|s| s.league == League::Wwe)
            .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-10-10T03:00:00Z")
            .unwrap()
            .timestamp_millis();
        let observation:Observation=serde_json::from_value(json!({"id":"wwe","sourceId":"ppv","url":"https://ppv.st/live/wwe/2026-10-09","title":"WWE Friday Night SmackDown","league":"wwe","teams":null,"kickoff":now-3600000,"endsAt":now+3600000,"rawTime":"","observedAt":now,"parserVersion":1})).unwrap();
        let mut shorter = observation.clone();
        shorter.ends_at = None;
        let games = listing_schedule_from_observations(&source, now, &[observation, shorter])
            .unwrap()
            .games;
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].lifecycle, GameLifecycle::Live);
        assert_eq!(
            games[0].wrestling().unwrap().event_id,
            numeric_identity("wwe|smackdown|2026-10-09")
        );
        assert_eq!(games[0].wrestling().unwrap().ends_at, Some(now + 3600000));
    }
}
