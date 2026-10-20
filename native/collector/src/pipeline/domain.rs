use super::{matching::*, model::*};
use chrono::{DateTime, Timelike, Utc};
use chrono_tz::America::{Chicago, New_York};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

pub const SOURCE_REFRESH_MS: i64 = 5 * 60_000;
pub const ACTIVE_DISCOVERY_MS: i64 = 30 * 60_000;
pub const IDLE_DISCOVERY_MS: i64 = 5 * 60 * 60_000;
pub const KICKOFF_WAKE_MS: i64 = 2 * 60 * 60_000;
pub const COLLECTION_SETTLE_MS: i64 = 60_000;
pub const SESSION_LEASE_MS: i64 = 90_000;
pub const GRACE_MS: i64 = 1440 * 60_000;
pub const DEFAULT_FINISHED_GAME_RETENTION_MINUTES: i64 = 1440;
pub const FEED_CHECK_RETENTION_MS: i64 = 24 * 3600_000;
pub const INCOMPLETE_RETRY_DELAYS: [i64; 5] = [30_000, 60_000, 120_000, 300_000, 600_000];

pub fn provider_probe_identity(locator: &CandidateLocator) -> String {
    provider_probe_identity_wire(&serde_json::to_value(locator).expect("typed locator"))
}
pub fn provider_probe_identity_wire(locator: &Value) -> String {
    if locator["provider"] == "event-page" {
        if let (Some(event_url), Some(server_url), Some(game_id)) = (
            locator["eventUrl"].as_str(),
            locator["serverUrl"].as_str(),
            locator["gameId"].as_str(),
        ) {
            if let (Ok(event), Ok(server)) =
                (url::Url::parse(event_url), url::Url::parse(server_url))
            {
                if matches!(
                    event.host_str(),
                    Some(
                        "methstreams.st" | "crackstreams.st" | "buffstreams.ch" | "methstreams.vg"
                    )
                ) && matches!(server.host_str(), Some("fxtrend.st" | "foxiy.st"))
                    && crate::event_policy::valid_event_page_pair(event_url, server_url)
                {
                    return serde_json::to_string(&json!([
                        "event-page",
                        "fxtrend",
                        game_id,
                        locator["serverUrl"]
                    ]))
                    .expect("typed identity");
                }
            }
        }
    }
    serde_json::to_string(locator).expect("JSON locator")
}
pub fn playback_resolution(locator: &CandidateLocator) -> &'static str {
    match locator {
        CandidateLocator::Gooz { .. }
        | CandidateLocator::Swac { .. }
        | CandidateLocator::Streamcenter { .. }
        | CandidateLocator::Streameast { .. }
        | CandidateLocator::Wikisport { .. } => "http",
        CandidateLocator::SportsurgeV2 { .. }
        | CandidateLocator::StreameastServer { .. }
        | CandidateLocator::EventPage { .. }
        | CandidateLocator::Tvapp { .. }
        | CandidateLocator::CatalogStream { .. } => "browser",
    }
}
fn public_https_url(value: &str) -> Option<url::Url> {
    let authority = value
        .strip_prefix("https://")?
        .split(['/', '?', '#'])
        .next()?;
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str()?;
    let host_port = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.into(),
    };
    if authority.to_lowercase() != host_port
        || url.as_str().len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 8443)
        || url.fragment().is_some()
        || host.ends_with('.')
        || !matches!(url.host(), Some(url::Host::Domain(_)))
        || !host.contains('.')
        || cached_regex!(r"(?:^|\.)(?:localhost|local|internal)$")
            .unwrap()
            .is_match(host)
    {
        return None;
    }
    Some(url)
}
pub fn streameast_server_url(locator: &CandidateLocator) -> Option<String> {
    let CandidateLocator::StreameastServer {
        game_id,
        source_event_id,
        event_url,
        server_id,
    } = locator
    else {
        return None;
    };
    let event = url::Url::parse(event_url).ok()?;
    let path_re = cached_regex!(r"^/([a-z0-9-]+)/[a-z0-9]+(?:-[a-z0-9]+)*/$").unwrap();
    let path = path_re.captures(event.path())?;
    let league_name = source_event_id.split(':').next()?;
    let league: League = serde_json::from_value(json!(league_name)).ok()?;
    let bound = if league == League::Motorsport {
        cached_regex!(r"^nascar-(?:cup|truck)-\d+$")
            .unwrap()
            .is_match(game_id)
            && cached_regex!(r"^/other-events/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{10}/$")
                .unwrap()
                .is_match(event.path())
    } else if league == League::Nfl {
        cached_regex!(r"^\d+$").unwrap().is_match(game_id)
    } else {
        game_id.starts_with(&format!("{league_name}-"))
    };
    static REGISTRY: std::sync::OnceLock<crate::registry::SourceRegistry> =
        std::sync::OnceLock::new();
    let category = REGISTRY
        .get_or_init(|| {
            crate::registry::SourceRegistry::parse(include_str!(
                "../../../../lib/football/source-registry.json"
            ))
            .expect("committed registry")
        })
        .browser_category("streameast", league)?;
    if event.origin().ascii_serialization() != "https://v2.streameast.ga"
        || !event.username().is_empty()
        || event.password().is_some()
        || event.query().is_some()
        || event.fragment().is_some()
        || event.as_str() != event_url
        || category.path_code.as_deref() != Some(&path[1])
        || !bound
        || !cached_regex!(r"^[a-z0-9-]+:\d{1,12}$")
            .unwrap()
            .is_match(source_event_id)
        || !cached_regex!(r"^[1-9]\d{0,3}$")
            .unwrap()
            .is_match(server_id)
    {
        return None;
    }
    Some(format!("{event_url}{server_id}"))
}
pub fn durable_catalog_stream(locator: &CandidateLocator) -> bool {
    let CandidateLocator::CatalogStream {
        source,
        event_url,
        event_id,
        source_name,
        source_id,
        stream_no,
        kickoff,
        ..
    } = locator
    else {
        return false;
    };
    let expected = match source.as_str() {
        "streamed" => format!("https://streamed.st/watch/{event_id}"),
        "sportsupa" => format!("https://streamed.pk/watch/{event_id}"),
        "livesportpro" => format!("https://api.kultsport.com/api/matches/all#{event_id}"),
        _ => return false,
    };
    cached_regex!(r"^[a-z][a-z0-9:-]{0,39}$")
        .unwrap()
        .is_match(source_name)
        && cached_regex!(r"^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,159}$")
            .unwrap()
            .is_match(source_id)
        && !source_id.contains("//")
        && !source_id.contains("..")
        && cached_regex!(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$")
            .unwrap()
            .is_match(event_id)
        && *event_url == expected
        && (946_684_800_000..4_102_444_800_000).contains(kickoff)
        && *stream_no <= 100
}
fn durable_sportsurge_query(url: &url::Url) -> bool {
    let query = url.query().unwrap_or_default();
    let pairs: Vec<_> = url.query_pairs().collect();
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(
            pairs
                .iter()
                .map(|(key, value)| (key.as_ref(), value.as_ref())),
        )
        .finish();
    if query != encoded {
        return false;
    }
    let mut keys: Vec<_> = pairs.iter().map(|(key, _)| key.as_ref()).collect();
    keys.sort();
    let keys = keys.join(",");
    let param = |name: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_ref())
            .unwrap_or("")
    };
    if url.origin().ascii_serialization() == "https://live.embedca.st" && url.path() == "/live.php"
    {
        return keys == "ch" && cached_regex!(r"^es\d{1,6}$").unwrap().is_match(param("ch"));
    }
    url.origin().ascii_serialization() == "https://sportsupa.st"
        && url.path() == "/event/"
        && keys == "id,sno,src"
        && cached_regex!(r"^[a-z0-9]+(?:-[a-z0-9]+)*-vs-[a-z0-9]+(?:-[a-z0-9]+)*-\d{1,12}$")
            .unwrap()
            .is_match(param("id"))
        && param("src") == "best"
        && cached_regex!(r"^[1-9]\d{0,3}$")
            .unwrap()
            .is_match(param("sno"))
}
pub fn persistable_locator(locator: &CandidateLocator) -> bool {
    match locator {
        CandidateLocator::CatalogStream{..}=>durable_catalog_stream(locator),
        CandidateLocator::EventPage{event_url,server_url,..}=>crate::event_policy::valid_event_page_pair(event_url,server_url),
        CandidateLocator::StreameastServer{..}=>streameast_server_url(locator).is_some(),
        CandidateLocator::Tvapp{event_url,..}=>public_https_url(event_url).is_some_and(|url|url.as_str()==event_url&&url.host_str()==Some("tvapp1.pk")&&url.query().is_none()&&url.fragment().is_none()&&cached_regex!(r"^/watch/[a-zA-Z0-9-]{1,120}$").unwrap().is_match(url.path())),
        CandidateLocator::SportsurgeV2{url:value,..}=>public_https_url(value).is_some_and(|url|url.as_str()==value&&url.port().is_none()&&(url.query().is_none()||durable_sportsurge_query(&url))&&url.fragment().is_none()&&!url.path().contains('%')&&!cached_regex!(r"(?i)\.(?:m3u8?|mpd|mp4|m4s|ts|aac|mp3|webm|key)(?:$|/)").unwrap().is_match(url.path())&&!cached_regex!(r"(?i)(?:^|/)(?:hls|dash|media|manifest|playlist|segments?|videoplayback)(?:[/.]|$)").unwrap().is_match(url.path())),
        _=>true,
    }
}

pub fn feed_calendar_day(at: i64) -> Option<i64> {
    let date = DateTime::<Utc>::from_timestamp_millis(at)?
        .with_timezone(&Chicago)
        .date_naive();
    Some(
        date.signed_duration_since(chrono::NaiveDate::from_ymd_opt(1970, 1, 1)?)
            .num_days(),
    )
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedWindow {
    pub time_zone: String,
    pub days: [String; 2],
}
pub fn feed_window(now: i64) -> Option<FeedWindow> {
    let day = feed_calendar_day(now)?;
    let format = |offset| {
        DateTime::<Utc>::from_timestamp_millis((day + offset) * 86_400_000)
            .map(|date| date.format("%Y-%m-%d").to_string())
    };
    Some(FeedWindow {
        time_zone: "America/Chicago".into(),
        days: [format(0)?, format(1)?],
    })
}
pub fn feed_date_eligible(kickoff: i64, now: i64) -> bool {
    feed_calendar_day(kickoff)
        .zip(feed_calendar_day(now))
        .is_some_and(|(day, today)| (0..=1).contains(&(day - today)))
}
pub fn feed_eligible(game: &Game, now: i64) -> bool {
    if game.final_observed_at.is_some() || game.lifecycle == GameLifecycle::Final {
        return false;
    }
    if game.lifecycle == GameLifecycle::Live {
        return true;
    }
    if is_wrestling_league(game.league) && game.lifecycle == GameLifecycle::Unknown {
        return game
            .kickoff()
            .is_some_and(|start| now >= start && now - start <= 6 * 60 * 60_000);
    }
    game.lifecycle == GameLifecycle::Scheduled
        && game
            .kickoff()
            .is_some_and(|start| feed_date_eligible(start, now))
}
pub fn combat_listing_feed_eligible(game: &Game, now: i64) -> bool {
    if !(game.league == League::Boxing || is_wrestling_league(game.league))
        || game.lifecycle != GameLifecycle::Unknown
        || game.final_observed_at.is_some()
    {
        return false;
    }
    game.kickoff().is_some_and(|start| {
        start <= now
            && now - start <= 6 * 60 * 60_000
            && feed_calendar_day(start)
                .zip(feed_calendar_day(now))
                .is_some_and(|(day, today)| (0..=1).contains(&(today - day)))
    })
}
pub fn feed_inventory_eligible(game: &Game, now: i64) -> bool {
    feed_eligible(game, now)
        || game.lifecycle == GameLifecycle::Unknown
            && game.final_observed_at.is_none()
            && game
                .kickoff()
                .is_some_and(|date| feed_date_eligible(date, now))
}
pub fn detail_identity(observation: &Observation) -> String {
    serde_json::to_string(&(
        &observation.source_id,
        &observation.url,
        observation.league,
        &observation.title,
        &observation.teams,
        observation.kickoff,
        if observation.kickoff.is_none() {
            observation.raw_time.as_str()
        } else {
            ""
        },
        observation.parser_version,
    ))
    .expect("typed detail identity")
}
pub fn detail_identity_matches(identity: Option<&str>, observation: &Observation) -> bool {
    let Some(identity) = identity else {
        return false;
    };
    let expected = detail_identity(observation);
    if identity == expected {
        return true;
    }
    if identity.len() > 16_384 {
        return false;
    }
    let Ok(mut fields) = serde_json::from_str::<Vec<Value>>(identity) else {
        return false;
    };
    if fields.len() != 8 || !fields[6].is_string() {
        return false;
    }
    if fields[5].is_number() {
        fields[6] = json!("")
    }
    serde_json::to_string(&fields).is_ok_and(|value| value == expected)
}
pub fn discovery_deadline(
    at: i64,
    observations: &[Observation],
    games: &[Game],
    leagues: &[League],
    now: i64,
) -> i64 {
    let active = observations.iter().any(|row| {
        row.league.is_none_or(|league| leagues.contains(&league))
            && row
                .kickoff
                .is_none_or(|kickoff| feed_date_eligible(kickoff, now))
    });
    let mut deadline = at
        + if active {
            ACTIVE_DISCOVERY_MS
        } else {
            IDLE_DISCOVERY_MS
        };
    for game in games {
        if !leagues.contains(&game.league) || !feed_eligible(game, now) {
            continue;
        }
        if game.lifecycle == GameLifecycle::Live
            || game
                .kickoff()
                .is_some_and(|start| start - now <= KICKOFF_WAKE_MS)
        {
            deadline = deadline.min(at + ACTIVE_DISCOVERY_MS)
        } else if let Some(start) = game.kickoff() {
            deadline = deadline.min(start - KICKOFF_WAKE_MS)
        }
    }
    deadline
}
pub fn detail_polling(
    prior: Option<&DetailEvidence>,
    observation: &Observation,
    players: &[ResolvedPlayer],
    game: Option<&Game>,
) -> DetailPolling {
    let mut identities: Vec<_> = players
        .iter()
        .map(|player| serde_json::to_string(&player.locator).expect("typed locator"))
        .collect();
    identities.sort();
    let signature = serde_json::to_string(&(
        detail_identity(observation),
        game.map(|game| &game.id),
        game.and_then(|game| game.date.as_ref()),
        identities,
    ))
    .expect("typed detail signature");
    let unchanged_checks = prior
        .and_then(|detail| detail.polling.as_ref())
        .filter(|polling| polling.signature == signature)
        .map(|polling| (polling.unchanged_checks + 1).min(3))
        .unwrap_or(0);
    DetailPolling {
        signature,
        unchanged_checks,
    }
}
pub fn detail_deadline(
    at: i64,
    polling: &DetailPolling,
    game: Option<&Game>,
    now: i64,
    published: bool,
) -> i64 {
    let mut deadline = at
        + if polling.unchanged_checks >= 3 {
            IDLE_DISCOVERY_MS
        } else {
            ACTIVE_DISCOVERY_MS
        };
    if let Some(game) = game {
        if published && (feed_eligible(game, now) || combat_listing_feed_eligible(game, now)) {
            return deadline.min(at + ACTIVE_DISCOVERY_MS);
        }
        if feed_eligible(game, now) {
            if game.lifecycle == GameLifecycle::Live
                || game
                    .kickoff()
                    .is_some_and(|start| start - now <= KICKOFF_WAKE_MS)
            {
                deadline = deadline.min(at + ACTIVE_DISCOVERY_MS)
            } else if let Some(start) = game.kickoff() {
                deadline = deadline.min(start - KICKOFF_WAKE_MS)
            }
        }
    }
    deadline
}
pub fn retry_deadline(at: i64, retry_after_ms: i64, minimum_delay_ms: i64) -> i64 {
    at + minimum_delay_ms.max(retry_after_ms)
}
pub fn source_failure(message: &str) -> SourceFailure {
    if message=="source-page-capacity"{SourceFailure::CollectorBusy}
    else if matches!(message,"blocked"|"http-403"|"source-page-challenge"){SourceFailure::Blocked}
    else if cached_regex!(r"\b404\b").unwrap().is_match(message){SourceFailure::NotFound}
    else if message=="rate-limited"||cached_regex!(r"\b429\b").unwrap().is_match(message){SourceFailure::RateLimited}
    else if cached_regex!(r"(?i)timeout|timed out").unwrap().is_match(message){SourceFailure::TimedOut}
    else if cached_regex!(r"(?i)fetch failed|network").unwrap().is_match(message)||matches!(message,"source-page-closed"|"source-page-window-closed"){SourceFailure::NetworkUnavailable}
    else if matches!(message,"unsupported-discovery-address"|"source-page-unsupported-address"){SourceFailure::UnsupportedAddress}
    else if matches!(message,"response-too-large"|"source-page-response-too-large"){SourceFailure::ResponseTooLarge}
    else if cached_regex!(r"^(?:empty-response|redirect-without-location|redirect-limit|source-page-(?:page-changed|changed|invalid-response))$").unwrap().is_match(message){SourceFailure::InvalidResponse}
    else{SourceFailure::UpstreamError}
}
pub fn record_final(game: &Game, now: i64, retention_minutes: i64) -> Game {
    let mut game = game.clone();
    game.source_url = None;
    game.source_urls = Some(Vec::new());
    game.final_observed_at = Some(now);
    game.grace_ends_at = Some(now + retention_minutes * 60_000);
    game
}
pub fn reconcile_session(session: &Session, game: Option<&Game>, now: i64) -> Session {
    if session.is_closed() {
        return session.clone();
    }
    let deadline = game
        .and_then(|game| game.grace_ends_at)
        .or_else(|| match session.phase {
            SessionPhase::Draining { grace_ends_at } => Some(grace_ends_at),
            _ => None,
        });
    let mut session = session.clone();
    if let Some(deadline) = deadline {
        session.phase = if now >= deadline {
            SessionPhase::Closed {
                grace_ends_at: deadline,
            }
        } else {
            SessionPhase::Draining {
                grace_ends_at: deadline,
            }
        }
    }
    session
}
pub fn failed_candidate(recovery: &Recovery, id: &str, now: i64) -> Recovery {
    let mut recovery = recovery.clone();
    let count = recovery.failures.get(id).copied().unwrap_or(0) + 1;
    if !recovery.attempted.iter().any(|item| item == id) {
        recovery.attempted.push(id.into())
    }
    recovery.failures.insert(id.into(), count);
    recovery.cooled.insert(
        id.into(),
        now + 60_000_i64
            .saturating_mul(2_i64.saturating_pow(count - 1))
            .min(600_000),
    );
    recovery
}
pub fn compare_candidates(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.id.cmp(&b.id)
}
pub fn next_candidate<'a>(
    candidates: &'a [Candidate],
    recovery: &Recovery,
    now: i64,
    exclude: Option<&str>,
) -> Option<&'a Candidate> {
    if recovery.attempted.len() >= 3 {
        return None;
    }
    candidates
        .iter()
        .filter(|candidate| {
            exclude != Some(&candidate.id)
                && !recovery.attempted.contains(&candidate.id)
                && recovery.cooled.get(&candidate.id).copied().unwrap_or(0) <= now
        })
        .min_by(|a, b| {
            recovery
                .failures
                .get(&a.id)
                .copied()
                .unwrap_or(0)
                .cmp(&recovery.failures.get(&b.id).copied().unwrap_or(0))
                .then_with(|| compare_candidates(a, b))
        })
}
pub fn working_feed_owner(game: &Game, partition_ids: &[String]) -> FeedOwner {
    let mut partition_ids = partition_ids.to_vec();
    partition_ids.sort();
    partition_ids.dedup();
    match &game.kind {
        GameKind::Matchup { home, away, .. } => {
            let team = |team: &Team| TeamIdentity {
                id: team.id.clone().filter(|id| !id.is_empty()),
                name: team.name.clone(),
            };
            FeedOwner::Matchup {
                league: game.league,
                home: team(home),
                away: team(away),
                partition_ids,
            }
        }
        GameKind::Race { race } => FeedOwner::Race {
            league: game.league,
            event_id: race.event_id.clone(),
            session_id: race.session_id.clone(),
            session: race.session.clone(),
            round: race.round.clone(),
            partition_ids,
        },
        GameKind::Combat { combat } => FeedOwner::Event {
            league: game.league,
            event_id: combat.event_id.clone(),
            date: game.date.clone().unwrap_or_default(),
            partition_ids,
        },
        GameKind::Wrestling { wrestling } => FeedOwner::Event {
            league: game.league,
            event_id: wrestling.event_id.clone(),
            date: game.date.clone().unwrap_or_default(),
            partition_ids,
        },
    }
}
pub fn feed_owner_matches(owner: &FeedOwner, game_id: &str, game: &Game) -> bool {
    if game_id != game.id || owner.league() != game.league {
        return false;
    }
    match (owner, &game.kind) {
        (
            FeedOwner::Matchup { home, away, .. },
            GameKind::Matchup {
                home: a, away: b, ..
            },
        ) => {
            let same = |saved: &TeamIdentity, current: &Team| match (
                saved.id.as_deref().filter(|id| !id.is_empty()),
                current.id.as_deref().filter(|id| !id.is_empty()),
            ) {
                (Some(a), Some(b)) => a == b,
                _ => normalized_name(&saved.name) == normalized_name(&current.name),
            };
            same(home, a) && same(away, b)
        }
        (
            FeedOwner::Race {
                event_id,
                session_id,
                session,
                round,
                ..
            },
            GameKind::Race { race },
        ) => {
            event_id == &race.event_id
                && session_id == &race.session_id
                && session == &race.session
                && round == &race.round
        }
        (FeedOwner::Event { event_id, date, .. }, GameKind::Combat { combat }) => {
            event_id == &combat.event_id && Some(date) == game.date.as_ref()
        }
        (FeedOwner::Event { event_id, date, .. }, GameKind::Wrestling { wrestling }) => {
            event_id == &wrestling.event_id && Some(date) == game.date.as_ref()
        }
        _ => false,
    }
}
pub fn working_feed_matches(feed: &WorkingFeed, game: &Game) -> bool {
    feed_owner_matches(&feed.owner, &feed.candidate.game_id, game)
}
pub fn cached_feed_eligible(feed: &WorkingFeed, game: &Game, now: i64) -> bool {
    if !working_feed_matches(feed, game) {
        return false;
    }
    if game.lifecycle == GameLifecycle::Final {
        return game.grace_ends_at.is_some_and(|at| now < at);
    }
    game.final_observed_at.is_none()
        && (matches!(
            game.lifecycle,
            GameLifecycle::Live | GameLifecycle::Scheduled
        ) && game
            .kickoff()
            .is_some_and(|date| feed_date_eligible(date, now))
            || combat_listing_feed_eligible(game, now))
}
pub fn browser_event_deadline(
    detail: Option<&DetailEvidence>,
    game: Option<&Game>,
    now: i64,
) -> i64 {
    let Some(detail) = detail else { return now };
    match &detail.polling {
        Some(polling) => detail_deadline(
            detail.at,
            polling,
            game,
            now,
            detail.is_resolved()
                && detail
                    .last_success
                    .as_ref()
                    .and_then(|success| success.publication.as_ref())
                    .is_some_and(|publication| !publication.players.is_empty()),
        ),
        None => detail.next_eligible_at,
    }
}
pub fn browser_evidence_fresh(detail: Option<&DetailEvidence>, checked_at: i64, now: i64) -> bool {
    if detail.is_some_and(|detail| {
        detail.at > checked_at || detail.at == checked_at && !detail.is_resolved()
    }) {
        return false;
    }
    checked_at <= now + 60_000
        && now
            <= (checked_at + ACTIVE_DISCOVERY_MS).max(
                detail
                    .filter(|detail| detail.at == checked_at)
                    .map(|detail| detail.next_eligible_at)
                    .unwrap_or(0),
            ) + COLLECTION_SETTLE_MS
}
fn live_channel_game<'a>(
    observation: &Observation,
    result: &Match,
    games: &'a [Game],
    now: i64,
) -> Option<&'a Game> {
    let source = match observation.league {
        Some(League::Nfl) => "buffstream-nfl",
        Some(League::Ncaaf) => "buffstream-cfb",
        Some(League::Nba) => "buffstream-nba",
        Some(League::Nhl) => "buffstream-nhl",
        Some(League::Mlb) => "buffstream-mlb",
        _ => return None,
    };
    let Match::Unmatched {
        reason,
        possible_game_ids,
    } = result
    else {
        return None;
    };
    if observation.source_id != source
        || observation.kickoff.is_some()
        || !(reason == "unverified-kickoff"
            || source == "buffstream-cfb" && reason == "unverified-contextual-kickoff")
        || possible_game_ids.len() != 1
        || observation.observed_at > now + 60_000
    {
        return None;
    }
    let clock_re = cached_regex!(r"(?i)^(0?[1-9]|1[0-2]):([0-5]\d)\s*(am|pm)\s*ET$").unwrap();
    let clock = clock_re.captures(observation.raw_time.trim())?;
    let game = games.iter().find(|game| game.id == possible_game_ids[0])?;
    if !feed_eligible(game, now) {
        return None;
    }
    let time = DateTime::<Utc>::from_timestamp_millis(game.kickoff()?)?.with_timezone(&New_York);
    let hour = clock[1].parse::<u32>().ok()? % 12
        + if clock[3].eq_ignore_ascii_case("pm") {
            12
        } else {
            0
        };
    let source_minutes = hour * 60 + clock[2].parse::<u32>().ok()?;
    let difference = (source_minutes as i32 - (time.hour() * 60 + time.minute()) as i32).abs();
    if if source == "buffstream-cfb" {
        difference.min(1440 - difference) <= 60
    } else {
        difference == 0
    } {
        Some(game)
    } else {
        None
    }
}
pub fn provisional_live_channel<'a>(
    observation: &Observation,
    result: &Match,
    games: &'a [Game],
    now: i64,
) -> Option<&'a Game> {
    if now - observation.observed_at >= ACTIVE_DISCOVERY_MS {
        return None;
    }
    live_channel_game(observation, result, games, now)
}
pub fn resolved_live_channel_match(
    observation: &Observation,
    result: &Match,
    games: &[Game],
    detail: Option<&DetailEvidence>,
    now: i64,
    retained_publication: bool,
) -> Match {
    let (Some(game), Some(detail)) = (live_channel_game(observation, result, games, now), detail)
    else {
        return result.clone();
    };
    let owned = detail
        .event
        .as_ref()
        .is_some_and(|event| event.game_id == game.id && event.date == game.date);
    if !detail.is_resolved()||detail.observation_id!=observation.id||now-observation.observed_at>=ACTIVE_DISCOVERY_MS&&(!owned||now-observation.observed_at>ACTIVE_DISCOVERY_MS+COLLECTION_SETTLE_MS)||!detail_identity_matches(detail.identity.as_deref(),observation)||now-detail.at>=30*60_000&&!(retained_publication&&now-detail.at<=60*60_000&&owned)||detail.at>now+60_000||detail.players().is_empty()||!detail.players().iter().all(|player|matches!(&player.locator,CandidateLocator::EventPage{game_id,event_url,..}if game_id==&game.id&&event_url==&observation.url)){return result.clone()}
    Match::Matched {
        game_id: game.id.clone(),
    }
}

pub fn external_domain_call(operation: &str, input: Value) -> Result<Value, String> {
    fn get<T: DeserializeOwned>(input: &Value, key: &str) -> Result<T, String> {
        serde_json::from_value(input[key].clone()).map_err(|error| format!("{key}: {error}"))
    }
    fn optional<T: DeserializeOwned>(input: &Value, key: &str) -> Result<Option<T>, String> {
        input
            .get(key)
            .filter(|value| !value.is_null())
            .map(|value| {
                serde_json::from_value(value.clone()).map_err(|error| format!("{key}: {error}"))
            })
            .transpose()
    }
    let at = || get::<i64>(&input, "now");
    let output = match operation {
        "normalized" => json!(normalized_name(&get::<String>(&input, "value")?)),
        "match" => {
            let games = get::<Vec<Game>>(&input, "games")?;
            json!(
                ObservationMatcher::new(&games, optional(&input, "mode")?.unwrap_or_default())
                    .match_observation(
                        &get(&input, "observation")?,
                        at()?,
                        optional(&input, "freshUntil")?
                    )
            )
        }
        "detail-candidates" => json!(detail_candidate_game_ids(&get(&input, "result")?)),
        "source-match" => json!(
            SourceEventMatcher::new(&get::<Vec<Game>>(&input, "games")?, MatchMode::Current)
                .match_event(
                    &get(&input, "observation")?,
                    &get(&input, "evidence")?,
                    at()?,
                    None
                )
        ),
        "finished-match" => {
            let matcher = FinishedGameMatcher::new(&get::<Vec<Game>>(&input, "games")?);
            let row = get(&input, "observation")?;
            json!([
                matcher.finished_game_id(
                    &row,
                    at()?,
                    optional::<String>(&input, "expectedGameId")?.as_deref()
                ),
                matcher.finished_bound_event(
                    &row,
                    &get::<String>(&input, "eventId")?,
                    &get::<Vec<SourceEventBinding>>(&input, "bindings")?
                )
            ])
        }
        "merge" => json!(merge_schedule_partitions(&get::<Vec<Vec<Game>>>(
            &input,
            "partitions"
        )?)),
        "calendar" => json!([json!(feed_calendar_day(at()?)), json!(feed_window(at()?))]),
        "date-eligible" => json!(feed_date_eligible(get(&input, "kickoff")?, at()?)),
        "eligible" => {
            let game = get(&input, "game")?;
            json!([
                feed_eligible(&game, at()?),
                feed_inventory_eligible(&game, at()?),
                combat_listing_feed_eligible(&game, at()?)
            ])
        }
        "identity" => json!(detail_identity(&get(&input, "observation")?)),
        "identity-match" => json!(detail_identity_matches(
            optional::<String>(&input, "identity")?.as_deref(),
            &get(&input, "observation")?
        )),
        "detail-deadline" => json!(detail_deadline(
            get(&input, "at")?,
            &get(&input, "polling")?,
            optional::<Game>(&input, "game")?.as_ref(),
            at()?,
            get(&input, "published")?
        )),
        "discovery-deadline" => json!(discovery_deadline(
            get(&input, "at")?,
            &get::<Vec<Observation>>(&input, "observations")?,
            &get::<Vec<Game>>(&input, "games")?,
            &get::<Vec<League>>(&input, "leagues")?,
            at()?
        )),
        "polling" => json!(detail_polling(
            optional::<DetailEvidence>(&input, "prior")?.as_ref(),
            &get(&input, "observation")?,
            &get::<Vec<ResolvedPlayer>>(&input, "players")?,
            optional::<Game>(&input, "game")?.as_ref()
        )),
        "source-failure" => json!(source_failure(&get::<String>(&input, "message")?)),
        "retry-deadline" => json!(retry_deadline(
            get(&input, "at")?,
            get(&input, "retryAfterMs")?,
            get(&input, "minimumDelayMs")?
        )),
        "owner" => json!(working_feed_owner(
            &get(&input, "game")?,
            &get::<Vec<String>>(&input, "partitions")?
        )),
        "working-match" => {
            let feed = get(&input, "feed")?;
            let game = get(&input, "game")?;
            json!([
                working_feed_matches(&feed, &game),
                cached_feed_eligible(&feed, &game, at()?)
            ])
        }
        "failed-candidate" => json!(failed_candidate(
            &get(&input, "recovery")?,
            &get::<String>(&input, "id")?,
            at()?
        )),
        "next-candidate" => json!(next_candidate(
            &get::<Vec<Candidate>>(&input, "candidates")?,
            &get(&input, "recovery")?,
            at()?,
            optional::<String>(&input, "exclude")?.as_deref()
        )),
        "session" => json!(reconcile_session(
            &get(&input, "session")?,
            optional::<Game>(&input, "game")?.as_ref(),
            at()?
        )),
        "browser-fresh" => json!(browser_evidence_fresh(
            optional::<DetailEvidence>(&input, "detail")?.as_ref(),
            get(&input, "checkedAt")?,
            at()?
        )),
        "browser-deadline" => json!(browser_event_deadline(
            optional::<DetailEvidence>(&input, "detail")?.as_ref(),
            optional::<Game>(&input, "game")?.as_ref(),
            at()?
        )),
        "live-channel" => {
            let observation = get(&input, "observation")?;
            let result = get(&input, "result")?;
            let games = get::<Vec<Game>>(&input, "games")?;
            json!([
                json!(
                    provisional_live_channel(&observation, &result, &games, at()?)
                        .map(|game| &game.id)
                ),
                json!(resolved_live_channel_match(
                    &observation,
                    &result,
                    &games,
                    optional::<DetailEvidence>(&input, "detail")?.as_ref(),
                    at()?,
                    false
                ))
            ])
        }
        "wrestling-key" => {
            let league = get(&input, "league")?;
            let title = get::<String>(&input, "title")?;
            json!([
                wrestling_show_key(league, &title),
                wrestling_event_key(league, &title, at()?)
            ])
        }
        "locator-policy" => {
            let locator = get(&input, "locator")?;
            json!([
                json!(provider_probe_identity_wire(&input["locator"])),
                json!(persistable_locator(&locator)),
                json!(playback_resolution(&locator))
            ])
        }
        _ => return Err(format!("unknown-domain-operation:{operation}")),
    };
    Ok(output)
}

pub fn domain_call(operation: &str, input: Value) -> Result<Value, String> {
    let Some(args) = input.as_array() else {
        return external_domain_call(operation, input);
    };
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    let decode = |mut value: Value| {
        if value["rawTime"].is_null() {
            value["rawTime"] = json!("")
        }
        serde_json::from_value(value).map_err(|error| format!("{operation}: {error}"))
    };
    let at = |index: usize| {
        arg(index)
            .as_i64()
            .ok_or_else(|| format!("{operation}: invalid timestamp"))
    };
    let string = |index: usize| {
        arg(index)
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("{operation}: invalid string"))
    };
    let output = match operation {
        "normalizedName" => json!(normalized_name(&string(0)?)),
        "feedCalendarDay" => json!(
            arg(0)
                .as_i64()
                .filter(|at| at.unsigned_abs() <= 8_640_000_000_000_000)
                .and_then(feed_calendar_day)
        ),
        "feedWindow" => json!(feed_window(at(0)?)),
        "feedDateEligible" => json!(
            arg(0)
                .as_i64()
                .zip(arg(1).as_i64())
                .is_some_and(|(kickoff, now)| feed_date_eligible(kickoff, now))
        ),
        "feedEligible" | "feedInventoryEligible" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Input {
                lifecycle: GameLifecycle,
                date: Option<String>,
                final_observed_at: Option<i64>,
                league: Option<League>,
            }
            let game: Input = serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let now = at(1)?;
            let date = game.date.as_deref().and_then(parse_game_date);
            let eligible = game.final_observed_at.is_none()
                && game.lifecycle != GameLifecycle::Final
                && (game.lifecycle == GameLifecycle::Live
                    || game.league.is_some_and(is_wrestling_league)
                        && game.lifecycle == GameLifecycle::Unknown
                        && date
                            .is_some_and(|start| now >= start && now - start <= 6 * 60 * 60_000)
                    || game.lifecycle == GameLifecycle::Scheduled
                        && date.is_some_and(|date| feed_date_eligible(date, now)));
            json!(
                eligible
                    || operation == "feedInventoryEligible"
                        && game.lifecycle == GameLifecycle::Unknown
                        && game.final_observed_at.is_none()
                        && date.is_some_and(|date| feed_date_eligible(date, now))
            )
        }
        "combatListingFeedEligible" => json!(combat_listing_feed_eligible(
            &serde_json::from_value::<Game>(arg(0)).map_err(|error| error.to_string())?,
            at(1)?
        )),
        "detailIdentity" => json!(detail_identity(&decode(arg(0))?)),
        "detailIdentityMatches" => {
            json!(detail_identity_matches(arg(0).as_str(), &decode(arg(1))?))
        }
        "discoveryDeadline" => json!(discovery_deadline(
            at(0)?,
            &serde_json::from_value::<Vec<Observation>>(arg(1))
                .map_err(|error| error.to_string())?,
            &serde_json::from_value::<Vec<Game>>(arg(2)).map_err(|error| error.to_string())?,
            &serde_json::from_value::<Vec<League>>(arg(3)).map_err(|error| error.to_string())?,
            arg(4).as_i64().unwrap_or(at(0)?)
        )),
        "detailPolling" => {
            let prior: Option<DetailEvidence> =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let players: Vec<ResolvedPlayer> =
                serde_json::from_value(arg(2)).map_err(|error| error.to_string())?;
            let game: Option<Game> =
                serde_json::from_value(arg(3)).map_err(|error| error.to_string())?;
            json!(detail_polling(
                prior.as_ref(),
                &decode(arg(1))?,
                &players,
                game.as_ref()
            ))
        }
        "detailDeadline" => {
            let mut value = arg(0);
            if value["now"].is_null() {
                value["now"] = value["at"].clone()
            }
            external_domain_call("detail-deadline", value)?
        }
        "retryDeadline" => json!(retry_deadline(
            at(0)?,
            arg(1).as_i64().unwrap_or(0),
            arg(2).as_i64().unwrap_or(SOURCE_REFRESH_MS)
        )),
        "sourceFailure" => json!(source_failure(
            arg(0)
                .as_str()
                .or_else(|| args[0]["message"].as_str())
                .unwrap_or_default()
        )),
        "recordFinal" => json!(record_final(
            &serde_json::from_value::<Game>(arg(0)).map_err(|error| error.to_string())?,
            at(1)?,
            arg(2)
                .as_i64()
                .unwrap_or(DEFAULT_FINISHED_GAME_RETENTION_MINUTES)
        )),
        "reconcileSession" => {
            let session: Session =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let game: Option<Game> =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            json!(reconcile_session(&session, game.as_ref(), at(2)?))
        }
        "failedCandidate" => {
            let recovery: Recovery =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(failed_candidate(&recovery, &string(1)?, at(2)?))
        }
        "nextCandidate" => {
            let candidates: Vec<Candidate> =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let recovery: Recovery =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            if arg(4) == true {
                let now = at(2)?;
                let exclude = arg(3);
                let exclude = exclude.as_str();
                json!(if recovery.attempted.len() >= 3 {
                    None
                } else {
                    candidates
                        .iter()
                        .filter(|candidate| {
                            exclude != Some(&candidate.id)
                                && !recovery.attempted.contains(&candidate.id)
                                && recovery.cooled.get(&candidate.id).copied().unwrap_or(0) <= now
                        })
                        .min_by_key(|candidate| {
                            recovery.failures.get(&candidate.id).copied().unwrap_or(0)
                        })
                })
            } else {
                json!(next_candidate(
                    &candidates,
                    &recovery,
                    at(2)?,
                    arg(3).as_str()
                ))
            }
        }
        "compareCandidates" => {
            let a: Candidate = serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let b: Candidate = serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            json!(match compare_candidates(&a, &b) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            })
        }
        "workingFeedOwner" => {
            let game: Game = serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let partitions: Vec<String> =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            json!(working_feed_owner(&game, &partitions))
        }
        "workingFeedMatches" | "cachedFeedEligible" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SavedCandidate {
                game_id: String,
            }
            #[derive(Deserialize)]
            struct Feed {
                owner: FeedOwner,
                candidate: SavedCandidate,
            }
            let feed: Feed = serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let game: Game = serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            let owned = feed_owner_matches(&feed.owner, &feed.candidate.game_id, &game);
            if operation == "workingFeedMatches" {
                json!(owned)
            } else {
                let now = at(2)?;
                json!(
                    owned
                        && if game.lifecycle == GameLifecycle::Final {
                            game.grace_ends_at.is_some_and(|until| now < until)
                        } else {
                            game.final_observed_at.is_none()
                                && (matches!(
                                    game.lifecycle,
                                    GameLifecycle::Live | GameLifecycle::Scheduled
                                ) && game
                                    .kickoff()
                                    .is_some_and(|date| feed_date_eligible(date, now))
                                    || combat_listing_feed_eligible(&game, now))
                        }
                )
            }
        }
        "matchObservation" => {
            let games: Vec<Game> =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            let mode: MatchMode = if arg(3).is_null() {
                MatchMode::Current
            } else {
                serde_json::from_value(arg(3)).map_err(|error| error.to_string())?
            };
            json!(ObservationMatcher::new(&games, mode).match_observation(
                &decode(arg(0))?,
                at(2)?,
                arg(4).as_i64()
            ))
        }
        "sourceEventMatch" => {
            let games: Vec<Game> =
                serde_json::from_value(arg(2)).map_err(|error| error.to_string())?;
            let evidence: SourceEventEvidence =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            let mode: MatchMode = if arg(4).is_null() {
                MatchMode::Current
            } else {
                serde_json::from_value(arg(4)).map_err(|error| error.to_string())?
            };
            json!(SourceEventMatcher::new(&games, mode).match_event(
                &decode(arg(0))?,
                &evidence,
                at(3)?,
                arg(5).as_i64()
            ))
        }
        "finishedGameId" => {
            let games: Vec<Game> =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            json!(FinishedGameMatcher::new(&games).finished_game_id(
                &decode(arg(0))?,
                at(2)?,
                arg(3).as_str()
            ))
        }
        "finishedBoundEvent" => {
            let games: Vec<Game> =
                serde_json::from_value(arg(2)).map_err(|error| error.to_string())?;
            let bindings: Vec<SourceEventBinding> =
                serde_json::from_value(arg(3)).map_err(|error| error.to_string())?;
            json!(FinishedGameMatcher::new(&games).finished_bound_event(
                &decode(arg(0))?,
                &string(1)?,
                &bindings
            ))
        }
        "detailCandidateGameIds" => {
            let result: Match =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(detail_candidate_game_ids(&result))
        }
        "mergeSchedulePartitions" => {
            let partitions: Vec<Vec<Game>> =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(merge_schedule_partitions(&partitions))
        }
        "sourceCoverage" => json!(source_coverage(&string(0)?)),
        "listingEventEvidence" => json!(listing_event_evidence(&string(0)?)),
        "wrestlingPromotion" => json!(wrestling_promotion(&string(0)?)),
        "wrestlingShowKey" => {
            let league: League =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(wrestling_show_key(league, &string(1)?))
        }
        "wrestlingEventKey" => {
            let league: League =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(wrestling_event_key(league, &string(1)?, at(2)?))
        }
        "combatCardTitle" => {
            let (title, segment) = combat_card_title(&string(0)?);
            json!({"title":title,"segment":segment})
        }
        "browserEventDeadline" => {
            let detail: Option<DetailEvidence> =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let game: Option<Game> =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            json!(browser_event_deadline(
                detail.as_ref(),
                game.as_ref(),
                at(2)?
            ))
        }
        "browserEvidenceFresh" => {
            let detail: Option<DetailEvidence> =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(browser_evidence_fresh(detail.as_ref(), at(1)?, at(2)?))
        }
        "provisionalLiveChannel" => {
            let observation: Observation =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let result: Match =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            let games: Vec<Game> =
                serde_json::from_value(arg(2)).map_err(|error| error.to_string())?;
            json!(provisional_live_channel(
                &observation,
                &result,
                &games,
                at(3)?
            ))
        }
        "resolvedLiveChannelMatch" => {
            let observation: Observation =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            let result: Match =
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?;
            let games: Vec<Game> =
                serde_json::from_value(arg(2)).map_err(|error| error.to_string())?;
            let detail: Option<DetailEvidence> =
                serde_json::from_value(arg(3)).map_err(|error| error.to_string())?;
            json!(resolved_live_channel_match(
                &observation,
                &result,
                &games,
                detail.as_ref(),
                at(4)?,
                arg(5)["retainedPublication"] == true
            ))
        }
        "providerProbeIdentity" | "eventPageProbeIdentity" => {
            json!(provider_probe_identity_wire(&arg(0)))
        }
        "persistableLocator" => {
            let locator: CandidateLocator =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(persistable_locator(&locator))
        }
        "playbackResolution" => {
            let locator: CandidateLocator =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(playback_resolution(&locator))
        }
        "durableCatalogStream" => {
            let locator: CandidateLocator =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(durable_catalog_stream(&locator))
        }
        "streameastServerUrl" => {
            let locator: CandidateLocator =
                serde_json::from_value(arg(0)).map_err(|error| error.to_string())?;
            json!(streameast_server_url(&locator))
        }
        "parseScoreboard" => {
            let league: League = if arg(1).is_null() {
                League::Nfl
            } else {
                serde_json::from_value(arg(1)).map_err(|error| error.to_string())?
            };
            json!(super::schedule::parse_scoreboard(&arg(0), league)?)
        }
        "scoreboardWeek" => json!(super::schedule::scoreboard_week(&arg(0))),
        "scoreboardFeedData" => super::schedule::scoreboard_feed_data(&arg(0), &string(1)?)?,
        "isUfcCardName" => json!(super::schedule::is_ufc_card_name(&string(0)?)),
        "defaultSchedules" => json!(super::schedule::default_schedules()),
        _ => return super::catalog_plan::browser_operation(operation, &input),
    };
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_provider_identities_do_not_compile_dynamic_player_routes() {
        let locator = json!({"provider":"event-page","gameId":"10001","eventUrl":"https://vipbox.fm/onair/ncaaf/montana-state-vs-idaho","serverUrl":"https://vipbox.fm/live/ncaaf/montana-state-vs-idaho-2","extra":"one"});
        assert!(crate::event_policy::valid_event_page_pair(
            locator["eventUrl"].as_str().unwrap(),
            locator["serverUrl"].as_str().unwrap(),
        ));
        crate::event_policy::UNCACHED_PATTERN_COMPILES.set(0);
        for _ in 0..16 {
            assert_eq!(
                provider_probe_identity_wire(&locator),
                r#"{"provider":"event-page","gameId":"10001","eventUrl":"https://vipbox.fm/onair/ncaaf/montana-state-vs-idaho","serverUrl":"https://vipbox.fm/live/ncaaf/montana-state-vs-idaho-2","extra":"one"}"#
            );
        }
        assert_eq!(crate::event_policy::UNCACHED_PATTERN_COMPILES.get(), 0);

        let alias = json!({"provider":"event-page","gameId":"10001","eventUrl":"https://methstreams.st/event/m-detroit-lions-vs-carolina-panthers-1005","serverUrl":"https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1"});
        assert_eq!(
            provider_probe_identity_wire(&alias),
            r#"["event-page","fxtrend","10001","https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1"]"#
        );
        let mut changed = alias;
        changed["eventUrl"] = json!("https://methstreams.st/event/unrelated");
        assert_eq!(
            provider_probe_identity_wire(&changed),
            r#"{"provider":"event-page","gameId":"10001","eventUrl":"https://methstreams.st/event/unrelated","serverUrl":"https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1"}"#
        );
    }

    #[test]
    fn wrestling_promotion_boundary_uses_clean_published_titles() {
        for (title, expected) in [
            ("WWE Monday Night Raw", json!("wwe")),
            ("NXT", json!("wwe")),
            ("TNA Impact live", json!("tna")),
            ("All Elite Wrestling Collision", json!("aew")),
            ("The Impact of Wrestling", Value::Null),
        ] {
            assert_eq!(
                domain_call("wrestlingPromotion", json!([title])),
                Ok(expected)
            );
        }
    }

    #[test]
    fn frozen_typescript_domain_contract() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-domain.json"
        ))
        .unwrap();
        let mut failures = Vec::new();
        for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
            let operation = case["operation"].as_str().unwrap();
            let result = external_domain_call(operation, case["input"].clone());
            if result != Ok(case["expected"].clone()) {
                failures.push(format!(
                    "case {index}: {operation}: {result:?}, expected {}",
                    case["expected"]
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} failures:\n{}",
            failures.len(),
            failures
                .iter()
                .take(12)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
