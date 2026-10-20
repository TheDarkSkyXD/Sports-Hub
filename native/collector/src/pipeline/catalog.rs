use super::model::{Candidate, Game, Observation, SourceEventBinding};
use crate::types::{CandidateLocator, ExpectedMatchup};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use url::Url;

pub(crate) fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub fn validate_stored_catalog(kind: &str, value: &Value) -> Result<(), String> {
    fn object(value: &Value, required: &[&str], optional: &[&str]) -> bool {
        value.as_object().is_some_and(|fields| {
            required.iter().all(|key| fields.contains_key(*key))
                && fields
                    .keys()
                    .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
        })
    }
    fn string(value: &Value, min: usize, max: usize) -> bool {
        value.as_str().is_some_and(|value| {
            let n = value.encode_utf16().count();
            n >= min && n <= max
        })
    }
    fn integer(value: &Value) -> bool {
        value
            .as_f64()
            .is_some_and(|number| number >= 0.0 && number.fract() == 0.0)
    }
    fn one(value: &Value, values: &[&str]) -> bool {
        value.as_str().is_some_and(|value| values.contains(&value))
    }
    fn uuid(value: &Value) -> bool {
        value.as_str().is_some_and(|value| {
            cached_regex!("(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
                .unwrap()
                .is_match(value)
        })
    }
    fn url(value: &Value, max: usize) -> bool {
        string(value, 1, max)
            && value
                .as_str()
                .is_some_and(|value| Url::parse(value).is_ok())
    }
    fn browser_league(value: &Value) -> bool {
        one(
            value,
            &[
                "nfl",
                "ncaaf",
                "nba",
                "wnba",
                "nhl",
                "mlb",
                "f1",
                "nascar-cup",
                "nascar-truck",
                "motogp",
                "motorsport",
                "ufc",
                "boxing",
            ],
        )
    }
    fn failure(value: &Value, surge: bool) -> bool {
        one(
            value,
            if surge {
                &[
                    "blocked",
                    "rate-limited",
                    "timeout",
                    "parser-changed",
                    "unavailable",
                    "invalid-detail-url",
                    "limit",
                ]
            } else {
                &[
                    "blocked",
                    "rate-limited",
                    "timeout",
                    "parser-changed",
                    "unavailable",
                    "limit",
                ]
            },
        )
    }
    fn category(value: &Value, surge: bool) -> bool {
        match value["kind"].as_str() {
            Some("pending") => object(value, &["kind"], &[]),
            Some("collected") => object(value, &["kind", "at"], &[]) && integer(&value["at"]),
            Some("failed") => {
                object(value, &["kind", "at", "reason"], &[])
                    && integer(&value["at"])
                    && failure(&value["reason"], surge)
            }
            _ => false,
        }
    }
    fn state(value: &Value, surge: bool) -> bool {
        match value["kind"].as_str() {
            Some("collecting") => object(value, &["kind"], &[]),
            Some("complete") => object(value, &["kind", "at"], &[]) && integer(&value["at"]),
            Some("partial") => {
                object(value, &["kind", "at", "reason"], &[])
                    && integer(&value["at"])
                    && failure(&value["reason"], surge)
            }
            _ => false,
        }
    }
    fn destination(value: &Value) -> bool {
        match value["kind"].as_str() {
            Some("link") => object(value, &["kind", "url"], &[]) && url(&value["url"], 2000),
            Some("rejected") => {
                object(value, &["kind", "reason", "display"], &[])
                    && one(
                        &value["reason"],
                        &[
                            "insecure",
                            "credentials",
                            "private-host",
                            "credential-query",
                            "oversized",
                        ],
                    )
                    && (value["display"].is_null() || string(&value["display"], 0, 240))
            }
            Some("malformed") => {
                object(value, &["kind", "reason"], &[])
                    && one(&value["reason"], &["missing", "invalid-url"])
            }
            _ => false,
        }
    }
    fn provider(value: &Value) -> bool {
        object(value, &["id", "label", "observedAt", "destination"], &[])
            && string(&value["id"], 1, 100)
            && string(&value["label"], 1, 160)
            && integer(&value["observedAt"])
            && destination(&value["destination"])
    }
    fn availability(value: &Value) -> bool {
        let channel = |value: &Value| {
            value
                .as_str()
                .is_some_and(|value| cached_regex!(r"^\d{1,4}$").unwrap().is_match(value))
        };
        match value["kind"].as_str() {
            Some("free-channel") => {
                object(value, &["kind", "channelId"], &[]) && channel(&value["channelId"])
            }
            Some("free-wikisport") => {
                object(value, &["kind", "section", "playerId"], &[])
                    && one(&value["section"], &["0nhl", "strm"])
                    && channel(&value["playerId"])
            }
            Some("free-page" | "free-unsupported" | "free-unresolved" | "premium" | "unknown") => {
                object(value, &["kind"], &[])
            }
            _ => false,
        }
    }
    fn server(value: &Value) -> bool {
        object(value, &["id", "label", "url", "availability"], &[])
            && value["id"]
                .as_str()
                .is_some_and(|v| cached_regex!(r"^\d{1,4}$").unwrap().is_match(v))
            && string(&value["label"], 1, 120)
            && url(&value["url"], 400)
            && availability(&value["availability"])
    }
    fn detail(value: &Value, surge: bool) -> bool {
        match value["kind"].as_str() {
            Some("pending") => object(value, &["kind"], &[]),
            Some("failed") => {
                object(value, &["kind", "at", "reason"], &[])
                    && integer(&value["at"])
                    && failure(&value["reason"], surge)
            }
            Some("collected") => {
                let base = if surge {
                    object(value, &["kind", "at", "providers"], &["retainedFromRunId"])
                } else {
                    object(
                        value,
                        &["kind", "at", "servers"],
                        &["retainedFromRunId", "publication"],
                    )
                };
                base && integer(&value["at"])
                    && value.get("retainedFromRunId").is_none_or(uuid)
                    && if surge {
                        value["providers"]
                            .as_array()
                            .is_some_and(|p| p.iter().all(provider))
                    } else {
                        value["servers"]
                            .as_array()
                            .is_some_and(|p| p.iter().all(server))
                            && value.get("publication").is_none_or(|p| {
                                object(p, &["premium", "unknown"], &[])
                                    && integer(&p["premium"])
                                    && integer(&p["unknown"])
                            })
                    }
            }
            _ => false,
        }
    }
    fn event(value: &Value, surge: bool) -> bool {
        let fields = if surge {
            &[
                "id",
                "url",
                "league",
                "title",
                "teams",
                "sourceStatus",
                "kickoff",
                "advertisedLinkCount",
                "detail",
            ][..]
        } else {
            &[
                "id",
                "url",
                "league",
                "title",
                "teams",
                "kickoff",
                "espnEventId",
                "detail",
            ][..]
        };
        object(value, fields, &[])
            && value["id"].as_str().is_some_and(|id| {
                id.rsplit_once(':').is_some_and(|(league, id)| {
                    browser_league(&json!(league))
                        && cached_regex!(r"^\d{1,12}$").unwrap().is_match(id)
                })
            })
            && url(&value["url"], 400)
            && browser_league(&value["league"])
            && string(&value["title"], 1, 240)
            && (value["teams"].is_null()
                || value["teams"].as_array().is_some_and(|teams| {
                    teams.len() == 2 && teams.iter().all(|team| string(team, 1, 120))
                }))
            && (value["kickoff"].is_null() || integer(&value["kickoff"]))
            && detail(&value["detail"], surge)
            && if surge {
                one(&value["sourceStatus"], &["live", "upcoming", "unknown"])
                    && (value["advertisedLinkCount"].is_null()
                        || integer(&value["advertisedLinkCount"]))
            } else {
                value["espnEventId"].is_null()
                    || value["espnEventId"]
                        .as_str()
                        .is_some_and(|id| cached_regex!(r"^\d{5,12}$").unwrap().is_match(id))
            }
    }
    fn rejected(value: &Value, issue: bool) -> bool {
        object(value, &["league", "title", "reason"], &[])
            && browser_league(&value["league"])
            && string(&value["title"], 0, 240)
            && if issue {
                value["reason"] == "duplicate-game-id"
            } else {
                one(
                    &value["reason"],
                    &["invalid-detail-url", "duplicate-game-id"],
                )
            }
    }
    let surge = match kind {
        "sportsurge-v2" => true,
        "streameast" => false,
        _ => return Err("invalid-catalog-kind".into()),
    };
    let catalog = &value["catalog"];
    let fields = if surge {
        &[
            "runId",
            "sequence",
            "startedAt",
            "state",
            "categories",
            "events",
            "rejectedGames",
            "catalogIssues",
        ][..]
    } else {
        &[
            "runId",
            "sequence",
            "startedAt",
            "state",
            "categories",
            "events",
            "rejectedGames",
        ][..]
    };
    let valid = object(value, &["catalog", "receivedAt"], &[])
        && integer(&value["receivedAt"])
        && object(catalog, fields, &[])
        && uuid(&catalog["runId"])
        && integer(&catalog["sequence"])
        && integer(&catalog["startedAt"])
        && state(&catalog["state"], surge)
        && catalog["categories"].as_object().is_some_and(|categories| {
            categories.contains_key("nfl")
                && categories.contains_key("ncaaf")
                && categories
                    .iter()
                    .all(|(league, value)| browser_league(&json!(league)) && category(value, surge))
        })
        && catalog["events"]
            .as_array()
            .is_some_and(|events| events.iter().all(|value| event(value, surge)))
        && catalog["rejectedGames"]
            .as_array()
            .is_some_and(|events| events.iter().all(|value| rejected(value, false)))
        && (!surge
            || catalog["catalogIssues"]
                .as_array()
                .is_some_and(|issues| issues.iter().all(|value| rejected(value, true))));
    if valid {
        Ok(())
    } else {
        Err("invalid-stored-catalog".into())
    }
}

#[cfg(test)]
mod storage_validation_tests {
    use super::*;
    #[test]
    fn persisted_catalog_schema_rejects_missing_unknown_and_malformed_fields() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-store.json"
        ))
        .unwrap();
        for (kind, operation) in [
            ("sportsurge-v2", "saveSportsurgeCatalog"),
            ("streameast", "saveStreameastCatalog"),
        ] {
            let catalog = fixture["steps"]
                .as_array()
                .unwrap()
                .iter()
                .find(|step| step["operation"] == operation)
                .unwrap()["args"][0]
                .clone();
            assert!(validate_stored_catalog(kind, &catalog).is_ok());
            let mut malformed = catalog.clone();
            malformed.as_object_mut().unwrap().remove("receivedAt");
            assert!(validate_stored_catalog(kind, &malformed).is_err());
            malformed = catalog.clone();
            malformed["extra"] = json!(true);
            assert!(validate_stored_catalog(kind, &malformed).is_err());
            malformed = catalog.clone();
            malformed["catalog"]["categories"] = json!({"nfl":{"kind":"pending"}});
            assert!(validate_stored_catalog(kind, &malformed).is_err());
            malformed = catalog.clone();
            malformed["catalog"]["runId"] = json!("invalid");
            assert!(validate_stored_catalog(kind, &malformed).is_err());
        }
    }
}
pub(crate) fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub(crate) fn number(value: &Value) -> i64 {
    value.as_i64().unwrap_or(0)
}
pub(crate) fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}
pub(crate) fn encode<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}
pub(crate) fn iso(at: i64) -> Result<String, String> {
    chrono::DateTime::from_timestamp_millis(at)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| "invalid-timestamp".into())
}

pub fn event_observation(kind: &str, event: &Value, at: i64) -> Result<Observation, String> {
    decode(
        &json!({"id":format!("{kind}:{}",text(&event["url"])),"sourceId":kind,
        "url":event["url"],"title":event["title"],"league":event["league"],
        "teams":event["teams"],"kickoff":event["kickoff"],
        "rawTime":event["kickoff"].as_i64().map(iso).transpose()?.unwrap_or_default(),
        "observedAt":at,"parserVersion":1}),
    )
}

pub fn event_evidence(kind: &str, event: &Value, now: i64) -> Value {
    if kind == "sportsurge-v2" {
        let detail = &event["detail"];
        let live = event["sourceStatus"] == "live";
        json!({"undated":if live && detail["kind"]=="collected" && number(&detail["at"])<=now+60_000 &&
            now-number(&detail["at"])<=1_860_000 {"retained-live-detail"} else if live {"live-claim"} else {"published-listing"},
            "externalGameId":null})
    } else {
        let id = event["espnEventId"].as_str().map(|id| {
            if event["league"] == "nfl" {
                id.to_owned()
            } else {
                format!("{}-{id}", text(&event["league"]))
            }
        });
        json!({"undated":"none","externalGameId":id})
    }
}

pub fn same_event(kind: &str, left: &Value, right: &Value) -> bool {
    let common = ["id", "url", "league", "title", "kickoff", "teams"];
    common.iter().all(|key| left[*key] == right[*key])
        && if kind == "sportsurge-v2" {
            left["sourceStatus"] == right["sourceStatus"]
                && left["advertisedLinkCount"] == right["advertisedLinkCount"]
        } else {
            left["espnEventId"] == right["espnEventId"]
        }
}

fn row_identity(event_url: &str, provider_id: &str, destination: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(event_url);
    digest.update([0]);
    digest.update(provider_id);
    digest.update([0]);
    digest.update(destination);
    hex::encode(digest.finalize())[..24].to_owned()
}

pub fn event_candidates(
    kind: &str,
    event: &Value,
    game_id: &str,
) -> Result<Vec<Candidate>, String> {
    if event["detail"]["kind"] != "collected" {
        return Ok(vec![]);
    }
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let detail = &event["detail"];
    if kind == "sportsurge-v2" {
        for provider in rows(&detail["providers"]) {
            if provider["destination"]["kind"] != "link" || provider["observedAt"] != detail["at"] {
                continue;
            }
            let id = format!(
                "sportsurge-v2:{}",
                row_identity(
                    text(&event["url"]),
                    text(&provider["id"]),
                    text(&provider["destination"]["url"])
                )
            );
            let expected_matchup = if event["teams"].is_null() {
                None
            } else {
                Some(ExpectedMatchup {
                    league: decode(&event["league"])?,
                    teams: decode(&event["teams"])?,
                    kickoff: event["kickoff"].as_i64(),
                })
            };
            let candidate = Candidate {
                id: id.clone(),
                game_id: game_id.into(),
                label: format!("Sportsurge v2 · {}", text(&provider["label"])),
                source_ids: vec![kind.into()],
                observed_at: number(&detail["at"]),
                locator: CandidateLocator::SportsurgeV2 {
                    event_id: text(&event["id"]).into(),
                    provider_id: text(&provider["id"]).into(),
                    url: text(&provider["destination"]["url"]).into(),
                    expected_matchup,
                },
            };
            if let Some(index) = candidates.iter().position(|row: &Candidate| row.id == id) {
                candidates[index] = candidate;
            } else {
                candidates.push(candidate);
            }
        }
    } else {
        for server in rows(&detail["servers"]) {
            let availability = &server["availability"];
            let (id, locator) = match text(&availability["kind"]) {
                "free-channel" => (
                    format!("streameast:{}", text(&availability["channelId"])),
                    CandidateLocator::Streameast {
                        channel_id: text(&availability["channelId"]).into(),
                    },
                ),
                "free-wikisport" => (
                    format!(
                        "wikisport:{}:{}",
                        text(&availability["section"]),
                        text(&availability["playerId"])
                    ),
                    CandidateLocator::Wikisport {
                        section: text(&availability["section"]).into(),
                        player_id: text(&availability["playerId"]).into(),
                    },
                ),
                "free-page" => (
                    format!(
                        "streameast-server:{}:{}",
                        text(&event["id"]),
                        text(&server["id"])
                    ),
                    CandidateLocator::StreameastServer {
                        game_id: game_id.into(),
                        source_event_id: text(&event["id"]).into(),
                        event_url: text(&event["url"]).into(),
                        server_id: text(&server["id"]).into(),
                    },
                ),
                _ => continue,
            };
            if seen.insert(id.clone()) {
                candidates.push(Candidate {
                    id,
                    game_id: game_id.into(),
                    label: format!("StreamEast · {}", text(&server["label"])),
                    source_ids: vec![kind.into()],
                    observed_at: number(&detail["at"]),
                    locator,
                });
            }
        }
    }
    Ok(candidates)
}

fn free_detail(detail: &Value) -> Value {
    if detail["kind"] != "collected" {
        return detail.clone();
    }
    let mut result = detail.clone();
    let servers = rows(&detail["servers"]);
    let premium = servers
        .iter()
        .filter(|server| server["availability"]["kind"] == "premium")
        .count();
    let unknown = servers
        .iter()
        .filter(|server| server["availability"]["kind"] == "unknown")
        .count();
    result["servers"] = json!(
        servers
            .iter()
            .filter(|server| text(&server["availability"]["kind"]).starts_with("free-"))
            .collect::<Vec<_>>()
    );
    if detail.get("publication").is_none() && (premium > 0 || unknown > 0) {
        result["publication"] = json!({"premium":premium,"unknown":unknown});
    }
    result
}

fn free_catalog(catalog: &Value) -> Value {
    let mut result = catalog.clone();
    if let Some(events) = result["events"].as_array_mut() {
        for event in events {
            event["detail"] = free_detail(&event["detail"]);
        }
    }
    result
}

pub fn catalog_decision(kind: &str, previous: &Value, incoming: &Value) -> &'static str {
    if previous.is_null() {
        return if incoming["sequence"] == 0 {
            "accepted"
        } else {
            "rejected"
        };
    }
    let current = &previous["catalog"];
    if current["runId"] != incoming["runId"] {
        return if incoming["sequence"] == 0
            && number(&incoming["startedAt"]) > number(&current["startedAt"])
        {
            "accepted"
        } else {
            "rejected"
        };
    }
    if incoming["startedAt"] != current["startedAt"] {
        return "rejected";
    }
    if incoming["sequence"] == current["sequence"] {
        let equal = if kind == "streameast" {
            free_catalog(incoming) == free_catalog(current)
        } else {
            incoming.to_string() == current.to_string()
        };
        return if equal { "replay" } else { "rejected" };
    }
    if number(&incoming["sequence"]) < number(&current["sequence"])
        || current["state"]["kind"] != "collecting"
    {
        "rejected"
    } else {
        "accepted"
    }
}

pub(crate) fn registry() -> &'static crate::registry::SourceRegistry {
    static REGISTRY: std::sync::OnceLock<crate::registry::SourceRegistry> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| {
        crate::registry::SourceRegistry::parse(include_str!(
            "../../../../lib/football/source-registry.json"
        ))
        .expect("source registry")
    })
}

pub fn sanitize_catalog(
    kind: &str,
    input: &Value,
    now: i64,
    history: &[Value],
    finished: &HashSet<String>,
) -> Result<Option<Value>, String> {
    let mut catalog = if kind == "streameast" {
        free_catalog(input)
    } else {
        input.clone()
    };
    let categories = catalog["categories"]
        .as_object()
        .ok_or("invalid-catalog-categories")?;
    if categories.keys().any(|league| {
        decode(&json!(league))
            .ok()
            .and_then(|league| registry().browser_category(kind, league))
            .is_none()
    }) {
        return Ok(None);
    }
    let started = number(&catalog["startedAt"]);
    let current = |at: i64| at >= started && at <= now + 60_000;
    if kind == "streameast" {
        if started > now + 60_000 || started < now - 86_400_000 {
            return Ok(None);
        }
        if catalog["state"]["kind"] != "collecting" && !current(number(&catalog["state"]["at"])) {
            return Ok(None);
        }
        for (league, category) in categories {
            if category["kind"] == "pending" || current(number(&category["at"])) {
                continue;
            }
            let reused = category["kind"] == "collected"
                && history.iter().any(|stored| {
                    let prior = &stored["catalog"];
                    let previous: Vec<_> = rows(&prior["events"])
                        .iter()
                        .filter(|event| event["league"] == *league)
                        .collect();
                    let incoming: Vec<_> = rows(&catalog["events"])
                        .iter()
                        .filter(|event| event["league"] == *league)
                        .collect();
                    prior["categories"][league]["kind"] == "collected"
                        && prior["categories"][league]["at"] == category["at"]
                        && incoming
                            .iter()
                            .all(|event| previous.iter().any(|old| same_event(kind, event, old)))
                        && previous.iter().all(|event| {
                            incoming.iter().any(|new| same_event(kind, event, new))
                                || finished.contains(text(&event["id"]))
                        })
                });
            if !reused {
                return Ok(None);
            }
        }
    }
    let mut latest = started;
    for category in categories.values() {
        if category["kind"] != "pending" {
            latest = latest.max(number(&category["at"]));
        }
    }
    let mut urls = HashSet::new();
    let mut ids = HashSet::new();
    let event_copy = rows(&catalog["events"]).to_vec();
    for event in &event_copy {
        let url = match Url::parse(text(&event["url"])) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let league = decode(&event["league"])?;
        let Some(category_config) = registry().browser_category(kind, league) else {
            return Ok(None);
        };
        let category = &catalog["categories"][text(&event["league"])];
        if category.is_null()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !urls.insert(url.to_string())
        {
            return Ok(None);
        }
        if kind == "sportsurge-v2" {
            let pattern =
                cached_regex!(r"^/watch-(\d{1,12})-([a-z0-9]+)-[a-z0-9]+(?:-[a-z0-9]+)*/$")
                    .unwrap();
            let Some(captures) = pattern.captures(url.path()) else {
                return Ok(None);
            };
            let valid_path = if event["league"] == "nascar-cup" {
                cached_regex!(
                    r"^/watch-[0-9]{1,12}-nascar-nascar-cup-series-at-[a-z0-9]+(?:-[a-z0-9]+)*/$"
                )
                .unwrap()
                .is_match(url.path())
            } else {
                category_config.path_code.as_deref() == Some(&captures[2])
            };
            if url.origin().ascii_serialization() != "https://v2.sportsurge.net"
                || text(&event["id"]) != format!("{}:{}", text(&event["league"]), &captures[1])
                || !valid_path
            {
                return Ok(None);
            }
        } else {
            let pattern = cached_regex!(r"^/([a-z0-9-]+)/([a-z0-9]+(?:-[a-z0-9]+)*)/$").unwrap();
            let Some(captures) = pattern.captures(url.path()) else {
                return Ok(None);
            };
            if url.origin().ascii_serialization() != "https://v2.streameast.ga"
                || category_config.path_code.as_deref() != Some(&captures[1])
                || !text(&event["id"]).starts_with(&format!("{}:", text(&event["league"])))
                || !ids.insert(text(&event["id"]).to_owned())
            {
                return Ok(None);
            }
            if event["league"] == "motorsport" {
                let pattern =
                    cached_regex!(r"^/other-events/[a-z0-9]+(?:-[a-z0-9]+)*-([0-9]{10})/$")
                        .unwrap();
                if pattern
                    .captures(url.path())
                    .and_then(|captures| captures[1].parse::<i64>().ok())
                    .map(|value| value * 1000)
                    != event["kickoff"].as_i64()
                    || !event["teams"].is_null()
                {
                    return Ok(None);
                }
            }
        }
        let detail = &event["detail"];
        let retained = detail["kind"] == "collected" && detail.get("retainedFromRunId").is_some();
        if retained
            && !history.iter().any(|stored| {
                rows(&stored["catalog"]["events"]).iter().any(|prior| {
                    same_event(kind, event, prior)
                        && prior["detail"]["kind"] == "collected"
                        && detail["retainedFromRunId"]
                            == prior["detail"]
                                .get("retainedFromRunId")
                                .unwrap_or(&stored["catalog"]["runId"])
                                .clone()
                        && detail["at"] == prior["detail"]["at"]
                        && detail[if kind == "sportsurge-v2" {
                            "providers"
                        } else {
                            "servers"
                        }] == prior["detail"][if kind == "sportsurge-v2" {
                            "providers"
                        } else {
                            "servers"
                        }]
                })
            })
        {
            return Ok(None);
        }
        if kind == "streameast" && detail["kind"] != "pending" {
            if category["kind"] != "collected"
                || !retained
                    && (!current(number(&detail["at"]))
                        || number(&detail["at"]) < number(&category["at"]))
            {
                return Ok(None);
            }
            latest = latest.max(number(&detail["at"]));
        }
        if detail["kind"] != "collected" {
            continue;
        }
        let mut row_ids = HashSet::new();
        for row in rows(
            &detail[if kind == "sportsurge-v2" {
                "providers"
            } else {
                "servers"
            }],
        ) {
            if !row_ids.insert(text(&row["id"])) {
                return Ok(None);
            }
            if kind == "streameast" {
                let server = match Url::parse(text(&row["url"])) {
                    Ok(value) => value,
                    Err(_) => return Ok(None),
                };
                if server.origin() != url.origin()
                    || !server.username().is_empty()
                    || server.password().is_some()
                    || server.query().is_some()
                    || server.fragment().is_some()
                    || server.path() != format!("{}{}", url.path(), text(&row["id"]))
                {
                    return Ok(None);
                }
            }
        }
    }
    if kind == "streameast"
        && catalog["state"]["kind"] != "collecting"
        && number(&catalog["state"]["at"]) < latest
    {
        return Ok(None);
    }
    if catalog["state"]["kind"] == "complete"
        && (categories
            .values()
            .any(|category| category["kind"] != "collected")
            || event_copy
                .iter()
                .any(|event| event["detail"]["kind"] != "collected")
            || !rows(&catalog["rejectedGames"]).is_empty())
    {
        return Ok(None);
    }
    if kind == "sportsurge-v2" {
        if let Some(events) = catalog["events"].as_array_mut() {
            for event in events {
                if let Some(providers) = event
                    .get_mut("detail")
                    .and_then(|detail| detail.get_mut("providers"))
                    .and_then(Value::as_array_mut)
                {
                    for provider in providers {
                        if provider["destination"]["kind"] == "link" {
                            provider["destination"] =
                                encode(&crate::browser::sportsurge_destination(text(
                                    &provider["destination"]["url"],
                                )))?;
                        }
                    }
                }
            }
        }
    }
    Ok(Some(catalog))
}

pub fn sportsurge_candidates(input: &Value) -> Result<Value, String> {
    let games: Vec<Game> = decode(&input["games"])?;
    let now = number(&input["now"]);
    let mut matcher =
        super::matching::SourceEventMatcher::new(&games, super::matching::MatchMode::InventoryLive);
    let mut catalogs = vec![&input["current"]];
    if input["current"]["catalog"]["state"]["kind"] != "complete" {
        catalogs.extend([&input["previous"], &input["lastComplete"]]);
    }
    let mut replaced = HashSet::new();
    let mut candidates = Vec::new();
    let mut positions = std::collections::HashMap::new();
    for stored in catalogs {
        for event in rows(&stored["catalog"]["events"]) {
            let category = &stored["catalog"]["categories"][text(&event["league"])];
            let detail = &event["detail"];
            if replaced.contains(text(&event["url"]))
                || category["kind"] != "collected"
                || detail["kind"] != "collected"
            {
                continue;
            }
            let id = format!("sportsurge-v2:{}", text(&event["url"]));
            let fresh = input["detailFresh"]
                .get(&id)
                .and_then(Value::as_bool)
                .unwrap_or(now - number(&detail["at"]) < 30 * 60_000);
            if detail["retainedFromRunId"].is_null()
                && number(&detail["at"]) < number(&category["at"])
                || number(&detail["at"]) > now + 60_000
                || !fresh
            {
                continue;
            }
            replaced.insert(text(&event["url"]).to_owned());
            let observation = event_observation("sportsurge-v2", event, number(&category["at"]))?;
            let decision = matcher.match_event(
                &observation,
                &decode(&event_evidence("sportsurge-v2", event, now))?,
                now,
                input["deadlines"]
                    .get(&observation.id)
                    .and_then(Value::as_i64),
            );
            let Some(game_id) = decision.match_result().game_id() else {
                continue;
            };
            for candidate in event_candidates("sportsurge-v2", event, game_id)? {
                if let Some(index) = positions.get(&candidate.id) {
                    candidates[*index] = candidate;
                } else {
                    positions.insert(candidate.id.clone(), candidates.len());
                    candidates.push(candidate);
                }
            }
        }
    }
    encode(&candidates)
}

pub fn catalog_operation(operation: &str, args: &Value) -> Result<Value, String> {
    let a = rows(args);
    let arg = |index: usize| a.get(index).unwrap_or(&Value::Null);
    let kind = if operation.starts_with("sportsurge")
        || operation == "catalogDecision"
        || operation == "sameSportsurgeEvent"
        || operation == "sanitizeSportsurgeCatalog"
    {
        "sportsurge-v2"
    } else {
        "streameast"
    };
    match operation {
        "sportsurgeObservation" | "streameastObservation" => {
            encode(&event_observation(kind, arg(0), number(arg(1)))?)
        }
        "sportsurgeEventCandidates" | "streameastCandidates" => {
            encode(&event_candidates(kind, arg(0), text(arg(1)))?)
        }
        "sportsurgeEvidence" | "streameastEvidence" => {
            Ok(event_evidence(kind, arg(0), number(arg(1))))
        }
        "sameSportsurgeEvent" | "sameStreameastEvent" => {
            Ok(json!(same_event(kind, arg(0), arg(1))))
        }
        "catalogDecision" | "streameastDecision" => {
            Ok(json!(catalog_decision(kind, arg(0), arg(1))))
        }
        "sanitizeSportsurgeCatalog" | "sanitizeStreameastCatalog" => Ok(sanitize_catalog(
            kind,
            arg(0),
            if kind == "sportsurge-v2" {
                number(&arg(0)["startedAt"])
            } else {
                number(arg(1))
            },
            rows(arg(if kind == "sportsurge-v2" { 1 } else { 2 })),
            &decode::<HashSet<String>>(arg(3)).unwrap_or_default(),
        )?
        .unwrap_or(Value::Null)),
        "sportsurgeEventCandidate" => {
            let locator = &arg(0)["locator"];
            let id = format!(
                "sportsurge-v2:{}",
                row_identity(
                    text(&arg(1)["url"]),
                    text(&locator["providerId"]),
                    text(&locator["url"])
                )
            );
            Ok(json!(
                locator["provider"] == "sportsurge-v2"
                    && locator["eventId"] == arg(1)["id"]
                    && (arg(0)["id"] == id || text(&arg(0)["id"]).starts_with(&format!("{id}:")))
            ))
        }
        "sportsurgeCandidates" => sportsurge_candidates(arg(0)),
        "sportsurgeCatalogView" | "streameastCatalogView" => catalog_view_with_deadlines(
            kind,
            arg(0),
            &decode::<Vec<Game>>(arg(1))?,
            number(arg(2)),
            &decode::<Vec<SourceEventBinding>>(arg(3)).unwrap_or_default(),
            &decode::<std::collections::HashMap<String, i64>>(arg(4)).unwrap_or_default(),
        ),
        _ => Err(format!("unknown-catalog-operation:{operation}")),
    }
}

pub fn catalog_view(
    kind: &str,
    stored: &Value,
    games: &[Game],
    now: i64,
    bindings: &[SourceEventBinding],
) -> Result<Value, String> {
    catalog_view_with_deadlines(
        kind,
        stored,
        games,
        now,
        bindings,
        &std::collections::HashMap::new(),
    )
}

pub fn catalog_view_with_deadlines(
    kind: &str,
    stored: &Value,
    games: &[Game],
    now: i64,
    bindings: &[SourceEventBinding],
    deadlines: &std::collections::HashMap<String, i64>,
) -> Result<Value, String> {
    catalog_view_with_preparation(
        kind,
        stored,
        std::sync::Arc::new(super::matching::GamePreparation::new(games)),
        now,
        bindings,
        deadlines,
    )
}

pub fn catalog_view_with_preparation(
    kind: &str,
    stored: &Value,
    preparation: std::sync::Arc<super::matching::GamePreparation>,
    now: i64,
    bindings: &[SourceEventBinding],
    deadlines: &std::collections::HashMap<String, i64>,
) -> Result<Value, String> {
    let games = preparation.games();
    let catalog = &stored["catalog"];
    let mut views = Vec::new();
    let mut active = Vec::new();
    let mut compatible = HashSet::new();
    let finished =
        super::matching::FinishedGameMatcher::with_preparation(std::sync::Arc::clone(&preparation));
    let mut matcher = super::matching::SourceEventMatcher::with_preparation(
        std::sync::Arc::clone(&preparation),
        if kind == "sportsurge-v2" {
            super::matching::MatchMode::InventoryLive
        } else {
            super::matching::MatchMode::Current
        },
    );
    for event in rows(&catalog["events"]) {
        let category = &catalog["categories"][text(&event["league"])];
        let at = if category["kind"] == "pending" {
            number(&catalog["startedAt"])
        } else {
            number(&category["at"])
        };
        let observation = event_observation(kind, event, at)?;
        let evidence: super::matching::SourceEventEvidence =
            decode(&event_evidence(kind, event, now))?;
        if finished
            .finished_game_id(&observation, now, evidence.external_game_id.as_deref())
            .is_some()
            || kind == "sportsurge-v2"
                && finished
                    .finished_bound_event(&observation, text(&event["id"]), bindings)
                    .is_some()
        {
            continue;
        }
        let decision = encode(&matcher.match_event(
            &observation,
            &evidence,
            now,
            deadlines.get(&observation.id).copied(),
        ))?;
        let game_id = decision["gameId"].as_str();
        let mut detail = if kind == "streameast" {
            free_detail(&event["detail"])
        } else {
            event["detail"].clone()
        };
        if kind == "sportsurge-v2" {
            if let Some(providers) = detail.get_mut("providers").and_then(Value::as_array_mut) {
                for provider in providers {
                    if provider["destination"]["kind"] == "link" {
                        provider["destination"] = json!({"kind":"link"});
                    }
                }
            }
        }
        let reason = text(&decision["match"]["reason"]);
        let public_reason = match reason {
            "not-a-matchup"
            | "unknown-teams"
            | "unverified-kickoff"
            | "unverified-contextual-kickoff"
            | "ambiguous-matchup"
            | "conflicting-date"
            | "conflicting-game-id"
            | "finished-game" => reason,
            _ => "other",
        };
        let mut view = json!({"id":event["id"],"title":event["title"],"url":event["url"],"league":event["league"],"gameId":game_id,
            "matchReason":if game_id.is_some() {Value::Null} else {json!(public_reason)},"detail":detail});
        if kind == "sportsurge-v2" {
            view["sourceStatus"] = event["sourceStatus"].clone();
        }
        if let Some(game_id) = game_id {
            if kind == "streameast" && event["league"] == "motorsport" {
                if let Some(game) = games.iter().find(|game| {
                    game.id == game_id
                        && matches!(
                            game.league,
                            crate::types::League::NascarCup | crate::types::League::NascarTruck
                        )
                }) {
                    view["title"] = json!(game.name);
                    view["league"] = encode(&game.league)?;
                }
            }
            for candidate in event_candidates(kind, event, game_id)? {
                compatible.insert(format!("{game_id}:{}", candidate.id));
            }
        }
        active.push(event);
        views.push(view);
    }
    let count = |state: &str| {
        active
            .iter()
            .filter(|event| event["detail"]["kind"] == state)
            .count()
    };
    let mut result = json!({"runId":catalog["runId"],"startedAt":catalog["startedAt"],"receivedAt":stored["receivedAt"],
        "interrupted":catalog["state"]["kind"]=="collecting"&&now-number(&stored["receivedAt"])>180_000,
        "state":catalog["state"],"categories":catalog["categories"],"gameCount":active.len(),"collectedDetails":count("collected"),
        "pendingDetails":count("pending"),"failedDetails":count("failed"),"rejectedGames":catalog["rejectedGames"],"games":views});
    if kind == "sportsurge-v2" {
        let providers: Vec<_> = active
            .iter()
            .flat_map(|event| rows(&event["detail"]["providers"]))
            .collect();
        result["providerRows"] = json!(providers.len());
        result["rejectedProviders"] = json!(
            providers
                .iter()
                .filter(|provider| provider["destination"]["kind"] != "link")
                .count()
        );
        result["catalogIssues"] = catalog["catalogIssues"].clone();
    } else {
        let servers: Vec<_> = views_servers(&result).collect();
        let premium: i64 = active
            .iter()
            .map(|event| number(&free_detail(&event["detail"])["publication"]["premium"]))
            .sum();
        let unknown: i64 = active
            .iter()
            .map(|event| number(&free_detail(&event["detail"])["publication"]["unknown"]))
            .sum();
        let unresolved = servers
            .iter()
            .filter(|server| server["availability"]["kind"] == "free-unresolved")
            .count();
        let unsupported = servers
            .iter()
            .filter(|server| server["availability"]["kind"] == "free-unsupported")
            .count();
        let free = servers.len();
        result["serverRows"] = json!(free as i64 + premium + unknown);
        result["freeRows"] = json!(free);
        result["premiumRows"] = json!(premium);
        result["unknownRows"] = json!(unknown + unresolved as i64);
        result["unsupportedFreeRows"] = json!(unsupported);
        result["matchedCompatibleChannels"] = json!(compatible.len());
        if !result["categories"]["motorsport"].is_null() {
            result["categories"]["nascar-cup"] = result["categories"]["motorsport"].clone();
            result["categories"]["nascar-truck"] = result["categories"]["motorsport"].clone();
        }
    }
    Ok(result)
}

fn views_servers(value: &Value) -> impl Iterator<Item = &Value> {
    rows(&value["games"])
        .iter()
        .flat_map(|event| rows(&event["detail"]["servers"]))
}
