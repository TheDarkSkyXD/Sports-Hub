use super::{
    catalog::*,
    domain,
    matching::{
        FinishedGameMatcher, MatchMode, SourceEventEvidence, SourceEventMatcher,
        detail_candidate_game_ids,
    },
    model::*,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub fn publication_identity(event: &Value) -> String {
    json!([
        if event.get("sourceStatus").is_some() {
            "sportsurge-v2"
        } else {
            "streameast"
        },
        event["id"],
        event["url"],
        event["league"],
        event["title"],
        event["teams"],
        event["kickoff"],
        if event.get("sourceStatus").is_some() {
            json!([event["sourceStatus"], event["advertisedLinkCount"]])
        } else {
            event["espnEventId"].clone()
        }
    ])
    .to_string()
}
pub fn retained_publication(
    event: &Value,
    observed_at: i64,
    detail: Option<&DetailEvidence>,
    game: &Game,
    now: i64,
) -> Value {
    let Some(success) = detail.and_then(|row| row.last_success.as_ref()) else {
        return Value::Null;
    };
    let Some(publication) = success.publication.as_ref() else {
        return Value::Null;
    };
    if success.identity != publication_identity(event)
        || publication.event.game_id != game.id
        || publication.event.date != game.date
        || success.at > now + 60_000
        || observed_at > now + 60_000
        || event["detail"]["kind"] == "collected" && number(&event["detail"]["at"]) > success.at
    {
        return Value::Null;
    }
    let until = (success.at + domain::ACTIVE_DISCOVERY_MS + 30 * 60_000)
        .min(observed_at + domain::ACTIVE_DISCOVERY_MS + domain::COLLECTION_SETTLE_MS);
    if now > until {
        Value::Null
    } else {
        json!({"players":publication.players,"at":success.at,"until":until})
    }
}
pub fn polling_signature(event: &Value, observation: &Observation, game: Option<&Game>) -> Value {
    if event["detail"]["kind"] != "collected" {
        return Value::Null;
    }
    let mut published = if event["detail"].get("providers").is_some() {
        rows(&event["detail"]["providers"])
            .iter()
            .map(|row| {
                json!([
                    row["id"],
                    if row["destination"]["kind"] == "link" {
                        row["destination"]["url"].clone()
                    } else {
                        row["destination"]["kind"].clone()
                    }
                ])
                .to_string()
            })
            .collect::<Vec<_>>()
    } else {
        rows(&event["detail"]["servers"])
            .iter()
            .map(|row| json!([row["id"], row["url"], row["availability"]]).to_string())
            .collect()
    };
    published.sort();
    json!(
        json!([
            domain::detail_identity(observation),
            game.map(|game| &game.id),
            game.and_then(|game| game.date.as_ref()),
            published
        ])
        .to_string()
    )
}
pub fn browser_operation(operation: &str, args: &Value) -> Result<Value, String> {
    Ok(match operation {
        "browserPublicationIdentity" => json!(publication_identity(&args[0])),
        "browserObservation" => encode(&event_observation(
            if args[0].get("sourceStatus").is_some() {
                "sportsurge-v2"
            } else {
                "streameast"
            },
            &args[0],
            number(&args[1]),
        )?)?,
        "browserCategoryDeadline" => json!(super::views::browser_category_deadline(
            &args[0],
            text(&args[1]),
            &decode::<Vec<Game>>(&args[2])?,
            number(&args[3])
        )?),
        "retainedBrowserPublication" => retained_publication(
            &args[0],
            number(&args[1]),
            decode::<Option<DetailEvidence>>(&args[2])?.as_ref(),
            &decode(&args[3])?,
            number(&args[4]),
        ),
        "browserPollingSignature" => polling_signature(
            &args[0],
            &decode(&args[1])?,
            decode::<Option<Game>>(&args[2])?.as_ref(),
        ),
        _ => return Err(format!("unknown-browser-operation:{operation}")),
    })
}

fn histories(history: &Value) -> Vec<&Value> {
    ["current", "lastComplete", "previous"]
        .iter()
        .filter_map(|key| history.get(key).filter(|row| !row.is_null()))
        .collect()
}
fn eligible(game: &Game, now: i64) -> bool {
    domain::feed_eligible(game, now) || domain::combat_listing_feed_eligible(game, now)
}

pub fn polling_plan(
    kind: &str,
    incoming: &Value,
    history: &Value,
    games: &[Game],
    details: &[DetailEvidence],
    forced: &HashSet<String>,
    coverage: &[League],
    at: i64,
) -> Result<Value, String> {
    let previous = histories(history)
        .into_iter()
        .filter(|row| row["catalog"]["runId"] != incoming["runId"])
        .min_by_key(|row| std::cmp::Reverse(number(&row["receivedAt"])));
    let starting = incoming["sequence"] == 0
        && incoming["categories"]
            .as_object()
            .is_some_and(|categories| {
                categories
                    .values()
                    .all(|category| category["kind"] == "pending")
            });
    let snapshot = if starting {
        previous.map(|row| &row["catalog"]).unwrap_or(incoming)
    } else {
        incoming
    };
    let mut next = i64::MAX;
    if let Some(categories) = snapshot["categories"].as_object() {
        for (league, _) in categories {
            next = next.min(super::views::browser_category_deadline(
                snapshot, league, games, at,
            )?);
        }
    }
    let details: HashMap<_, _> = details
        .iter()
        .map(|row| (row.observation_id.as_str(), row))
        .collect();
    let game_index: HashMap<_, _> = games.iter().map(|game| (game.id.as_str(), game)).collect();
    let mut matcher = SourceEventMatcher::new(games, MatchMode::Current);
    for event in rows(&snapshot["events"]) {
        let category = &snapshot["categories"][text(&event["league"])];
        if category["kind"] != "collected" {
            continue;
        }
        let observation = event_observation(kind, event, number(&category["at"]))?;
        let decision = matcher.match_event(
            &observation,
            &decode(&event_evidence(kind, event, at))?,
            at,
            None,
        );
        let game = decision
            .match_result()
            .game_id()
            .and_then(|id| game_index.get(id).copied());
        if let Some(game) = game.filter(|game| eligible(game, at)) {
            next = next.min(if forced.contains(&observation.id) {
                at
            } else {
                domain::browser_event_deadline(
                    details.get(observation.id.as_str()).copied(),
                    Some(game),
                    at,
                )
            });
        }
    }
    if next == i64::MAX {
        next = at + domain::SOURCE_REFRESH_MS;
    }
    let mut plan = json!({"nextSweepAt":next.max(at+1000)});
    if !starting {
        return Ok(plan);
    }
    let Some(previous) = previous else {
        return Ok(plan);
    };
    let prior = &previous["catalog"];
    let mut categories = Vec::new();
    for league in coverage {
        let league = encode(league)?;
        let name = text(&league);
        let category = &prior["categories"][name];
        if category["kind"] == "collected"
            && super::views::browser_category_deadline(prior, name, games, at)? > at
            && !rows(&prior["rejectedGames"])
                .iter()
                .any(|event| event["league"] == league)
            && !rows(&prior["catalogIssues"])
                .iter()
                .any(|issue| issue["league"] == league)
        {
            categories.push(json!({"league":league,"at":category["at"]}));
        }
    }
    if !categories.is_empty() {
        let events = rows(&prior["events"])
            .iter()
            .filter(|event| {
                categories
                    .iter()
                    .any(|category| category["league"] == event["league"])
            })
            .map(|event| {
                let mut event = event.clone();
                event["detail"] = json!({"kind":"pending"});
                event
            })
            .collect::<Vec<_>>();
        plan["reuseCategories"] = json!({"kind":kind,"categories":categories,"events":events});
    }
    Ok(plan)
}

pub fn catalog_plan(
    kind: &str,
    incoming: &Value,
    history: &Value,
    games: &[Game],
    bindings: &[SourceEventBinding],
    details: &[DetailEvidence],
    _pinned: &BTreeMap<String, Vec<String>>,
    forced: &HashSet<String>,
    coverage: &[League],
    at: i64,
) -> Result<Value, String> {
    let mut plan = polling_plan(
        kind, incoming, history, games, details, forced, coverage, at,
    )?;
    let mut planning = incoming.clone();
    if !plan["reuseCategories"].is_null() {
        for category in rows(&plan["reuseCategories"]["categories"]) {
            planning["categories"][text(&category["league"])] =
                json!({"kind":"collected","at":category["at"]});
        }
        planning["events"] = plan["reuseCategories"]["events"].clone();
    }
    let finished = FinishedGameMatcher::new(games);
    let mut matcher = SourceEventMatcher::new(games, MatchMode::InventoryLive);
    let mut excluded = Vec::new();
    let mut reuse = Vec::new();
    let mut bytes = 2;
    let evidence: HashMap<_, _> = details
        .iter()
        .map(|row| (row.observation_id.as_str(), row))
        .collect();
    for event in rows(&planning["events"]) {
        let category = &planning["categories"][text(&event["league"])];
        let observed_at = if category["kind"] == "pending" {
            number(&planning["startedAt"])
        } else {
            number(&category["at"])
        };
        let observation = event_observation(kind, event, observed_at)?;
        let event_evidence: SourceEventEvidence = decode(&event_evidence(kind, event, at))?;
        let decision = matcher.match_event(&observation, &event_evidence, at, None);
        let listing = matcher.match_event(
            &observation,
            &super::matching::listing_event_evidence(kind),
            at,
            None,
        );
        let collect = detail_candidate_game_ids(listing.match_result())
            .iter()
            .any(|id| {
                games
                    .iter()
                    .any(|game| game.id == *id && eligible(game, at))
            });
        if finished
            .finished_game_id(&observation, at, event_evidence.external_game_id.as_deref())
            .is_some()
            || kind == "sportsurge-v2"
                && finished
                    .finished_bound_event(&observation, text(&event["id"]), bindings)
                    .is_some()
            || !collect
            || kind == "streameast" && detail_candidate_game_ids(decision.match_result()).is_empty()
        {
            excluded.push(event);
        }
        if event["detail"]["kind"] != "pending"
            || category["kind"] != "collected"
            || forced.contains(&observation.id)
        {
            continue;
        }
        let game_id = decision
            .match_result()
            .game_id()
            .map(str::to_owned)
            .or_else(|| {
                let value = encode(&decision).ok()?;
                let ids = rows(&value["match"]["possibleGameIds"]);
                (kind == "sportsurge-v2"
                    && event["sourceStatus"] == "live"
                    && event["kickoff"].is_null()
                    && value["match"]["reason"] == "unverified-kickoff"
                    && ids.len() == 1)
                    .then(|| text(&ids[0]).to_owned())
            });
        let Some(game_id) = game_id else { continue };
        let game = games.iter().find(|game| game.id == game_id);
        if at
            >= domain::browser_event_deadline(
                evidence.get(observation.id.as_str()).copied(),
                game,
                at,
            )
        {
            continue;
        }
        for stored in histories(history) {
            if let Some(prior) = rows(&stored["catalog"]["events"]).iter().find(|prior| {
                same_event(kind, event, prior) && prior["detail"]["kind"] == "collected"
            }) {
                let mut reused = event.clone();
                reused["detail"] = prior["detail"].clone();
                if reused["detail"]["retainedFromRunId"].is_null() {
                    reused["detail"]["retainedFromRunId"] = stored["catalog"]["runId"].clone();
                }
                let size = reused.to_string().len() + 1;
                if bytes + size <= 512 * 1024 {
                    reuse.push(reused);
                    bytes += size;
                }
                break;
            }
        }
    }
    let mut ids = Vec::new();
    for event in &excluded {
        let id = &event["id"];
        if !ids.contains(id)
            && rows(&planning["events"])
                .iter()
                .filter(|row| row["id"] == *id)
                .all(|row| excluded.contains(&row))
        {
            ids.push(id.clone());
        }
    }
    let urls = excluded
        .iter()
        .filter(|event| !ids.contains(&event["id"]))
        .map(|event| event["url"].clone())
        .collect::<Vec<_>>();
    plan["skipDetailEventIds"] = json!(ids);
    if !urls.is_empty() {
        plan["skipDetailEventUrls"] = json!(urls);
    }
    if !reuse.is_empty() {
        plan["reuseDetails"] = json!({"kind":kind,"events":reuse});
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_browser_helpers() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../../../tests/fixtures/rust-browser.json"))
                .unwrap();
        for (index, case) in rows(&corpus["cases"]).iter().enumerate() {
            assert_eq!(
                browser_operation(text(&case["operation"]), &case["args"]).unwrap(),
                case["expected"],
                "Browser case {index}, {}",
                case["operation"]
            );
        }
    }
}
