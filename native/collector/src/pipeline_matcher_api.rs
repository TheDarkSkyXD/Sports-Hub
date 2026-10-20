use crate::pipeline::{
    matching::{
        FinishedGameMatcher, MatchMode, ObservationMatcher, SourceEventEvidence, SourceEventMatcher,
    },
    model::{Game, Observation, SourceEventBinding},
};
use napi_derive::napi;
use parking_lot::Mutex;
use serde::Deserialize;

#[cfg_attr(test, allow(dead_code))]
enum PreparedMatcher {
    Observation(ObservationMatcher),
    Source(SourceEventMatcher),
    Finished(FinishedGameMatcher),
}

#[napi]
pub struct NativeMatcher {
    inner: Mutex<PreparedMatcher>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatcherInput {
    observation: Observation,
    now: Option<i64>,
    fresh_until: Option<i64>,
    evidence: Option<SourceEventEvidence>,
    expected_game_id: Option<String>,
    event_id: Option<String>,
    #[serde(default)]
    bindings: Vec<SourceEventBinding>,
    operation: Option<String>,
}

#[napi]
impl NativeMatcher {
    #[napi]
    pub fn call(&self, input_json: String) -> napi::Result<String> {
        let mut value: serde_json::Value = serde_json::from_str(&input_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        if value["observation"]["rawTime"].is_null() {
            value["observation"]["rawTime"] = serde_json::Value::String(String::new());
        }
        let input: MatcherInput = serde_json::from_value(value)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let now = input.now.unwrap_or(input.observation.observed_at);
        let output = match &mut *self.inner.lock() {
            PreparedMatcher::Observation(matcher) => serde_json::to_value(
                matcher.match_observation(&input.observation, now, input.fresh_until),
            ),
            PreparedMatcher::Source(matcher) => {
                let evidence = input.evidence.ok_or_else(|| {
                    napi::Error::from_reason("Source matcher requires event evidence")
                })?;
                serde_json::to_value(matcher.match_event(
                    &input.observation,
                    &evidence,
                    now,
                    input.fresh_until,
                ))
            }
            PreparedMatcher::Finished(matcher) => match input.operation.as_deref() {
                Some("finishedBoundEvent") => {
                    serde_json::to_value(matcher.finished_bound_event(
                        &input.observation,
                        input.event_id.as_deref().ok_or_else(|| {
                            napi::Error::from_reason("Bound event requires eventId")
                        })?,
                        &input.bindings,
                    ))
                }
                _ => serde_json::to_value(matcher.finished_game_id(
                    &input.observation,
                    now,
                    input.expected_game_id.as_deref(),
                )),
            },
        }
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
    }
}

#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn create_native_matcher(
    kind: String,
    games_json: String,
    mode: Option<String>,
) -> napi::Result<NativeMatcher> {
    let games: Vec<Game> = serde_json::from_str(&games_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let mode = match mode.as_deref() {
        None | Some("current") => MatchMode::Current,
        Some("inventory-live") => MatchMode::InventoryLive,
        _ => return Err(napi::Error::from_reason("Invalid matcher mode")),
    };
    let inner = match kind.as_str() {
        "observation" => PreparedMatcher::Observation(ObservationMatcher::new(&games, mode)),
        "source" => PreparedMatcher::Source(SourceEventMatcher::new(&games, mode)),
        "finished" => PreparedMatcher::Finished(FinishedGameMatcher::new(&games)),
        _ => return Err(napi::Error::from_reason("Invalid matcher kind")),
    };
    Ok(NativeMatcher {
        inner: Mutex::new(inner),
    })
}
