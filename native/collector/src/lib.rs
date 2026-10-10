fn compile_fixed_pattern(expression: &str) -> regex::Regex {
    regex::Regex::new(expression).expect("fixed collector expression")
}

macro_rules! cached_regex {
    ($expression:literal $(,)?) => {{
        static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        Ok::<regex::Regex, regex::Error>(
            PATTERN
                .get_or_init(|| crate::compile_fixed_pattern($expression))
                .clone(),
        )
    }};
}

pub mod browser;
pub mod detail_html;
pub mod detail_json;
pub mod error;
pub mod event_policy;
pub mod html;
pub mod http;
pub mod listing_html;
pub mod listing_json;
pub mod registry;
pub mod resolver;
pub mod sweep;
pub mod time;
pub mod types;
pub mod wrestling;

use napi_derive::napi;
use parking_lot::Mutex;
use registry::SourceRegistry;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};
use tokio_util::sync::CancellationToken;

static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();

pub(crate) fn runtime() -> Result<&'static tokio::runtime::Runtime, error::CollectorError> {
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .max_blocking_threads(4)
                .thread_name("sports-hub-collector")
                .enable_all()
                .build()
                .map_err(|failure| failure.to_string())
        })
        .as_ref()
        .map_err(|failure| {
            error::CollectorError::InvalidState(format!("collector runtime unavailable: {failure}"))
        })
}

pub struct CatalogSnapshot {
    pub body: String,
    pub at: i64,
}

pub struct SportsfeedEvent {
    pub team_a: String,
    pub team_b: String,
    pub at: i64,
}

pub struct CollectorState {
    pub registry: Arc<SourceRegistry>,
    pub catalogs: HashMap<String, CatalogSnapshot>,
    pub sportsfeed_events: HashMap<String, SportsfeedEvent>,
    pub inflight: HashMap<u32, CancellationToken>,
    pub next_request_id: u32,
    pub resolvers: HashMap<u32, resolver::Resolver>,
    pub next_resolver_id: u32,
    pub sweeps: HashMap<u32, sweep::BrowserSweep>,
    pub next_sweep_id: u32,
}

fn parse_json<T: DeserializeOwned>(value: &str) -> napi::Result<T> {
    serde_json::from_str(value).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn json_string<T: Serialize>(value: &T) -> napi::Result<String> {
    serde_json::to_string(value).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn epoch_ms(value: f64) -> napi::Result<i64> {
    if !value.is_finite() || value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0 {
        return Err(napi::Error::from_reason("invalid collector timestamp"));
    }
    Ok(value as i64)
}

fn helper_arg<T: DeserializeOwned>(args: &[Value], index: usize) -> napi::Result<T> {
    let value = args.get(index).cloned().ok_or_else(|| {
        napi::Error::from_reason(format!("missing browser helper argument {index}"))
    })?;
    serde_json::from_value(value).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn category_value<Event: Serialize>(result: browser::CategoryResult<Event>) -> Value {
    match result.failure {
        Some(reason) => json!({
            "kind":"failed", "reason":reason, "events":result.events,
            "rejectedGames":result.rejected_games, "catalogIssues":result.catalog_issues,
        }),
        None => json!({
            "kind":"collected", "events":result.events,
            "rejectedGames":result.rejected_games, "catalogIssues":result.catalog_issues,
        }),
    }
}

fn outcome_json(outcome: types::ReadOutcome) -> String {
    let value = match outcome {
        types::ReadOutcome::Complete(body) => json!({"kind":"complete","body":body}),
        types::ReadOutcome::Partial { body, failure } => {
            json!({"kind":"partial","body":body,"failure":failure})
        }
        types::ReadOutcome::Failed(failure) => json!({"kind":"failed","failure":failure}),
    };
    value.to_string()
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ResolverReadResult {
    ReadOk { body: String },
    ReadFailed { error: resolver::ResolveFailure },
}

#[napi]
pub struct Collector {
    state: Arc<Mutex<CollectorState>>,
    http: http::HttpBackend,
}

impl Drop for Collector {
    fn drop(&mut self) {
        let state = self.state.lock();
        for token in state.inflight.values() {
            token.cancel();
        }
    }
}

#[napi]
impl Collector {
    #[napi(constructor)]
    pub fn new(registry_json: String, fixture_mode: Option<bool>) -> napi::Result<Self> {
        let registry = SourceRegistry::parse(&registry_json)?;
        let http = http::HttpBackend::new(fixture_mode.unwrap_or(false))?;
        Ok(Self {
            state: Arc::new(Mutex::new(CollectorState {
                registry: Arc::new(registry),
                catalogs: HashMap::new(),
                sportsfeed_events: HashMap::new(),
                inflight: HashMap::new(),
                next_request_id: 1,
                resolvers: HashMap::new(),
                next_resolver_id: 1,
                sweeps: HashMap::new(),
                next_sweep_id: 1,
            })),
            http,
        })
    }

    #[napi]
    pub fn source_count(&self) -> u32 {
        self.state.lock().registry.sources().len() as u32
    }

    #[napi]
    pub fn begin_request(&self) -> napi::Result<u32> {
        let mut state = self.state.lock();
        let id = state.next_request_id;
        state.next_request_id = id
            .checked_add(1)
            .ok_or_else(|| napi::Error::from_reason("request ID exhausted"))?;
        state.inflight.insert(id, CancellationToken::new());
        Ok(id)
    }

    #[napi]
    pub fn cancel_request(&self, id: u32) {
        if let Some(token) = self.state.lock().inflight.remove(&id) {
            token.cancel();
        }
    }

    #[napi]
    pub fn read_html<'env>(
        &self,
        env: &'env napi::Env,
        request_id: u32,
        url: String,
    ) -> napi::Result<napi::bindgen_prelude::Object<'env>> {
        let token = self
            .state
            .lock()
            .inflight
            .get(&request_id)
            .cloned()
            .ok_or_else(|| napi::Error::from_reason("unknown collector request"))?;
        let (deferred, promise) = env.create_deferred::<String, _>()?;
        let runtime = runtime()?;
        let state = self.state.clone();
        let http = self.http.clone();
        runtime.spawn(async move {
            let outcome = http::read_html_with(&http, &state, &url, &token).await;
            state.lock().inflight.remove(&request_id);
            let value = outcome_json(outcome);
            deferred.resolve(move |_| Ok(value));
        });
        Ok(promise)
    }

    #[napi]
    pub fn enqueue_fixture(&self, script_json: String) -> napi::Result<()> {
        let fixture = self
            .http
            .fixture()
            .ok_or_else(|| napi::Error::from_reason("collector is not in fixture mode"))?;
        fixture.enqueue_script(parse_json(&script_json)?)?;
        Ok(())
    }

    #[napi]
    pub fn fixture_requests(&self) -> napi::Result<String> {
        let fixture = self
            .http
            .fixture()
            .ok_or_else(|| napi::Error::from_reason("collector is not in fixture mode"))?;
        json_string(&fixture.requests())
    }

    #[napi]
    pub fn fixture_cancels(&self) -> napi::Result<String> {
        let fixture = self
            .http
            .fixture()
            .ok_or_else(|| napi::Error::from_reason("collector is not in fixture mode"))?;
        json_string(&fixture.cancels())
    }

    #[napi]
    pub fn parse_listings(
        &self,
        source_json: String,
        body: String,
        now: f64,
    ) -> napi::Result<String> {
        let source: types::ListingSource = parse_json(&source_json)?;
        let at = epoch_ms(now)?;
        let registry = { self.state.lock().registry.clone() };
        let result = listing_json::parse_json(&source, &body, at)
            .or_else(|| listing_html::parse_html(&source, &body, at, &registry))
            .unwrap_or(types::ListingResult {
                observations: Vec::new(),
                outcome: types::ListingOutcome::Unsupported,
            });
        http::remember_listing(&self.state, &source.id, &body, &result);
        json_string(&result)
    }

    #[napi]
    pub fn enrich_observation(&self, row_json: String, body: String) -> napi::Result<String> {
        let row: types::Observation = parse_json(&row_json)?;
        json_string(&detail_html::enrich_html_observation(&row, &body).unwrap_or(row))
    }

    #[napi]
    pub fn compatible_players(
        &self,
        game_id: String,
        row_json: String,
        body: String,
    ) -> napi::Result<String> {
        let row: types::Observation = parse_json(&row_json)?;
        let players =
            if let Some(players) = detail_json::compatible_json_players(&game_id, &row, &body) {
                players
            } else {
                let registry = { self.state.lock().registry.clone() };
                detail_html::compatible_html_players(&game_id, &row, &body, &registry)
                    .unwrap_or_default()
            };
        json_string(&players)
    }

    #[napi]
    pub fn missing_player_reason(&self, row_json: String, body: String) -> napi::Result<String> {
        let row: types::Observation = parse_json(&row_json)?;
        let reason = detail_json::missing_json_reason(&row, &body)
            .or_else(|| detail_html::missing_html_reason(&row, &body))
            .unwrap_or(types::MissingPlayerReason::NoCompatibleMedia);
        json_string(&reason)
    }

    #[napi]
    pub fn allowed_discovery_url(&self, value: String) -> bool {
        let registry = { self.state.lock().registry.clone() };
        http::allowed_discovery_url(&value, &registry)
    }

    #[napi]
    pub fn digest(&self, value: String) -> String {
        time::digest(&value)
    }

    #[napi]
    pub fn parse_kickoff(&self, value: String) -> Option<f64> {
        time::parse_kickoff(&value).map(|value| value as f64)
    }

    #[napi]
    pub fn browser_helper(
        &self,
        kind: String,
        helper: String,
        args_json: String,
    ) -> napi::Result<String> {
        let args: Vec<Value> = parse_json(&args_json)?;
        let registry = { self.state.lock().registry.clone() };
        let value = match (kind.as_str(), helper.as_str()) {
            ("sportsurge-v2", "detailUrl") => {
                let pair = browser::sportsurge_detail_url(
                    &helper_arg::<String>(&args, 0)?,
                    helper_arg::<types::League>(&args, 1)?,
                    &registry,
                );
                pair.map_or(Value::Null, |(id, url)| json!({"id":id,"url":url}))
            }
            ("sportsurge-v2", "destination") => {
                json!(browser::sportsurge_destination(&helper_arg::<String>(
                    &args, 0
                )?))
            }
            ("sportsurge-v2", "parseCategory") => category_value(browser::sportsurge_category(
                &helper_arg::<String>(&args, 0)?,
                helper_arg::<types::League>(&args, 1)?,
                &registry,
            )),
            ("sportsurge-v2", "parseDetail") => json!(browser::sportsurge_detail(
                &helper_arg::<String>(&args, 0)?,
                &helper_arg::<browser::SportsurgeEvent>(&args, 1)?,
                helper_arg::<i64>(&args, 2)?,
            )),
            ("streameast", "eventUrl") => json!(browser::streameast_event_url(
                &helper_arg::<String>(&args, 0)?,
                helper_arg::<types::League>(&args, 1)?,
                &registry,
            )),
            ("streameast", "serverUrl") => {
                let pair = browser::streameast_server_url(
                    &helper_arg::<String>(&args, 0)?,
                    &helper_arg::<browser::StreameastEvent>(&args, 1)?,
                );
                pair.map_or(Value::Null, |(url, id)| json!({"url":url,"id":id}))
            }
            ("streameast", "parseCategory") => {
                let result = browser::streameast_category(
                    &helper_arg::<String>(&args, 0)?,
                    helper_arg::<types::League>(&args, 1)?,
                    &registry,
                );
                match result.failure {
                    Some(reason) => json!({"kind":"failed","reason":reason,
                        "events":result.events,"rejectedGames":result.rejected_games}),
                    None => json!({"kind":"collected",
                        "events":result.events,"rejectedGames":result.rejected_games}),
                }
            }
            ("streameast", "parseDetail") => json!(browser::streameast_detail(
                &helper_arg::<String>(&args, 0)?,
                &helper_arg::<browser::StreameastEvent>(&args, 1)?,
                helper_arg::<i64>(&args, 2)?,
                &helper_arg::<Vec<(String, browser::ServerPlayer)>>(&args, 3)?
                    .into_iter()
                    .collect::<HashMap<_, _>>(),
            )),
            ("streameast", "freePlayer") => {
                json!(browser::streameast_free_player(&helper_arg::<String>(
                    &args, 0
                )?))
            }
            ("streameast", "publishedFreePlayer") => {
                json!(browser::streameast_published_free_player(
                    &helper_arg::<String>(&args, 0)?,
                    &helper_arg::<browser::StreameastEvent>(&args, 1)?,
                    &helper_arg::<String>(&args, 2)?,
                ))
            }
            ("streameast", "serverPlayer") => json!(browser::streameast_server_player(
                &helper_arg::<String>(&args, 0)?,
                &helper_arg::<browser::StreameastEvent>(&args, 1)?,
                &helper_arg::<String>(&args, 2)?,
            )),
            ("streameast", "freeServerUrls") => json!(browser::streameast_free_server_urls(
                &helper_arg::<String>(&args, 0)?,
                &helper_arg::<browser::StreameastEvent>(&args, 1)?,
            )),
            ("streameast", "activeFreeServerUrl") => {
                json!(browser::streameast_active_free_server_url(
                    &helper_arg::<String>(&args, 0)?,
                    &helper_arg::<browser::StreameastEvent>(&args, 1)?,
                ))
            }
            _ => return Err(napi::Error::from_reason("unknown browser collector helper")),
        };
        json_string(&value)
    }

    #[napi]
    pub fn begin_resolve(
        &self,
        game_id: String,
        row_json: String,
        body: String,
    ) -> napi::Result<String> {
        let row: types::Observation = parse_json(&row_json)?;
        let specialized = matches!(
            row.source_id.as_str(),
            "tvapp"
                | "tvapp-nba"
                | "tvapp-nhl"
                | "tvapp-mlb"
                | "streamed"
                | "livesportpro"
                | "sportsbite"
                | "sportsfeed24"
        );
        let (resolver, action) = if specialized {
            resolver::Resolver::begin(&game_id, &row, &body)
        } else {
            let (resolver, _) = resolver::Resolver::begin(&game_id, &row, &body);
            let players = if let Some(players) =
                detail_json::compatible_json_players(&game_id, &row, &body)
            {
                players
            } else if let Some(players) = detail_html::resolved_html_players(&game_id, &row, &body)
            {
                players
            } else {
                let registry = { self.state.lock().registry.clone() };
                detail_html::compatible_html_players(&game_id, &row, &body, &registry)
                    .unwrap_or_default()
            };
            (resolver, resolver::ResolveAction::Done { players })
        };
        let mut state = self.state.lock();
        let id = state.next_resolver_id;
        state.next_resolver_id = id
            .checked_add(1)
            .ok_or_else(|| napi::Error::from_reason("resolver ID exhausted"))?;
        state.resolvers.insert(id, resolver);
        drop(state);
        json_string(&json!({"id":id,"action":action}))
    }

    #[napi]
    pub fn validate_resolve_response(
        &self,
        id: u32,
        request_index: u32,
        body: String,
    ) -> napi::Result<bool> {
        let streamed = {
            let state = self.state.lock();
            let resolver = state
                .resolvers
                .get(&id)
                .ok_or_else(|| napi::Error::from_reason("unknown collector resolver"))?;
            resolver
                .requires_streamed_validation(request_index as usize)
                .map_err(napi::Error::from_reason)?
        };
        Ok(!streamed || resolver::valid_streamed_response(&body))
    }

    #[napi]
    pub fn advance_resolve(&self, id: u32, responses_json: String) -> napi::Result<String> {
        let replies: Vec<ResolverReadResult> = parse_json(&responses_json)?;
        let replies = replies
            .into_iter()
            .map(|reply| match reply {
                ResolverReadResult::ReadOk { body } => Ok(body),
                ResolverReadResult::ReadFailed { error } => Err(error),
            })
            .collect();
        let mut resolver = self
            .state
            .lock()
            .resolvers
            .remove(&id)
            .ok_or_else(|| napi::Error::from_reason("unknown collector resolver"))?;
        let action = resolver.advance(replies);
        if matches!(action, resolver::ResolveAction::ReadBatch { .. }) {
            self.state.lock().resolvers.insert(id, resolver);
        }
        json_string(&action)
    }

    #[napi]
    pub fn close_resolve(&self, id: u32) {
        self.state.lock().resolvers.remove(&id);
    }

    #[napi]
    pub fn begin_sweep(&self, kind: String, run_id: String, now: f64) -> napi::Result<String> {
        let kind: browser::BrowserKind = parse_json(&json!(kind).to_string())?;
        let registry = { self.state.lock().registry.clone() };
        let (sweep, action) = sweep::BrowserSweep::begin(&registry, kind, run_id, epoch_ms(now)?)
            .map_err(napi::Error::from_reason)?;
        let mut state = self.state.lock();
        let id = state.next_sweep_id;
        state.next_sweep_id = id
            .checked_add(1)
            .ok_or_else(|| napi::Error::from_reason("sweep ID exhausted"))?;
        state.sweeps.insert(id, sweep);
        drop(state);
        json_string(&json!({"id":id,"action":action}))
    }

    #[napi]
    pub fn advance_sweep(&self, id: u32, result_json: String, now: f64) -> napi::Result<String> {
        let result: sweep::SweepResult = parse_json(&result_json)?;
        let at = epoch_ms(now)?;
        let (mut sweep, registry) = {
            let mut state = self.state.lock();
            let registry = state.registry.clone();
            let sweep = state
                .sweeps
                .remove(&id)
                .ok_or_else(|| napi::Error::from_reason("unknown collector sweep"))?;
            (sweep, registry)
        };
        let action = sweep
            .advance(&registry, result, at)
            .map_err(napi::Error::from_reason)?;
        if !matches!(
            action,
            sweep::SweepAction::Done { .. } | sweep::SweepAction::Failed { .. }
        ) {
            self.state.lock().sweeps.insert(id, sweep);
        }
        json_string(&action)
    }

    #[napi]
    pub fn close_sweep(&self, id: u32) {
        self.state.lock().sweeps.remove(&id);
    }
}
