use super::model::*;
use super::protocol::Token;
use crate::types::SourceKind;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const ACTIVE_DISCOVERY_MS: i64 = 30 * 60_000;
pub const SOURCE_REFRESH_MS: i64 = 5 * 60_000;

#[derive(Default)]
pub struct SourceBook {
    pub projection_dirty: bool,
    pub suppressed_candidates: BTreeSet<(String, String)>,
    pub detail_waiting: Option<Vec<(Observation, String)>>,
    pub detail_plan_at: i64,
    pub detail_plan_fresh: BTreeSet<String>,
    pub published_detail_ids: BTreeSet<(String, String)>,
    pub pending_listing_hosts: BTreeSet<String>,
    pub listings: BTreeMap<Token, Source>,
    pub details: BTreeMap<Token, (Observation, String)>,
    pub host_cooldowns: BTreeMap<String, i64>,
    pub source_times: BTreeMap<String, i64>,
    pub last_discovery: Option<i64>,
    pub detail_cursor: usize,
    pub detail_admissions: usize,
    pub forced_details: BTreeSet<String>,
}

impl SourceBook {
    pub fn reserve_listings(
        &mut self,
        sources: &[Source],
        attempts: &BTreeMap<String, SourceAttempt>,
        observations: &[Observation],
        games: &[Game],
        at: i64,
        explicit: bool,
    ) {
        self.pending_listing_hosts = sources
            .iter()
            .filter(|source| {
                self.host_retry_at(&source.url) <= at
                    && self.listing_due(
                        source,
                        attempts.get(&source.id),
                        observations,
                        games,
                        at,
                        explicit,
                    )
            })
            .map(|source| host(&source.url))
            .collect();
    }
    pub fn listing_available(&self, source: &Source, at: i64) -> bool {
        if self.listings.len() >= 4 || self.host_retry_at(&source.url) > at {
            return false;
        }
        let family = source_group(source);
        !self
            .listings
            .values()
            .any(|active| source_group(active) == family)
    }
    pub fn detail_available(&self, observation: &Observation, at: i64) -> bool {
        if self.details.len() >= 8
            || self.detail_admissions >= 80
            || self.host_retry_at(&observation.url) > at
        {
            return false;
        }
        let group = host(&observation.url);
        if self.pending_listing_hosts.contains(&group) {
            return false;
        }
        !self
            .listings
            .values()
            .any(|source| host(&source.url) == group)
            && self
                .details
                .values()
                .filter(|(active, _)| host(&active.url) == group)
                .count()
                < 2
            && !self
                .details
                .values()
                .any(|(active, _)| active.id == observation.id)
    }
    pub fn host_retry_at(&self, url: &str) -> i64 {
        *self.host_cooldowns.get(&host(url)).unwrap_or(&0)
    }
    pub fn listing_due(
        &self,
        source: &Source,
        attempt: Option<&SourceAttempt>,
        observations: &[Observation],
        games: &[Game],
        at: i64,
        explicit: bool,
    ) -> bool {
        if matches!(
            source.kind,
            Some(SourceKind::Pending | SourceKind::BrowserCatalog)
        ) {
            return false;
        }
        let Some(attempt) = attempt else {
            return true;
        };
        if attempt.outcome != SourceOutcome::Failed
            && attempt.parser_version != Some(source.parser_version.unwrap_or(3))
        {
            return true;
        }
        if attempt.outcome == SourceOutcome::Unsupported {
            return explicit;
        }
        if matches!(
            attempt.outcome,
            SourceOutcome::Parsed | SourceOutcome::Empty
        ) {
            let rows: Vec<_> = observations
                .iter()
                .filter(|row| row.source_id == source.id && row.observed_at >= attempt.at)
                .cloned()
                .collect();
            let leagues = if source.leagues.is_empty() {
                games.iter().map(|game| game.league).collect()
            } else {
                source.leagues.clone()
            };
            return super::domain::discovery_deadline(attempt.at, &rows, games, &leagues, at) <= at;
        }
        attempt.next_eligible_at.unwrap_or(0) <= at
    }
}

pub fn host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default()
}
pub fn source_group(source: &Source) -> String {
    if source.family == "unknown" {
        host(&source.url)
    } else {
        source.family.clone()
    }
}

pub fn detail_generation(observation: &Observation) -> String {
    let mut fields = vec![json!(observation.source_id), json!(observation.url)];
    let contextual = observation.teams.is_none()
        || observation
            .league
            .is_some_and(|league| is_combat_league(league) || is_wrestling_league(league));
    if contextual {
        fields.push(json!(observation.title));
        fields.push(json!(observation.league));
    }
    fields.extend([
        json!(observation.teams),
        json!(observation.kickoff),
        json!(observation.observed_at),
        json!(observation.parser_version),
    ]);
    Value::Array(fields).to_string()
}

pub fn error_message(result: &Value) -> Option<String> {
    (result["kind"] == "error").then(|| {
        result["message"]
            .as_str()
            .unwrap_or("request-failed")
            .to_owned()
    })
}

pub use super::domain::source_failure as failure;
