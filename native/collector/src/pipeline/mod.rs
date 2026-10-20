pub mod catalog;
pub mod catalog_plan;
pub mod discovery;
pub mod domain;
pub mod feeds;
pub mod matching;
pub mod model;
pub mod probes;
pub mod protocol;
pub mod schedule;
pub mod sessions;
pub mod sources;
pub mod store;
pub mod views;

use feeds::{FeedBook, Priority, Terminal, TerminalOutcome};
use matching::{MatchMode, SourceEventMatcher};
use model::*;
use protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use sessions::{Choice, SessionBook};
use sha2::{Digest, Sha256};
use sources::SourceBook;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineConfig {
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub schedules: Vec<Value>,
    #[serde(default)]
    pub browser_collectors_available: bool,
    #[serde(default = "default_probe_concurrency")]
    pub probe_concurrency: usize,
    pub owner_token: Option<String>,
    pub reclaim_token: Option<String>,
    pub now: Option<i64>,
    #[serde(default)]
    pub fixture_operations: BTreeSet<String>,
}
fn default_probe_concurrency() -> usize {
    2
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerificationPolicy {
    viewing_concurrency: usize,
    working_feeds_per_game: usize,
}
fn verification_policy() -> &'static VerificationPolicy {
    static POLICY: std::sync::OnceLock<VerificationPolicy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../lib/playback/verification-policy.json"
        ))
        .expect("checked verification policy")
    })
}

struct RefreshPass {
    requests: Vec<u64>,
    pending: BTreeSet<Token>,
    membership_started: bool,
    previous_coverage: BTreeSet<String>,
    force: bool,
}
struct InventoryCache {
    at: i64,
    day: Option<i64>,
    revision: u64,
    probe_limit: usize,
    proof_expires_at: i64,
    visible: BTreeSet<String>,
    fresh: BTreeSet<String>,
    room: bool,
    snapshot: std::sync::Arc<Value>,
}
pub(super) struct ReassignmentContext(Vec<AssignmentCatalog>);
struct AssignmentCatalog {
    kind: &'static str,
    history: Value,
    assignments: BTreeMap<(String, String), BTreeSet<String>>,
    published: BTreeSet<String>,
}
enum Job {
    Schedule {
        source: Value,
    },
    Membership {
        season: i64,
    },
    Listing {
        source: Source,
    },
    Detail {
        observation: Observation,
        game_id: String,
    },
    Resolve {
        original: Observation,
        observation: Observation,
        game_id: String,
    },
    OpenId {
        request: u64,
        command: Command,
    },
    ProbeId,
    Probe,
    Cancelled,
    FlushProbes,
    DeferredDiscovery {
        remaining: u8,
        explicit: bool,
    },
    CloseSchedule,
    Metadata {
        locators: Vec<String>,
    },
}

pub struct Pipeline {
    pub config: PipelineConfig,
    pub store: store::Store,
    pub games: Vec<Game>,
    pub candidates: BTreeMap<String, Vec<Candidate>>,
    pub feeds: FeedBook,
    pub sessions: SessionBook,
    pub sources: SourceBook,
    pub errors: BTreeMap<String, String>,
    pub revision: u64,
    schedule_ready: bool,
    last_schedule: Option<i64>,
    started: bool,
    discovery_enabled: bool,
    resolution_enabled: bool,
    stopping: bool,
    stopped: bool,
    last_tick: i64,
    last_sweep: i64,
    next_job: u64,
    epoch: u64,
    wake_version: u64,
    jobs: BTreeMap<Token, Job>,
    refresh: Option<RefreshPass>,
    queued_refresh: Vec<u64>,
    stop_requests: Vec<u64>,
    restored_working: Vec<WorkingFeed>,
    restored_checks: Vec<FeedCheck>,
    refreshed_schedules: BTreeSet<String>,
    catalog_evidence: BTreeMap<String, matching::SourceEventEvidence>,
    observation_deadlines: BTreeMap<String, i64>,
    publication_deadlines: BTreeMap<String, i64>,
    current_matcher: std::cell::RefCell<SourceEventMatcher>,
    inventory_matcher: std::cell::RefCell<SourceEventMatcher>,
    fixture_identities: BTreeMap<String, String>,
    fixture_persistable: BTreeMap<String, bool>,
    metadata_pending: BTreeSet<String>,
    pending_commands: Vec<(u64, Command)>,
    partition_times: BTreeMap<String, i64>,
    inventory_cache: Option<InventoryCache>,
    cached_wake: Option<i64>,
    pending_probe_pump: bool,
    last_restore_day: Option<i64>,
    cleaned_finals: BTreeSet<String>,
    source_wakes: BTreeSet<i64>,
    metadata_scanned_revision: Option<u64>,
    schedule_dirty: bool,
    schedule_promotes_discovery: bool,
}

impl Pipeline {
    pub fn open(path: impl AsRef<Path>, config_json: &str) -> Result<Self, String> {
        let config: PipelineConfig =
            serde_json::from_str(config_json).map_err(|error| error.to_string())?;
        if config.probe_concurrency < 1 {
            return Err("Invalid playback verification concurrency".into());
        }
        let store = store::Store::open(
            path,
            config.owner_token.as_deref(),
            config.reclaim_token.as_deref(),
        )?;
        Self::from_store(store, config)
    }

    pub fn with_store(store: store::Store, config_json: &str) -> Result<Self, String> {
        let config: PipelineConfig =
            serde_json::from_str(config_json).map_err(|error| error.to_string())?;
        if config.probe_concurrency < 1 {
            return Err("Invalid playback verification concurrency".into());
        }
        Self::from_store(store, config)
    }

    fn from_store(store: store::Store, config: PipelineConfig) -> Result<Self, String> {
        let now = config
            .now
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let restored_working = store.working_feeds()?;
        let restored_checks = store.feed_checks(now)?;
        let partition_times = store.partition_times()?;
        let mut pipeline = Self {
            config,
            store,
            games: Vec::new(),
            candidates: BTreeMap::new(),
            feeds: FeedBook::default(),
            sessions: SessionBook::default(),
            sources: SourceBook::default(),
            errors: BTreeMap::new(),
            revision: 0,
            schedule_ready: false,
            last_schedule: None,
            started: false,
            discovery_enabled: false,
            resolution_enabled: false,
            stopping: false,
            stopped: false,
            last_tick: 0,
            last_sweep: 0,
            next_job: 0,
            epoch: 0,
            wake_version: 0,
            jobs: BTreeMap::new(),
            refresh: None,
            queued_refresh: Vec::new(),
            stop_requests: Vec::new(),
            restored_working,
            restored_checks,
            refreshed_schedules: BTreeSet::new(),
            catalog_evidence: BTreeMap::new(),
            observation_deadlines: BTreeMap::new(),
            publication_deadlines: BTreeMap::new(),
            current_matcher: std::cell::RefCell::new(SourceEventMatcher::new(
                &[],
                MatchMode::Current,
            )),
            inventory_matcher: std::cell::RefCell::new(SourceEventMatcher::new(
                &[],
                MatchMode::InventoryLive,
            )),
            fixture_identities: BTreeMap::new(),
            fixture_persistable: BTreeMap::new(),
            metadata_pending: BTreeSet::new(),
            pending_commands: Vec::new(),
            partition_times,
            inventory_cache: None,
            cached_wake: None,
            pending_probe_pump: false,
            last_restore_day: domain::feed_calendar_day(now),
            cleaned_finals: BTreeSet::new(),
            source_wakes: BTreeSet::new(),
            metadata_scanned_revision: None,
            schedule_dirty: false,
            schedule_promotes_discovery: false,
        };
        pipeline.rebuild(now)?;
        Ok(pipeline)
    }

    pub fn step(&mut self, input: Input, at: i64) -> Result<Batch, String> {
        let mut batch = Batch::default();
        let flush_probes = matches!(&input, Input::Complete { token, .. } if matches!(self.jobs.get(token), Some(Job::FlushProbes)));
        let schedule_publication = matches!(&input, Input::Complete { token, .. } | Input::Progress { token, .. }
            if matches!(self.jobs.get(token), Some(Job::Schedule { .. })));
        let discovery_completion = matches!(&input, Input::Complete { token, .. }
            if matches!(self.jobs.get(token), Some(Job::Listing { .. } | Job::Detail { .. } | Job::Resolve { .. })));
        let plan_details_now = flush_probes
            || schedule_publication
            || match &input {
                Input::Complete { token, .. } => matches!(
                    self.jobs.get(token),
                    Some(
                        Job::Cancelled
                            | Job::Membership { .. }
                            | Job::Metadata { .. }
                            | Job::Listing { .. }
                            | Job::Detail { .. }
                            | Job::Resolve { .. }
                    )
                ),
                Input::Progress { .. } => false,
                _ => true,
            };
        let mut needs_planning = match &input {
            Input::Command { value, .. } => !matches!(
                value,
                Command::Board
                    | Command::Sources
                    | Command::RoomSources
                    | Command::FeedLink { .. }
                    | Command::CollectorPolling { .. }
                    | Command::Authorize { .. }
            ),
            Input::Progress { token, .. } => {
                matches!(self.jobs.get(token), Some(Job::Schedule { .. }))
            }
            _ => true,
        };
        let sessions_before = self.sessions.sessions.len();
        if !self.stopped && !self.stopping {
            let times = self.store.partition_times()?;
            if times != self.partition_times {
                self.partition_times = times;
                self.rebuild(at)?;
                needs_planning = true;
            }
            if self.cached_wake.is_some_and(|deadline| at >= deadline) {
                needs_planning = true;
            }
            if self.schedule_dirty
                && matches!(&input,Input::Complete {token,..}
                if matches!(self.jobs.get(token),Some(Job::Probe | Job::ProbeId | Job::Detail {..} | Job::Resolve {..})))
            {
                self.rebuild(at)?;
                needs_planning = true;
            }
        }
        match input {
            Input::Configure { sources } => {
                if !self.config.fixture_operations.contains("sources") {
                    return Err("Fixture sources are not configured.".into());
                }
                if json!(sources) != json!(self.config.sources) {
                    self.config.sources = sources;
                    self.sources.detail_waiting = None;
                    self.revision += 1;
                    self.discovery_enabled = true;
                    self.resolution_enabled = true;
                    self.inventory_cache = None;
                }
            }
            Input::Start => {
                if !self.started && !self.stopping && !self.stopped {
                    self.started = true;
                    self.last_tick = at;
                    self.refresh(None, false, at, &mut batch)?;
                }
            }
            Input::Refresh { request_id, force } => {
                self.refresh(Some(request_id), force, at, &mut batch)?
            }
            Input::Wake => {
                if !self.stopping && !self.stopped {
                    self.sweep(at, &mut batch)?;
                    if self.started && at - self.last_tick >= 15_000 {
                        self.last_tick = at;
                        self.refresh(None, false, at, &mut batch)?;
                    }
                }
            }
            Input::Command { request_id, value } => {
                if matches!(value, Command::Stop) {
                    self.stop_requests.push(request_id);
                    self.begin_stop(&mut batch)?;
                } else if self.stopping || self.stopped {
                    Self::reply(&mut batch, request_id, error(503, "Pipeline is stopped."));
                } else {
                    if self.schedule_dirty {
                        self.rebuild(at)?;
                        needs_planning = true;
                    }
                    if needs_planning || domain::feed_calendar_day(at) != self.last_restore_day {
                        self.sweep(at, &mut batch)?;
                    }
                    self.plan_metadata(&mut batch)?;
                    if self.metadata_pending.is_empty() {
                        self.command(request_id, value, at, &mut batch)?;
                    } else {
                        self.pending_commands.push((request_id, value));
                    }
                }
            }
            Input::Progress { token, value } => self.progress(token, value, at, &mut batch)?,
            Input::Complete { token, result } => self.complete(token, result, at, &mut batch)?,
        }
        needs_planning |= sessions_before != self.sessions.sessions.len();
        if !self.stopping && !self.stopped && needs_planning {
            self.plan_metadata(&mut batch)?;
            if self.metadata_pending.is_empty() {
                for (request, command) in std::mem::take(&mut self.pending_commands) {
                    self.command(request, command, at, &mut batch)?;
                }
            }
            if !self.schedule_dirty {
                self.plan_sources(at, false, &mut batch)?;
            }
            if plan_details_now && !self.schedule_dirty {
                if flush_probes
                    && self.sources.details.is_empty()
                    && self.sources.detail_admissions >= 80
                {
                    self.sources.detail_admissions = 0;
                }
                self.plan_details(at, &mut batch)?;
            }
            let schedule_launched = batch
                .launch
                .iter()
                .any(|effect| matches!(effect, Effect::Schedule { .. }));
            if self.metadata_pending.is_empty() && !schedule_launched {
                let maintenance_ready = !self.feeds.terminal.is_empty()
                    || !self.feeds.deferred.is_empty()
                    || !self.feeds.forced.is_empty();
                if !self.schedule_dirty
                    && (flush_probes
                        || (schedule_publication
                            && !self.sources.projection_dirty
                            && maintenance_ready))
                {
                    self.plan_probes(at, &mut batch)?;
                    self.pump_probes(at, &mut batch)?;
                } else if (discovery_completion
                    || self.schedule_dirty
                    || self.candidates.values().any(|rows| !rows.is_empty())
                    || self.sources.projection_dirty)
                    && !self
                        .jobs
                        .values()
                        .any(|job| matches!(job, Job::FlushProbes))
                {
                    let token = self.token(0);
                    self.jobs.insert(token, Job::FlushProbes);
                    batch.launch.push(Effect::FlushProbes { token });
                }
            }
        }
        let invalidated: Vec<_> = self
            .feeds
            .active
            .iter()
            .filter(|(_, job)| {
                job.revision != self.feeds.revision(&job.key)
                    || !self.schedule_dirty && !self.current_probe(job, at)
            })
            .map(|(token, _)| *token)
            .collect();
        for token in invalidated {
            self.feeds.active.remove(&token);
            if !batch.cancel.contains(&token) {
                batch.cancel.push(token);
            }
            self.revision += 1;
        }
        if !self.schedule_dirty && !self.stopping {
            let stale_details: Vec<_> = self
                .sources
                .details
                .iter()
                .filter(|(token, (observation, _))| {
                    if matches!(self.jobs.get(token), Some(Job::Cancelled)) {
                        return false;
                    }
                    let result = self.match_observation(observation, at, true);
                    !matching::detail_candidate_game_ids(&result)
                        .iter()
                        .any(|id| {
                            self.games
                                .iter()
                                .any(|game| game.id == *id && self.feed_game(game, at))
                        })
                })
                .map(|(token, _)| *token)
                .collect();
            for token in stale_details {
                self.jobs.insert(token, Job::Cancelled);
                batch.cancel.push(token);
                self.revision += 1;
            }
        }
        self.finish_stop(&mut batch)?;
        self.wake_version += 1;
        if needs_planning || self.stopping || self.stopped {
            self.cached_wake = self.next_wake(at);
        }
        batch.wake = self.cached_wake.map(|at| Wake {
            at,
            version: self.wake_version,
        });
        Ok(batch)
    }

    fn reply(batch: &mut Batch, request_id: u64, value: Reply) {
        batch.replies.push(CompletedRequest {
            request_id,
            value: CompletedReply::Owned(value),
        });
    }
    fn token(&mut self, revision: u64) -> Token {
        self.next_job += 1;
        Token {
            id: self.next_job,
            epoch: self.epoch,
            health_revision: revision,
        }
    }
    fn refresh(
        &mut self,
        request: Option<u64>,
        force: bool,
        at: i64,
        batch: &mut Batch,
    ) -> Result<(), String> {
        if self.stopping || self.stopped {
            if let Some(request) = request {
                Self::reply(batch, request, json!({"kind":"ok"}));
            }
            return Ok(());
        }
        if let Some(refresh) = &mut self.refresh {
            if force {
                if let Some(request) = request {
                    self.queued_refresh.push(request);
                } else if self.queued_refresh.is_empty() {
                    self.queued_refresh.push(0);
                }
            } else if let Some(request) = request {
                refresh.requests.push(request);
            }
            return Ok(());
        }
        if !force && self.last_schedule.is_some_and(|last| at - last < 30_000) {
            if self.sources.details.is_empty() {
                self.sources.detail_admissions = 0;
            }
            if let Some(request) = request {
                Self::reply(batch, request, json!({"kind":"ok"}));
            }
            return Ok(());
        }
        self.last_schedule = Some(at);
        self.schedule_promotes_discovery = false;
        self.sources.detail_waiting = None;
        self.discovery_enabled = false;
        self.resolution_enabled = true;
        self.sources.detail_admissions = 0;
        self.reserve_listing_hosts(at, force)?;
        let previous_coverage = self.refreshed_schedules.clone();
        let mut pending = BTreeSet::new();
        for source in self.config.schedules.clone() {
            let token = self.token(0);
            pending.insert(token);
            self.jobs.insert(
                token,
                Job::Schedule {
                    source: source.clone(),
                },
            );
            self.refreshed_schedules
                .remove(source["id"].as_str().unwrap_or_default());
            batch.launch.push(Effect::Schedule { token, source, at });
        }
        self.refresh = Some(RefreshPass {
            requests: request.into_iter().collect(),
            pending,
            membership_started: false,
            previous_coverage,
            force,
        });
        if self.config.sources.iter().any(|source| {
            !matches!(
                source.kind,
                Some(crate::types::SourceKind::BrowserCatalog | crate::types::SourceKind::Pending)
            )
        }) && !self
            .jobs
            .values()
            .any(|job| matches!(job, Job::DeferredDiscovery { .. }))
        {
            let token = self.token(0);
            self.jobs.insert(
                token,
                Job::DeferredDiscovery {
                    remaining: 1,
                    explicit: force,
                },
            );
            batch.launch.push(Effect::FlushProbes { token });
        }
        self.advance_refresh(at, batch)
    }

    fn advance_refresh(&mut self, at: i64, batch: &mut Batch) -> Result<(), String> {
        if self
            .refresh
            .as_ref()
            .is_none_or(|refresh| !refresh.pending.is_empty())
        {
            return Ok(());
        }
        if self.schedule_dirty {
            self.rebuild(at)?;
        }
        self.discovery_enabled = true;
        let force = self.refresh.as_ref().expect("refresh exists").force;
        self.plan_sources(at, force, batch)?;
        if !self
            .refresh
            .as_ref()
            .expect("refresh exists")
            .membership_started
        {
            self.refresh
                .as_mut()
                .expect("refresh exists")
                .membership_started = true;
            self.schedule_ready = true;
            let seasons: BTreeSet<_> = self
                .games
                .iter()
                .filter(|game| game.league == League::Ncaaf)
                .filter_map(|game| game.season.map(|season| season as i64))
                .collect();
            for season in seasons {
                let cached = self.store.membership(season)?;
                if cached.is_some_and(|cached| {
                    at - cached.at < 24 * 3_600_000
                        && (!self
                            .config
                            .schedules
                            .iter()
                            .any(|source| source["id"] == "d2-d3")
                            || cached
                                .teams
                                .values()
                                .any(|subdivision| *subdivision == Subdivision::D2D3))
                }) {
                    continue;
                }
                let token = self.token(0);
                self.jobs.insert(token, Job::Membership { season });
                self.refresh
                    .as_mut()
                    .expect("refresh exists")
                    .pending
                    .insert(token);
                batch.launch.push(Effect::Membership { token, season });
            }
            if self
                .refresh
                .as_ref()
                .is_some_and(|refresh| !refresh.pending.is_empty())
            {
                return Ok(());
            }
        }
        let finished = self.refresh.take().expect("refresh exists");
        self.revision += 1;
        for request in finished.requests {
            Self::reply(batch, request, json!({"kind":"ok"}));
        }
        if !self.queued_refresh.is_empty() {
            let requests = std::mem::take(&mut self.queued_refresh);
            self.refresh(None, true, at, batch)?;
            if let Some(refresh) = &mut self.refresh {
                refresh
                    .requests
                    .extend(requests.into_iter().filter(|request| *request != 0));
            } else {
                for request in requests.into_iter().filter(|request| *request != 0) {
                    Self::reply(batch, request, json!({"kind":"ok"}));
                }
            }
        }
        Ok(())
    }

    fn progress(
        &mut self,
        token: Token,
        value: Value,
        at: i64,
        batch: &mut Batch,
    ) -> Result<(), String> {
        if self.stopping || self.stopped {
            return Ok(());
        }
        if let Some(Job::Schedule { source }) = self.jobs.get(&token) {
            let source = source.clone();
            self.accept_schedule(&source, value, false, at, batch)?;
        } else if let Some(job) = self.feeds.active.get_mut(&token) {
            if job.revision == token.health_revision {
                let active = value["kind"] == "active";
                if active && self.feeds.protected_background.as_deref() == Some(job.key.as_str()) {
                    self.feeds.protected_background = None;
                }
                if active != job.active_phase {
                    job.active_phase = active;
                    job.phase_at = at;
                    self.revision += 1;
                }
            }
        }
        Ok(())
    }

    fn complete(
        &mut self,
        token: Token,
        result: Value,
        at: i64,
        batch: &mut Batch,
    ) -> Result<(), String> {
        let Some(job) = self.jobs.remove(&token) else {
            return Ok(());
        };
        if self.stopping {
            self.sources.listings.remove(&token);
            self.sources.details.remove(&token);
            self.feeds.active.remove(&token);
            return Ok(());
        }
        match job {
            Job::Schedule { source } => {
                let id = source["id"].as_str().unwrap_or_default();
                if let Some(message) = sources::error_message(&result) {
                    self.errors.insert(id.into(), redact_error(&message));
                    self.refreshed_schedules.remove(id);
                    self.rebuild(at)?;
                } else {
                    self.accept_schedule(&source, result, true, at, batch)?;
                }
                if let Some(refresh) = &mut self.refresh {
                    refresh.pending.remove(&token);
                }
                self.advance_refresh(at, batch)?;
            }
            Job::Membership { season } => {
                if let Some(message) = sources::error_message(&result) {
                    self.errors
                        .insert(format!("membership-{season}"), redact_error(&message));
                } else {
                    let membership: SeasonMembership =
                        serde_json::from_value(result).map_err(|error| error.to_string())?;
                    self.store.save_membership(&membership)?;
                    self.errors.remove(&format!("membership-{season}"));
                    self.rebuild(at)?;
                }
                if let Some(refresh) = &mut self.refresh {
                    refresh.pending.remove(&token);
                }
                self.advance_refresh(at, batch)?;
            }
            Job::Listing { source } => {
                self.sources.listings.remove(&token);
                self.accept_listing(source, result, at)?;
            }
            Job::Detail {
                observation,
                game_id,
            } => {
                self.sources.details.remove(&token);
                if sources::error_message(&result).is_some() {
                    self.accept_detail(observation, game_id, result, at)?;
                } else {
                    let enriched: Observation =
                        serde_json::from_value(result["observation"].clone())
                            .map_err(|error| error.to_string())?;
                    let matched = self.match_observation(&enriched, at, false);
                    let fresh_games: Vec<_> = self
                        .games
                        .iter()
                        .filter(|game| self.feed_game(game, at))
                        .cloned()
                        .collect();
                    let accepted = matched
                        .game_id()
                        .and_then(|id| {
                            self.games
                                .iter()
                                .find(|game| game.id == id && self.feed_game(game, at))
                        })
                        .map(|game| game.id.clone())
                        .or_else(|| {
                            domain::provisional_live_channel(&enriched, &matched, &fresh_games, at)
                                .map(|game| game.id.clone())
                        })
                        .or_else(|| {
                            self.live_rollover_game(&enriched, at)
                                .map(|game| game.id.clone())
                        });
                    if let Some(game_id) = accepted {
                        let next = self.token(0);
                        self.jobs.insert(
                            next,
                            Job::Resolve {
                                original: observation,
                                observation: enriched.clone(),
                                game_id: game_id.clone(),
                            },
                        );
                        self.sources
                            .details
                            .insert(next, (enriched.clone(), game_id.clone()));
                        batch.launch.push(Effect::Resolve {
                            token: next,
                            game_id,
                            observation: json!(enriched),
                            body: result["body"].as_str().unwrap_or_default().into(),
                            at,
                        });
                    } else {
                        self.accept_detail(observation,game_id,json!({"observation":enriched,"players":[],"reason":"conflicting-game"}),at)?;
                    }
                }
            }
            Job::Resolve {
                original,
                observation,
                game_id,
            } => {
                self.sources.details.remove(&token);
                let mut result = result;
                self.ingest_metadata(&result)?;
                if result.is_object() {
                    result["observation"] = json!(observation);
                }
                self.accept_detail(original, game_id, result, at)?;
            }
            Job::OpenId { request, command } => {
                if let Some(id) = result.as_str() {
                    self.open_command(request, command, Some(id.into()), at, batch)?;
                } else {
                    Self::reply(
                        batch,
                        request,
                        error(503, "Playback session could not be created."),
                    );
                }
            }
            Job::ProbeId => {
                if let Some(id) = result.as_str() {
                    self.launch_probe(token, id.into(), at, batch)?;
                } else {
                    self.feeds.active.remove(&token);
                }
            }
            Job::Probe => {
                if let Some(job) = self.feeds.active.remove(&token) {
                    if self.current_probe(&job, at) {
                        let result = if sources::error_message(&result).is_some() {
                            MediaCheckResult::Deferred {
                                retry_after_ms: 300_000,
                                reason: None,
                                phase: None,
                                timings: None,
                            }
                        } else {
                            serde_json::from_value(result).map_err(|error| error.to_string())?
                        };
                        if matches!(&result,MediaCheckResult::Playable{proof,..}if !proof.valid()) {
                            return Err("Invalid advancing video proof".into());
                        }
                        let rediscover = matches!(&result,MediaCheckResult::Unavailable {reason,..}
                            if *reason == MediaFailureReason::Playback || matches!(self.feeds.terminal.get(&job.key),Some(Terminal {outcome:TerminalOutcome::Playable {..},..})));
                        let persisted = self.feeds.accept(&job, result, at);
                        if rediscover {
                            self.rediscover_game(
                                &job.candidate.game_id,
                                &job.candidate.source_ids,
                                at,
                            )?;
                        }
                        if let Some(outcome) = persisted {
                            self.save_check(&job.candidate, &job.owner, outcome)?;
                        } else if self.feeds.playable(&job.key, at) {
                            self.persist_working(&job.candidate, at)?;
                        }
                        self.revision += 1;
                        self.pending_probe_pump = true;
                    }
                }
            }
            Job::Metadata { locators } => {
                self.metadata_scanned_revision = None;
                self.ingest_metadata(&result)?;
                for locator in locators {
                    self.metadata_pending.remove(&locator);
                    if self.config.fixture_operations.contains("probeIdentity")
                        && !self.fixture_identities.contains_key(&locator)
                    {
                        return Err("Missing fixture probe identity".into());
                    }
                    if self
                        .config
                        .fixture_operations
                        .contains("persistableLocator")
                        && !self.fixture_persistable.contains_key(&locator)
                    {
                        return Err("Missing fixture locator persistence result".into());
                    }
                }
                self.project_candidates(at)?;
                self.restore(at)?;
            }
            Job::CloseSchedule => {}
            Job::Cancelled => {
                self.sources.details.remove(&token);
            }
            Job::FlushProbes => {
                if self.schedule_dirty {
                    self.rebuild(at)?;
                } else if self.sources.projection_dirty {
                    self.project_candidates(at)?;
                    self.metadata_scanned_revision = None;
                }
                if self.pending_probe_pump {
                    self.pending_probe_pump = false;
                    self.pump_probes(at, batch)?;
                }
            }
            Job::DeferredDiscovery {
                remaining,
                explicit,
            } => {
                if remaining > 0 {
                    let token = self.token(0);
                    self.jobs.insert(
                        token,
                        Job::DeferredDiscovery {
                            remaining: remaining - 1,
                            explicit,
                        },
                    );
                    batch.launch.push(Effect::FlushProbes { token });
                } else {
                    self.discovery_enabled = true;
                    self.plan_sources(at, explicit, batch)?;
                }
            }
        }
        Ok(())
    }

    fn accept_schedule(
        &mut self,
        source: &Value,
        result: Value,
        settled: bool,
        at: i64,
        batch: &mut Batch,
    ) -> Result<(), String> {
        let id = source["id"].as_str().ok_or("Schedule source requires id")?;
        let previous = self.store.partition(id)?;
        let was_fresh = !self.errors.contains_key(id)
            && previous
                .as_ref()
                .is_some_and(|partition| at - partition.at <= 90_000);
        let covered_before = self.refresh.as_ref().map_or_else(
            || self.refreshed_schedules.contains(id),
            |refresh| refresh.previous_coverage.contains(id),
        );
        let mut partition: Partition =
            serde_json::from_value(result.clone()).map_err(|error| error.to_string())?;
        partition.at = at;
        if !result["history"].is_null() {
            if let Some(previous) = previous.as_ref() {
                let history_day = chrono::DateTime::from_timestamp_millis(
                    self.last_schedule.unwrap_or(at) - 86_400_000,
                )
                .map(|date| date.format("%Y-%m-%d").to_string())
                .unwrap_or_default();
                let mut retained: Vec<_> = previous
                    .games
                    .iter()
                    .cloned()
                    .filter(|game| {
                        game.date
                            .as_ref()
                            .is_some_and(|date| date.starts_with(&history_day))
                            || game.lifecycle == GameLifecycle::Live
                                && domain::feed_eligible(game, at)
                    })
                    .collect();
                for game in partition.games {
                    if let Some(index) = retained.iter().position(|prior| prior.id == game.id) {
                        retained[index] = game;
                    } else {
                        retained.push(game);
                    }
                }
                partition.games = retained;
            }
        }
        self.store.save_partition(id, &partition)?;
        let partition = self
            .store
            .partition(id)?
            .ok_or("Saved schedule partition is missing")?;
        self.errors.remove(id);
        if result["history"].is_null() {
            self.errors.remove(&format!("{id}-history"));
        } else {
            self.refreshed_schedules.remove(id);
            if result["history"]["kind"] == "failed" {
                self.errors.insert(
                    format!("{id}-history"),
                    format!(
                        "{}:{}",
                        result["history"]["day"].as_str().unwrap_or_default(),
                        result["history"]["reason"].as_str().unwrap_or_default()
                    )
                    .chars()
                    .take(120)
                    .collect(),
                );
            }
        }
        if settled {
            if result["history"].is_null()
                && result["horizonErrors"].as_array().is_none_or(Vec::is_empty)
            {
                self.refreshed_schedules.insert(id.into());
            } else {
                self.refreshed_schedules.remove(id);
            }
            if let Some(errors) = result["horizonErrors"]
                .as_array()
                .filter(|errors| !errors.is_empty())
            {
                self.errors.insert(
                    format!("{id}-horizon"),
                    errors
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("; ")
                        .chars()
                        .take(240)
                        .collect(),
                );
            } else {
                self.errors.remove(&format!("{id}-horizon"));
            }
        }
        let changed = previous.as_ref().is_none_or(|previous| {
            previous.games != partition.games
                || domain::feed_calendar_day(previous.at) != domain::feed_calendar_day(at)
        });
        self.schedule_promotes_discovery |= previous
            .as_ref()
            .map_or(!partition.games.is_empty(), |previous| {
                previous.games != partition.games
            });
        let coverage_settled = settled || result["history"]["kind"] == "failed";
        let covered_after = self.refreshed_schedules.contains(id);
        if changed || !was_fresh || coverage_settled && covered_before != covered_after {
            self.schedule_dirty = true;
        }
        if coverage_settled {
            if let Some(refresh) = &mut self.refresh {
                if covered_after {
                    refresh.previous_coverage.insert(id.into());
                } else {
                    refresh.previous_coverage.remove(id);
                }
            }
        }
        self.partition_times.insert(id.to_owned(), at);
        self.revision += 1;
        if !self.schedule_dirty {
            self.discovery_enabled = true;
            let force = self.refresh.as_ref().is_some_and(|refresh| refresh.force);
            self.plan_sources(at, force, batch)?;
        }
        Ok(())
    }

    fn match_observation(&self, observation: &Observation, at: i64, inventory: bool) -> Match {
        let mut matcher = if inventory {
            self.inventory_matcher.borrow_mut()
        } else {
            self.current_matcher.borrow_mut()
        };
        let fallback = matching::listing_event_evidence(&observation.source_id);
        let evidence = self
            .catalog_evidence
            .get(&observation.id)
            .unwrap_or(&fallback);
        let decision = matcher.match_event(
            observation,
            evidence,
            at,
            self.observation_deadlines.get(&observation.id).copied(),
        );
        decision.match_result().clone()
    }

    fn rebuild(&mut self, at: i64) -> Result<(), String> {
        self.schedule_dirty = false;
        self.metadata_scanned_revision = None;
        let previous_games = self.games.clone();
        self.partition_times = self.store.partition_times()?;
        let mut partitions = Vec::new();
        for source in &self.config.schedules {
            if let Some(id) = source["id"].as_str() {
                if let Some(partition) = self.store.partition(id)? {
                    partitions.push((
                        !self.errors.contains_key(id) && at - partition.at <= 90_000,
                        partition,
                    ));
                }
            }
        }
        partitions.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.at.cmp(&a.1.at)));
        self.games = matching::merge_schedule_partitions(
            &partitions
                .into_iter()
                .map(|(_, partition)| partition.games)
                .collect::<Vec<_>>(),
        );
        let finals = self.store.finals()?;
        for game in &mut self.games {
            if let Some(final_game) = finals.iter().find(|row| row.id == game.id) {
                let partitions = game.partitions.clone();
                *game = final_game.clone();
                game.partitions = partitions;
            }
        }
        for game in finals {
            if game.grace_ends_at.is_some_and(|deadline| at < deadline)
                && !self.games.iter().any(|row| row.id == game.id)
            {
                self.games.push(game);
            }
        }
        let mut memberships = BTreeMap::new();
        for game in &mut self.games {
            if game.league == League::Ncaaf {
                if let Some(season) = game.season {
                    if let std::collections::btree_map::Entry::Vacant(entry) =
                        memberships.entry(season as i64)
                    {
                        entry.insert(self.store.membership(season as i64)?);
                    }
                    if let Some(membership) =
                        memberships.get(&(season as i64)).and_then(Option::as_ref)
                    {
                        if let GameKind::Matchup { home, away, .. } = &mut game.kind {
                            for team in [home, away] {
                                if let Some(subdivision) = team.id.as_deref().and_then(|id| {
                                    membership.teams.get(id.trim_start_matches("espn:ncaaf:"))
                                }) {
                                    team.membership = Some(TeamMembership {
                                        subdivision: *subdivision,
                                        season: membership.season,
                                        observed_at: membership.at,
                                        source: "espn-core".into(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        self.current_matcher
            .replace(SourceEventMatcher::new(&self.games, MatchMode::Current));
        self.inventory_matcher.replace(SourceEventMatcher::new(
            &self.games,
            MatchMode::InventoryLive,
        ));
        if previous_games != self.games {
            self.sources.detail_waiting = None;
        }
        let retired: Vec<_> = self
            .feeds
            .terminal
            .iter()
            .filter(|(key, terminal)| {
                self.games
                    .iter()
                    .find(|game| key.starts_with(&format!("[\"{}\",", game.id)))
                    .is_some_and(|game| {
                        self.feed_game(game, at)
                            && !domain::feed_owner_matches(&terminal.owner, &game.id, game)
                    })
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in retired {
            self.feeds.terminal.remove(&key);
            self.feeds.invalidate(&key);
            self.feeds.decoded.remove(&key);
            let hash = hex::encode(Sha256::digest(key.as_bytes()));
            if let Ok(parts) = serde_json::from_str::<Vec<String>>(&key) {
                if let Some(game_id) = parts.first() {
                    self.store.remove_feed_check(game_id, &hash)?;
                    self.store.replace_working_identity(game_id, &hash, &[])?;
                    self.restored_working.retain(|feed| {
                        feed.candidate.game_id != *game_id || feed.identity_hash != hash
                    });
                }
            }
        }
        self.project_candidates(at)?;
        self.restore(at)?;
        for observation in self.store.observations()? {
            self.store.observe(
                &observation,
                &self.match_observation(&observation, at, false),
            )?;
        }
        self.revision += 1;
        self.last_restore_day = domain::feed_calendar_day(at);
        if self.schedule_promotes_discovery {
            self.discovery_enabled = true;
            self.schedule_promotes_discovery = false;
        }
        Ok(())
    }

    fn schedule_fresh(&self, game: &Game, at: i64) -> bool {
        let keys = game
            .partitions
            .clone()
            .filter(|keys| !keys.is_empty())
            .unwrap_or_else(|| {
                self.config
                    .schedules
                    .iter()
                    .filter(|source| source["league"] == json!(game.league))
                    .filter_map(|source| source["id"].as_str().map(str::to_owned))
                    .collect()
            });
        keys.iter().any(|key| {
            !self.errors.contains_key(key)
                && self
                    .partition_times
                    .get(key)
                    .is_some_and(|checked| at - *checked <= 90_000)
        })
    }
    fn feed_game(&self, game: &Game, at: i64) -> bool {
        self.schedule_fresh(game, at)
            && (domain::feed_eligible(game, at) || domain::combat_listing_feed_eligible(game, at))
    }
    fn owner(&self, game: &Game) -> FeedOwner {
        domain::working_feed_owner(game, game.partitions.as_deref().unwrap_or(&[]))
    }
    pub fn key(&self, candidate: &Candidate) -> String {
        let wire = json!(candidate.locator).to_string();
        let identity = self
            .fixture_identities
            .get(&wire)
            .cloned()
            .unwrap_or_else(|| domain::provider_probe_identity(&candidate.locator));
        json!([candidate.game_id, identity]).to_string()
    }
    fn persistable(&self, locator: &CandidateLocator) -> bool {
        self.fixture_persistable
            .get(&json!(locator).to_string())
            .copied()
            .unwrap_or_else(|| {
                !self
                    .config
                    .fixture_operations
                    .contains("persistableLocator")
                    && domain::persistable_locator(locator)
            })
    }
    fn metadata_needed(&self, locator: &CandidateLocator) -> bool {
        let wire = json!(locator).to_string();
        self.config.fixture_operations.contains("probeIdentity")
            && !self.fixture_identities.contains_key(&wire)
            || self
                .config
                .fixture_operations
                .contains("persistableLocator")
                && !self.fixture_persistable.contains_key(&wire)
    }
    fn plan_metadata(&mut self, batch: &mut Batch) -> Result<(), String> {
        if !self.config.fixture_operations.contains("probeIdentity")
            && !self
                .config
                .fixture_operations
                .contains("persistableLocator")
        {
            return Ok(());
        }
        if self.metadata_scanned_revision == Some(self.revision) {
            return Ok(());
        }
        self.metadata_scanned_revision = Some(self.revision);
        let mut locators: BTreeMap<String, CandidateLocator> = BTreeMap::new();
        for candidate in self
            .candidates
            .values()
            .flatten()
            .chain(self.restored_working.iter().map(|feed| &feed.candidate))
        {
            let wire = json!(candidate.locator).to_string();
            if self.metadata_needed(&candidate.locator) && !self.metadata_pending.contains(&wire) {
                locators.insert(wire, candidate.locator.clone());
            }
        }
        let values: Vec<_> = locators.into_iter().take(256).collect();
        if values.is_empty() {
            return Ok(());
        }
        let token = self.token(0);
        let keys = values
            .iter()
            .map(|(wire, _)| wire.clone())
            .collect::<Vec<_>>();
        self.metadata_pending.extend(keys.iter().cloned());
        self.jobs.insert(token, Job::Metadata { locators: keys });
        batch.launch.push(Effect::Metadata {
            token,
            locators: values
                .into_iter()
                .map(|(_, locator)| json!(locator))
                .collect(),
        });
        Ok(())
    }
    fn ingest_metadata(&mut self, result: &Value) -> Result<(), String> {
        for (wire, identity) in result["identities"]
            .as_object()
            .into_iter()
            .flat_map(|values| values.iter())
        {
            let locator: CandidateLocator =
                serde_json::from_str(wire).map_err(|error| error.to_string())?;
            let identity = identity.as_str().ok_or("Invalid fixture probe identity")?;
            self.fixture_identities
                .insert(json!(locator).to_string(), identity.into());
        }
        for (wire, persistable) in result["persistable"]
            .as_object()
            .into_iter()
            .flat_map(|values| values.iter())
        {
            let locator: CandidateLocator =
                serde_json::from_str(wire).map_err(|error| error.to_string())?;
            let persistable = persistable
                .as_bool()
                .ok_or("Invalid fixture persistence result")?;
            self.fixture_persistable
                .insert(json!(locator).to_string(), persistable);
        }
        Ok(())
    }
    fn hash(&self, candidate: &Candidate) -> String {
        hex::encode(Sha256::digest(self.key(candidate).as_bytes()))
    }
    fn current_candidate(&self, candidate: &Candidate, at: i64) -> bool {
        let Some(game) = self.games.iter().find(|game| game.id == candidate.game_id) else {
            return false;
        };
        if game.grace_ends_at.is_some_and(|deadline| at >= deadline)
            || candidate.observed_at > at + 60_000
        {
            return false;
        }
        if locator_game(&candidate.locator).is_some_and(|id| id != game.id) {
            return false;
        }
        let key = self.key(candidate);
        let retained=self.feeds.terminal.get(&key).is_some_and(|terminal|matches!(terminal.outcome,TerminalOutcome::Playable{checked_at,..}if checked_at<=at+60_000)&&domain::feed_owner_matches(&terminal.owner,&candidate.game_id,game));
        if at - candidate.observed_at > sources::ACTIVE_DISCOVERY_MS
            && !candidate.source_ids.iter().any(|source| {
                self.publication_deadlines
                    .get(&format!("{source}:{key}"))
                    .is_some_and(|deadline| *deadline >= at)
            })
            && !retained
            && !self.restored_working.iter().any(|feed| {
                feed.candidate.game_id == candidate.game_id
                    && feed.candidate.id == candidate.id
                    && feed.identity_hash == self.hash(candidate)
                    && domain::working_feed_matches(feed, game)
                    && (self.feed_game(game, at) || domain::cached_feed_eligible(feed, game, at))
            })
        {
            return false;
        }
        candidate
            .source_ids
            .iter()
            .any(|id| self.config.sources.iter().any(|source| source.id == *id))
            && domain::feed_owner_matches(&self.owner(game), &candidate.game_id, game)
    }

    fn retained_playable(&self, candidate: &Candidate, at: i64) -> bool {
        let key = self.key(candidate);
        let Some(Terminal {
            owner,
            outcome: TerminalOutcome::Playable {
                checked_at, proof, ..
            },
        }) = self.feeds.terminal.get(&key)
        else {
            return false;
        };
        let Some(game) = self.games.iter().find(|game| game.id == candidate.game_id) else {
            return false;
        };
        let feed = WorkingFeed {
            version: 2,
            identity_hash: String::new(),
            candidate: candidate.clone(),
            owner: owner.clone(),
            checked_at: *checked_at,
            proof: WorkingProof::Advancing(proof.clone()),
        };
        candidate.observed_at <= at + 60_000
            && *checked_at <= at + 60_000
            && domain::feed_owner_matches(owner, &candidate.game_id, game)
            && (self.feed_game(game, at) || domain::cached_feed_eligible(&feed, game, at))
    }
    fn retained_candidate(&self, candidate: &Candidate, at: i64) -> bool {
        if self.retained_playable(candidate, at) {
            return true;
        }
        let Some(game) = self.games.iter().find(|game| game.id == candidate.game_id) else {
            return false;
        };
        self.restored_working.iter().any(|feed| {
            feed.candidate.game_id == candidate.game_id
                && feed.candidate.id == candidate.id
                && feed.identity_hash == self.hash(candidate)
                && domain::working_feed_matches(feed, game)
                && (self.feed_game(game, at) || domain::cached_feed_eligible(feed, game, at))
        })
    }
    fn current_probe(&self, job: &feeds::ProbeJob, at: i64) -> bool {
        let awaiting_schedule = self
            .jobs
            .values()
            .any(|job| matches!(job, Job::Schedule { .. }));
        job.revision == self.feeds.revision(&job.key)
            && self
                .games
                .iter()
                .find(|game| game.id == job.candidate.game_id)
                .is_some_and(|game| {
                    (self.feed_game(game, at)
                        || (awaiting_schedule && domain::feed_inventory_eligible(game, at)))
                        && domain::feed_owner_matches(&job.owner, &job.candidate.game_id, game)
                })
            && self
                .candidates
                .get(&job.candidate.game_id)
                .is_some_and(|rows| {
                    rows.iter().any(|candidate| {
                        candidate.id == job.candidate.id
                            && self.key(candidate) == job.key
                            && (self.current_candidate(candidate, at)
                                || (awaiting_schedule
                                    && candidate.source_ids.iter().any(|id| {
                                        self.config.sources.iter().any(|source| source.id == *id)
                                    })))
                    })
                })
    }

    fn project_browser_candidates(
        &mut self,
        kind: &str,
        details: &[DetailEvidence],
        at: i64,
        projected: &mut BTreeMap<String, Vec<Candidate>>,
    ) -> Result<(), String> {
        let history = self.store.catalog(kind)?;
        let current = &history["current"]["catalog"];
        let current_urls: BTreeSet<_> = catalog::rows(&current["events"])
            .iter()
            .map(|event| catalog::text(&event["url"]))
            .collect();
        let bindings = self.store.source_event_bindings()?;
        let current_view = if history["current"].is_null() {
            Value::Null
        } else {
            catalog::catalog_view(kind, &history["current"], &self.games, at, &bindings)?
        };
        let keys = if current["state"]["kind"] == "complete" {
            vec!["current"]
        } else if kind == "sportsurge-v2" {
            vec!["current", "previous", "lastComplete"]
        } else {
            vec!["lastComplete", "current"]
        };
        let mut replaced = BTreeSet::new();
        let mut matcher = SourceEventMatcher::new(
            &self.games,
            if kind == "sportsurge-v2" {
                MatchMode::InventoryLive
            } else {
                MatchMode::Current
            },
        );
        for key in keys {
            let catalog = &history[key]["catalog"];
            for event in catalog::rows(&catalog["events"]) {
                let url = catalog::text(&event["url"]);
                if replaced.contains(url)
                    || kind == "streameast" && key != "current" && current_urls.contains(url)
                {
                    continue;
                }
                let league = catalog::text(&event["league"]);
                let category = &catalog["categories"][league];
                if category["kind"] != "collected" {
                    continue;
                }
                let observation =
                    catalog::event_observation(kind, event, catalog::number(&category["at"]))?;
                let evidence = serde_json::from_value(catalog::event_evidence(kind, event, at))
                    .map_err(|error| error.to_string())?;
                let decision = matcher.match_event(
                    &observation,
                    &evidence,
                    at,
                    self.observation_deadlines.get(&observation.id).copied(),
                );
                let assigned = decision
                    .match_result()
                    .game_id()
                    .map(str::to_owned)
                    .or_else(|| {
                        details
                            .iter()
                            .find(|detail| detail.observation_id == observation.id)
                            .and_then(|detail| detail.last_success.as_ref())
                            .and_then(|success| success.publication.as_ref())
                            .map(|publication| publication.event.game_id.clone())
                    });
                let Some(game) = assigned.as_ref().and_then(|id| {
                    self.games
                        .iter()
                        .find(|game| game.id == *id && self.feed_game(game, at))
                }) else {
                    continue;
                };
                if catalog::rows(&current_view["games"]).iter().any(|row| {
                    row["id"] == event["id"]
                        && row["url"] == event["url"]
                        && row["gameId"].is_string()
                        && row["gameId"] != json!(game.id)
                }) {
                    continue;
                }
                let detail = details
                    .iter()
                    .find(|detail| detail.observation_id == observation.id);
                let handoff =
                    key == "current" || current["categories"][league]["kind"] == "pending";
                let detail_at = catalog::number(&event["detail"]["at"]);
                let fresh = event["detail"]["kind"] == "collected"
                    && (kind != "sportsurge-v2"
                        || event["detail"]["retainedFromRunId"].is_string()
                        || detail_at >= catalog::number(&category["at"]))
                    && if handoff || kind == "sportsurge-v2" {
                        domain::browser_evidence_fresh(detail, detail_at, at)
                    } else {
                        at - detail_at < sources::ACTIVE_DISCOVERY_MS
                    };
                let mut candidates = if fresh {
                    catalog::event_candidates(kind, event, &game.id)?
                } else {
                    Vec::new()
                };
                let mut deadline =
                    detail.map_or(detail_at + sources::ACTIVE_DISCOVERY_MS, |detail| {
                        detail.next_eligible_at
                    }) + if handoff || kind == "sportsurge-v2" {
                        domain::COLLECTION_SETTLE_MS
                    } else {
                        0
                    };
                if key == "current" && !fresh {
                    let retained = catalog_plan::retained_publication(
                        event,
                        observation.observed_at,
                        detail,
                        game,
                        at,
                    );
                    if !retained.is_null() {
                        let players: Vec<ResolvedPlayer> =
                            serde_json::from_value(retained["players"].clone())
                                .map_err(|error| error.to_string())?;
                        let observed_at = catalog::number(&retained["at"]);
                        deadline = catalog::number(&retained["until"]);
                        candidates = players
                            .into_iter()
                            .map(|player| Candidate {
                                id: player.id,
                                game_id: game.id.clone(),
                                label: player.label,
                                source_ids: vec![kind.into()],
                                observed_at,
                                locator: player.locator,
                            })
                            .collect();
                    }
                }
                if fresh {
                    replaced.insert(url.to_owned());
                }
                for candidate in candidates {
                    self.publication_deadlines
                        .insert(format!("{kind}:{}", self.key(&candidate)), deadline);
                    merge_candidate(
                        projected.entry(candidate.game_id.clone()).or_default(),
                        candidate,
                    );
                }
            }
        }
        Ok(())
    }

    fn restore(&mut self, at: i64) -> Result<(), String> {
        let reassignment = self.reassignment_context(at)?;
        let mut groups: BTreeMap<(String, String), Vec<WorkingFeed>> = BTreeMap::new();
        for feed in std::mem::take(&mut self.restored_working) {
            groups
                .entry((feed.candidate.game_id.clone(), feed.identity_hash.clone()))
                .or_default()
                .push(feed);
        }
        for ((game_id, hash), rows) in groups {
            let first = &rows[0];
            let game = self.games.iter().find(|game| game.id == game_id).cloned();
            let absent = game.is_none()
                && self
                    .config
                    .schedules
                    .iter()
                    .filter(|source| source["league"] == json!(first.owner.league()))
                    .all(|source| {
                        source["id"].as_str().is_some_and(|id| {
                            self.refreshed_schedules.contains(id)
                                && !self.errors.contains_key(id)
                                && self
                                    .store
                                    .partition(id)
                                    .ok()
                                    .flatten()
                                    .is_some_and(|partition| at - partition.at <= 90_000)
                        })
                    });
            let finished = game
                .as_ref()
                .and_then(|game| game.grace_ends_at)
                .is_some_and(|deadline| at >= deadline);
            let mut accepted = Vec::new();
            if !absent && !finished {
                for mut feed in rows.clone() {
                    if self.metadata_needed(&feed.candidate.locator) {
                        accepted.push(feed);
                        continue;
                    }
                    feed.candidate
                        .source_ids
                        .retain(|id| self.config.sources.iter().any(|source| source.id == *id));
                    if feed.candidate.source_ids.is_empty()
                        || feed.checked_at > at + 60_000
                        || feed.candidate.observed_at > at + 60_000
                        || !self.persistable(&feed.candidate.locator)
                        || self.hash(&feed.candidate) != feed.identity_hash
                        || locator_game(&feed.candidate.locator).is_some_and(|id| id != game_id)
                        || game.as_ref().is_some_and(|game| {
                            (game.lifecycle == GameLifecycle::Final
                                || self.schedule_fresh(game, at))
                                && !domain::working_feed_matches(&feed, game)
                        })
                    {
                        continue;
                    }
                    if self.catalog_reassigned_in(&feed.candidate, &reassignment)? {
                        continue;
                    }
                    if let Some(game) = game.as_ref().filter(|game| {
                        self.feed_game(game, at) || domain::cached_feed_eligible(&feed, game, at)
                    }) {
                        if let Some(current) =
                            self.candidates.get(&game.id).and_then(|candidates| {
                                candidates.iter().find(|candidate| {
                                    candidate.id == feed.candidate.id
                                        && candidate.locator != feed.candidate.locator
                                })
                            })
                        {
                            let _ = current;
                            let suffix = hex::encode(Sha256::digest(
                                json!(feed.candidate.locator).to_string().as_bytes(),
                            ));
                            feed.candidate.id = format!("{}:{}", feed.candidate.id, &suffix[..12]);
                        }
                        let key = self.key(&feed.candidate);
                        let replace = match self
                            .feeds
                            .terminal
                            .get(&key)
                            .map(|terminal| &terminal.outcome)
                        {
                            Some(TerminalOutcome::Unavailable { .. }) => false,
                            Some(TerminalOutcome::Playable { checked_at, .. }) => {
                                *checked_at < feed.checked_at
                            }
                            None => true,
                        };
                        if feed.version == 2
                            && at - feed.checked_at < feeds::WORKING_FRESH_MS
                            && replace
                        {
                            if let WorkingProof::Advancing(proof) = &feed.proof {
                                self.feeds.terminal.insert(
                                    key,
                                    Terminal {
                                        owner: feed.owner.clone(),
                                        outcome: TerminalOutcome::Playable {
                                            checked_at: feed.checked_at,
                                            proof: proof.clone(),
                                            timings: None,
                                        },
                                    },
                                );
                            }
                        }
                        if !self
                            .sources
                            .suppressed_candidates
                            .contains(&(game.id.clone(), feed.candidate.id.clone()))
                        {
                            merge_candidate(
                                self.candidates.entry(game.id.clone()).or_default(),
                                feed.candidate.clone(),
                            );
                        }
                    }
                    accepted.push(feed);
                }
            }
            if json!(accepted) != json!(rows) {
                self.store
                    .replace_working_identity(&game_id, &hash, &accepted)?;
            }
            if accepted.is_empty() {
                let key = self.key(&first.candidate);
                if self.feeds.terminal.get(&key).is_some_and(|terminal|terminal.owner==first.owner&&matches!(terminal.outcome,TerminalOutcome::Playable{checked_at,..}if checked_at<=first.checked_at)){self.feeds.terminal.remove(&key);}
                if let Some(candidates) = self.candidates.get_mut(&game_id) {
                    candidates.retain(|candidate| {
                        !rows.iter().any(|row| {
                            row.candidate.id == candidate.id
                                && row.candidate.locator == candidate.locator
                        })
                    });
                }
            }
            self.restored_working.extend(accepted);
        }
        let checks = std::mem::take(&mut self.restored_checks);
        for check in checks {
            let Some(game) = self.games.iter().find(|game| game.id == check.game_id) else {
                self.restored_checks.push(check);
                continue;
            };
            if !self.feed_game(game, at) {
                self.restored_checks.push(check);
                continue;
            }
            let Some(candidate) = self
                .candidates
                .get(&game.id)
                .and_then(|rows| {
                    rows.iter()
                        .find(|candidate| self.hash(candidate) == check.identity_hash)
                })
                .cloned()
            else {
                self.restored_checks.push(check);
                continue;
            };
            if check.game_date != game.date
                || !domain::feed_owner_matches(&check.owner, &candidate.game_id, game)
            {
                self.store
                    .remove_feed_check(&check.game_id, &check.identity_hash)?;
                continue;
            }
            let key = self.key(&candidate);
            match check.outcome {
                FeedCheckOutcome::Unavailable {
                    checked_at,
                    retry_at,
                    reason,
                    phase,
                    timings,
                } => {
                    if at - checked_at < domain::FEED_CHECK_RETENTION_MS {
                        self.feeds.terminal.insert(
                            key,
                            Terminal {
                                owner: check.owner,
                                outcome: TerminalOutcome::Unavailable {
                                    checked_at,
                                    retry_at,
                                    reason,
                                    phase,
                                    timings,
                                },
                            },
                        );
                    }
                }
                FeedCheckOutcome::Incomplete {
                    checked_at,
                    retry_at,
                    incomplete_attempts,
                    reason,
                    phase,
                    timings,
                } => {
                    if at - checked_at < domain::FEED_CHECK_RETENTION_MS {
                        self.feeds.deferred.insert(
                            key,
                            feeds::Deferred {
                                candidate,
                                owner: check.owner,
                                since: checked_at,
                                until: retry_at,
                                incomplete_attempts,
                                reason,
                                phase,
                                timings,
                            },
                        );
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) fn reassignment_context(&self, at: i64) -> Result<ReassignmentContext, String> {
        let mut catalogs = Vec::new();
        let bindings = self.store.source_event_bindings()?;
        for kind in ["sportsurge-v2", "streameast"] {
            if !self.config.sources.iter().any(|source| source.id == kind) {
                continue;
            }
            let history = self.store.catalog(kind)?;
            if history["current"].is_null() {
                continue;
            }
            let view =
                catalog::catalog_view(kind, &history["current"], &self.games, at, &bindings)?;
            let mut assignments: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
            for row in catalog::rows(&view["games"]) {
                if let Some(game) = row["gameId"].as_str() {
                    assignments
                        .entry((
                            catalog::text(&row["id"]).into(),
                            catalog::text(&row["url"]).into(),
                        ))
                        .or_default()
                        .insert(game.into());
                }
            }
            let mut published = BTreeSet::new();
            for event in catalog::rows(&history["current"]["catalog"]["events"]) {
                if history["current"]["catalog"]["categories"][catalog::text(&event["league"])]["kind"]
                    != "collected"
                {
                    continue;
                }
                if let Some(games) = assignments.get(&(
                    catalog::text(&event["id"]).into(),
                    catalog::text(&event["url"]).into(),
                )) {
                    for game in games {
                        for candidate in catalog::event_candidates(kind, event, game)? {
                            published
                                .insert(json!([game, candidate.id, candidate.locator]).to_string());
                        }
                    }
                }
            }
            catalogs.push(AssignmentCatalog {
                kind,
                history,
                assignments,
                published,
            });
        }
        Ok(ReassignmentContext(catalogs))
    }

    pub(super) fn catalog_reassigned_in(
        &self,
        candidate: &Candidate,
        context: &ReassignmentContext,
    ) -> Result<bool, String> {
        let publication = json!([candidate.game_id, candidate.id, candidate.locator]).to_string();
        if context.0.iter().any(|entry| {
            candidate
                .source_ids
                .iter()
                .any(|source| source == entry.kind)
                && entry.published.contains(&publication)
        }) {
            return Ok(false);
        }
        for entry in &context.0 {
            let kind = entry.kind;
            if !candidate.source_ids.iter().any(|source| source == kind) {
                continue;
            }
            let history = &entry.history;
            for event in catalog::rows(&history["current"]["catalog"]["events"]) {
                if history["current"]["catalog"]["categories"][catalog::text(&event["league"])]["kind"]
                    != "collected"
                {
                    continue;
                }
                if !entry
                    .assignments
                    .get(&(
                        catalog::text(&event["id"]).into(),
                        catalog::text(&event["url"]).into(),
                    ))
                    .is_some_and(|games| games.iter().any(|game| game != &candidate.game_id))
                {
                    continue;
                }
                match &candidate.locator {
                    CandidateLocator::SportsurgeV2 { event_id, .. } => {
                        if event["id"] == json!(event_id)
                            && catalog::catalog_operation(
                                "sportsurgeEventCandidate",
                                &json!([candidate, event]),
                            )? == true
                        {
                            return Ok(true);
                        }
                    }
                    _ => {
                        for key in ["current", "previous", "lastComplete"] {
                            for prior in catalog::rows(&history[key]["catalog"]["events"]) {
                                if prior["id"] == event["id"]
                                    && prior["url"] == event["url"]
                                    && catalog::event_candidates(kind, prior, &candidate.game_id)?
                                        .iter()
                                        .any(|row| {
                                            row.id == candidate.id
                                                && row.locator == candidate.locator
                                        })
                                {
                                    return Ok(true);
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(false)
    }

    fn retire_proof(&mut self, candidate: &Candidate) -> Result<(), String> {
        let key = self.key(candidate);
        let hash = self.hash(candidate);
        self.feeds.terminal.remove(&key);
        self.feeds.invalidate(&key);
        self.feeds.decoded.remove(&key);
        self.store.remove_feed_check(&candidate.game_id, &hash)?;
        self.store
            .replace_working_identity(&candidate.game_id, &hash, &[])?;
        self.restored_working.retain(|feed| {
            feed.candidate.game_id != candidate.game_id || feed.identity_hash != hash
        });
        Ok(())
    }

    fn demand(&self, at: i64) -> BTreeSet<String> {
        let mut demand: BTreeSet<_> = self
            .feeds
            .check_targets
            .iter()
            .filter(|(_, requested)| at - *requested <= 90_000)
            .map(|(id, _)| id.clone())
            .collect();
        demand.extend(
            self.sessions
                .sessions
                .values()
                .map(|owned| owned.value.game_id.clone()),
        );
        for game in &self.games {
            if game.lifecycle == GameLifecycle::Live
                && self.feed_game(game, at)
                && !self.candidates.get(&game.id).is_some_and(|rows| {
                    rows.iter()
                        .any(|candidate| self.feeds.playable(&self.key(candidate), at))
                })
            {
                demand.insert(game.id.clone());
            }
        }
        demand
    }

    fn launch_probe(
        &mut self,
        token: Token,
        id: String,
        at: i64,
        batch: &mut Batch,
    ) -> Result<(), String> {
        let game_day = self
            .feeds
            .active
            .get(&token)
            .and_then(|job| {
                self.games
                    .iter()
                    .find(|game| game.id == job.candidate.game_id)
            })
            .and_then(Game::kickoff)
            .and_then(domain::feed_calendar_day);
        let Some(job) = self.feeds.active.get_mut(&token) else {
            return Ok(());
        };
        let target = VerificationTarget {
            session_id: id,
            game_id: job.candidate.game_id.clone(),
            candidate_id: job.candidate.id.clone(),
            generation: 0,
            game_day,
        };
        job.target = Some(target.clone());
        job.deadline = at + 60_000;
        self.jobs.insert(token, Job::Probe);
        batch.launch.push(Effect::Verify {
            token,
            locator: json!(job.candidate.locator),
            target: json!(target),
        });
        Ok(())
    }
    fn rediscover_game(
        &mut self,
        game_id: &str,
        source_ids: &[String],
        at: i64,
    ) -> Result<(), String> {
        for observation in self.store.observations()? {
            if source_ids.contains(&observation.source_id)
                && matching::detail_candidate_game_ids(&self.match_observation(
                    &observation,
                    at,
                    false,
                ))
                .iter()
                .any(|id| id == game_id)
            {
                self.sources.forced_details.insert(observation.id);
            }
        }
        self.sources.detail_waiting = None;
        self.resolution_enabled = true;
        Ok(())
    }

    fn save_check(
        &mut self,
        candidate: &Candidate,
        owner: &FeedOwner,
        outcome: FeedCheckOutcome,
    ) -> Result<(), String> {
        let Some(game) = self.games.iter().find(|game| game.id == candidate.game_id) else {
            return Ok(());
        };
        let hash = self.hash(candidate);
        let unavailable = matches!(outcome, FeedCheckOutcome::Unavailable { .. });
        let result = self.store.save_feed_check(&FeedCheck {
            version: 1,
            game_id: game.id.clone(),
            game_date: game.date.clone(),
            identity_hash: hash.clone(),
            owner: owner.clone(),
            outcome,
        });
        let failed = result.is_err();
        if let Err(message) = result {
            self.errors
                .insert("feed-check-cache".into(), redact_error(&message));
        } else {
            self.errors.remove("feed-check-cache");
        }
        if unavailable {
            if failed {
                if let Err(message) =
                    self.store
                        .replace_working_identity(&candidate.game_id, &hash, &[])
                {
                    self.errors
                        .insert("working-feed-cache".into(), redact_error(&message));
                } else {
                    self.errors.remove("working-feed-cache");
                }
            }
            self.restored_working
                .retain(|feed| feed.candidate.game_id != game.id || feed.identity_hash != hash);
        }
        Ok(())
    }
    fn persist_working(&mut self, candidate: &Candidate, at: i64) -> Result<(), String> {
        let key = self.key(candidate);
        let Some(Terminal {
            owner,
            outcome: TerminalOutcome::Playable {
                checked_at, proof, ..
            },
        }) = self.feeds.terminal.get(&key)
        else {
            return Ok(());
        };
        let hash = self.hash(candidate);
        let feeds: Vec<_> = self
            .candidates
            .get(&candidate.game_id)
            .into_iter()
            .flatten()
            .filter(|row| self.key(row) == key && self.persistable(&row.locator))
            .map(|candidate| WorkingFeed {
                version: 2,
                identity_hash: hash.clone(),
                candidate: candidate.clone(),
                owner: owner.clone(),
                checked_at: *checked_at,
                proof: WorkingProof::Advancing(proof.clone()),
            })
            .collect();
        let existing: Vec<_> = self
            .restored_working
            .iter()
            .filter(|feed| {
                feed.candidate.game_id == candidate.game_id && feed.identity_hash == hash
            })
            .collect();
        if let Err(message) = self.store.remove_feed_check(&candidate.game_id, &hash) {
            self.errors
                .insert("feed-check-cache".into(), redact_error(&message));
        } else {
            self.errors.remove("feed-check-cache");
        }
        if json!(existing) == json!(feeds) {
            return Ok(());
        }
        if let Err(message) = self
            .store
            .replace_working_identity(&candidate.game_id, &hash, &feeds)
        {
            self.errors
                .insert("working-feed-cache".into(), redact_error(&message));
            return Ok(());
        }
        self.errors.remove("working-feed-cache");
        self.restored_working.retain(|feed| {
            feed.candidate.game_id != candidate.game_id || feed.identity_hash != hash
        });
        self.restored_working.extend(feeds);
        let _ = at;
        Ok(())
    }
    fn rank(&self, a: &Candidate, b: &Candidate, at: i64) -> std::cmp::Ordering {
        let a_key = self.key(a);
        let b_key = self.key(b);
        let a_playable = self.feeds.playable(&a_key, at);
        let b_playable = self.feeds.playable(&b_key, at);
        b_playable
            .cmp(&a_playable)
            .then_with(|| {
                match (
                    self.feeds
                        .decoded
                        .get(&a_key)
                        .filter(|(checked, _)| at - *checked < 600_000),
                    self.feeds
                        .decoded
                        .get(&b_key)
                        .filter(|(checked, _)| at - *checked < 600_000),
                ) {
                    (Some((_, a)), Some((_, b))) => a.cmp(b),
                    _ => std::cmp::Ordering::Equal,
                }
            })
            .then(a.id.cmp(&b.id))
    }
    fn availability(&self, candidate: &Candidate, key: &str, at: i64) -> Value {
        let availability = self.feeds.availability(candidate, key, at);
        if availability["kind"] == "unknown"
            && self.retained_playable(candidate, at)
            && self
                .games
                .iter()
                .find(|game| game.id == candidate.game_id)
                .is_some_and(|game| self.feed_game(game, at))
        {
            if let Some(Terminal {
                outcome: TerminalOutcome::Playable { checked_at, .. },
                ..
            }) = self.feeds.terminal.get(key)
            {
                return json!({"kind":"checking","progress":{"kind":"queued","since":checked_at+feeds::WORKING_FRESH_MS}});
            }
        }
        availability
    }
    fn choices(&self, game_id: &str, at: i64) -> Vec<Choice> {
        let mut candidates = self.candidates.get(game_id).cloned().unwrap_or_default();
        candidates.sort_by(|a, b| self.rank(a, b, at));
        candidates.iter().map(|candidate| {
            let key = self.key(candidate);
            let terminal = self.feeds.terminal.get(&key);
            let game = self.games.iter().find(|game| game.id == candidate.game_id);
            let owner = terminal.map(|terminal| terminal.owner.clone())
                .or_else(|| game.map(|game| self.owner(game)))
                .map(|owner| format!("{}:{}", key, json!(owner))).unwrap_or_default();
            let selected = self.sessions.sessions.values().any(|owned| {
                owned.value.game_id == candidate.game_id
                    && owned.value.candidate_id == candidate.id
                    && owned.selection.as_ref() == Some(&owner)
                    && !owned.value.is_closed()
                    && at - owned.last_seen <= sessions::SESSION_LEASE_MS
            });
            let current = self.current_candidate(candidate, at)
                || (selected && game.is_some_and(|game| {
                    game.grace_ends_at.is_none_or(|deadline| at < deadline)
                        && terminal.is_none_or(|terminal| domain::feed_owner_matches(&terminal.owner,&candidate.game_id,game))
                }) && candidate.source_ids.iter().any(|id| self.config.sources.iter().any(|source| source.id == *id))
                    && locator_game(&candidate.locator).is_none_or(|id| id == candidate.game_id));
            Choice {
                id: candidate.id.clone(), owner,
                playable: current && self.retained_playable(candidate,at) && self.feeds.playable(&key,at),
                current,
                visible: game.is_some_and(|game| self.feed_game(game,at)) || self.retained_candidate(candidate,at),
                recovery_ready: matches!(terminal,Some(Terminal{outcome:TerminalOutcome::Unavailable{reason:MediaFailureReason::Playback,retry_at,..},..}) if *retry_at<=at),
                summary: summary(candidate,self.availability(candidate,&key,at)),
            }
        }).collect()
    }
    fn command(
        &mut self,
        request: u64,
        command: Command,
        at: i64,
        batch: &mut Batch,
    ) -> Result<(), String> {
        let reply = match command {
            Command::Board => {
                self.refresh(None, false, at, batch)?;
                json!({"kind":"board","board":self.board(at)?})
            }
            Command::SetRetention { minutes } => {
                self.store.set_finished_game_retention_minutes(minutes)?;
                self.cleaned_finals.clear();
                self.rebuild(at)?;
                self.sweep(at, batch)?;
                json!({"kind":"board","board":self.board(at)?})
            }
            Command::Refresh => {
                self.refresh(Some(request), true, at, batch)?;
                return Ok(());
            }
            Command::Sources | Command::RoomSources => {
                let room = matches!(command, Command::RoomSources);
                let snapshot = self.inventory(at, room)?;
                batch.replies.push(CompletedRequest {
                    request_id: request,
                    value: CompletedReply::Sources { snapshot, room },
                });
                return Ok(());
            }
            Command::FeedLink {
                game_id,
                candidate_id,
            } => self
                .candidates
                .get(&game_id)
                .and_then(|rows| {
                    rows.iter().find(|candidate| {
                        candidate.id == candidate_id && self.current_candidate(candidate, at)
                    })
                })
                .map(|candidate| json!({"kind":"feed-link","locator":candidate.locator}))
                .unwrap_or_else(|| error(404, "This feed is no longer listed.")),
            Command::CheckSources { game_ids, retry } => {
                let listed: Vec<_> = game_ids
                    .into_iter()
                    .filter(|id| self.games.iter().any(|game| game.id == *id))
                    .collect();
                let eligible: Vec<_> = listed
                    .iter()
                    .filter(|id| {
                        self.games
                            .iter()
                            .any(|game| game.id == **id && self.feed_game(game, at))
                    })
                    .cloned()
                    .collect();
                if listed.is_empty() {
                    error(404, "Game is no longer listed.")
                } else if eligible.is_empty() {
                    error(
                        409,
                        "Feed checks are available for live games and games scheduled today or tomorrow in America/Chicago.",
                    )
                } else {
                    self.feeds.demand(&eligible, at);
                    self.sources.detail_waiting = None;
                    if retry {
                        for id in &eligible {
                            for candidate in self.candidates.get(id).into_iter().flatten() {
                                let key = self.key(candidate);
                                if matches!(
                                    self.feeds.terminal.get(&key),
                                    Some(Terminal {
                                        outcome: TerminalOutcome::Unavailable { .. },
                                        ..
                                    })
                                ) || self
                                    .feeds
                                    .deferred
                                    .get(&key)
                                    .is_some_and(|deferred| deferred.incomplete_attempts > 0)
                                    && !self.feeds.playable(&key, at)
                                {
                                    self.feeds.forced.insert(key.clone());
                                }
                            }
                        }
                        self.feeds
                            .deferred
                            .retain(|_, deferred| !eligible.contains(&deferred.candidate.game_id));
                        for job in self
                            .feeds
                            .active
                            .values_mut()
                            .chain(self.feeds.queue.iter_mut())
                        {
                            if eligible.contains(&job.candidate.game_id) {
                                job.incomplete_attempts = 0;
                            }
                        }
                        for job in &mut self.feeds.queue {
                            if eligible.contains(&job.candidate.game_id)
                                && job.priority == Priority::Retry
                            {
                                job.priority = Priority::Forced;
                                self.feeds.forced.remove(&job.key);
                                self.feeds.terminal.remove(&job.key);
                                self.revision += 1;
                            }
                        }
                        let cancelled: Vec<_> = self
                            .feeds
                            .active
                            .iter()
                            .filter(|(_, job)| {
                                eligible.contains(&job.candidate.game_id)
                                    && job.priority == Priority::Retry
                                    && !job.active_phase
                            })
                            .map(|(token, _)| *token)
                            .collect();
                        for token in cancelled {
                            if let Some(job) = self.feeds.active.remove(&token) {
                                self.feeds.forced.insert(job.key);
                            }
                            batch.cancel.push(token);
                            self.revision += 1;
                        }
                        for observation in self.store.observations()? {
                            if matching::detail_candidate_game_ids(&self.match_observation(
                                &observation,
                                at,
                                true,
                            ))
                            .iter()
                            .any(|id| eligible.contains(id))
                            {
                                self.sources.forced_details.insert(observation.id);
                            }
                        }
                        self.sources.detail_admissions = 0;
                    }
                    self.plan_probes(at, batch)?;
                    self.pump_probes(at, batch)?;
                    json!({"kind":"ok"})
                }
            }
            command @ Command::Open { .. } => {
                self.open_command(request, command, None, at, batch)?;
                return Ok(());
            }
            Command::Close { session_id } => {
                self.sessions.sessions.remove(&session_id);
                self.sources.detail_waiting = None;
                json!({"kind":"ok"})
            }
            Command::CollectorPolling { source } => {
                json!({"kind":"collector-polling","nextSweepAt":self.catalog_next(&source,at)?})
            }
            Command::SportsurgeCatalog { catalog } => {
                self.accept_catalog("sportsurge-v2", catalog, at)?
            }
            Command::StreameastCatalog { catalog } => {
                self.accept_catalog("streameast", catalog, at)?
            }
            command @ Command::Authorize { .. }
            | command @ Command::Session { .. }
            | command @ Command::PlaybackEvidence { .. } => {
                if let Command::Authorize {
                    session_id,
                    candidate_id,
                    generation,
                } = &command
                {
                    if let Some((_, job)) = self.feeds.active.iter().find(|(_, job)| {
                        job.target
                            .as_ref()
                            .is_some_and(|target| target.session_id == *session_id)
                    }) {
                        let target = job.target.as_ref().expect("target exists");
                        let reply = if target.candidate_id == *candidate_id
                            && target.generation == *generation
                            && at < job.deadline
                            && self.current_probe(job, at)
                        {
                            json!({"kind":"verification-authorized","candidate":job.candidate,"target":target,"deadline":job.deadline})
                        } else {
                            error(410, "Verification grant expired.")
                        };
                        Self::reply(batch, request, reply);
                        return Ok(());
                    }
                }
                let session_id = match &command {
                    Command::Authorize { session_id, .. }
                    | Command::Session { session_id, .. }
                    | Command::PlaybackEvidence { session_id, .. } => session_id,
                    _ => unreachable!(),
                };
                let game_id = self
                    .sessions
                    .sessions
                    .get(session_id)
                    .map(|owned| owned.value.game_id.clone());
                let choices = game_id
                    .as_deref()
                    .map(|id| self.choices(id, at))
                    .unwrap_or_default();
                if let Command::PlaybackEvidence { evidence, .. } = &command {
                    let proof: AdvancingVideo = serde_json::from_value(evidence.clone())
                        .map_err(|error| error.to_string())?;
                    if !proof.valid() {
                        Self::reply(batch, request, error(400, "Invalid playback evidence."));
                        return Ok(());
                    }
                }
                let mut action = self.sessions.handle(&command, &choices, at);
                if action.failed.is_some() || action.evidence.is_some() {
                    self.sources.detail_waiting = None;
                }
                if let Some(game_id) = game_id {
                    if let Some(candidate) = action
                        .failed
                        .as_ref()
                        .and_then(|id| {
                            self.candidates
                                .get(&game_id)
                                .and_then(|rows| rows.iter().find(|candidate| candidate.id == *id))
                        })
                        .cloned()
                    {
                        let key = self.key(&candidate);
                        batch.cancel.extend(self.feeds.invalidate(&key));
                        if let Some(game) = self.games.iter().find(|game| game.id == game_id) {
                            let owner = self.owner(game);
                            self.feeds.terminal.insert(
                                key.clone(),
                                Terminal {
                                    owner: owner.clone(),
                                    outcome: TerminalOutcome::Unavailable {
                                        checked_at: at,
                                        retry_at: at + feeds::FAILED_RETRY_MS,
                                        reason: MediaFailureReason::Playback,
                                        phase: None,
                                        timings: None,
                                    },
                                },
                            );
                            self.save_check(
                                &candidate,
                                &owner,
                                FeedCheckOutcome::Unavailable {
                                    checked_at: at,
                                    retry_at: at + feeds::FAILED_RETRY_MS,
                                    reason: MediaFailureReason::Playback,
                                    phase: None,
                                    timings: None,
                                },
                            )?;
                            self.rediscover_game(&game_id, &candidate.source_ids, at)?;
                            self.feeds.decoded.remove(&key);
                            self.revision += 1;
                        }
                    }
                    if let Some((id, evidence)) = action.evidence {
                        if let Some(candidate) = self
                            .candidates
                            .get(&game_id)
                            .and_then(|rows| rows.iter().find(|candidate| candidate.id == id))
                            .cloned()
                        {
                            let key = self.key(&candidate);
                            batch.cancel.extend(self.feeds.invalidate(&key));
                            let proof: AdvancingVideo = serde_json::from_value(evidence)
                                .map_err(|error| error.to_string())?;
                            if let Some(game) = self.games.iter().find(|game| game.id == game_id) {
                                self.feeds.terminal.insert(
                                    key.clone(),
                                    Terminal {
                                        owner: self.owner(game),
                                        outcome: TerminalOutcome::Playable {
                                            checked_at: at,
                                            proof: proof.clone(),
                                            timings: None,
                                        },
                                    },
                                );
                                self.feeds.decoded.insert(key, (at, proof.startup_ms));
                                self.persist_working(&candidate, at)?;
                                self.revision += 1;
                            }
                        }
                    }
                    if action.reply["kind"] == "authorized" {
                        if let Command::Authorize { candidate_id, .. } = &command {
                            if let Some(candidate) =
                                self.candidates.get(&game_id).and_then(|rows| {
                                    rows.iter().find(|candidate| candidate.id == *candidate_id)
                                })
                            {
                                action.reply["candidate"] = json!(candidate);
                            }
                        }
                    }
                }
                action.reply
            }
            Command::Stop => unreachable!(),
        };
        Self::reply(batch, request, reply);
        Ok(())
    }

    fn open_command(
        &mut self,
        request: u64,
        command: Command,
        id: Option<String>,
        at: i64,
        batch: &mut Batch,
    ) -> Result<(), String> {
        let Command::Open {
            game_id,
            manual,
            request_id,
            initial_candidate_id,
        } = &command
        else {
            unreachable!()
        };
        let aliases = self.store.aliases()?;
        let game_id = aliases[game_id].as_str().unwrap_or(game_id).to_owned();
        let choices = self.choices(&game_id, at);
        if let Some(prior) = request_id.as_ref().and_then(|request_id| {
            self.sessions
                .prior(request_id, &game_id, *manual, at, &choices)
        }) {
            Self::reply(batch, request, prior);
            return Ok(());
        }
        let Some(game) = self.games.iter().find(|game| game.id == game_id) else {
            Self::reply(
                batch,
                request,
                error(
                    409,
                    "This game is finished or its schedule needs a refresh.",
                ),
            );
            return Ok(());
        };
        let retained = game.lifecycle == GameLifecycle::Final
            && game.grace_ends_at.is_some_and(|deadline| at < deadline)
            && choices.iter().any(|choice| choice.playable);
        if !*manual
            && !domain::feed_eligible(game, at)
            && !domain::combat_listing_feed_eligible(game, at)
            && !retained
        {
            Self::reply(
                batch,
                request,
                error(
                    409,
                    "Listed feeds are available for live games and games scheduled today or tomorrow in America/Chicago.",
                ),
            );
            return Ok(());
        }
        if game.final_observed_at.is_some() && (!retained || *manual)
            || (*manual && !self.schedule_fresh(game, at))
            || (!*manual
                && !self.feed_game(game, at)
                && !choices.iter().any(|choice| choice.playable))
        {
            Self::reply(
                batch,
                request,
                error(
                    409,
                    "This game is finished or its schedule needs a refresh.",
                ),
            );
            return Ok(());
        }
        if !*manual && !choices.iter().any(|choice| choice.playable) {
            self.feeds.demand(std::slice::from_ref(&game_id), at);
            self.plan_probes(at, batch)?;
            self.pump_probes(at, batch)?;
            Self::reply(
                batch,
                request,
                error(404, "No playable server has been verified yet."),
            );
            return Ok(());
        }
        let grace = game.grace_ends_at;
        let id = if let Some(id) = id {
            id
        } else if self.config.fixture_operations.contains("id") {
            let token = self.token(0);
            self.jobs.insert(token, Job::OpenId { request, command });
            batch.launch.push(Effect::Id { token });
            return Ok(());
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let reply = self.sessions.open(
            id,
            game_id.clone(),
            *manual,
            request_id.clone(),
            initial_candidate_id.as_deref(),
            grace,
            &choices,
            at,
        );
        if grace.is_none() {
            self.feeds.demand(&[game_id], at);
            self.sources.detail_waiting = None;
        }
        Self::reply(batch, request, reply);
        Ok(())
    }

    fn catalog_coverage(&self, kind: &str) -> Vec<League> {
        self.config
            .sources
            .iter()
            .find(|source| source.id == kind)
            .filter(|source| !source.leagues.is_empty())
            .map_or_else(
                || matching::source_coverage(kind).to_vec(),
                |source| source.leagues.clone(),
            )
    }

    fn catalog_next(&self, kind: &str, at: i64) -> Result<i64, String> {
        let history = self.store.catalog(kind)?;
        let catalog = &history["current"]["catalog"];
        if catalog.is_null() {
            return Ok(at);
        }
        let forced = self.sources.forced_details.iter().cloned().collect();
        let plan = catalog_plan::polling_plan(
            kind,
            catalog,
            &history,
            &self.games,
            &self.store.detail_evidence()?,
            &forced,
            &self.catalog_coverage(kind),
            at,
        )?;
        plan["nextSweepAt"]
            .as_i64()
            .ok_or_else(|| "Missing browser polling deadline".into())
    }

    fn accept_catalog(&mut self, kind: &str, catalog: Value, at: i64) -> Result<Value, String> {
        let history = self.store.catalog(kind)?;
        let stored: Vec<_> = ["current", "previous", "lastComplete"]
            .iter()
            .filter_map(|key| history.get(key).filter(|stored| !stored.is_null()).cloned())
            .collect();
        let name = if kind == "sportsurge-v2" {
            "Sportsurge"
        } else {
            "StreamEast"
        };
        let finished = matching::FinishedGameMatcher::new(&self.games);
        let mut finished_events = std::collections::HashSet::new();
        if kind == "streameast" {
            for event in std::iter::once(&catalog)
                .chain(stored.iter().map(|stored| &stored["catalog"]))
                .flat_map(|catalog| catalog["events"].as_array().into_iter().flatten())
            {
                let observation = catalog::event_observation(kind, event, at)?;
                let evidence: matching::SourceEventEvidence =
                    serde_json::from_value(catalog::event_evidence(kind, event, at))
                        .map_err(|error| error.to_string())?;
                if finished
                    .finished_game_id(&observation, at, evidence.external_game_id.as_deref())
                    .is_some()
                {
                    if let Some(id) = event["id"].as_str() {
                        finished_events.insert(id.into());
                    }
                }
            }
        }
        let Some(sanitized) =
            catalog::sanitize_catalog(kind, &catalog, at, &stored, &finished_events)?
        else {
            return Ok(error(400, &format!("Invalid {name} catalog checkpoint.")));
        };
        let decision = catalog::catalog_decision(kind, &history["current"], &sanitized);
        if decision == "rejected" {
            return Ok(error(
                409,
                &format!("{name} catalog checkpoint is obsolete."),
            ));
        }
        let bindings = self.store.source_event_bindings()?;
        let details = self.store.detail_evidence()?;
        let forced = self.sources.forced_details.iter().cloned().collect();
        let mut pinned: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for owned in self.sessions.sessions.values() {
            pinned
                .entry(owned.value.game_id.clone())
                .or_default()
                .push(owned.value.candidate_id.clone());
        }
        let mut plan = catalog_plan::catalog_plan(
            kind,
            &sanitized,
            &history,
            &self.games,
            &bindings,
            &details,
            &pinned,
            &forced,
            &self.catalog_coverage(kind),
            at,
        )?;
        let mut observations = Vec::new();
        let mut new_bindings = Vec::new();
        let mut matcher = SourceEventMatcher::new(&self.games, MatchMode::Current);
        for event in sanitized["events"].as_array().into_iter().flatten() {
            if plan["skipDetailEventIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(&event["id"]))
                || plan["skipDetailEventUrls"]
                    .as_array()
                    .is_some_and(|urls| urls.contains(&event["url"]))
            {
                continue;
            }
            let league = event["league"].as_str().unwrap_or_default();
            let observed_at = sanitized["categories"][league]["at"]
                .as_i64()
                .or_else(|| sanitized["startedAt"].as_i64())
                .unwrap_or(at);
            let observation = catalog::event_observation(kind, event, observed_at)?;
            let evidence = serde_json::from_value(catalog::event_evidence(kind, event, at))
                .map_err(|error| error.to_string())?;
            let result = matcher
                .match_event(&observation, &evidence, at, None)
                .match_result()
                .clone();
            if kind == "streameast"
                && event["espnEventId"].is_string()
                && result.reason() == Some("conflicting-game-id")
            {
                continue;
            }
            if kind == "sportsurge-v2"
                && sanitized["categories"][league]["kind"] == "collected"
                && event["kickoff"].is_null()
            {
                if let (Some(game_id), Some(league), Some(teams)) = (
                    result.game_id(),
                    observation.league,
                    observation.teams.as_ref(),
                ) {
                    if self
                        .games
                        .iter()
                        .find(|game| game.id == game_id)
                        .is_some_and(|game| self.schedule_fresh(game, at))
                    {
                        new_bindings.push(json!(SourceEventBinding {
                            source_id: kind.into(),
                            event_id: event["id"].as_str().unwrap_or_default().into(),
                            url: observation.url.clone(),
                            league,
                            teams: teams.clone(),
                            game_id: game_id.into(),
                            observed_at: at
                        }));
                    }
                }
            }
            observations.push(json!({"observation":observation,"result":result}));
        }
        if decision != "replay" {
            self.store.save_catalog(
                kind,
                &json!({"catalog":sanitized,"receivedAt":at}),
                &observations,
                &new_bindings,
            )?;
            self.persist_browser_polling(kind, &sanitized, at)?;
            self.revision += 1;
        }
        self.project_candidates(at)?;
        if sanitized["sequence"] != 0 {
            plan["nextSweepAt"] = json!(self.catalog_next(kind, at)?);
        }
        plan["kind"] = json!("catalog-ack");
        Ok(plan)
    }

    fn persist_browser_polling(
        &mut self,
        kind: &str,
        catalog: &Value,
        now: i64,
    ) -> Result<(), String> {
        let details = self.store.detail_evidence()?;
        let mut matcher = SourceEventMatcher::new(&self.games, MatchMode::Current);
        for event in catalog["events"].as_array().into_iter().flatten() {
            let category = &catalog["categories"][event["league"].as_str().unwrap_or_default()];
            if category["kind"] != "collected" || event["detail"]["kind"] == "pending" {
                continue;
            }
            let observed_at = category["at"]
                .as_i64()
                .ok_or("Invalid category timestamp")?;
            let observation = catalog::event_observation(kind, event, observed_at)?;
            let at = event["detail"]["at"]
                .as_i64()
                .ok_or("Invalid detail timestamp")?;
            let prior = details
                .iter()
                .find(|detail| detail.observation_id == observation.id);
            if prior.is_some_and(|prior| prior.at >= at) {
                continue;
            }
            self.sources.forced_details.remove(&observation.id);
            let evidence = serde_json::from_value(catalog::event_evidence(kind, event, now))
                .map_err(|error| error.to_string())?;
            let decision = matcher.match_event(&observation, &evidence, now, None);
            let game = decision
                .match_result()
                .game_id()
                .and_then(|id| self.games.iter().find(|game| game.id == id));
            let signature = catalog_plan::polling_signature(event, &observation, game);
            let publication_identity = catalog_plan::publication_identity(event);
            let prior_success = prior
                .and_then(|prior| prior.last_success.as_ref())
                .filter(|success| success.identity == publication_identity)
                .cloned();
            let (result, polling, last_success, next_eligible_at) = if let Some(signature) =
                signature.as_str()
            {
                let polling = DetailPolling {
                    signature: signature.into(),
                    unchanged_checks: prior
                        .and_then(|prior| prior.polling.as_ref())
                        .filter(|prior| prior.signature == signature)
                        .map_or(0, |prior| prior.unchanged_checks.saturating_add(1).min(3)),
                };
                let candidates = if let Some(game) = game.filter(|game| self.feed_game(game, now)) {
                    catalog::event_candidates(kind, event, &game.id)?
                } else {
                    Vec::new()
                };
                let players: Vec<_> = candidates
                    .into_iter()
                    .map(|candidate| ResolvedPlayer {
                        id: candidate.id,
                        label: candidate.label,
                        locator: candidate.locator,
                    })
                    .collect();
                let last_success =
                    game.filter(|_| !players.is_empty())
                        .map(|game| LastDetailSuccess {
                            identity: publication_identity,
                            at,
                            count: players.len() as u64,
                            publication: Some(Publication {
                                players: players.clone(),
                                event: DetailEvent {
                                    game_id: game.id.clone(),
                                    date: game.date.clone(),
                                },
                            }),
                        });
                let deadline = domain::detail_deadline(at, &polling, game, at, !players.is_empty());
                (
                    DetailOutcome::Resolved {
                        players: Vec::new(),
                    },
                    Some(polling),
                    last_success,
                    deadline,
                )
            } else {
                let failures = prior.map_or(1, |prior| match prior.result {
                    DetailOutcome::Failed { failures, .. } => failures + 1,
                    _ => 1,
                });
                let failure = match event["detail"]["reason"].as_str() {
                    Some("rate-limited") => SourceFailure::RateLimited,
                    Some("timeout") => SourceFailure::TimedOut,
                    _ => SourceFailure::UpstreamError,
                };
                (
                    DetailOutcome::Failed { failure, failures },
                    None,
                    prior_success,
                    at + sources::SOURCE_REFRESH_MS,
                )
            };
            let detail = DetailEvidence {
                observation_id: observation.id.clone(),
                generation: sources::detail_generation(&observation),
                identity: Some(domain::detail_identity(&observation)),
                at,
                next_eligible_at,
                last_success,
                polling,
                event: None,
                result,
            };
            self.store.save_detail_evidence(&json!(detail), None)?;
        }
        Ok(())
    }

    fn inventory(&mut self, at: i64, room: bool) -> Result<std::sync::Arc<Value>, String> {
        let fresh: Vec<_> = self
            .games
            .iter()
            .filter(|game| self.feed_game(game, at))
            .map(|game| game.id.clone())
            .collect();
        let visible: Vec<_> = self
            .games
            .iter()
            .filter(|game| {
                domain::feed_inventory_eligible(game, at)
                    || self.candidates.get(&game.id).is_some_and(|rows| {
                        rows.iter()
                            .any(|candidate| self.retained_candidate(candidate, at))
                    })
            })
            .map(|game| game.id.clone())
            .collect();
        let fresh_set: BTreeSet<_> = fresh.iter().cloned().collect();
        let visible_set: BTreeSet<_> = visible.iter().cloned().collect();
        let probe_limit = if self.sessions.sessions.is_empty() {
            self.config.probe_concurrency
        } else {
            self.config
                .probe_concurrency
                .min(verification_policy().viewing_concurrency)
        };
        let day = domain::feed_calendar_day(at);
        if let Some(cache) = &self.inventory_cache {
            if cache.revision == self.revision
                && cache.probe_limit == probe_limit
                && at >= cache.at
                && at - cache.at < 15_000
                && at < cache.proof_expires_at
                && day == cache.day
                && fresh_set == cache.fresh
                && visible_set == cache.visible
                && (!cache.room || room)
            {
                return Ok(if room && !cache.room {
                    std::sync::Arc::new(views::room_sources(&cache.snapshot))
                } else {
                    cache.snapshot.clone()
                });
            }
        }
        let attempts = self.store.source_attempts()?;
        let observations = self.store.observations()?;
        let details = self.store.detail_evidence()?;
        let candidates: Vec<_> = self
            .candidates
            .iter()
            .filter(|(id, _)| visible.contains(id))
            .map(|(id, rows)| {
                (
                    id.clone(),
                    rows.iter()
                        .filter(|candidate| {
                            fresh.contains(id) || self.retained_candidate(candidate, at)
                        })
                        .cloned()
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        let mut availability = serde_json::Map::new();
        let mut identities = serde_json::Map::new();
        let mut eligible = Vec::new();
        let mut rank = Vec::new();
        for (_, rows) in &candidates {
            let mut rows = rows.clone();
            rows.sort_by(|a, b| self.rank(a, b, at));
            for candidate in rows {
                let key = self.key(&candidate);
                let candidate_key = json!([candidate.game_id, candidate.id]).to_string();
                availability.insert(
                    candidate_key.clone(),
                    self.availability(&candidate, &key, at),
                );
                identities.insert(candidate_key.clone(), json!(key));
                if self.current_candidate(&candidate, at) {
                    eligible.push(candidate_key.clone());
                }
                rank.push(candidate_key);
            }
        }
        let mut scopes = Vec::new();
        let mut leagues = BTreeSet::new();
        let dates = domain::feed_window(at)
            .map(|window| window.days.map(|day| day.replace('-', "")))
            .unwrap_or_default();
        for source in &self.config.schedules {
            let league = source["league"].clone();
            let name = league.to_string();
            if !leagues.insert(name) {
                continue;
            }
            let partitions: Vec<_> = self
                .config
                .schedules
                .iter()
                .filter(|source| source["league"] == league)
                .collect();
            let mut checked = i64::MAX;
            let mut failed = false;
            for source in partitions {
                if let Some(id) = source["id"].as_str() {
                    checked = checked.min(
                        self.store
                            .partition(id)?
                            .map_or(0, |partition| partition.at),
                    );
                    failed |= self.errors.contains_key(id)
                        || dates.iter().any(|date| {
                            self.errors
                                .get(&format!("{id}-horizon"))
                                .is_some_and(|error| error.contains(date))
                        });
                }
            }
            if checked == i64::MAX {
                checked = 0;
            }
            let read = if failed {
                json!({"kind":"incomplete","reason":"failed","checkedAt":(checked!=0).then_some(checked)})
            } else if checked == 0 {
                json!({"kind":"incomplete","reason":"pending","checkedAt":null})
            } else if at - checked > 90_000 {
                json!({"kind":"incomplete","reason":"stale","checkedAt":checked})
            } else if self.refresh.is_some() {
                json!({"kind":"incomplete","reason":"pending","checkedAt":checked})
            } else {
                json!({"kind":"complete","checkedAt":checked})
            };
            scopes.push(json!({"league":league,"read":read}));
        }
        let last_discovery = attempts
            .as_object()
            .into_iter()
            .flat_map(|rows| rows.values())
            .filter_map(|attempt| attempt["at"].as_i64())
            .max();
        let input = json!({"at":at,"revision":self.revision,"lastDiscoveryAt":last_discovery,"browserCollectorsAvailable":self.config.browser_collectors_available,"sources":self.config.sources,"games":self.games,"observations":observations,"candidates":candidates,"attempts":attempts,"details":details,"sourceEventBindings":self.store.source_event_bindings()?,"sportsurgeCatalog":self.store.catalog("sportsurge-v2")?,"streameastCatalog":self.store.catalog("streameast")?,"freshGameIds":fresh,"visibleGameIds":visible,"availability":availability,"identities":identities,"eligibleCandidateIds":eligible,"rankIds":rank,"collectionHistory":self.store.collection_history(at)?,"scheduleScopes":scopes,"observationDeadlines":self.observation_deadlines});
        let mut snapshot = views::source_inventory(&input, room)?;
        if !room {
            let limit = if self.sessions.sessions.is_empty() {
                self.config.probe_concurrency
            } else {
                self.config
                    .probe_concurrency
                    .min(verification_policy().viewing_concurrency)
            };
            snapshot["checks"] = self.feeds.checks(limit.max(self.feeds.active.len()));
        }
        let mut proof_expires_at = i64::MAX;
        for (_, rows) in &candidates {
            for candidate in rows {
                let key = self.key(candidate);
                let publication = candidate
                    .source_ids
                    .iter()
                    .filter_map(|source| {
                        self.publication_deadlines
                            .get(&format!("{source}:{key}"))
                            .copied()
                    })
                    .fold(
                        candidate.observed_at + sources::ACTIVE_DISCOVERY_MS,
                        i64::max,
                    );
                if publication >= at {
                    proof_expires_at = proof_expires_at.min(publication.saturating_add(1));
                }
                if let Some(Terminal {
                    outcome: TerminalOutcome::Playable { checked_at, .. },
                    ..
                }) = self.feeds.terminal.get(&key)
                {
                    if self.retained_playable(candidate, at)
                        && at - *checked_at < feeds::WORKING_FRESH_MS
                    {
                        proof_expires_at =
                            proof_expires_at.min(*checked_at + feeds::WORKING_FRESH_MS);
                    }
                }
            }
        }
        let snapshot = std::sync::Arc::new(snapshot);
        self.inventory_cache = Some(InventoryCache {
            at,
            day,
            revision: self.revision,
            probe_limit,
            proof_expires_at,
            visible: visible_set,
            fresh: fresh_set,
            room,
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    fn board(&self, at: i64) -> Result<Value, String> {
        let mut leagues = serde_json::Map::new();
        for league in [
            League::Nfl,
            League::Ncaaf,
            League::Nba,
            League::Wnba,
            League::Nhl,
            League::Mlb,
            League::F1,
            League::NascarCup,
            League::NascarTruck,
            League::Motogp,
            League::Motorsport,
            League::Ufc,
            League::Boxing,
            League::Wwe,
            League::Tna,
            League::Aew,
            League::Wrestling,
        ] {
            let name = matching::league_name(league);
            let keys: Vec<_> = if league == League::Ncaaf {
                if self
                    .config
                    .schedules
                    .iter()
                    .any(|source| source["id"] == "d2-d3")
                {
                    vec!["fbs", "fcs", "d2-d3"]
                } else {
                    vec!["fbs", "fcs"]
                }
            } else {
                vec![name]
            };
            let mut times = Vec::new();
            let mut errors = Vec::new();
            let mut week = None;
            for (index, key) in keys.iter().enumerate() {
                let partition = self.store.partition(key)?;
                let time = partition.as_ref().map_or(0, |partition| partition.at);
                times.push(time);
                if index == 0 {
                    week = partition.as_ref().and_then(|partition| partition.week);
                }
                if time == 0 || at - time > 90_000 {
                    errors.push(format!(
                        "{} schedule is unavailable or stale.",
                        key.to_uppercase()
                    ));
                } else if self.errors.contains_key(*key) {
                    errors.push(format!(
                        "{} schedule refresh failed; showing saved scores.",
                        key.to_uppercase()
                    ));
                }
                for (suffix, label) in [
                    ("horizon", "future schedule"),
                    ("history", "recent schedule history"),
                ] {
                    if let Some(error) = self.errors.get(&format!("{key}-{suffix}")) {
                        errors.push(format!(
                            "{} {label} is incomplete: {error}",
                            key.to_uppercase()
                        ));
                    }
                }
            }
            if self.errors.contains_key("working-feed-cache") {
                errors.push("Working feeds could not be saved for the next restart.".into());
            }
            let oldest = times.into_iter().min().filter(|at| *at != 0);
            let source_at = self.sources.source_times.values().max().copied();
            let mut value =
                json!({"scoresAt":oldest.map(iso),"sourceAt":source_at.map(iso),"errors":errors});
            if let Some(week) = week {
                value["week"] = json!(week);
            }
            leagues.insert(name.into(), value);
        }
        let mut games = Vec::new();
        for game in &self.games {
            if game.grace_ends_at.is_some_and(|deadline| at >= deadline) {
                continue;
            }
            if game.lifecycle != GameLifecycle::Final
                && !game.partitions.as_ref().is_some_and(|keys| {
                    keys.iter().any(|key| {
                        self.store
                            .partition(key)
                            .ok()
                            .flatten()
                            .is_some_and(|partition| at - partition.at < 86_400_000)
                    })
                })
                && !self
                    .sessions
                    .sessions
                    .values()
                    .any(|owned| owned.value.game_id == game.id)
                && !self.candidates.get(&game.id).is_some_and(|rows| {
                    rows.iter()
                        .any(|candidate| self.feeds.playable(&self.key(candidate), at))
                })
            {
                continue;
            }
            let mut value = json!(game);
            let object = value.as_object_mut().ok_or("Invalid game projection")?;
            object.remove("sourceUrls");
            object.remove("sourceUrl");
            if self.candidates.get(&game.id).is_some_and(|rows| {
                rows.iter().any(|candidate| {
                    self.current_candidate(candidate, at)
                        && self.feeds.playable(&self.key(candidate), at)
                })
            }) {
                object.insert(
                    "sourceUrl".into(),
                    json!(format!("/play/{}", encode_component(&game.id))),
                );
            }
            games.push(value);
        }
        Ok(
            json!({"schemaVersion":2,"revision":self.revision,"scheduleState":if self.schedule_ready{"ready"}else{"loading"},"finishedGameRetentionMinutes":self.store.finished_game_retention_minutes()?,"updatedAt":iso(at),"aliases":self.store.aliases()?,"leagues":leagues,"games":games}),
        )
    }

    fn sweep(&mut self, at: i64, batch: &mut Batch) -> Result<(), String> {
        let day = domain::feed_calendar_day(at);
        if day != self.last_restore_day {
            self.restore(at)?;
            self.last_restore_day = day;
        }
        let deadlines: BTreeMap<_, _> = self
            .games
            .iter()
            .filter_map(|game| {
                game.grace_ends_at
                    .map(|deadline| (game.id.clone(), deadline))
            })
            .collect();
        self.sessions.sweep(&deadlines, at);
        let expired: Vec<_> = deadlines
            .iter()
            .filter(|(id, deadline)| **deadline <= at && !self.cleaned_finals.contains(*id))
            .map(|(id, _)| id.clone())
            .collect();
        if !expired.is_empty() {
            self.store.remove_final_evidence(&expired, at)?;
            for id in expired {
                self.cleaned_finals.insert(id.clone());
                self.candidates.remove(&id);
            }
            self.revision += 1;
        }
        let stale: Vec<_> = self
            .feeds
            .active
            .iter()
            .filter(|(_, job)| !self.current_probe(job, at))
            .map(|(token, _)| *token)
            .collect();
        for token in stale {
            if let Some(job) = self.feeds.active.remove(&token) {
                self.feeds.invalidate(&job.key);
            }
            batch.cancel.push(token);
        }
        if at - self.last_sweep >= 3_600_000 {
            self.store.sweep(at)?;
            self.last_sweep = at;
        }
        Ok(())
    }
    fn begin_stop(&mut self, batch: &mut Batch) -> Result<(), String> {
        if self.stopped {
            return self.finish_stop(batch);
        }
        if self.stopping {
            return Ok(());
        }
        self.stopping = true;
        self.epoch += 1;
        self.feeds.queue.clear();
        self.feeds.deferred.clear();
        batch.cancel.extend(self.jobs.keys().copied());
        for (request, _) in std::mem::take(&mut self.pending_commands) {
            Self::reply(batch, request, error(503, "Pipeline is stopped."));
        }
        for job in self.jobs.values() {
            if let Job::OpenId { request, .. } = job {
                Self::reply(batch, *request, error(503, "Pipeline is stopped."));
            }
        }
        if let Some(refresh) = self.refresh.take() {
            for request in refresh.requests {
                Self::reply(batch, request, json!({"kind":"ok"}));
            }
        }
        for request in std::mem::take(&mut self.queued_refresh) {
            if request != 0 {
                Self::reply(batch, request, json!({"kind":"ok"}));
            }
        }
        if self.config.fixture_operations.contains("closeSchedule") {
            let token = self.token(0);
            self.jobs.insert(token, Job::CloseSchedule);
            batch.launch.push(Effect::CloseSchedule { token });
        }
        Ok(())
    }
    fn finish_stop(&mut self, batch: &mut Batch) -> Result<(), String> {
        if self.stopping && self.jobs.is_empty() {
            self.store.close()?;
            self.sessions.sessions.clear();
            self.candidates.clear();
            self.stopped = true;
            self.stopping = false;
        }
        if self.stopped {
            for request in std::mem::take(&mut self.stop_requests) {
                Self::reply(batch, request, json!({"kind":"ok"}));
            }
        }
        Ok(())
    }
    fn next_wake(&self, at: i64) -> Option<i64> {
        if self.stopping || self.stopped {
            return None;
        }
        let mut deadlines = Vec::new();
        if self.started {
            deadlines.push(self.last_tick + 15_000);
        }
        deadlines.extend(self.feeds.next_deadline(at));
        deadlines.extend(
            self.games
                .iter()
                .filter_map(|game| game.grace_ends_at)
                .filter(|deadline| *deadline > at),
        );
        deadlines.extend(
            self.sessions
                .sessions
                .values()
                .map(|owned| owned.last_seen + sessions::SESSION_LEASE_MS + 1),
        );
        deadlines.extend(
            self.source_wakes
                .range((std::ops::Bound::Excluded(at), std::ops::Bound::Unbounded))
                .next()
                .copied(),
        );
        deadlines
            .into_iter()
            .filter(|deadline| *deadline > at)
            .min()
    }
}

fn iso(at: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
fn urgency(game: &Game, at: i64) -> u8 {
    if game.lifecycle == GameLifecycle::Live {
        0
    } else if game.lifecycle == GameLifecycle::Scheduled
        && game
            .kickoff()
            .is_some_and(|kickoff| kickoff >= at && kickoff <= at + 3_600_000)
    {
        1
    } else {
        2
    }
}
fn summary(candidate: &Candidate, availability: Value) -> Value {
    json!({"id":candidate.id,"gameId":candidate.game_id,"label":candidate.label,"sourceIds":candidate.source_ids,"observedAt":candidate.observed_at,"availability":availability})
}
fn merge_candidate(rows: &mut Vec<Candidate>, candidate: Candidate) {
    if let Some(current) = rows
        .iter_mut()
        .find(|row| row.id == candidate.id && row.locator == candidate.locator)
    {
        for id in candidate.source_ids {
            if !current.source_ids.contains(&id) {
                current.source_ids.push(id);
            }
        }
        current.observed_at = current.observed_at.max(candidate.observed_at);
    } else {
        rows.push(candidate);
    }
}
fn same_teams(a: Option<&[String; 2]>, b: Option<&[String; 2]>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    let mut a = a.each_ref().map(|name| matching::normalized_name(name));
    let mut b = b.each_ref().map(|name| matching::normalized_name(name));
    a.sort();
    b.sort();
    a == b
}
fn detail_matches(detail: &DetailEvidence, observation: &Observation) -> bool {
    detail.identity.as_deref().map_or_else(
        || detail.generation == sources::detail_generation(observation),
        |identity| domain::detail_identity_matches(Some(identity), observation),
    )
}
fn locator_game(locator: &CandidateLocator) -> Option<&str> {
    match locator {
        CandidateLocator::EventPage { game_id, .. }
        | CandidateLocator::CatalogStream { game_id, .. }
        | CandidateLocator::Tvapp { game_id, .. }
        | CandidateLocator::StreameastServer { game_id, .. } => Some(game_id),
        _ => None,
    }
}
fn redact_error(message: &str) -> String {
    cached_regex!(r"https?://\S+")
        .unwrap()
        .replace_all(message, "[url]")
        .chars()
        .take(120)
        .collect()
}
fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_check_cache_writes_keep_health_visible_and_recover() {
        let path = std::env::temp_dir().join(format!(
            "sports-hub-check-fault-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut pipeline=Pipeline::open(&path,r#"{"sources":[{"id":"source","family":"fixture","url":"https://example.com/"}],"schedules":[{"id":"nfl","league":"nfl","path":"nfl","group":null}],"now":100000}"#).unwrap();
        pipeline
            .store
            .save_partition(
                "nfl",
                &Partition {
                    games: vec![live_game()],
                    at: 100_000,
                    week: None,
                },
            )
            .unwrap();
        pipeline.rebuild(100_000).unwrap();
        pipeline.candidates.insert(
            "game".into(),
            vec![Candidate {
                id: "candidate".into(),
                game_id: "game".into(),
                label: "Server".into(),
                source_ids: vec!["source".into()],
                observed_at: 100_000,
                locator: CandidateLocator::Gooz {
                    player_id: "1".into(),
                },
            }],
        );
        let candidate = pipeline.candidates["game"][0].clone();
        let hash = pipeline.hash(&candidate);
        pipeline.store.replace_working_identity("game",&hash,&[WorkingFeed {version:2,identity_hash:hash.clone(),candidate,owner:pipeline.owner(&pipeline.games[0]),checked_at:100_000,proof:WorkingProof::Advancing(serde_json::from_value(json!({"kind":"advancing-video","version":1,"startupMs":3000,"observedMs":3000,"mediaAdvanceMs":3000,"presentedFrames":4})).unwrap())}]).unwrap();
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TRIGGER deny_check BEFORE INSERT ON feed_checks BEGIN SELECT RAISE(FAIL,'cache-unavailable'); END;").unwrap();
        let queued = pipeline.step(Input::Wake, 100_000).unwrap();
        let turn = queued
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::FlushProbes { token } => Some(*token),
                _ => None,
            })
            .unwrap();
        let admitted = pipeline
            .step(
                Input::Complete {
                    token: turn,
                    result: json!({}),
                },
                100_000,
            )
            .unwrap();
        let token = admitted
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::Verify { token, .. } => Some(*token),
                _ => None,
            })
            .unwrap();
        let result = pipeline.step(
            Input::Complete {
                token,
                result: json!({"kind":"unavailable","reason":"invalid-media"}),
            },
            100_000,
        );
        assert!(
            result.is_ok(),
            "cache writes must not reject a completed physical check: {result:?}"
        );
        let snapshot = pipeline
            .step(
                Input::Command {
                    request_id: 1,
                    value: Command::Sources,
                },
                100_000,
            )
            .unwrap();
        assert_eq!(
            json!(snapshot)["replies"][0]["value"]["snapshot"]["games"][0]["candidates"][0]["availability"]
                ["kind"],
            "unavailable"
        );
        assert!(pipeline.errors.contains_key("feed-check-cache"));
        assert!(
            pipeline.store.working_feeds().unwrap().is_empty(),
            "a failed route cannot retain durable playable proof"
        );
        connection
            .execute_batch("DROP TRIGGER deny_check;")
            .unwrap();
        let retry = pipeline
            .step(
                Input::Command {
                    request_id: 2,
                    value: Command::CheckSources {
                        game_ids: vec!["game".into()],
                        retry: true,
                    },
                },
                100_000,
            )
            .unwrap();
        let token = retry
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::Verify { token, .. } => Some(*token),
                _ => None,
            })
            .unwrap();
        pipeline
            .step(
                Input::Complete {
                    token,
                    result: json!({"kind":"unavailable","reason":"invalid-media"}),
                },
                100_000,
            )
            .unwrap();
        assert!(!pipeline.errors.contains_key("feed-check-cache"));
        assert_eq!(pipeline.store.feed_checks(100_000).unwrap().len(), 1);
        pipeline.store.close().unwrap();
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }
    fn deferred_pipeline() -> Pipeline {
        Pipeline::open(":memory:",r#"{"sources":[{"id":"source","family":"fixture","url":"https://example.com/"}],"schedules":[],"now":100000}"#).unwrap()
    }
    #[test]
    fn pending_schedule_discovery_waits_for_two_turns_and_stop_waits_for_owned_work() {
        let mut pipeline = deferred_pipeline();
        pipeline.config.schedules =
            vec![json!({"id":"nfl","league":"nfl","path":"nfl","group":null})];
        let first = pipeline
            .step(
                Input::Refresh {
                    request_id: 1,
                    force: true,
                },
                100_000,
            )
            .unwrap();
        assert!(
            !first
                .launch
                .iter()
                .any(|effect| matches!(effect, Effect::Listing { .. }))
        );
        let turn = first
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::FlushProbes { token } => Some(*token),
                _ => None,
            })
            .unwrap();
        let second = pipeline
            .step(
                Input::Complete {
                    token: turn,
                    result: json!({}),
                },
                100_000,
            )
            .unwrap();
        assert!(
            !second
                .launch
                .iter()
                .any(|effect| matches!(effect, Effect::Listing { .. }))
        );
        let turn = second
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::FlushProbes { token } => Some(*token),
                _ => None,
            })
            .unwrap();
        let admitted = pipeline
            .step(
                Input::Complete {
                    token: turn,
                    result: json!({}),
                },
                100_000,
            )
            .unwrap();
        assert_eq!(
            admitted
                .launch
                .iter()
                .filter(|effect| matches!(effect, Effect::Listing { .. }))
                .count(),
            1
        );

        let mut pipeline = deferred_pipeline();
        pipeline.config.schedules =
            vec![json!({"id":"nfl","league":"nfl","path":"nfl","group":null})];
        let first = pipeline
            .step(
                Input::Refresh {
                    request_id: 1,
                    force: true,
                },
                100_000,
            )
            .unwrap();
        let turn = first
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::FlushProbes { token } => Some(*token),
                _ => None,
            })
            .unwrap();
        let stopping = pipeline
            .step(
                Input::Command {
                    request_id: 2,
                    value: Command::Stop,
                },
                100_000,
            )
            .unwrap();
        assert!(stopping.cancel.contains(&turn));
        assert!(!stopping.replies.iter().any(|reply| reply.request_id == 2));
        let stopped = pipeline
            .step(
                Input::Complete {
                    token: turn,
                    result: json!({"kind":"error","message":"request-cancelled"}),
                },
                100_000,
            )
            .unwrap();
        assert!(!stopped.replies.iter().any(|reply| reply.request_id == 2));
        let stopped = pipeline
            .step(
                Input::Complete {
                    token: schedule_token(&first),
                    result: json!({"kind":"error","message":"request-cancelled"}),
                },
                100_000,
            )
            .unwrap();
        assert_eq!(stopped.replies[0].request_id, 2);
        assert!(stopped.launch.is_empty());
    }
    #[test]
    fn a_changed_schedule_promotes_discovery_before_deferred_turns() {
        let mut pipeline = deferred_pipeline();
        pipeline.config.schedules =
            vec![json!({"id":"nfl","league":"nfl","path":"nfl","group":null})];
        let first = pipeline
            .step(
                Input::Refresh {
                    request_id: 1,
                    force: true,
                },
                100_000,
            )
            .unwrap();
        let published = pipeline
            .step(
                Input::Complete {
                    token: schedule_token(&first),
                    result: json!({"games":[live_game()],"at":100000,"league":"nfl"}),
                },
                100_000,
            )
            .unwrap();
        assert!(
            published
                .launch
                .iter()
                .any(|effect| matches!(effect, Effect::Listing { .. }))
        );
    }
    #[test]
    fn fixture_sources_can_change_without_reopening_the_store() {
        let mut pipeline = Pipeline::open(
            ":memory:",
            r#"{"sources":[],"schedules":[],"fixtureOperations":["sources"],"now":100000}"#,
        )
        .unwrap();
        let input: Input = serde_json::from_value(json!({"kind":"configure","sources":[{"id":"source","url":"https://example.com/","family":"unknown","parserVersion":9}]})).unwrap();
        pipeline.step(input, 100_000).unwrap();
        assert_eq!(pipeline.config.sources[0].parser_version, Some(9));
        assert!(pipeline.revision > 0);
    }
    fn live_game() -> Game {
        serde_json::from_value(json!({"id":"game","league":"nfl","name":"Away at Home","home":{"name":"Home","short":"Home","abbreviation":"H","color":"000000","score":null},"away":{"name":"Away","short":"Away","abbreviation":"A","color":"ffffff","score":null},"redzone":false,"status":"in","lifecycle":"live","detail":"Live","partitions":["nfl"]})).unwrap()
    }
    #[test]
    fn active_viewing_uses_the_shared_verification_capacity() {
        let mut pipeline = pipeline();
        pipeline.config.probe_concurrency = 16;
        pipeline.config.sources = vec![
            serde_json::from_value(
                json!({"id":"source","url":"https://example.com/","family":"unknown"}),
            )
            .unwrap(),
        ];
        pipeline
            .store
            .save_partition(
                "nfl",
                &Partition {
                    games: vec![live_game()],
                    at: 100_000,
                    week: None,
                },
            )
            .unwrap();
        pipeline.rebuild(100_000).unwrap();
        pipeline.candidates.insert(
            "game".into(),
            (1..=8)
                .map(|index| Candidate {
                    id: format!("candidate-{index}"),
                    game_id: "game".into(),
                    label: format!("Server {index}"),
                    source_ids: vec!["source".into()],
                    observed_at: 100_000,
                    locator: CandidateLocator::Streameast {
                        channel_id: index.to_string(),
                    },
                })
                .collect(),
        );
        let batch = pipeline
            .step(
                Input::Command {
                    request_id: 1,
                    value: Command::Open {
                        game_id: "game".into(),
                        manual: true,
                        request_id: None,
                        initial_candidate_id: None,
                    },
                },
                100_000,
            )
            .unwrap();
        let token = batch
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::FlushProbes { token } => Some(*token),
                _ => None,
            })
            .unwrap();
        let batch = pipeline
            .step(
                Input::Complete {
                    token,
                    result: json!({}),
                },
                100_000,
            )
            .unwrap();
        assert_eq!(
            batch
                .launch
                .iter()
                .filter(|effect| matches!(effect, Effect::Verify { .. }))
                .count(),
            4
        );
    }
    #[test]
    fn an_empty_owner_stops_without_an_external_cleanup_adapter() {
        let mut pipeline =
            Pipeline::open(":memory:", r#"{"schedules":[],"sources":[],"now":100000}"#).unwrap();
        let stopped = pipeline
            .step(
                Input::Command {
                    request_id: 1,
                    value: Command::Stop,
                },
                100_000,
            )
            .unwrap();
        assert!(stopped.launch.is_empty());
        assert_eq!(stopped.replies.len(), 1);
        assert_eq!(stopped.replies[0].request_id, 1);
    }
    fn pipeline() -> Pipeline {
        Pipeline::open(":memory:",&json!({"sources":[],"fixtureOperations":["closeSchedule"],"now":100000,"schedules":[{"id":"nfl","league":"nfl","path":"nfl","group":null}]}).to_string()).unwrap()
    }
    fn schedule_token(batch: &Batch) -> Token {
        batch
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::Schedule { token, .. } => Some(*token),
                _ => None,
            })
            .unwrap()
    }
    #[test]
    fn forced_refresh_callers_join_exactly_one_following_pass() {
        let mut pipeline = pipeline();
        let first = pipeline
            .step(
                Input::Refresh {
                    request_id: 1,
                    force: true,
                },
                100_000,
            )
            .unwrap();
        assert!(
            pipeline
                .step(
                    Input::Refresh {
                        request_id: 2,
                        force: true
                    },
                    100_001
                )
                .unwrap()
                .launch
                .is_empty()
        );
        assert!(
            pipeline
                .step(
                    Input::Refresh {
                        request_id: 3,
                        force: true
                    },
                    100_002
                )
                .unwrap()
                .launch
                .is_empty()
        );
        let second = pipeline
            .step(
                Input::Complete {
                    token: schedule_token(&first),
                    result: json!({"games":[],"at":0,"league":"nfl"}),
                },
                100_100,
            )
            .unwrap();
        assert_eq!(
            second
                .replies
                .iter()
                .map(|reply| reply.request_id)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            second
                .launch
                .iter()
                .filter(|effect| matches!(effect, Effect::Schedule { .. }))
                .count(),
            1
        );
        let done = pipeline
            .step(
                Input::Complete {
                    token: schedule_token(&second),
                    result: json!({"games":[],"at":0,"league":"nfl"}),
                },
                100_200,
            )
            .unwrap();
        assert_eq!(
            done.replies
                .iter()
                .map(|reply| reply.request_id)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(done.launch.is_empty());
    }
    #[test]
    fn schedule_progress_is_saved_at_acceptance_time_before_refresh_settles() {
        let mut pipeline = pipeline();
        let launched = pipeline
            .step(
                Input::Refresh {
                    request_id: 1,
                    force: true,
                },
                100_000,
            )
            .unwrap();
        let progress = pipeline
            .step(
                Input::Progress {
                    token: schedule_token(&launched),
                    value: json!({"games":[],"at":1,"league":"nfl"}),
                },
                150_000,
            )
            .unwrap();
        assert!(progress.replies.is_empty());
        assert_eq!(
            pipeline.store.partition("nfl").unwrap().unwrap().at,
            150_000
        );
    }
    #[test]
    fn stopping_waits_for_owned_effects_and_ignores_their_late_results() {
        let mut pipeline = pipeline();
        let started = pipeline
            .step(
                Input::Refresh {
                    request_id: 1,
                    force: true,
                },
                100_000,
            )
            .unwrap();
        let schedule = schedule_token(&started);
        let stopping = pipeline
            .step(
                Input::Command {
                    request_id: 2,
                    value: Command::Stop,
                },
                100_001,
            )
            .unwrap();
        assert_eq!(stopping.cancel, vec![schedule]);
        assert!(!stopping.replies.iter().any(|reply| reply.request_id == 2));
        let close = stopping
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::CloseSchedule { token } => Some(*token),
                _ => None,
            })
            .unwrap();
        let late = pipeline
            .step(
                Input::Complete {
                    token: schedule,
                    result: json!({"games":[],"at":1}),
                },
                100_002,
            )
            .unwrap();
        assert!(late.replies.is_empty());
        assert!(pipeline.store.partition("nfl").unwrap().is_none());
        let stopped = pipeline
            .step(
                Input::Complete {
                    token: close,
                    result: Value::Null,
                },
                100_003,
            )
            .unwrap();
        assert_eq!(stopped.replies.len(), 1);
        assert_eq!(stopped.replies[0].request_id, 2);
    }
}
