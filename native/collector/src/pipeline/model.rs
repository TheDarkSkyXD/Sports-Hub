//! Typed values shared by the native schedule, repository, and coordinator.
pub use crate::types::{
    CandidateLocator, League, ListingSource, MissingPlayerReason, Observation, ResolvedPlayer,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Source = ListingSource;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GameStatus {
    Pre,
    In,
    Post,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GameLifecycle {
    Scheduled,
    Live,
    Unknown,
    Final,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub short: String,
    pub abbreviation: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    pub score: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub membership: Option<TeamMembership>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Subdivision {
    Fbs,
    Fcs,
    D2D3,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMembership {
    pub subdivision: Subdivision,
    pub season: i32,
    pub observed_at: i64,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Race {
    pub event_id: String,
    pub session_id: String,
    pub session: String,
    pub round: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circuit: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Combat {
    pub event_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wrestling {
    pub event_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GameKind {
    Matchup {
        home: Team,
        away: Team,
        redzone: bool,
        #[serde(
            rename = "possession",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        possession: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        down: Option<String>,
        #[serde(rename = "lastPlay", default, skip_serializing_if = "Option::is_none")]
        last_play: Option<String>,
    },
    Race {
        race: Race,
    },
    Combat {
        combat: Combat,
    },
    Wrestling {
        wrestling: Wrestling,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub league: League,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(flatten)]
    pub kind: GameKind,
    pub status: GameStatus,
    pub lifecycle: GameLifecycle,
    pub detail: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_number"
    )]
    pub season: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partitions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broadcast: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_urls: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_integer"
    )]
    pub final_observed_at: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_integer"
    )]
    pub grace_ends_at: Option<i64>,
}

fn deserialize_optional_integer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    let number = Option::<serde_json::Number>::deserialize(deserializer)?;
    number
        .map(|number| {
            number
                .as_i64()
                .or_else(|| {
                    number
                        .as_f64()
                        .filter(|value| {
                            value.is_finite()
                                && value.fract() == 0.0
                                && *value >= i64::MIN as f64
                                && *value < i64::MAX as f64
                        })
                        .map(|value| value as i64)
                })
                .ok_or_else(|| serde::de::Error::custom("invalid-integer-timestamp"))
        })
        .transpose()
}

impl Game {
    pub fn home(&self) -> Option<&Team> {
        match &self.kind {
            GameKind::Matchup { home, .. } => Some(home),
            _ => None,
        }
    }
    pub fn away(&self) -> Option<&Team> {
        match &self.kind {
            GameKind::Matchup { away, .. } => Some(away),
            _ => None,
        }
    }
    pub fn race(&self) -> Option<&Race> {
        match &self.kind {
            GameKind::Race { race } => Some(race),
            _ => None,
        }
    }
    pub fn combat(&self) -> Option<&Combat> {
        match &self.kind {
            GameKind::Combat { combat } => Some(combat),
            _ => None,
        }
    }
    pub fn wrestling(&self) -> Option<&Wrestling> {
        match &self.kind {
            GameKind::Wrestling { wrestling } => Some(wrestling),
            _ => None,
        }
    }
    pub fn is_matchup(&self) -> bool {
        matches!(self.kind, GameKind::Matchup { .. })
    }
    pub fn kickoff(&self) -> Option<i64> {
        self.date.as_deref().and_then(parse_game_date)
    }
}

pub fn parse_game_date(value: &str) -> Option<i64> {
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis());
    }
    let pattern = cached_regex!(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$").unwrap();
    if let Some(parts) = pattern.captures(value) {
        return chrono::DateTime::parse_from_rfc3339(&format!("{}:00{}", &parts[1], &parts[2]))
            .ok()
            .map(|date| date.timestamp_millis());
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)
        .map(|date| date.and_utc().timestamp_millis())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Partition {
    pub games: Vec<Game>,
    pub at: i64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_number"
    )]
    pub week: Option<f64>,
}

fn serialize_optional_number<S: serde::Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value)
            if value.fract() == 0.0 && *value >= i64::MIN as f64 && *value < i64::MAX as f64 =>
        {
            serializer.serialize_i64(*value as i64)
        }
        Some(value) => serializer.serialize_f64(*value),
        None => serializer.serialize_none(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeasonMembership {
    pub season: i32,
    pub at: i64,
    pub teams: BTreeMap<String, Subdivision>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Match {
    Matched {
        game_id: String,
    },
    Unmatched {
        reason: String,
        possible_game_ids: Vec<String>,
    },
}

impl Match {
    pub fn game_id(&self) -> Option<&str> {
        match self {
            Self::Matched { game_id } => Some(game_id),
            _ => None,
        }
    }
    pub fn possible_game_ids(&self) -> &[String] {
        match self {
            Self::Unmatched {
                possible_game_ids, ..
            } => possible_game_ids,
            _ => &[],
        }
    }
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Unmatched { reason, .. } => Some(reason),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEventBinding {
    pub source_id: String,
    pub event_id: String,
    pub url: String,
    pub league: League,
    pub teams: [String; 2],
    pub game_id: String,
    pub observed_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub game_id: String,
    pub label: String,
    pub source_ids: Vec<String>,
    pub observed_at: i64,
    pub locator: CandidateLocator,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub game_id: String,
    pub candidate_id: String,
    pub generation: u64,
    #[serde(flatten)]
    pub phase: SessionPhase,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionPhase {
    Active { grace_ends_at: () },
    Draining { grace_ends_at: i64 },
    Closed { grace_ends_at: i64 },
}

impl Session {
    pub fn grace_ends_at(&self) -> Option<i64> {
        match self.phase {
            SessionPhase::Active { .. } => None,
            SessionPhase::Draining { grace_ends_at } | SessionPhase::Closed { grace_ends_at } => {
                Some(grace_ends_at)
            }
        }
    }
    pub fn is_closed(&self) -> bool {
        matches!(self.phase, SessionPhase::Closed { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvancingVideo {
    pub kind: ProofKind,
    pub version: u8,
    pub startup_ms: u32,
    pub observed_ms: u32,
    pub media_advance_ms: u32,
    pub presented_frames: u32,
}
pub type Proof = AdvancingVideo;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProofKind {
    AdvancingVideo,
}

impl AdvancingVideo {
    pub fn valid(&self) -> bool {
        self.version == 1
            && self.startup_ms <= 300_000
            && (2_000..=300_000).contains(&self.observed_ms)
            && (2_000..=300_000).contains(&self.media_advance_ms)
            && (3..=1_000_000).contains(&self.presented_frames)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPhase {
    Resolution,
    Activation,
    Capture,
    Ownership,
    Replay,
    Decode,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaFailureReason {
    Upstream,
    Unsupported,
    InvalidMedia,
    Timeout,
    Playback,
    NoFeed,
    Blocked,
    NotFound,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaDeferralReason {
    Capacity,
    Upstream,
    Timeout,
    Cancelled,
    Unverified,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaTimings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MediaCheckResult {
    Playable {
        proof: AdvancingVideo,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timings: Option<MediaTimings>,
    },
    Unavailable {
        reason: MediaFailureReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MediaPhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timings: Option<MediaTimings>,
    },
    Deferred {
        retry_after_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<MediaDeferralReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MediaPhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timings: Option<MediaTimings>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationTarget {
    pub session_id: String,
    pub game_id: String,
    pub candidate_id: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_day: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceFailure {
    NotFound,
    Blocked,
    RateLimited,
    TimedOut,
    NetworkUnavailable,
    UnsupportedAddress,
    CollectorBusy,
    ResponseTooLarge,
    InvalidResponse,
    UpstreamError,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceOutcome {
    Parsed,
    Empty,
    Unsupported,
    ParserChanged,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAttempt {
    pub at: i64,
    pub outcome: SourceOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<SourceFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failures: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_eligible_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parser_version: Option<u32>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionAttempt {
    pub source_id: String,
    pub league: Option<League>,
    pub at: i64,
    pub outcome: SourceOutcome,
    pub count: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailEvent {
    pub game_id: String,
    pub date: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailPolling {
    pub signature: String,
    pub unchanged_checks: u8,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Publication {
    pub players: Vec<ResolvedPlayer>,
    pub event: DetailEvent,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LastDetailSuccess {
    pub identity: String,
    pub at: i64,
    pub count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication: Option<Publication>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailEvidence {
    pub observation_id: String,
    pub generation: String,
    pub at: i64,
    pub next_eligible_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success: Option<LastDetailSuccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub polling: Option<DetailPolling>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<DetailEvent>,
    #[serde(flatten)]
    pub result: DetailOutcome,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DetailOutcome {
    Resolved {
        players: Vec<ResolvedPlayer>,
    },
    Unresolved {
        reason: MissingPlayerReason,
        failures: u64,
    },
    Failed {
        failure: SourceFailure,
        failures: u64,
    },
}
impl DetailEvidence {
    pub fn players(&self) -> &[ResolvedPlayer] {
        match &self.result {
            DetailOutcome::Resolved { players } => players,
            _ => &[],
        }
    }
    pub fn is_resolved(&self) -> bool {
        matches!(self.result, DetailOutcome::Resolved { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TeamIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum FeedOwner {
    Matchup {
        league: League,
        home: TeamIdentity,
        away: TeamIdentity,
        partition_ids: Vec<String>,
    },
    Race {
        league: League,
        event_id: String,
        session_id: String,
        session: String,
        round: String,
        partition_ids: Vec<String>,
    },
    Event {
        league: League,
        event_id: String,
        date: String,
        partition_ids: Vec<String>,
    },
}
impl FeedOwner {
    pub fn partition_ids(&self) -> &[String] {
        match self {
            Self::Matchup { partition_ids, .. }
            | Self::Race { partition_ids, .. }
            | Self::Event { partition_ids, .. } => partition_ids,
        }
    }
    pub fn league(&self) -> League {
        match self {
            Self::Matchup { league, .. }
            | Self::Race { league, .. }
            | Self::Event { league, .. } => *league,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorkingProof {
    Legacy(String),
    Advancing(AdvancingVideo),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingFeed {
    pub version: u8,
    pub identity_hash: String,
    pub candidate: Candidate,
    pub owner: FeedOwner,
    pub checked_at: i64,
    pub proof: WorkingProof,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedCheck {
    pub version: u8,
    pub game_id: String,
    pub game_date: Option<String>,
    pub identity_hash: String,
    pub owner: FeedOwner,
    pub outcome: FeedCheckOutcome,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FeedCheckOutcome {
    Unavailable {
        checked_at: i64,
        retry_at: i64,
        reason: MediaFailureReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MediaPhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timings: Option<MediaTimings>,
    },
    Incomplete {
        checked_at: i64,
        retry_at: i64,
        incomplete_attempts: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<MediaDeferralReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MediaPhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timings: Option<MediaTimings>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub attempted: Vec<String>,
    pub cooled: BTreeMap<String, i64>,
    pub cycle_started_at: i64,
    pub failures: BTreeMap<String, u32>,
}

pub fn is_motorsports_league(league: League) -> bool {
    matches!(
        league,
        League::F1 | League::NascarCup | League::NascarTruck | League::Motogp | League::Motorsport
    )
}
pub fn is_wrestling_league(league: League) -> bool {
    matches!(
        league,
        League::Wwe | League::Tna | League::Aew | League::Wrestling
    )
}
pub fn is_combat_league(league: League) -> bool {
    matches!(league, League::Ufc | League::Boxing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persisted_evidence_rejects_forged_proof_and_invalid_ownership() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-domain.json"
        ))
        .unwrap();
        let mut feed = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["operation"] == "working-match")
            .unwrap()["input"]["feed"]
            .clone();
        assert!(validate_payload("working", &feed).is_ok());
        feed["proof"]["presentedFrames"] = json!(2);
        assert!(validate_payload("working", &feed).is_err());
        feed["proof"]["presentedFrames"] = json!(3);
        feed["identityHash"] = json!("bad");
        assert!(validate_payload("working", &feed).is_err());
        feed["identityHash"] = json!("a".repeat(64));
        feed["owner"]["partitionIds"] = json!([]);
        assert!(validate_payload("working", &feed).is_err());
    }

    #[test]
    fn game_lifecycle_and_league_shape_must_agree() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-domain.json"
        ))
        .unwrap();
        let mut game = corpus["cases"][6]["input"]["games"][0].clone();
        assert!(validate_payload("game", &game).is_ok());
        game["lifecycle"] = json!("final");
        assert!(validate_payload("game", &game).is_err());
        game["lifecycle"] = json!("live");
        game["league"] = json!("ufc");
        assert!(validate_payload("game", &game).is_err());
    }

    #[test]
    fn espn_minute_precision_and_date_only_inputs_keep_their_utc_epoch() {
        assert_eq!(
            parse_game_date("2026-10-18T18:00Z"),
            Some(1_792_346_400_000)
        );
        assert_eq!(
            parse_game_date("2026-10-18T18:00+00:00"),
            Some(1_792_346_400_000)
        );
        assert_eq!(parse_game_date("2026-10-18"), Some(1_792_281_600_000));
        assert_eq!(parse_game_date("2026-02-30T18:00Z"), None);
    }

    #[test]
    fn observation_storage_preserves_the_existing_string_contract() {
        let observation = json!({"id":"","sourceId":"","url":"relative","title":"","league":null,"teams":["",""],"kickoff":null,"rawTime":"","observedAt":0,"parserVersion":1});
        assert!(validate_payload("observation", &observation).is_ok());
    }

    #[test]
    fn strict_feed_ownership_and_optional_game_fields_reject_unknown_or_null_values() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-domain.json"
        ))
        .unwrap();
        let mut feed = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["operation"] == "working-match")
            .unwrap()["input"]["feed"]
            .clone();
        feed["owner"]["extra"] = json!("unexpected");
        assert!(validate_payload("working", &feed).is_err());
        let mut game = corpus["cases"][6]["input"]["games"][0].clone();
        game["date"] = serde_json::Value::Null;
        assert!(validate_payload("game", &game).is_err());
    }
}

pub fn validate_payload(kind: &str, value: &serde_json::Value) -> Result<(), String> {
    use serde_json::Value;
    fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())
    }
    fn require(valid: bool) -> Result<(), String> {
        if valid {
            Ok(())
        } else {
            Err("invalid-pipeline-payload".into())
        }
    }
    fn nonnegative(value: &Value) -> bool {
        value
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0 && n.fract() == 0.0)
    }
    fn optional_number(value: &Value, key: &str) -> bool {
        value
            .get(key)
            .is_none_or(|value| value.as_f64().is_some_and(f64::is_finite))
    }
    fn optional_count(value: &Value, key: &str) -> bool {
        value.get(key).is_none_or(nonnegative)
    }
    fn strict(value: &Value, keys: &[&str]) -> bool {
        value
            .as_object()
            .is_some_and(|value| value.keys().all(|key| keys.contains(&key.as_str())))
    }
    fn optional_nonnull(value: &Value, keys: &[&str]) -> bool {
        keys.iter()
            .all(|key| value.get(*key).is_none_or(|value| !value.is_null()))
    }
    fn owner(owner: &FeedOwner) -> bool {
        let ids = owner.partition_ids();
        if ids.is_empty() || ids.len() > 32 || ids.iter().any(String::is_empty) {
            return false;
        }
        match owner {
            FeedOwner::Matchup {
                league, home, away, ..
            } => {
                !is_combat_league(*league)
                    && !is_motorsports_league(*league)
                    && !is_wrestling_league(*league)
                    && !home.name.is_empty()
                    && !away.name.is_empty()
            }
            FeedOwner::Race { league, .. } => is_motorsports_league(*league),
            FeedOwner::Event {
                league, event_id, ..
            } => {
                (is_combat_league(*league) || is_wrestling_league(*league)) && !event_id.is_empty()
            }
        }
    }
    fn hash(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
    fn owner_fields(owner: &FeedOwner, value: &Value) -> bool {
        match owner {
            FeedOwner::Matchup { .. } => {
                strict(value, &["league", "home", "away", "partitionIds"])
                    && strict(&value["home"], &["id", "name"])
                    && strict(&value["away"], &["id", "name"])
                    && optional_nonnull(&value["home"], &["id"])
                    && optional_nonnull(&value["away"], &["id"])
            }
            FeedOwner::Race { .. } => strict(
                value,
                &[
                    "league",
                    "eventId",
                    "sessionId",
                    "session",
                    "round",
                    "partitionIds",
                ],
            ),
            FeedOwner::Event { .. } => {
                strict(value, &["league", "eventId", "date", "partitionIds"])
            }
        }
    }
    fn game(value: &Value, schedule: bool) -> Result<(), String> {
        let game: Game = parse(value)?;
        require(optional_nonnull(
            value,
            &[
                "date",
                "season",
                "partitions",
                "venue",
                "broadcast",
                "sourceUrl",
                "sourceUrls",
                "finalObservedAt",
                "graceEndsAt",
                "possession",
                "down",
                "lastPlay",
            ],
        ))?;
        let mut keys = vec![
            "id",
            "league",
            "name",
            "date",
            "status",
            "lifecycle",
            "detail",
            "partitions",
            "broadcast",
            "sourceUrl",
            "sourceUrls",
            "finalObservedAt",
            "graceEndsAt",
        ];
        let lifecycle = match game.lifecycle {
            GameLifecycle::Scheduled => game.status == GameStatus::Pre,
            GameLifecycle::Live => game.status == GameStatus::In,
            GameLifecycle::Unknown => true,
            GameLifecycle::Final => game.status == GameStatus::Post,
        };
        if !lifecycle {
            return Err("invalid-game-lifecycle".into());
        }
        if game.lifecycle == GameLifecycle::Final {
            if schedule {
                require(game.final_observed_at.is_none() && game.grace_ends_at.is_none())?
            } else {
                require(
                    game.final_observed_at.is_some()
                        && game.grace_ends_at.is_some()
                        && game.source_urls.as_ref().is_none_or(Vec::is_empty),
                )?
            }
        } else {
            require(game.final_observed_at.is_none() && game.grace_ends_at.is_none())?
        }
        let shape = match &game.kind {
            GameKind::Matchup { home, away, .. } => {
                keys.extend([
                    "home",
                    "away",
                    "redzone",
                    "season",
                    "possession",
                    "down",
                    "lastPlay",
                    "venue",
                ]);
                let team = |team: &Team, raw: &Value| {
                    raw.get("score").is_some()
                        && optional_nonnull(raw, &["id", "logo", "record", "aliases", "membership"])
                        && team
                            .membership
                            .as_ref()
                            .is_none_or(|membership| membership.source == "espn-core")
                };
                !is_motorsports_league(game.league)
                    && !is_combat_league(game.league)
                    && !is_wrestling_league(game.league)
                    && team(home, &value["home"])
                    && team(away, &value["away"])
            }
            GameKind::Race { race } => {
                keys.extend(["race", "season"]);
                is_motorsports_league(game.league)
                    && cached_regex!(r"^(?:f1|nascar-cup|nascar-truck|motogp|motorsport)-\d{1,20}$")
                        .unwrap()
                        .is_match(&game.id)
                    && !game.name.is_empty()
                    && game.date.is_some()
                    && cached_regex!(r"^\d{1,20}$")
                        .unwrap()
                        .is_match(&race.event_id)
                    && cached_regex!(r"^\d{1,20}$")
                        .unwrap()
                        .is_match(&race.session_id)
                    && matches!(
                        race.session.as_str(),
                        "practice"
                            | "practice-1"
                            | "practice-2"
                            | "practice-3"
                            | "practice-4"
                            | "sprint-qualifying"
                            | "sprint"
                            | "qualifying"
                            | "race"
                    )
                    && !race.round.is_empty()
                    && race
                        .circuit
                        .as_ref()
                        .is_none_or(|circuit| !circuit.is_empty())
                    && strict(
                        &value["race"],
                        &["eventId", "sessionId", "session", "round", "circuit"],
                    )
            }
            GameKind::Combat { combat } => {
                keys.extend(["combat", "season"]);
                is_combat_league(game.league)
                    && cached_regex!(r"^(?:ufc|boxing)-\d{1,20}$")
                        .unwrap()
                        .is_match(&game.id)
                    && !game.name.is_empty()
                    && game.date.is_some()
                    && !combat.event_id.is_empty()
                    && combat.event_id.len() <= 160
                    && strict(&value["combat"], &["eventId"])
            }
            GameKind::Wrestling { wrestling } => {
                keys.push("wrestling");
                is_wrestling_league(game.league)
                    && cached_regex!(r"^(?:wwe|tna|aew|wrestling)-\d{1,20}$")
                        .unwrap()
                        .is_match(&game.id)
                    && !game.name.is_empty()
                    && game.date.is_some()
                    && cached_regex!(r"^\d{1,20}$")
                        .unwrap()
                        .is_match(&wrestling.event_id)
                    && wrestling.ends_at.is_none_or(|at| at > 0)
                    && strict(&value["wrestling"], &["eventId", "endsAt"])
            }
        };
        require(shape && strict(value, &keys))
    }
    match kind {
        "game" => game(value, false),
        "scheduleGame" => game(value, true),
        "partition" => {
            let partition: Partition = parse(value)?;
            for row in value["games"].as_array().ok_or("invalid-games")? {
                game(row, false)?
            }
            require(partition.week.is_none_or(f64::is_finite))
        }
        "observation" => {
            let row: Observation = parse(value)?;
            require(
                ["league", "teams", "kickoff"]
                    .iter()
                    .all(|key| value.get(*key).is_some())
                    && row.ends_at.is_none_or(|at| at > 0)
                    && optional_nonnull(value, &["endsAt", "legacyId", "kickoffLineage"]),
            )
        }
        "binding" => {
            let row: SourceEventBinding = parse(value)?;
            require(url::Url::parse(&row.url).is_ok())
        }
        "attempt" => {
            let outcome: SourceOutcome = parse(&value["outcome"])?;
            let _ = outcome;
            if let Some(failure) = value.get("failure") {
                let _: SourceFailure = parse(failure)?;
            }
            require(
                value["at"].as_f64().is_some_and(f64::is_finite)
                    && optional_number(value, "nextEligibleAt")
                    && optional_count(value, "count")
                    && optional_count(value, "failures")
                    && value
                        .get("parserVersion")
                        .is_none_or(|value| value.as_u64().is_some_and(|value| value > 0)),
            )
        }
        "working" => {
            let feed: WorkingFeed = parse(value)?;
            let proof = match &feed.proof {
                WorkingProof::Legacy(proof) => {
                    feed.version == 1 && matches!(proof.as_str(), "media" | "decoded")
                }
                WorkingProof::Advancing(proof) => feed.version == 2 && proof.valid(),
            };
            require(
                hash(&feed.identity_hash)
                    && owner(&feed.owner)
                    && owner_fields(&feed.owner, &value["owner"])
                    && feed.checked_at >= 0
                    && proof
                    && strict(
                        value,
                        &[
                            "version",
                            "identityHash",
                            "candidate",
                            "owner",
                            "checkedAt",
                            "proof",
                        ],
                    )
                    && strict(
                        &value["candidate"],
                        &[
                            "id",
                            "gameId",
                            "label",
                            "sourceIds",
                            "observedAt",
                            "locator",
                        ],
                    ),
            )
        }
        "check" => {
            let check: FeedCheck = parse(value)?;
            let result = match check.outcome {
                FeedCheckOutcome::Unavailable {
                    checked_at,
                    retry_at,
                    ..
                } => checked_at >= 0 && retry_at >= 0,
                FeedCheckOutcome::Incomplete {
                    checked_at,
                    retry_at,
                    incomplete_attempts,
                    reason,
                    ..
                } => {
                    checked_at >= 0
                        && retry_at >= 0
                        && (1..=5).contains(&incomplete_attempts)
                        && !matches!(
                            reason,
                            Some(MediaDeferralReason::Capacity | MediaDeferralReason::Cancelled)
                        )
                }
            };
            require(
                check.version == 1
                    && !check.game_id.is_empty()
                    && value.get("gameDate").is_some()
                    && hash(&check.identity_hash)
                    && owner(&check.owner)
                    && owner_fields(&check.owner, &value["owner"])
                    && result
                    && strict(
                        value,
                        &[
                            "version",
                            "gameId",
                            "gameDate",
                            "identityHash",
                            "owner",
                            "outcome",
                        ],
                    ),
            )
        }
        "detail" => {
            let detail: DetailEvidence = parse(value)?;
            let polling = detail
                .polling
                .as_ref()
                .is_none_or(|polling| polling.unchanged_checks <= 3);
            let success = detail.last_success.as_ref().is_none_or(|success| {
                success.count > 0
                    && success
                        .publication
                        .as_ref()
                        .is_none_or(|publication| !publication.players.is_empty())
            });
            require(polling && success)
        }
        "membership" => {
            let _: SeasonMembership = parse(value)?;
            Ok(())
        }
        _ => Err(format!("unknown-payload-kind:{kind}")),
    }
}
