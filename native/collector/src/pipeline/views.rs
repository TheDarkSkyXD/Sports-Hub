use super::{
    catalog::*,
    domain,
    matching::{self, FinishedGameMatcher, GamePreparation, MatchMode, SourceEventMatcher},
    model::*,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryInput {
    at: i64,
    revision: u64,
    last_discovery_at: Option<i64>,
    browser_collectors_available: bool,
    sources: Vec<ListingSource>,
    observations: Vec<Observation>,
    games: Vec<Game>,
    candidates: Vec<(String, Vec<Candidate>)>,
    attempts: BTreeMap<String, SourceAttempt>,
    #[serde(default)]
    details: Vec<DetailEvidence>,
    #[serde(default)]
    collection_history: Vec<CollectionAttempt>,
    #[serde(default)]
    source_event_bindings: Vec<SourceEventBinding>,
    #[serde(default)]
    schedule_scopes: Vec<Value>,
    sportsurge_catalog: Value,
    streameast_catalog: Value,
    visible_game_ids: Option<HashSet<String>>,
    fresh_game_ids: Option<HashSet<String>>,
    #[serde(default)]
    availability: HashMap<String, Value>,
    #[serde(default)]
    identities: HashMap<String, String>,
    eligible_candidate_ids: Option<HashSet<String>>,
    #[serde(default)]
    observation_deadlines: HashMap<String, i64>,
    #[serde(default)]
    rank_ids: Vec<String>,
    #[serde(default)]
    eligibility: HashMap<String, bool>,
}

fn candidate_key(candidate: &Candidate) -> String {
    json!([candidate.game_id, candidate.id]).to_string()
}
fn visible_games(input: &InventoryInput) -> HashSet<String> {
    input.visible_game_ids.clone().unwrap_or_else(|| {
        input
            .games
            .iter()
            .filter(|game| domain::feed_inventory_eligible(game, input.at))
            .map(|game| game.id.clone())
            .collect()
    })
}
#[cfg(test)]
thread_local! {
    static ELIGIBILITY_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn candidate_eligible(
    input: &InventoryInput,
    visible: &HashSet<String>,
    candidate: &Candidate,
) -> bool {
    #[cfg(test)]
    ELIGIBILITY_READS.set(ELIGIBILITY_READS.get() + 1);
    visible.contains(&candidate.game_id)
        && input
            .eligibility
            .get(&candidate_key(candidate))
            .or_else(|| input.eligibility.get(&candidate.id))
            .copied()
            .unwrap_or_else(|| {
                input
                    .eligible_candidate_ids
                    .as_ref()
                    .map(|ids| {
                        ids.contains(&candidate.id) || ids.contains(&candidate_key(candidate))
                    })
                    .unwrap_or(
                        candidate.observed_at >= input.at - 1_800_000
                            && candidate.observed_at <= input.at + 60_000,
                    )
            })
}
fn candidate_indexes(input: &Value, eligible: bool) -> Result<Value, String> {
    let input: InventoryInput = decode(input)?;
    let visible = visible_games(&input);
    let mut indexes = Vec::new();
    for (group, (_, candidates)) in input.candidates.iter().enumerate() {
        for (index, candidate) in candidates.iter().enumerate() {
            let selected = if eligible {
                candidate_eligible(&input, &visible, candidate)
            } else {
                visible.contains(&candidate.game_id)
            };
            if selected {
                indexes.push((group, index));
            }
        }
    }
    Ok(json!(indexes))
}

struct Projection<'a> {
    input: &'a InventoryInput,
    preparation: Arc<GamePreparation>,
    matcher: SourceEventMatcher,
    finished: FinishedGameMatcher,
    visible: HashSet<String>,
    candidates: HashMap<&'a str, &'a Vec<Candidate>>,
    games: HashMap<&'a str, &'a Game>,
    fresh_games: Vec<Game>,
    ranks: HashMap<&'a str, usize>,
    source_ids: HashSet<&'a str>,
    public_hosts: HashSet<String>,
    details: HashMap<&'a str, &'a DetailEvidence>,
    attempts: BTreeMap<String, SourceAttempt>,
    deadlines: HashMap<String, i64>,
    links: HashMap<String, Vec<Value>>,
    game_links: HashMap<String, Vec<Value>>,
    reasons: HashMap<String, Vec<(String, u64)>>,
    drops: HashMap<String, Value>,
    full: bool,
}

fn generation(observation: &Observation) -> String {
    let mut values = vec![json!(observation.source_id), json!(observation.url)];
    if observation.teams.is_none()
        || matches!(
            observation.league,
            Some(
                League::Ufc
                    | League::Boxing
                    | League::Wwe
                    | League::Tna
                    | League::Aew
                    | League::Wrestling
            )
        )
    {
        values.push(json!(observation.title));
        values.push(json!(observation.league));
    }
    values.extend([
        json!(observation.teams),
        json!(observation.kickoff),
        json!(observation.observed_at),
        json!(observation.parser_version),
    ]);
    json!(values).to_string()
}
fn public_reason(value: &str) -> &str {
    match value {
        "not-a-matchup"
        | "unknown-teams"
        | "unverified-kickoff"
        | "unverified-contextual-kickoff"
        | "ambiguous-matchup"
        | "conflicting-date"
        | "conflicting-game-id"
        | "finished-game" => value,
        _ => "other",
    }
}
fn no_published_feed(evidence: &Value) -> bool {
    evidence["kind"] == "missing"
        && matches!(
            text(&evidence["reason"]),
            "no-published-player" | "not-yet-published"
        )
}
fn room_game(
    game_id: &str,
    candidates: Value,
    schedule_incomplete: bool,
    pending_listing: bool,
) -> Value {
    let rows = rows(&candidates);
    let pending = !schedule_incomplete
        && !rows
            .iter()
            .any(|candidate| candidate["availability"]["kind"] == "playable")
        && (pending_listing
            || rows.iter().any(|candidate| {
                candidate["availability"]["kind"] == "unknown"
                    || candidate["availability"]["kind"] == "checking"
                        && candidate["availability"]["progress"]["kind"] != "deferred"
            }));
    json!({"gameId":game_id,"candidates":candidates,"pending":pending})
}
pub fn room_sources(snapshot: &Value) -> Value {
    json!({"revision":snapshot["revision"],"collecting":snapshot["sportsurgeV2"]["current"]["state"]["kind"]=="collecting"||snapshot["streameast"]["current"]["state"]["kind"]=="collecting",
        "games":rows(&snapshot["games"]).iter().map(|game|room_game(text(&game["gameId"]),game["candidates"].clone(),game["feeds"]["kind"]=="incomplete"&&game["feeds"]["reason"]=="schedule",rows(&game["sourceLinks"]).iter().any(|link|link["evidence"]["kind"]=="pending"))).collect::<Vec<_>>()})
}

pub(crate) fn browser_category_deadline(
    catalog: &Value,
    league: &str,
    games: &[Game],
    now: i64,
) -> Result<i64, String> {
    let category = &catalog["categories"][league];
    if category.is_null() || category["kind"] == "pending" {
        return Ok(now);
    }
    if category["kind"] == "failed"
        || rows(&catalog["rejectedGames"])
            .iter()
            .any(|event| event["league"] == league)
        || rows(&catalog["catalogIssues"])
            .iter()
            .any(|event| event["league"] == league)
    {
        return Ok(number(&category["at"]) + 300_000);
    }
    let kind = if catalog.get("catalogIssues").is_some() {
        "sportsurge-v2"
    } else {
        "streameast"
    };
    let observations = rows(&catalog["events"])
        .iter()
        .filter(|event| event["league"] == league)
        .map(|event| event_observation(kind, event, number(&category["at"])))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(domain::discovery_deadline(
        number(&category["at"]),
        &observations,
        games,
        &[decode(&json!(league))?],
        now,
    ))
}

impl<'a> Projection<'a> {
    fn new(input: &'a InventoryInput, full: bool) -> Result<Self, String> {
        let visible = visible_games(input);
        let mut attempts = input.attempts.clone();
        for (source_id, attempt) in &mut attempts {
            let source = input.sources.iter().find(|source| source.id == *source_id);
            if source
                .is_some_and(|source| source.kind == Some(crate::types::SourceKind::BrowserCatalog))
                || !matches!(
                    attempt.outcome,
                    SourceOutcome::Parsed | SourceOutcome::Empty
                )
            {
                continue;
            }
            let observations = input
                .observations
                .iter()
                .filter(|row| row.source_id == *source_id && row.observed_at >= attempt.at)
                .cloned()
                .collect::<Vec<_>>();
            let games = input
                .games
                .iter()
                .filter(|game| domain::feed_eligible(game, input.at))
                .cloned()
                .collect::<Vec<_>>();
            let leagues = source
                .map(|source| source.leagues.as_slice())
                .unwrap_or_else(|| matching::source_coverage(source_id));
            attempt.next_eligible_at = Some(domain::discovery_deadline(
                attempt.at,
                &observations,
                &games,
                leagues,
                input.at,
            ));
        }
        let mut category_deadlines: HashMap<String, (i64, i64)> = HashMap::new();
        let mut browser_deadlines: HashMap<&str, i64> = HashMap::new();
        for (kind, history) in [
            ("sportsurge-v2", &input.sportsurge_catalog),
            ("streameast", &input.streameast_catalog),
        ] {
            for league in matching::source_coverage(kind) {
                let name = matching::league_name(*league);
                for key in ["current", "previous", "lastComplete"] {
                    let stored = &history[key];
                    let category = &stored["catalog"]["categories"][name];
                    if category.is_null() || category["kind"] == "pending" {
                        continue;
                    }
                    let until = if category["kind"] == "collected" {
                        browser_category_deadline(&stored["catalog"], name, &input.games, input.at)?
                    } else {
                        number(&category["at"]) + 300_000
                    };
                    browser_deadlines
                        .entry(kind)
                        .and_modify(|deadline| *deadline = (*deadline).min(until))
                        .or_insert(until);
                    if category["kind"] == "collected" {
                        category_deadlines.insert(
                            format!("{kind}:{name}"),
                            (number(&category["at"]), until + 60_000),
                        );
                    }
                    break;
                }
            }
        }
        for (kind, deadline) in browser_deadlines {
            if let Some(attempt) = attempts.get_mut(kind) {
                attempt.next_eligible_at = Some(deadline);
            }
        }
        let mut deadlines = input.observation_deadlines.clone();
        for observation in &input.observations {
            if deadlines.contains_key(&observation.id) {
                continue;
            }
            let category = category_deadlines.get(&format!(
                "{}:{}",
                observation.source_id,
                observation
                    .league
                    .map(matching::league_name)
                    .unwrap_or("null")
            ));
            let until = if let Some((at, until)) = category {
                (*at == observation.observed_at).then_some(*until)
            } else {
                attempts
                    .get(&observation.source_id)
                    .filter(|attempt| {
                        matches!(
                            attempt.outcome,
                            SourceOutcome::Parsed | SourceOutcome::Empty
                        ) && observation.observed_at >= attempt.at
                    })
                    .and_then(|attempt| attempt.next_eligible_at.map(|at| at + 60_000))
            };
            if let Some(until) = until {
                deadlines.insert(observation.id.clone(), until);
            }
        }
        let preparation = Arc::new(GamePreparation::new(&input.games));
        Ok(Self {
            input,
            matcher: SourceEventMatcher::with_preparation(
                Arc::clone(&preparation),
                MatchMode::InventoryLive,
            ),
            finished: FinishedGameMatcher::with_preparation(Arc::clone(&preparation)),
            preparation,
            visible,
            candidates: input
                .candidates
                .iter()
                .map(|(id, rows)| (id.as_str(), rows))
                .collect(),
            games: input
                .games
                .iter()
                .map(|game| (game.id.as_str(), game))
                .collect(),
            fresh_games: input
                .games
                .iter()
                .filter(|game| {
                    input
                        .fresh_game_ids
                        .as_ref()
                        .is_some_and(|ids| ids.contains(&game.id))
                })
                .cloned()
                .collect(),
            ranks: input
                .rank_ids
                .iter()
                .enumerate()
                .map(|(index, id)| (id.as_str(), index))
                .collect(),
            source_ids: input
                .sources
                .iter()
                .map(|source| source.id.as_str())
                .collect(),
            public_hosts: input
                .sources
                .iter()
                .flat_map(|source| {
                    std::iter::once(source.url.as_str())
                        .chain(source.public_urls.iter().flatten().map(String::as_str))
                })
                .filter_map(|value| Url::parse(value).ok())
                .filter_map(|url| url.host_str().map(str::to_owned))
                .collect(),
            details: input
                .details
                .iter()
                .map(|detail| (detail.observation_id.as_str(), detail))
                .collect(),
            attempts,
            deadlines,
            links: HashMap::new(),
            game_links: HashMap::new(),
            reasons: HashMap::new(),
            drops: HashMap::new(),
            full,
        })
    }
    fn availability(&self, candidate: &Candidate) -> Value {
        self.input
            .availability
            .get(&candidate_key(candidate))
            .or_else(|| self.input.availability.get(&candidate.id))
            .cloned()
            .unwrap_or_else(|| json!({"kind":"unknown"}))
    }
    fn eligible(&self, candidate: &Candidate) -> bool {
        candidate_eligible(self.input, &self.visible, candidate)
    }
    fn identity(&self, candidate: &Candidate) -> String {
        json!([
            candidate.game_id,
            self.input
                .identities
                .get(&candidate_key(candidate))
                .or_else(|| self.input.identities.get(&candidate.id))
                .unwrap_or(&candidate.id)
        ])
        .to_string()
    }
    fn summarize(&self, rows: &[&Candidate]) -> Value {
        let mut rows = rows.to_vec();
        let ranks = &self.ranks;
        rows.sort_by(|left, right| {
            if ranks.is_empty() {
                left.id.cmp(&right.id)
            } else {
                ranks
                    .get(candidate_key(left).as_str())
                    .or_else(|| ranks.get(left.id.as_str()))
                    .copied()
                    .unwrap_or(usize::MAX)
                    .cmp(
                        &ranks
                            .get(candidate_key(right).as_str())
                            .or_else(|| ranks.get(right.id.as_str()))
                            .copied()
                            .unwrap_or(usize::MAX),
                    )
                    .then_with(|| left.id.cmp(&right.id))
            }
        });
        json!(rows.into_iter().map(|candidate|json!({"id":candidate.id,"gameId":candidate.game_id,"label":candidate.label,"sourceIds":candidate.source_ids,"observedAt":candidate.observed_at,"availability":self.availability(candidate)})).collect::<Vec<_>>())
    }
    fn feed_counts(&self, rows: &[&Candidate]) -> Value {
        let mut seen = HashSet::new();
        let distinct = rows
            .iter()
            .filter(|candidate| seen.insert(self.identity(candidate)))
            .collect::<Vec<_>>();
        let working = distinct
            .iter()
            .filter(|candidate| self.availability(candidate)["kind"] == "playable")
            .count();
        let checking = distinct
            .iter()
            .filter(|candidate| {
                matches!(
                    text(&self.availability(candidate)["kind"]),
                    "unknown" | "checking"
                )
            })
            .count();
        json!({"kind":"feeds","discovered":distinct.len(),"mediaVerified":working,"decoded":working,"checking":checking})
    }
    fn game(&self, id: &str) -> Option<&Game> {
        self.games.get(id).copied()
    }
    fn visible_observation(&self, observation: &Observation, result: &Match) -> bool {
        match result {
            Match::Matched { game_id } => self.visible.contains(game_id),
            Match::Unmatched {
                reason,
                possible_game_ids,
            } => {
                reason != "finished-game"
                    && (possible_game_ids.is_empty()
                        || possible_game_ids.iter().any(|id| self.visible.contains(id)))
                    && observation
                        .kickoff
                        .is_none_or(|kickoff| domain::feed_date_eligible(kickoff, self.input.at))
            }
        }
    }
    fn evidence(&self, observation: &Observation, result: &Match) -> Result<Value, String> {
        let Some(game_id) = result.game_id() else {
            return Ok(
                json!({"kind":"unmatched","reason":public_reason(result.reason().unwrap_or("other"))}),
            );
        };
        let Some(detail) = self.details.get(observation.id.as_str()) else {
            return Ok(json!({"kind":"pending"}));
        };
        let identity_matches = detail
            .identity
            .as_deref()
            .map(|identity| domain::detail_identity_matches(Some(identity), observation))
            .unwrap_or_else(|| detail.generation == generation(observation));
        let retained = detail.is_resolved()
            && domain::detail_identity_matches(detail.identity.as_deref(), observation)
            && !detail.players().is_empty()
            && self.game(game_id).is_some_and(|game| {
                game.lifecycle == GameLifecycle::Live && game.final_observed_at.is_none()
            })
            && detail.players().iter().all(|player| {
                self.candidates.get(game_id).is_some_and(|rows| {
                    rows.iter().any(|candidate| {
                        candidate.source_ids.contains(&observation.source_id)
                            && self.eligible(candidate)
                            && self.availability(candidate)["kind"] == "playable"
                            && candidate.locator == player.locator
                    })
                })
            });
        let expires = (detail.at + 1_800_000).max(detail.next_eligible_at)
            + if detail.is_resolved() { 60_000 } else { 0 };
        let value = encode(detail)?;
        let short = value["outcome"] == "failed"
            || value["outcome"] == "unresolved" && value["reason"] == "parser-changed";
        if detail.at > self.input.at + 60_000
            || !identity_matches
            || ((if short {
                detail.at < self.input.at - 1_800_000
            } else {
                self.input.at > expires
            }) || self.input.at
                > (observation.observed_at + 1_800_000)
                    .max(self.deadlines.get(&observation.id).copied().unwrap_or(0)))
                && !retained
        {
            return Ok(json!({"kind":"pending"}));
        }
        Ok(if detail.is_resolved() {
            json!({"kind":"collected","checkedAt":detail.at,"candidateIds":self.candidates.get(game_id).into_iter().flat_map(|rows|rows.iter()).filter(|candidate|candidate.source_ids.contains(&observation.source_id)&&detail.players().iter().any(|player|player.locator==candidate.locator)).map(|candidate|&candidate.id).collect::<Vec<_>>()})
        } else if value["outcome"] == "failed" {
            json!({"kind":"failed","checkedAt":detail.at,"failure":value["failure"],"retryAt":detail.next_eligible_at})
        } else {
            json!({"kind":"missing","checkedAt":detail.at,"reason":value["reason"],"retryAt":detail.next_eligible_at})
        })
    }
    fn add(
        &mut self,
        observation: Observation,
        fallback: bool,
        event: Option<&Value>,
        source_evidence: Option<Value>,
        catalog_evidence: Option<Value>,
        event_id: Option<&str>,
    ) -> Result<(), String> {
        let at = self.input.at;
        let evidence = event
            .map(|event| event_evidence("streameast", event, at))
            .or(source_evidence)
            .unwrap_or(encode(&matching::listing_event_evidence(
                &observation.source_id,
            ))?);
        if self
            .finished
            .finished_game_id(&observation, at, evidence["externalGameId"].as_str())
            .is_some()
            || event_id.is_some_and(|id| {
                self.finished
                    .finished_bound_event(&observation, id, &self.input.source_event_bindings)
                    .is_some()
            })
        {
            return Ok(());
        }
        if !self.source_ids.contains(observation.source_id.as_str())
            || observation.observed_at > at + 60_000
        {
            return Ok(());
        }
        let url = match Url::parse(&observation.url) {
            Ok(url) => url,
            Err(_) => return Ok(()),
        };
        let public = url
            .host_str()
            .is_some_and(|host| self.public_hosts.contains(host));
        let credential = cached_regex!(
            r"(?i)^(?:token|access_token|auth|authorization|key|signature|sig|st|x-amz-.+)$",
        )
        .expect("fixed credential pattern");
        let hash_credential = cached_regex!(
            r"(?i)(?:^#|[&?])(?:token|access_token|auth|authorization|key|signature|sig|st|x-amz-[^=]+)=",
        ).expect("fixed fragment credential pattern");
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || !public
            || url.query_pairs().any(|(key, _)| credential.is_match(&key))
            || url
                .fragment()
                .is_some_and(|fragment| hash_credential.is_match(&format!("#{fragment}")))
        {
            return Ok(());
        }
        if self
            .links
            .get(&observation.source_id)
            .is_some_and(|links| links.iter().any(|link| link["url"] == url.as_str()))
        {
            return Ok(());
        }
        let stale = fallback
            || at
                > (observation.observed_at + 1_800_000)
                    .max(self.deadlines.get(&observation.id).copied().unwrap_or(0));
        if stale
            && (observation.teams.is_none()
                || observation.kickoff.is_none()
                || !self.input.games.iter().any(|game| {
                    self.visible.contains(&game.id)
                        && game.lifecycle == GameLifecycle::Live
                        && observation
                            .league
                            .is_none_or(|league| league == game.league)
                        && game
                            .kickoff()
                            .zip(observation.kickoff)
                            .is_some_and(|(game, kickoff)| (game - kickoff).abs() <= 10_800_000)
                }))
        {
            return Ok(());
        }
        let evidence = decode(&evidence)?;
        let decision = self.matcher.match_event(
            &observation,
            &evidence,
            at,
            self.deadlines.get(&observation.id).copied(),
        );
        let mut result = decision.match_result().clone();
        if event.is_none() {
            result = domain::resolved_live_channel_match(
                &observation,
                &result,
                &self.fresh_games,
                self.details.get(observation.id.as_str()).copied(),
                at,
                false,
            );
        }
        if !self.visible_observation(&observation, &result) {
            return Ok(());
        }
        let game_id = result
            .game_id()
            .filter(|id| self.game(id).is_some())
            .map(str::to_owned);
        if stale
            && game_id
                .as_ref()
                .and_then(|id| self.game(id))
                .is_none_or(|game| game.lifecycle != GameLifecycle::Live)
        {
            return Ok(());
        }
        if fallback
            && game_id.as_ref().is_some_and(|id| {
                self.game_links.get(id).is_some_and(|links| {
                    links
                        .iter()
                        .any(|link| link["sourceId"] == observation.source_id)
                })
            })
        {
            return Ok(());
        }
        let mut evidence = catalog_evidence.unwrap_or(self.evidence(&observation, &result)?);
        if evidence["kind"] == "collected" {
            evidence["candidateIds"] = json!(
                rows(&evidence["candidateIds"])
                    .iter()
                    .filter(|id| game_id
                        .as_deref()
                        .and_then(|game_id| self.candidates.get(game_id))
                        .is_some_and(|rows| rows
                            .iter()
                            .any(|candidate| candidate.id == text(id) && self.eligible(candidate))))
                    .collect::<Vec<_>>()
            );
        }
        let league = game_id
            .as_deref()
            .and_then(|id| self.game(id))
            .map(|game| game.league)
            .or(observation.league);
        let freshness = if stale { "stale-live" } else { "fresh" };
        self.links.entry(observation.source_id.clone()).or_default().push(json!({"title":observation.title,"url":url.as_str(),"gameId":game_id,"league":league,"observedAt":observation.observed_at,"freshness":freshness,"evidence":evidence}));
        if let Some(game_id) = game_id {
            self.game_links.entry(game_id).or_default().push(json!({"sourceId":observation.source_id,"title":observation.title,"url":url.as_str(),"observedAt":observation.observed_at,"freshness":freshness,"evidence":evidence}));
            if self.full {
                if let Some(detail) = self.details.get(observation.id.as_str()) {
                    let value = encode(detail)?;
                    let success = &value["lastSuccess"];
                    if value["outcome"] == "unresolved"
                        && detail.generation == generation(&observation)
                        && value["reason"] != "not-yet-published"
                        && !success.is_null()
                        && domain::detail_identity_matches(
                            success["identity"].as_str(),
                            &observation,
                        )
                        && number(&success["at"]) < detail.at
                        && number(&success["at"]) >= at - 86_400_000
                        && self
                            .drops
                            .get(&observation.source_id)
                            .is_none_or(|prior| number(&prior["currentAt"]) < detail.at)
                    {
                        self.drops.insert(observation.source_id.clone(),json!({"kind":"attention","reason":if value["reason"]=="parser-changed" {"parser-changed"} else {"player-drop"},"currentAt":detail.at,"currentCount":0,"baselineAt":success["at"],"baselineCount":success["count"]}));
                    }
                }
            }
        } else {
            let reasons = self.reasons.entry(observation.source_id).or_default();
            let reason = public_reason(result.reason().unwrap_or("other"));
            if let Some((_, count)) = reasons.iter_mut().find(|(key, _)| key == reason) {
                *count += 1;
            } else {
                reasons.push((reason.into(), 1));
            }
        }
        Ok(())
    }
}

pub fn source_inventory(input: &Value, room: bool) -> Result<Value, String> {
    let input: InventoryInput = decode(input)?;
    let mut projection = Projection::new(&input, !room)?;
    for observation in &input.observations {
        if observation.source_id != "sportsurge-v2" && observation.source_id != "streameast" {
            projection.add(observation.clone(), false, None, None, None, None)?;
        }
    }
    add_catalog_links(&mut projection)?;
    if room {
        return Ok(
            json!({"revision":input.revision,"collecting":input.sportsurge_catalog["current"]["catalog"]["state"]["kind"]=="collecting"||input.streameast_catalog["current"]["catalog"]["state"]["kind"]=="collecting", "games":input.games.iter().filter(|game|projection.visible.contains(&game.id)).map(|game| {
        let candidates=projection.candidates.get(game.id.as_str()).into_iter().flat_map(|rows|rows.iter()).filter(|candidate|projection.eligible(candidate)).collect::<Vec<_>>();
        room_game(&game.id,projection.summarize(&candidates),candidates.is_empty()&&(game.lifecycle==GameLifecycle::Unknown||input.fresh_game_ids.as_ref().is_some_and(|ids|!ids.contains(&game.id))),projection.game_links.get(&game.id).is_some_and(|links|links.iter().any(|link|link["evidence"]["kind"]=="pending")))
    }).collect::<Vec<_>>()}),
        );
    }
    let sources = source_rows(&projection)?;
    let mut games = Vec::new();
    for game in &input.games {
        if !projection.visible.contains(&game.id) {
            continue;
        }
        let links = projection
            .game_links
            .get(&game.id)
            .cloned()
            .unwrap_or_default();
        let candidates = projection
            .candidates
            .get(game.id.as_str())
            .into_iter()
            .flat_map(|rows| rows.iter())
            .filter(|candidate| projection.eligible(candidate))
            .collect::<Vec<_>>();
        let source_count = links
            .iter()
            .map(|link| text(&link["sourceId"]))
            .collect::<HashSet<_>>()
            .len();
        let current_sources = links
            .iter()
            .filter(|link| link["freshness"] == "fresh")
            .map(|link| text(&link["sourceId"]))
            .collect::<HashSet<_>>();
        let unique = candidates
            .iter()
            .filter(|candidate| {
                candidate
                    .source_ids
                    .iter()
                    .any(|id| current_sources.contains(id.as_str()))
                    && projection.availability(candidate)["kind"] == "playable"
            })
            .map(|candidate| projection.identity(candidate))
            .collect::<HashSet<_>>()
            .len();
        let relevant = sources
            .iter()
            .flat_map(|source| rows(&source["scopes"]))
            .filter(|scope| scope["league"] == matching::league_name(game.league))
            .collect::<Vec<_>>();
        let complete = !relevant.is_empty()
            && relevant
                .iter()
                .all(|scope| scope["read"]["kind"] == "complete");
        let feeds = if !candidates.is_empty() {
            projection.feed_counts(&candidates)
        } else if game.lifecycle == GameLifecycle::Unknown
            || input
                .fresh_game_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&game.id))
        {
            json!({"kind":"incomplete","reason":"schedule"})
        } else if complete
            && links
                .iter()
                .all(|link| link["freshness"] == "fresh" && no_published_feed(&link["evidence"]))
        {
            json!({"kind":"no-feeds","checkedAt":relevant.iter().map(|scope|number(&scope["read"]["checkedAt"])).max().unwrap_or(0)})
        } else {
            json!({"kind":"incomplete","reason":if links.is_empty() {"listings"} else {"details"}})
        };
        let free = candidates
            .iter()
            .map(|candidate| projection.identity(candidate))
            .collect::<HashSet<_>>()
            .len();
        let working = candidates
            .iter()
            .filter(|candidate| projection.availability(candidate)["kind"] == "playable")
            .map(|candidate| projection.identity(candidate))
            .collect::<HashSet<_>>()
            .len();
        games.push(json!({"gameId":game.id,"name":game.name,"league":game.league,"date":game.date,"feeds":feeds,"sourceCount":source_count,"uniqueFeedCount":unique,"freeChoiceCount":free,"workingChoiceCount":working,"sharedRoutes":shared_routes(&projection,game,&candidates,&links)?,"candidates":projection.summarize(&candidates),"sourceLinks":links}));
    }
    let browser_views = |kind: &str, history: &Value| -> Result<Value, String> {
        let mut result = json!({"current":null,"lastComplete":null,"previous":null});
        for key in ["current", "lastComplete", "previous"] {
            let stored = &history[key];
            if stored.is_null() {
                continue;
            }
            let mut scoped = stored.clone();
            let mut visible = Vec::new();
            let mut matcher = SourceEventMatcher::with_preparation(
                Arc::clone(&projection.preparation),
                MatchMode::InventoryLive,
            );
            for event in rows(&stored["catalog"]["events"]) {
                let category = &stored["catalog"]["categories"][text(&event["league"])];
                let observation = event_observation(
                    kind,
                    event,
                    if category["kind"] == "pending" {
                        number(&stored["catalog"]["startedAt"])
                    } else {
                        number(&category["at"])
                    },
                )?;
                let evidence = decode(&event_evidence(kind, event, input.at))?;
                let decision = matcher.match_event(
                    &observation,
                    &evidence,
                    input.at,
                    projection.deadlines.get(&observation.id).copied(),
                );
                if projection.visible_observation(&observation, decision.match_result()) {
                    visible.push(event.clone());
                }
            }
            scoped["catalog"]["events"] = json!(visible);
            result[key] = catalog_view_with_preparation(
                kind,
                &scoped,
                Arc::clone(&projection.preparation),
                input.at,
                &input.source_event_bindings,
                &HashMap::new(),
            )?;
        }
        Ok(result)
    };
    Ok(
        json!({"at":input.at,"revision":input.revision,"windowStartAt":input.at-1_800_000,"window":domain::feed_window(input.at),"scheduleScopes":input.schedule_scopes,"lastDiscoveryAt":input.last_discovery_at,"browserCollectorsAvailable":input.browser_collectors_available,
        "sportsurgeV2":browser_views("sportsurge-v2",&input.sportsurge_catalog)?,"streameast":browser_views("streameast",&input.streameast_catalog)?,"sources":sources,"games":games}),
    )
}

pub fn external_view_call(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "sourceInventory" => source_inventory(&input, false),
        "roomSourceInventory" => source_inventory(&input, true),
        "roomSources" => Ok(room_sources(&input)),
        "inventoryCandidateIndexes" => candidate_indexes(&input, false),
        "inventoryEligibleCandidateIndexes" => candidate_indexes(&input, true),
        _ => catalog_operation(operation, &input),
    }
}

fn source_rows(projection: &Projection<'_>) -> Result<Vec<Value>, String> {
    let input = projection.input;
    let mut candidates_by_source: HashMap<&str, Vec<&Candidate>> = HashMap::new();
    for candidate in projection.candidates.values().flat_map(|rows| rows.iter()) {
        if !projection.eligible(candidate) {
            continue;
        }
        let mut source_ids = HashSet::new();
        for source_id in &candidate.source_ids {
            if source_ids.insert(source_id.as_str()) {
                candidates_by_source
                    .entry(source_id)
                    .or_default()
                    .push(candidate);
            }
        }
    }
    let mut result = Vec::new();
    for source in &input.sources {
        let links = projection
            .links
            .get(&source.id)
            .cloned()
            .unwrap_or_default();
        let matched = links
            .iter()
            .filter_map(|link| link["gameId"].as_str())
            .collect::<HashSet<_>>();
        let fresh = links
            .iter()
            .filter(|link| link["freshness"] == "fresh")
            .filter_map(|link| link["gameId"].as_str())
            .collect::<HashSet<_>>();
        let all = candidates_by_source
            .get(source.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let free = all
            .iter()
            .map(|candidate| projection.identity(candidate))
            .collect::<HashSet<_>>()
            .len();
        let working = all
            .iter()
            .filter(|candidate| projection.availability(candidate)["kind"] == "playable")
            .map(|candidate| projection.identity(candidate))
            .collect::<HashSet<_>>()
            .len();
        let compatible = all
            .iter()
            .filter(|candidate| {
                fresh.contains(candidate.game_id.as_str())
                    && projection.availability(candidate)["kind"] == "playable"
            })
            .map(|candidate| projection.identity(candidate))
            .collect::<HashSet<_>>()
            .len();
        let public_urls = source
            .public_urls
            .clone()
            .unwrap_or_else(|| vec![source.url.clone()]);
        let mut scopes = Vec::new();
        for league in &source.leagues {
            let collection_league = if source.id == "streameast"
                && matches!(league, League::NascarCup | League::NascarTruck)
            {
                League::Motorsport
            } else {
                *league
            };
            let name = matching::league_name(*league);
            let collection_name = matching::league_name(collection_league);
            let category_urls = source
                .public_categories
                .iter()
                .flatten()
                .filter(|category| category.league == *league)
                .map(|category| category.url.clone())
                .collect::<Vec<_>>();
            let browser_url = if source.kind == Some(crate::types::SourceKind::BrowserCatalog) {
                registry()
                    .browser_category(&source.id, collection_league)
                    .map(|category| category.url.clone())
            } else {
                None
            };
            let scope_urls = if !category_urls.is_empty() {
                category_urls
            } else if let Some(url) = browser_url {
                vec![url]
            } else {
                public_urls.clone()
            };
            let scope_links = links
                .iter()
                .filter(|link| {
                    link["freshness"] == "fresh"
                        && (link["league"] == name
                            || link["league"].is_null()
                            || collection_league != *league
                                && link["league"] == collection_name
                                && link["gameId"].is_null())
                })
                .collect::<Vec<_>>();
            let run = if source.id == "sportsurge-v2" {
                &input.sportsurge_catalog["current"]
            } else if source.id == "streameast" {
                &input.streameast_catalog["current"]
            } else {
                &Value::Null
            };
            let mut read = if source.kind == Some(crate::types::SourceKind::Pending) {
                json!({"kind":"incomplete","reason":"unavailable","checkedAt":null})
            } else if source.kind == Some(crate::types::SourceKind::BrowserCatalog) {
                let category = &run["catalog"]["categories"][collection_name];
                if !input.browser_collectors_available {
                    json!({"kind":"incomplete","reason":"unavailable","checkedAt":null})
                } else if category.is_null() || category["kind"] == "pending" {
                    json!({"kind":"incomplete","reason":"pending","checkedAt":null})
                } else if category["kind"] == "failed" {
                    json!({"kind":"incomplete","reason":"failed","checkedAt":category["at"]})
                } else if input.at
                    > browser_category_deadline(
                        &run["catalog"],
                        collection_name,
                        &input.games,
                        input.at,
                    )? + 60_000
                {
                    json!({"kind":"incomplete","reason":"stale","checkedAt":category["at"]})
                } else if rows(&run["catalog"]["rejectedGames"])
                    .iter()
                    .any(|event| event["league"] == collection_name)
                    || source.id == "sportsurge-v2"
                        && rows(&run["catalog"]["catalogIssues"])
                            .iter()
                            .any(|event| event["league"] == name)
                {
                    json!({"kind":"incomplete","reason":"partial","checkedAt":category["at"]})
                } else {
                    json!({"kind":"complete","checkedAt":category["at"]})
                }
            } else if let Some(attempt) = projection.attempts.get(&source.id) {
                if matches!(
                    attempt.outcome,
                    SourceOutcome::Parsed | SourceOutcome::Empty
                ) {
                    if input.at > attempt.next_eligible_at.unwrap_or(attempt.at) + 60_000 {
                        json!({"kind":"incomplete","reason":"stale","checkedAt":attempt.at})
                    } else {
                        json!({"kind":"complete","checkedAt":attempt.at})
                    }
                } else {
                    json!({"kind":"incomplete","reason":"failed","checkedAt":attempt.at})
                }
            } else {
                json!({"kind":"incomplete","reason":"pending","checkedAt":null})
            };
            if read["kind"] == "complete"
                && scope_links
                    .iter()
                    .any(|link| link["league"].is_null() || link["gameId"].is_null())
            {
                read = json!({"kind":"incomplete","reason":if scope_links.iter().any(|link|link["evidence"]["kind"]=="unmatched"&&matches!(text(&link["evidence"]["reason"]),"unverified-kickoff"|"unverified-contextual-kickoff")) {"unverified-date"} else {"partial"},"checkedAt":read["checkedAt"]});
            }
            let scope_candidates = all
                .iter()
                .copied()
                .filter(|candidate| {
                    projection
                        .game(&candidate.game_id)
                        .is_some_and(|game| game.league == *league)
                })
                .collect::<Vec<_>>();
            let feeds = if !scope_candidates.is_empty() {
                projection.feed_counts(&scope_candidates)
            } else if read["kind"] == "complete"
                && !scope_links.is_empty()
                && scope_links
                    .iter()
                    .all(|link| !link["gameId"].is_null() && no_published_feed(&link["evidence"]))
            {
                json!({"kind":"no-feeds","checkedAt":read["checkedAt"]})
            } else {
                json!({"kind":"incomplete","reason":if scope_links.is_empty() {"listings"} else {"details"}})
            };
            scopes.push(json!({"league":league,"publicUrls":scope_urls,"read":read,"eventCount":scope_links.len(),"feeds":feeds}));
        }
        result.push(json!({"id":source.id,"name":source.name.clone().unwrap_or_else(||source.id.replace('-'," ")),"catalogUrl":source.url,"leagues":source.leagues,"scopes":scopes,"publicUrls":public_urls,"pending":source.kind==Some(crate::types::SourceKind::Pending),
            "collectionMode":"compatible-feed-discovery","lastAttempt":projection.attempts.get(&source.id),"listingCount":links.len(),"matchedGameCount":matched.len(),"staleListingCount":links.iter().filter(|link|link["freshness"]=="stale-live").count(),"compatibleFeedCount":compatible,"freeChoiceCount":free,"workingChoiceCount":working,
            "collectionHealth":collection_health(&source.id,&input.collection_history,projection.drops.get(&source.id)),"unmatchedListingCount":links.iter().filter(|link|link["gameId"].is_null()).count(),"unmatchedReasons":projection.reasons.get(&source.id).into_iter().flatten().map(|(reason,count)|json!({"reason":reason,"count":count})).collect::<Vec<_>>(),"links":links}));
    }
    Ok(result)
}

fn collection_health(source: &str, history: &[CollectionAttempt], drop: Option<&Value>) -> Value {
    let mut scopes: Vec<(Option<League>, Vec<&CollectionAttempt>)> = Vec::new();
    for attempt in history.iter().filter(|attempt| attempt.source_id == source) {
        if let Some((_, rows)) = scopes
            .iter_mut()
            .find(|(league, _)| *league == attempt.league)
        {
            rows.push(attempt);
        } else {
            scopes.push((attempt.league, vec![attempt]));
        }
    }
    let mut findings = Vec::new();
    for (_, rows) in &mut scopes {
        rows.sort_by_key(|row| std::cmp::Reverse(row.at));
        let Some(current) = rows.first() else {
            continue;
        };
        let Some(baseline) = rows.iter().find(|row| {
            row.at < current.at && row.outcome == SourceOutcome::Parsed && row.count > 0
        }) else {
            continue;
        };
        let reason = match current.outcome {
            SourceOutcome::ParserChanged => Some("parser-changed"),
            SourceOutcome::Failed => Some("collection-failed"),
            _ => None,
        };
        let mut finding = json!({"kind":if reason.is_some() {"attention"} else {"healthy"},"currentAt":current.at,"currentCount":current.count,"baselineAt":baseline.at,"baselineCount":baseline.count});
        if let Some(reason) = reason {
            finding["reason"] = json!(reason);
        }
        findings.push(finding);
    }
    findings.sort_by_key(|value| std::cmp::Reverse(number(&value["currentAt"])));
    findings
        .iter()
        .find(|value| value["kind"] == "attention")
        .cloned()
        .or_else(|| drop.cloned())
        .or_else(|| findings.first().cloned())
        .unwrap_or_else(|| json!({"kind":"no-baseline"}))
}

fn shared_routes(
    projection: &Projection<'_>,
    game: &Game,
    candidates: &[&Candidate],
    links: &[Value],
) -> Result<Vec<Value>, String> {
    let direct = &projection.input.streameast_catalog["current"]["catalog"];
    let surge = &projection.input.sportsurge_catalog["current"]["catalog"];
    let fresh_link = |kind: &str, url: &Value| {
        links.iter().any(|link| {
            link["sourceId"] == kind && link["freshness"] == "fresh" && link["url"] == *url
        })
    };
    let mut result = Vec::new();
    for event in rows(&direct["events"]) {
        if direct["categories"][text(&event["league"])]["kind"] != "collected"
            || event["detail"]["kind"] != "collected"
            || projection.input.at - number(&event["detail"]["at"]) >= 1_800_000
            || !fresh_link("streameast", &event["url"])
        {
            continue;
        }
        for server in rows(&event["detail"]["servers"]) {
            let mut one = event.clone();
            one["detail"]["servers"] = json!([server]);
            let mapped = event_candidates("streameast", &one, &game.id)?;
            let Some(choice) = candidates.iter().find(|candidate| {
                candidate.source_ids.iter().any(|id| id == "streameast")
                    && mapped.iter().any(|row| row.locator == candidate.locator)
            }) else {
                continue;
            };
            for candidate in candidates {
                let CandidateLocator::SportsurgeV2 {
                    event_id,
                    provider_id,
                    url,
                    ..
                } = &candidate.locator
                else {
                    continue;
                };
                if !candidate.source_ids.iter().any(|id| id == "sportsurge-v2")
                    || url != text(&server["url"])
                {
                    continue;
                }
                let current = rows(&surge["events"]).iter().any(|event| {
                    event["id"] == *event_id
                        && surge["categories"][text(&event["league"])]["kind"] == "collected"
                        && event["detail"]["kind"] == "collected"
                        && projection.input.at - number(&event["detail"]["at"]) < 1_800_000
                        && fresh_link("sportsurge-v2", &event["url"])
                        && rows(&event["detail"]["providers"]).iter().any(|provider| {
                            provider["id"] == *provider_id
                                && provider["observedAt"] == event["detail"]["at"]
                                && provider["destination"]["kind"] == "link"
                                && provider["destination"]["url"] == *url
                        })
                });
                if current {
                    result.push(json!({"id":format!("{}:{}:{}",game.id,choice.id,candidate.id),"candidateIds":[choice.id,candidate.id],"sourceIds":["streameast","sportsurge-v2"],"evidence":"same-published-server"}));
                }
            }
        }
    }
    Ok(result)
}

fn add_catalog_links(projection: &mut Projection<'_>) -> Result<(), String> {
    for kind in ["sportsurge-v2", "streameast"] {
        let history = if kind == "sportsurge-v2" {
            &projection.input.sportsurge_catalog
        } else {
            &projection.input.streameast_catalog
        };
        let keys = if kind == "sportsurge-v2"
            && history["current"]["catalog"]["state"]["kind"] == "complete"
        {
            vec!["current"]
        } else {
            vec!["current", "previous", "lastComplete"]
        };
        let mut seen = HashSet::new();
        for (run_index, key) in keys.iter().enumerate() {
            let stored = &history[*key];
            if stored.is_null() {
                continue;
            }
            for event in rows(&stored["catalog"]["events"]) {
                let category = &stored["catalog"]["categories"][text(&event["league"])];
                if kind == "sportsurge-v2" && category["kind"] != "collected" {
                    continue;
                }
                if !seen.insert(
                    text(&event[if kind == "sportsurge-v2" { "url" } else { "id" }]).to_owned(),
                ) {
                    continue;
                }
                let mut observation = event_observation(
                    kind,
                    event,
                    if category["kind"] == "pending" {
                        number(&stored["catalog"]["startedAt"])
                    } else {
                        number(&category["at"])
                    },
                )?;
                let detail = &event["detail"];
                let retry_at = projection
                    .details
                    .get(format!("{kind}:{}", text(&event["url"])).as_str())
                    .filter(|stored| stored.at == number(&detail["at"]))
                    .map(|stored| stored.next_eligible_at)
                    .unwrap_or(
                        number(&detail["at"])
                            + if detail["kind"] == "failed" {
                                300_000
                            } else {
                                1_800_000
                            },
                    );
                let evidence = if detail["kind"] == "pending" {
                    json!({"kind":"pending"})
                } else if detail["kind"] == "failed" {
                    json!({"kind":"failed","checkedAt":detail["at"],"failure":match text(&detail["reason"]) {"timeout"=>"timed-out","blocked"=>"blocked","rate-limited"=>"rate-limited",_=>"upstream-error"},"retryAt":retry_at})
                } else {
                    let candidates=projection.candidates.values().flat_map(|rows|rows.iter()).filter(|candidate|candidate.source_ids.iter().any(|id|id==kind)&&
                        if kind=="sportsurge-v2" {matches!(&candidate.locator,CandidateLocator::SportsurgeV2{event_id,..} if *event_id==text(&event["id"]))}
                        else {event_candidates(kind,event,&candidate.game_id).is_ok_and(|rows|rows.iter().any(|row|row.locator==candidate.locator))}).map(|candidate|&candidate.id).collect::<Vec<_>>();
                    if !candidates.is_empty() {
                        json!({"kind":"collected","checkedAt":detail["at"],"candidateIds":candidates})
                    } else {
                        let reason = if kind == "sportsurge-v2" {
                            if rows(&detail["providers"]).is_empty() {
                                "no-published-player"
                            } else {
                                "unsupported-player"
                            }
                        } else if number(&detail["publication"]["unknown"]) > 0
                            || rows(&detail["servers"])
                                .iter()
                                .any(|server| server["availability"]["kind"] == "unknown")
                        {
                            "parser-changed"
                        } else if rows(&detail["servers"])
                            .iter()
                            .any(|server| server["availability"]["kind"] == "free-unsupported")
                        {
                            "unsupported-player"
                        } else if rows(&detail["servers"])
                            .iter()
                            .any(|server| server["availability"]["kind"] == "free-unresolved")
                        {
                            "no-compatible-media"
                        } else if number(&detail["publication"]["premium"]) > 0
                            || rows(&detail["servers"])
                                .iter()
                                .any(|server| server["availability"]["kind"] == "premium")
                        {
                            "paid-only"
                        } else if detail.get("publication").is_some() {
                            "no-published-player"
                        } else {
                            "parser-changed"
                        };
                        json!({"kind":"missing","checkedAt":detail["at"],"reason":reason,"retryAt":retry_at})
                    }
                };
                let mut historical = None;
                if run_index == 0 && observation.kickoff.is_none() {
                    for older in keys.iter().skip(1) {
                        let prior = &history[*older];
                        for old in rows(&prior["catalog"]["events"]) {
                            if old[if kind == "sportsurge-v2" { "url" } else { "id" }]
                                != event[if kind == "sportsurge-v2" { "url" } else { "id" }]
                            {
                                continue;
                            }
                            let category = &prior["catalog"]["categories"][text(&old["league"])];
                            let old_observation = event_observation(
                                kind,
                                old,
                                if category["kind"] == "pending" {
                                    number(&prior["catalog"]["startedAt"])
                                } else {
                                    number(&category["at"])
                                },
                            )?;
                            let pair = |teams: &[String; 2]| {
                                let mut names =
                                    teams.each_ref().map(|name| matching::normalized_name(name));
                                names.sort();
                                names
                            };
                            if old_observation.kickoff.is_some()
                                && old_observation.source_id == observation.source_id
                                && old_observation.url == observation.url
                                && old_observation.league == observation.league
                                && old_observation
                                    .teams
                                    .as_ref()
                                    .zip(observation.teams.as_ref())
                                    .is_some_and(|(a, b)| pair(a) == pair(b))
                            {
                                historical = Some((old_observation, old));
                                break;
                            }
                        }
                        if historical.is_some() {
                            break;
                        }
                    }
                }
                if let Some((old, old_event)) = historical {
                    let mut matcher = SourceEventMatcher::with_preparation(
                        Arc::clone(&projection.preparation),
                        MatchMode::InventoryLive,
                    );
                    let evidence = if kind == "streameast" {
                        event_evidence(kind, old_event, projection.input.at)
                    } else {
                        json!({"undated":"none","externalGameId":null})
                    };
                    let decision = matcher.match_event(
                        &old,
                        &decode(&evidence)?,
                        projection.input.at,
                        projection.deadlines.get(&old.id).copied(),
                    );
                    let live = decision.match_result().game_id().is_some_and(|id| {
                        projection.visible.contains(id)
                            && projection
                                .game(id)
                                .is_some_and(|game| game.lifecycle == GameLifecycle::Live)
                    });
                    let current_valid = kind != "streameast"
                        || matcher
                            .match_event(
                                &old,
                                &decode(&event_evidence(kind, event, projection.input.at))?,
                                projection.input.at,
                                None,
                            )
                            .match_result()
                            .game_id()
                            .is_some_and(|id| {
                                projection.visible.contains(id)
                                    && projection
                                        .game(id)
                                        .is_some_and(|game| game.lifecycle == GameLifecycle::Live)
                            });
                    if live && current_valid {
                        if kind == "sportsurge-v2" {
                            observation.kickoff = old.kickoff;
                            observation.raw_time = old.raw_time;
                        } else {
                            observation = old;
                        }
                    }
                }
                projection.add(
                    observation,
                    kind == "streameast" && run_index > 0,
                    if kind == "streameast" {
                        Some(event)
                    } else {
                        None
                    },
                    Some(event_evidence(kind, event, projection.input.at)),
                    Some(evidence),
                    if kind == "sportsurge-v2" {
                        event["id"].as_str()
                    } else {
                        None
                    },
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod fixture_tests {
    use super::*;
    #[test]
    fn source_rows_check_each_candidate_once() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        let input: InventoryInput = decode(&corpus["cases"][0]["input"]).unwrap();
        let mut input = input;
        let source = input.sources[0].clone();
        for index in 0..128 {
            let mut source = source.clone();
            source.id = format!("additional-source-{index}");
            input.sources.push(source);
        }
        let projection = Projection::new(&input, true).unwrap();
        ELIGIBILITY_READS.set(0);
        let sources = source_rows(&projection).unwrap();
        assert_eq!(sources.len(), input.sources.len());
        assert_eq!(sources[0]["freeChoiceCount"], json!(1));
        assert_eq!(sources.last().unwrap()["freeChoiceCount"], json!(0));
        assert_eq!(
            ELIGIBILITY_READS.get(),
            input
                .candidates
                .iter()
                .map(|(_, rows)| rows.len())
                .sum::<usize>()
        );
    }
    #[test]
    fn an_inventory_prepares_each_games_team_aliases_once() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
            if case["operation"] != "sourceInventory" {
                continue;
            }
            let matchup_count = case["input"]["games"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|game| game.get("home").is_some() && game.get("away").is_some())
                .count();
            matching::alias_preparations(true);
            let actual = external_view_call("sourceInventory", case["input"].clone()).unwrap();
            assert_eq!(actual, case["expected"], "View output {index}");
            assert_eq!(
                matching::alias_preparations(false),
                matchup_count * 2,
                "Repeated game preparation in view {index}"
            );
        }
    }
    #[test]
    fn fixture_callbacks_only_receive_visible_and_then_eligible_candidates() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        let mut input = corpus["cases"][0]["input"].clone();
        let mut hidden = input["candidates"][0][1][0].clone();
        hidden["gameId"] = json!("hidden");
        input["candidates"]
            .as_array_mut()
            .unwrap()
            .push(json!(["hidden", [hidden]]));
        assert_eq!(candidate_indexes(&input, false).unwrap(), json!([[0, 0]]));
        input["eligibility"] = json!({"[\"100\",\"gooz:1\"]":false});
        assert_eq!(candidate_indexes(&input, true).unwrap(), json!([]));
    }
    #[test]
    fn frozen_typescript_views() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
            let actual =
                external_view_call(case["operation"].as_str().unwrap(), case["input"].clone())
                    .unwrap_or_else(|error| panic!("View case {index}: {error}"));
            assert_eq!(
                actual, case["expected"],
                "View case {index}, {}",
                case["operation"]
            );
        }
    }
}
