use super::*;

#[cfg(test)]
thread_local! {
    static DETAIL_NEED_COUNTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl Pipeline {
    pub(super) fn reserve_listing_hosts(&mut self, at: i64, explicit: bool) -> Result<(), String> {
        self.sources.reserve_listings(
            &self.config.sources,
            &self.store.typed_source_attempts()?,
            &self.store.observations()?,
            &self.games,
            at,
            explicit,
        );
        Ok(())
    }
    pub(super) fn live_rollover_game(&self, observation: &Observation, at: i64) -> Option<&Game> {
        if at - observation.observed_at <= domain::ACTIVE_DISCOVERY_MS
            || observation.kickoff.is_none()
            || !self
                .config
                .sources
                .iter()
                .any(|source| source.id == observation.source_id && source.family == "vipbox")
        {
            return None;
        }
        let matched = self.match_observation(observation, at, true);
        self.games.iter().find(|game| {
            matched.game_id() == Some(game.id.as_str())
                && game.lifecycle == GameLifecycle::Live
                && game.final_observed_at.is_none()
                && self.schedule_fresh(game, at)
                && game.kickoff() == observation.kickoff
        })
    }
    pub(super) fn plan_sources(
        &mut self,
        at: i64,
        explicit: bool,
        batch: &mut Batch,
    ) -> Result<(), String> {
        if !self.discovery_enabled {
            return Ok(());
        }
        let attempts = self.store.typed_source_attempts()?;
        let observations = self.store.observations()?;
        self.sources.reserve_listings(
            &self.config.sources,
            &attempts,
            &observations,
            &self.games,
            at,
            explicit,
        );
        for source in self.config.sources.clone() {
            if !self.sources.listing_available(&source, at)
                || !self.sources.listing_due(
                    &source,
                    attempts.get(&source.id),
                    &observations,
                    &self.games,
                    at,
                    explicit,
                )
            {
                continue;
            }
            let token = self.token(0);
            self.jobs.insert(
                token,
                Job::Listing {
                    source: source.clone(),
                },
            );
            self.sources.listings.insert(token, source.clone());
            self.sources.last_discovery = Some(at);
            batch.launch.push(Effect::Listing {
                token,
                source: json!(source),
                at,
            });
        }
        if self.sources.listings.is_empty() {
            self.discovery_enabled = false;
            self.sources.pending_listing_hosts.clear();
        }
        Ok(())
    }

    pub(super) fn accept_listing(
        &mut self,
        source: Source,
        result: Value,
        at: i64,
    ) -> Result<(), String> {
        let attempts = self.store.typed_source_attempts()?;
        let prior = attempts.get(&source.id);
        if let Some(message) = sources::error_message(&result) {
            let delay = result["retryAfterMs"]
                .as_i64()
                .unwrap_or(0)
                .max(sources::SOURCE_REFRESH_MS);
            if sources::failure(&message) == SourceFailure::RateLimited {
                self.sources
                    .host_cooldowns
                    .insert(sources::host(&source.url), at + delay);
            }
            self.store.save_listing_attempt(&source.id,&json!({"at":at,"outcome":"failed","failure":sources::failure(&message),"count":0,"failures":prior.and_then(|prior|prior.failures).unwrap_or(0)+1,"parserVersion":source.parser_version.unwrap_or(3),"nextEligibleAt":at+delay}),&[],&[])?;
            self.revision += 1;
            return Ok(());
        }
        let mut observations: Vec<Observation> =
            serde_json::from_value(result["observations"].clone())
                .map_err(|error| error.to_string())?;
        let count = observations.len();
        let previous = self.store.observations()?;
        let bindings = self.store.source_event_bindings()?;
        let finished = matching::FinishedGameMatcher::new(&self.games);
        let mut accepted = Vec::new();
        let mut accepted_observations = Vec::new();
        let mut new_bindings = Vec::new();
        for observation in &mut observations {
            if observation.kickoff.is_none() {
                if let Some(prior) = previous.iter().find(|prior| {
                    prior.id == observation.id
                        && prior.source_id == observation.source_id
                        && prior.url == observation.url
                        && prior.league == observation.league
                        && same_teams(prior.teams.as_ref(), observation.teams.as_ref())
                }) {
                    let result = self.match_observation(prior, at, true);
                    if let Some(game) = result
                        .game_id()
                        .and_then(|id| self.games.iter().find(|game| game.id == id))
                    {
                        if prior.kickoff.is_some()
                            && game.lifecycle == GameLifecycle::Live
                            && self.schedule_fresh(game, at)
                        {
                            observation.kickoff = prior.kickoff;
                            observation.raw_time = prior.raw_time.clone();
                            observation.kickoff_lineage =
                                prior.kickoff_lineage.clone().or_else(|| {
                                    Some(crate::types::KickoffLineage {
                                        observed_at: prior.observed_at,
                                        raw_time: prior.raw_time.clone(),
                                    })
                                });
                        }
                    }
                }
            }
            if finished.finished_game_id(observation, at, None).is_some()
                || finished
                    .finished_bound_event(observation, &observation.id, &bindings)
                    .is_some()
            {
                continue;
            }
            if observation.kickoff.is_none()
                && observation.observed_at <= at + 60_000
                && at - observation.observed_at <= domain::ACTIVE_DISCOVERY_MS
            {
                if let (Some(league), Some(teams), Some(prior)) = (
                    observation.league,
                    observation.teams.as_ref(),
                    previous.iter().find(|prior| {
                        prior.id == observation.id
                            && prior.source_id == observation.source_id
                            && prior.url == observation.url
                            && prior.league == observation.league
                            && prior.kickoff.is_some()
                            && same_teams(prior.teams.as_ref(), observation.teams.as_ref())
                    }),
                ) {
                    if let Some(game_id) = finished.finished_game_id(prior, at, None) {
                        let binding = SourceEventBinding {
                            source_id: observation.source_id.clone(),
                            event_id: observation.id.clone(),
                            url: observation.url.clone(),
                            league,
                            teams: teams.clone(),
                            game_id,
                            observed_at: at,
                        };
                        if finished
                            .finished_bound_event(
                                observation,
                                &observation.id,
                                std::slice::from_ref(&binding),
                            )
                            .is_some()
                        {
                            new_bindings.push(json!(binding));
                            continue;
                        }
                    }
                }
            }
            let result = self.match_observation(observation, at, false);
            if let (Some(league), Some(teams), Some(game_id)) =
                (observation.league, &observation.teams, result.game_id())
            {
                if let Some(game) = self.games.iter().find(|game| game.id == game_id) {
                    if self.schedule_fresh(game, at)
                        && (observation.kickoff.is_some() && game.lifecycle == GameLifecycle::Live
                            || observation.source_id == "sportsurge"
                                && observation.kickoff.is_none())
                    {
                        new_bindings.push(json!(SourceEventBinding {
                            source_id: observation.source_id.clone(),
                            event_id: observation.id.clone(),
                            url: observation.url.clone(),
                            league,
                            teams: teams.clone(),
                            game_id: game_id.into(),
                            observed_at: at
                        }));
                    }
                }
            }
            accepted.push(json!({"observation":observation,"result":result}));
            accepted_observations.push(observation.clone());
        }
        let outcome = result["outcome"].as_str().unwrap_or("parsed");
        let partial = result.get("partial").filter(|value| value.is_object());
        let failures = if partial.is_some() || outcome == "parser-changed" {
            prior.and_then(|prior| prior.failures).unwrap_or(0) + 1
        } else if outcome == "unsupported" {
            prior.and_then(|prior| prior.failures).unwrap_or(0)
        } else {
            0
        };
        let next = if let Some(partial) = partial {
            let next = domain::retry_deadline(
                at,
                partial["retryAfterMs"].as_i64().unwrap_or(0),
                sources::SOURCE_REFRESH_MS,
            );
            if sources::failure(partial["failure"].as_str().unwrap_or_default())
                == SourceFailure::RateLimited
            {
                self.sources
                    .host_cooldowns
                    .insert(sources::host(&source.url), next);
            }
            next
        } else if outcome == "unsupported" {
            9_007_199_254_740_991
        } else if outcome == "parser-changed" {
            at + sources::SOURCE_REFRESH_MS
        } else {
            let leagues = if source.leagues.is_empty() {
                self.games.iter().map(|game| game.league).collect()
            } else {
                source.leagues.clone()
            };
            domain::discovery_deadline(at, &accepted_observations, &self.games, &leagues, at)
        };
        let mut attempt = json!({"at":at,"outcome":if partial.is_some(){"failed"}else{outcome},"count":count,"failures":failures,"nextEligibleAt":next,"parserVersion":source.parser_version.unwrap_or(3)});
        if let Some(partial) = partial {
            attempt["failure"] = json!(sources::failure(
                partial["failure"].as_str().unwrap_or("request-failed")
            ));
        }
        self.store
            .save_listing_attempt(&source.id, &attempt, &accepted, &new_bindings)?;
        if partial.is_none() {
            self.sources.source_times.insert(source.id, at);
        }
        self.revision += 1;
        self.sources.detail_admissions = 0;
        self.sources.detail_waiting = None;
        self.sources.projection_dirty = true;
        Ok(())
    }

    pub(super) fn plan_details(&mut self, at: i64, batch: &mut Batch) -> Result<(), String> {
        if !self.resolution_enabled
            || self.sources.details.len() >= 8
            || self.sources.detail_admissions >= 80
        {
            return Ok(());
        }
        let fresh: BTreeSet<_> = self
            .games
            .iter()
            .filter(|game| self.feed_game(game, at))
            .map(|game| game.id.clone())
            .collect();
        if self.sources.detail_plan_at != at || self.sources.detail_plan_fresh != fresh {
            self.sources.detail_waiting = None;
            self.sources.detail_plan_fresh = fresh;
        }
        if self.sources.detail_waiting.is_none() {
            let details = self.store.detail_evidence()?;
            let details_by_id: std::collections::HashMap<_, _> = details
                .iter()
                .map(|detail| (detail.observation_id.as_str(), detail))
                .collect();
            let mut need_by_game = std::collections::HashMap::new();
            let demand = self.demand(at);
            let mut ranked = Vec::new();
            for observation in self.store.observations()? {
                let Some(source) = self
                    .config
                    .sources
                    .iter()
                    .find(|source| source.id == observation.source_id)
                else {
                    continue;
                };
                if source.kind == Some(crate::types::SourceKind::BrowserCatalog)
                    || self.sources.host_retry_at(&observation.url) > at
                    || self.sources.details.values().any(|(active, _)| {
                        active.id == observation.id
                            && sources::detail_generation(active)
                                == sources::detail_generation(&observation)
                    })
                {
                    continue;
                }
                let result = self.match_observation(&observation, at, false);
                let ids = matching::detail_candidate_game_ids(&result);
                let Some(game) = self
                    .games
                    .iter()
                    .find(|game| ids.contains(&game.id) && self.feed_game(game, at))
                    .or_else(|| self.live_rollover_game(&observation, at))
                else {
                    continue;
                };
                let prior = details_by_id.get(observation.id.as_str()).copied();
                let deadline = prior
                    .map(|prior| {
                        prior
                            .polling
                            .as_ref()
                            .map_or(prior.next_eligible_at, |polling| {
                                domain::detail_deadline(
                                    prior.at,
                                    polling,
                                    Some(game),
                                    at,
                                    !prior.players().is_empty(),
                                )
                            })
                    })
                    .unwrap_or(0);
                if prior.is_some_and(|prior| {
                    detail_matches(prior, &observation)
                        && prior
                            .event
                            .as_ref()
                            .is_none_or(|event| event.game_id == game.id && event.date == game.date)
                        && deadline > at
                }) && !self.sources.forced_details.contains(&observation.id)
                {
                    continue;
                }
                let need = *need_by_game.entry(game.id.as_str()).or_insert_with(|| {
                    #[cfg(test)]
                    DETAIL_NEED_COUNTS.set(DETAIL_NEED_COUNTS.get() + 1);
                    self.candidates.get(&game.id).map_or(0, |rows| {
                        rows.iter()
                            .filter(|candidate| self.feeds.playable(&self.key(candidate), at))
                            .map(|candidate| self.key(candidate))
                            .collect::<BTreeSet<_>>()
                            .len()
                    }) < verification_policy().working_feeds_per_game
                });
                ranked.push((
                    !need,
                    !demand.contains(&game.id),
                    urgency(game, at),
                    game.kickoff().unwrap_or(i64::MAX),
                    if source.family == "ppv" {
                        0
                    } else if source.id == "sportsurge" {
                        1
                    } else {
                        2
                    },
                    observation,
                    game.id.clone(),
                ));
            }
            ranked.sort_by_key(|row| (row.0, row.1, row.2, row.3, row.4));
            self.sources.detail_plan_at = at;
            self.sources.detail_waiting = Some(
                ranked
                    .into_iter()
                    .map(|(_, _, _, _, _, observation, game_id)| (observation, game_id))
                    .collect(),
            );
        }
        let mut waiting = self.sources.detail_waiting.take().unwrap_or_default();
        while self.sources.details.len() < 8
            && self.sources.detail_admissions < 80
            && !waiting.is_empty()
        {
            let split = waiting.len().min(20);
            let offset = if waiting.len() > split {
                self.sources.detail_cursor % (waiting.len() - split)
            } else {
                0
            };
            let foreground = 0..split;
            let background = (split + offset..waiting.len()).chain(split..split + offset);
            let ordered: Vec<_> = if self.sources.detail_admissions % 4 == 3 {
                background.chain(foreground).collect()
            } else {
                foreground.chain(background).collect()
            };
            let Some(index) = ordered
                .into_iter()
                .find(|index| self.sources.detail_available(&waiting[*index].0, at))
            else {
                break;
            };
            if index >= split {
                self.sources.detail_cursor += 1;
            }
            let (observation, game_id) = waiting.remove(index);
            let token = self.token(0);
            self.sources.detail_admissions += 1;
            self.sources.forced_details.remove(&observation.id);
            self.sources
                .details
                .insert(token, (observation.clone(), game_id.clone()));
            self.jobs.insert(
                token,
                Job::Detail {
                    observation: observation.clone(),
                    game_id: game_id.clone(),
                },
            );
            batch.launch.push(Effect::Detail {
                token,
                observation: json!(observation),
                game_id,
                at,
            });
        }
        self.sources.detail_waiting = Some(waiting);
        Ok(())
    }

    pub(super) fn accept_detail(
        &mut self,
        original: Observation,
        game_id: String,
        result: Value,
        at: i64,
    ) -> Result<(), String> {
        let Some(current) = self.store.observation(&original.id)? else {
            return Ok(());
        };
        if sources::detail_generation(&current) != sources::detail_generation(&original) {
            return Ok(());
        }
        let Some(game) = self
            .games
            .iter()
            .find(|game| game.id == game_id && self.feed_game(game, at))
            .cloned()
        else {
            return Ok(());
        };
        let prior = self.store.detail_for(&original.id)?;
        let mut observation: Observation = if result["observation"].is_object() {
            serde_json::from_value(result["observation"].clone())
                .map_err(|error| error.to_string())?
        } else {
            original.clone()
        };
        let generation = sources::detail_generation(&observation);
        if let Some(message) = sources::error_message(&result) {
            let failures = prior.as_ref().map_or(1, |prior| match prior.result {
                DetailOutcome::Resolved { .. } => 1,
                DetailOutcome::Unresolved { failures, .. }
                | DetailOutcome::Failed { failures, .. } => failures + 1,
            });
            let next = at
                + result["retryAfterMs"]
                    .as_i64()
                    .unwrap_or(0)
                    .max(sources::SOURCE_REFRESH_MS);
            if sources::failure(&message) == SourceFailure::RateLimited {
                self.sources
                    .host_cooldowns
                    .insert(sources::host(&original.url), next);
            }
            let last_success = prior.as_ref().and_then(|prior| {
                if prior.is_resolved() && !prior.players().is_empty() {
                    prior.event.clone().map(|event| LastDetailSuccess {
                        identity: domain::detail_identity(&original),
                        at: prior.at,
                        count: prior.players().len() as u64,
                        publication: Some(Publication {
                            players: prior.players().to_vec(),
                            event,
                        }),
                    })
                } else {
                    prior.last_success.clone()
                }
            });
            let detail = DetailEvidence {
                observation_id: original.id,
                generation,
                identity: None,
                at,
                next_eligible_at: next,
                last_success,
                polling: None,
                event: None,
                result: if message == "parser-changed" {
                    DetailOutcome::Unresolved {
                        reason: MissingPlayerReason::ParserChanged,
                        failures,
                    }
                } else {
                    DetailOutcome::Failed {
                        failure: sources::failure(&message),
                        failures,
                    }
                },
            };
            self.store.save_detail_evidence(&json!(detail), None)?;
        } else {
            let players: Vec<ResolvedPlayer> = serde_json::from_value(result["players"].clone())
                .map_err(|error| error.to_string())?;
            let mut players: Vec<_> = players
                .into_iter()
                .filter(|player| {
                    locator_game(&player.locator).is_none_or(|id| id == game_id)
                        && locator_event_url(&player.locator)
                            .is_none_or(|url| url == observation.url)
                })
                .collect();
            if self.live_rollover_game(&original, at).is_some()
                && observation.kickoff == original.kickoff
                && players.iter().any(|player| {
                    matches!(
                        player.locator,
                        CandidateLocator::EventPage { .. }
                            | CandidateLocator::Tvapp { .. }
                            | CandidateLocator::CatalogStream { .. }
                    )
                })
            {
                observation.observed_at = at;
            }
            let raw = self.match_observation(&observation, at, false);
            let fresh: Vec<_> = self
                .games
                .iter()
                .filter(|game| self.feed_game(game, at))
                .cloned()
                .collect();
            let matched = raw.game_id().map(str::to_owned).or_else(|| {
                domain::provisional_live_channel(&observation, &raw, &fresh, at)
                    .map(|game| game.id.clone())
            });
            if matched.as_deref().is_some_and(|id| id != game_id) {
                return Ok(());
            }
            if matched.is_none() {
                if at - original.observed_at <= sources::ACTIVE_DISCOVERY_MS
                    && self
                        .match_observation(&original, at, false)
                        .game_id()
                        .is_some_and(|id| id != game_id)
                {
                    return Ok(());
                }
                players.clear();
            }
            let generation = sources::detail_generation(&observation);
            let identity = domain::detail_identity(&observation);
            let polling =
                domain::detail_polling(prior.as_ref(), &observation, &players, Some(&game));
            let reason: MissingPlayerReason = serde_json::from_value(
                result
                    .get("reason")
                    .cloned()
                    .unwrap_or(json!("no-compatible-media")),
            )
            .map_err(|error| error.to_string())?;
            let known = !players.is_empty()
                || matches!(
                    reason,
                    MissingPlayerReason::NoPublishedPlayer | MissingPlayerReason::NotYetPublished
                );
            let next = if matches!(
                reason,
                MissingPlayerReason::ParserChanged | MissingPlayerReason::ConflictingGame
            ) {
                at + sources::SOURCE_REFRESH_MS
            } else if known {
                domain::detail_deadline(at, &polling, Some(&game), at, !players.is_empty())
            } else {
                at + sources::ACTIVE_DISCOVERY_MS
            };
            let event = DetailEvent {
                game_id: game.id,
                date: game.date,
            };
            let last_success = if !players.is_empty() {
                Some(LastDetailSuccess {
                    identity: identity.clone(),
                    at,
                    count: players.len() as u64,
                    publication: Some(Publication {
                        players: players.clone(),
                        event: event.clone(),
                    }),
                })
            } else {
                prior
                    .as_ref()
                    .and_then(|prior| prior.last_success.as_ref())
                    .filter(|success| {
                        domain::detail_identity_matches(Some(&success.identity), &observation)
                    })
                    .map(|success| LastDetailSuccess {
                        identity: success.identity.clone(),
                        at: success.at,
                        count: success.count,
                        publication: None,
                    })
            };
            let detail = DetailEvidence {
                observation_id: observation.id.clone(),
                generation,
                identity: Some(identity),
                at,
                next_eligible_at: next,
                last_success,
                polling: known.then_some(polling),
                event: matched.map(|_| event),
                result: if players.is_empty() {
                    DetailOutcome::Unresolved {
                        reason,
                        failures: 0,
                    }
                } else {
                    DetailOutcome::Resolved { players }
                },
            };
            let raw_result = self.match_observation(&observation, at, false);
            let fresh_games: Vec<_> = self
                .games
                .iter()
                .filter(|game| self.feed_game(game, at))
                .cloned()
                .collect();
            let matched = domain::resolved_live_channel_match(
                &observation,
                &raw_result,
                &fresh_games,
                Some(&detail),
                at,
                false,
            );
            self.store.save_detail_evidence(
                &json!(detail),
                Some(&json!({"observation":observation,"result":matched})),
            )?;
        }
        self.revision += 1;
        self.sources.projection_dirty = true;
        Ok(())
    }

    pub(super) fn project_candidates(&mut self, at: i64) -> Result<(), String> {
        let reassignment = self.reassignment_context(at)?;
        let prior_detail_ids = std::mem::take(&mut self.sources.published_detail_ids);
        self.sources.projection_dirty = false;
        self.publication_deadlines.clear();
        self.catalog_evidence.clear();
        for kind in ["sportsurge-v2", "streameast"] {
            let history = self.store.catalog(kind)?;
            for key in ["current", "previous", "lastComplete"] {
                for event in history[key]["catalog"]["events"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    let id = format!("{kind}:{}", event["url"].as_str().unwrap_or_default());
                    if !self.catalog_evidence.contains_key(&id) {
                        let evidence =
                            serde_json::from_value(catalog::event_evidence(kind, event, at))
                                .map_err(|error| error.to_string())?;
                        self.catalog_evidence.insert(id, evidence);
                    }
                }
            }
        }
        let observations = self.store.observations()?;
        let details = self.store.detail_evidence()?;
        let mut projected: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
        let fresh_games: Vec<_> = self
            .games
            .iter()
            .filter(|game| self.feed_game(game, at))
            .cloned()
            .collect();
        self.observation_deadlines.clear();
        let attempts = self.store.typed_source_attempts()?;
        self.source_wakes = details
            .iter()
            .map(|detail| detail.next_eligible_at)
            .chain(
                attempts
                    .values()
                    .filter_map(|attempt| attempt.next_eligible_at),
            )
            .collect();
        for source in &self.config.sources {
            let Some(attempt) = attempts.get(&source.id).filter(|attempt| {
                matches!(
                    attempt.outcome,
                    SourceOutcome::Parsed | SourceOutcome::Empty
                )
            }) else {
                continue;
            };
            let rows: Vec<_> = observations
                .iter()
                .filter(|observation| {
                    observation.source_id == source.id && observation.observed_at >= attempt.at
                })
                .cloned()
                .collect();
            let leagues = if source.leagues.is_empty() {
                self.games.iter().map(|game| game.league).collect()
            } else {
                source.leagues.clone()
            };
            let deadline =
                domain::discovery_deadline(attempt.at, &rows, &fresh_games, &leagues, at)
                    + domain::COLLECTION_SETTLE_MS;
            for observation in rows {
                self.observation_deadlines.insert(observation.id, deadline);
            }
        }
        let details_by_id: std::collections::HashMap<_, _> = details
            .iter()
            .map(|detail| (detail.observation_id.as_str(), detail))
            .collect();
        let changed_locators: BTreeSet<_> = observations
            .iter()
            .filter_map(|observation| {
                details_by_id
                    .get(observation.id.as_str())
                    .filter(|detail| detail.is_resolved() && !detail_matches(detail, observation))
            })
            .flat_map(|detail| {
                detail
                    .players()
                    .iter()
                    .map(|player| json!(player.locator).to_string())
            })
            .collect();
        let mut changed_identity_ids = BTreeSet::new();
        let corrected_locators: BTreeSet<_> = observations
            .iter()
            .filter_map(|observation| {
                details_by_id.get(observation.id.as_str()).filter(|detail| {
                    detail.is_resolved()
                        && detail.generation == sources::detail_generation(observation)
                        && !detail_matches(detail, observation)
                })
            })
            .flat_map(|detail| {
                detail
                    .players()
                    .iter()
                    .map(|player| json!(player.locator).to_string())
            })
            .collect();
        for candidate in self.candidates.values().flatten() {
            if changed_locators.contains(&json!(candidate.locator).to_string()) {
                changed_identity_ids.insert(candidate.id.clone());
            }
        }
        let mut conflicting_locators = BTreeSet::new();
        let mut matched_locators = BTreeSet::new();
        for observation in &observations {
            let Some(detail) = details_by_id
                .get(observation.id.as_str())
                .filter(|detail| detail.is_resolved() && detail_matches(detail, observation))
            else {
                continue;
            };
            let result = self.match_observation(observation, at, false);
            for player in detail.players() {
                let key = json!([observation.source_id, player.locator]).to_string();
                if let Some(game_id) = result.game_id() {
                    matched_locators.insert((key, game_id.to_owned()));
                } else if matches!(&result, Match::Unmatched { reason, .. } if reason == "conflicting-date")
                {
                    conflicting_locators.insert(key);
                }
            }
        }
        for observation in &observations {
            if !self
                .config
                .sources
                .iter()
                .any(|source| source.id == observation.source_id)
            {
                continue;
            }
            if attempts.get(&observation.source_id).is_some_and(|attempt| {
                matches!(
                    attempt.outcome,
                    SourceOutcome::Parsed | SourceOutcome::Empty
                ) && observation.observed_at < attempt.at
            }) {
                continue;
            }
            let Some(stored) = details_by_id.get(observation.id.as_str()).copied() else {
                continue;
            };
            let Some(effective) = published_detail(stored, observation, at) else {
                continue;
            };
            let detail = effective.as_ref();
            let deadline = (observation.observed_at + domain::ACTIVE_DISCOVERY_MS).max(
                self.observation_deadlines
                    .get(&observation.id)
                    .copied()
                    .unwrap_or(0),
            );
            if detail.at > at + 60_000 || at > deadline {
                continue;
            }
            let retained = matches!(stored.result, DetailOutcome::Failed { .. })
                || at - detail.at >= domain::ACTIVE_DISCOVERY_MS;
            if retained && (detail.event.is_none() || at > detail.at + 60 * 60_000) {
                continue;
            }
            let raw_result = self.match_observation(observation, at, false);
            let result = domain::resolved_live_channel_match(
                observation,
                &raw_result,
                &fresh_games,
                Some(detail),
                at,
                retained,
            );
            let Some(game_id) = result.game_id() else {
                continue;
            };
            let Some(game) = self
                .games
                .iter()
                .find(|game| game.id == game_id && self.feed_game(game, at))
            else {
                continue;
            };
            if detail
                .event
                .as_ref()
                .is_some_and(|event| event.game_id != game.id || event.date != game.date)
            {
                continue;
            }
            for published in detail.players() {
                if locator_game(&published.locator).is_some_and(|id| id != game_id)
                    || locator_event_url(&published.locator)
                        .is_some_and(|url| url != observation.url)
                {
                    continue;
                }
                let rows = projected.entry(game_id.into()).or_default();
                let previous_rows = self.candidates.get(game_id);
                let locate = |id: &str| {
                    rows.iter()
                        .find(|candidate| candidate.id == id)
                        .or_else(|| {
                            previous_rows
                                .and_then(|rows| rows.iter().find(|candidate| candidate.id == id))
                        })
                };
                let version_id = format!(
                    "{}:{}",
                    published.id,
                    &hex::encode(Sha256::digest(
                        json!(published.locator).to_string().as_bytes()
                    ))[..12]
                );
                let mut id = if locate(&version_id).is_some() {
                    version_id.clone()
                } else {
                    published.id.clone()
                };
                if let Some(previous) =
                    locate(&id).filter(|previous| previous.locator != published.locator)
                {
                    if detail.at <= previous.observed_at {
                        continue;
                    }
                    let selected = self.sessions.sessions.values().any(|owned| {
                        owned.value.game_id == game_id
                            && owned.value.candidate_id == previous.id
                            && !owned.value.is_closed()
                            && at - owned.last_seen <= sessions::SESSION_LEASE_MS
                    });
                    if self.retained_candidate(previous, at)
                        || selected
                        || locate(&version_id).is_some()
                    {
                        id = version_id;
                    }
                }
                let candidate = Candidate {
                    id,
                    game_id: game_id.into(),
                    label: published.label.clone(),
                    source_ids: vec![observation.source_id.clone()],
                    observed_at: observation.observed_at.min(detail.at),
                    locator: published.locator.clone(),
                };
                self.sources
                    .suppressed_candidates
                    .remove(&(candidate.game_id.clone(), candidate.id.clone()));
                self.sources
                    .published_detail_ids
                    .insert((candidate.game_id.clone(), candidate.id.clone()));
                self.publication_deadlines.insert(
                    format!("{}:{}", observation.source_id, self.key(&candidate)),
                    deadline.min(detail.at + 60 * 60_000),
                );
                merge_candidate(rows, candidate);
            }
            if let Some(legacy_id) = &observation.legacy_id {
                self.store.alias(legacy_id, game_id)?;
            }
        }

        for kind in ["sportsurge-v2", "streameast"] {
            if !self.config.sources.iter().any(|source| source.id == kind) {
                continue;
            }
            self.project_browser_candidates(kind, &details, at, &mut projected)?;
        }
        for owned in self.sessions.sessions.values() {
            if let Some(candidate) = self.candidates.get(&owned.value.game_id).and_then(|rows| {
                rows.iter()
                    .find(|candidate| candidate.id == owned.value.candidate_id)
            }) {
                if prior_detail_ids.contains(&(candidate.game_id.clone(), candidate.id.clone())) {
                    self.sources
                        .published_detail_ids
                        .insert((candidate.game_id.clone(), candidate.id.clone()));
                }
                merge_candidate(
                    projected.entry(candidate.game_id.clone()).or_default(),
                    candidate.clone(),
                );
            }
        }
        for candidate in self
            .candidates
            .values()
            .flatten()
            .cloned()
            .collect::<Vec<_>>()
        {
            let superseded = projected.get(&candidate.game_id).is_some_and(|rows| {
                rows.iter().any(
                    |replacement| match (&candidate.locator, &replacement.locator) {
                        (
                            CandidateLocator::SportsurgeV2 {
                                event_id,
                                provider_id,
                                url,
                                ..
                            },
                            CandidateLocator::SportsurgeV2 {
                                event_id: new_event,
                                provider_id: new_provider,
                                url: new_url,
                                expected_matchup: Some(_),
                                ..
                            },
                        ) => {
                            event_id == new_event
                                && provider_id == new_provider
                                && url == new_url
                                && candidate.locator != replacement.locator
                                && (candidate.id == replacement.id
                                    || candidate.id.starts_with(&format!("{}:", replacement.id)))
                        }
                        _ => false,
                    },
                )
            });
            let selected = self.sessions.sessions.values().any(|owned| {
                owned.value.game_id == candidate.game_id
                    && owned.value.candidate_id == candidate.id
                    && !owned.value.is_closed()
                    && at - owned.last_seen <= sessions::SESSION_LEASE_MS
            });
            let conflicting = prior_detail_ids
                .contains(&(candidate.game_id.clone(), candidate.id.clone()))
                && locator_game(&candidate.locator).is_none()
                && candidate.source_ids.iter().any(|source| {
                    conflicting_locators.contains(&json!([source, candidate.locator]).to_string())
                })
                && !candidate.source_ids.iter().any(|source| {
                    matched_locators.contains(&(
                        json!([source, candidate.locator]).to_string(),
                        candidate.game_id.clone(),
                    ))
                });
            if corrected_locators.contains(&json!(candidate.locator).to_string()) && !selected {
                self.sources
                    .suppressed_candidates
                    .insert((candidate.game_id.clone(), candidate.id.clone()));
                if let Some(rows) = projected.get_mut(&candidate.game_id) {
                    rows.retain(|row| row.id != candidate.id);
                }
                continue;
            }
            if superseded || self.catalog_reassigned_in(&candidate, &reassignment)? || conflicting {
                let key = self.key(&candidate);
                if let Some(rows) = projected.get_mut(&candidate.game_id) {
                    rows.retain(|row| self.key(row) != key);
                }
                self.retire_proof(&candidate)?;
                continue;
            }
            if !changed_identity_ids.contains(&candidate.id)
                && self.retained_candidate(&candidate, at)
            {
                if prior_detail_ids.contains(&(candidate.game_id.clone(), candidate.id.clone())) {
                    self.sources
                        .published_detail_ids
                        .insert((candidate.game_id.clone(), candidate.id.clone()));
                }
                merge_candidate(
                    projected.entry(candidate.game_id.clone()).or_default(),
                    candidate,
                );
            }
        }
        self.candidates = projected;
        let mut persisted = BTreeSet::new();
        for candidate in self
            .candidates
            .values()
            .flatten()
            .cloned()
            .collect::<Vec<_>>()
        {
            let key = self.key(&candidate);
            if self.feeds.playable(&key, at)
                && persisted.insert(key)
                && self
                    .games
                    .iter()
                    .find(|game| game.id == candidate.game_id)
                    .is_some_and(|game| self.feed_game(game, at))
            {
                self.persist_working(&candidate, at)?;
            }
        }
        Ok(())
    }
}

fn locator_event_url(locator: &CandidateLocator) -> Option<&str> {
    match locator {
        CandidateLocator::EventPage { event_url, .. }
        | CandidateLocator::Tvapp { event_url, .. }
        | CandidateLocator::CatalogStream { event_url, .. }
        | CandidateLocator::StreameastServer { event_url, .. } => Some(event_url),
        _ => None,
    }
}
fn published_detail<'a>(
    stored: &'a DetailEvidence,
    observation: &Observation,
    at: i64,
) -> Option<std::borrow::Cow<'a, DetailEvidence>> {
    if stored.is_resolved() {
        return detail_matches(stored, observation).then_some(std::borrow::Cow::Borrowed(stored));
    }
    if !matches!(
        stored.result,
        DetailOutcome::Failed {
            failure: SourceFailure::Blocked
                | SourceFailure::RateLimited
                | SourceFailure::TimedOut
                | SourceFailure::NetworkUnavailable
                | SourceFailure::CollectorBusy
                | SourceFailure::UpstreamError,
            ..
        }
    ) {
        return None;
    }
    let success = stored.last_success.as_ref()?;
    let publication = success.publication.as_ref()?;
    if !domain::detail_identity_matches(Some(&success.identity), observation)
        || success.at > at + 60_000
        || at > success.at + 60 * 60_000
    {
        return None;
    }
    Some(std::borrow::Cow::Owned(DetailEvidence {
        observation_id: stored.observation_id.clone(),
        generation: stored.generation.clone(),
        at: success.at,
        next_eligible_at: stored.next_eligible_at,
        identity: Some(success.identity.clone()),
        last_success: None,
        polling: None,
        event: Some(publication.event.clone()),
        result: DetailOutcome::Resolved {
            players: publication.players.clone(),
        },
    }))
}

#[cfg(test)]
mod admission_tests {
    use super::*;

    #[test]
    fn ambiguous_conflicting_game_results_persist_until_the_retry_deadline() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        let input = &fixtures["cases"][0]["input"];
        let at = input["at"].as_i64().unwrap();
        let mut games: Vec<Game> = serde_json::from_value(input["games"].clone()).unwrap();
        let mut sibling = games[0].clone();
        sibling.id = "101".into();
        games.push(sibling);
        let mut observation: Observation =
            serde_json::from_value(input["observations"][0].clone()).unwrap();
        observation.kickoff = None;
        let mut pipeline = Pipeline::open(":memory:", &json!({"now":at,"sources":input["sources"],"schedules":[{"id":"nfl","league":"nfl","path":"nfl","group":null}]}).to_string()).unwrap();
        pipeline
            .store
            .save_partition(
                "nfl",
                &Partition {
                    games,
                    at,
                    week: None,
                },
            )
            .unwrap();
        pipeline.rebuild(at).unwrap();
        let matched = pipeline.match_observation(&observation, at, false);
        assert!(matched.game_id().is_none());
        assert_eq!(
            matching::detail_candidate_game_ids(&matched),
            ["100", "101"]
        );
        pipeline.store.observe(&observation, &matched).unwrap();
        pipeline.resolution_enabled = true;
        let mut batch = Batch::default();
        pipeline.plan_details(at, &mut batch).unwrap();
        let token = batch
            .launch
            .iter()
            .find_map(|effect| match effect {
                Effect::Detail { token, .. } => Some(*token),
                _ => None,
            })
            .unwrap();
        let completed = pipeline
            .step(
                Input::Complete {
                    token,
                    result: json!({"observation":observation,"body":""}),
                },
                at + 1,
            )
            .unwrap();
        let detail = pipeline
            .store
            .detail_for(&observation.id)
            .unwrap()
            .expect("negative enrichment must be retained");
        assert!(matches!(
            detail.result,
            DetailOutcome::Unresolved {
                reason: MissingPlayerReason::ConflictingGame,
                ..
            }
        ));
        assert_eq!(detail.at, at + 1);
        assert_eq!(detail.next_eligible_at, at + 1 + 300_000);
        assert!(detail.event.is_none());
        assert!(
            !completed
                .launch
                .iter()
                .any(|effect| matches!(effect, Effect::Detail { .. }))
        );
        for effect in completed.launch {
            if let Effect::FlushProbes { token } = effect {
                pipeline
                    .step(
                        Input::Complete {
                            token,
                            result: Value::Null,
                        },
                        at + 2,
                    )
                    .unwrap();
            }
        }
        pipeline
            .store
            .save_partition(
                "nfl",
                &Partition {
                    games: pipeline.games.clone(),
                    at: at + 300_000,
                    week: None,
                },
            )
            .unwrap();
        let before = pipeline.step(Input::Wake, at + 300_000).unwrap();
        assert!(
            !before
                .launch
                .iter()
                .any(|effect| matches!(effect, Effect::Detail { .. }))
        );
        let due = pipeline.step(Input::Wake, at + 300_001).unwrap();
        assert_eq!(
            due.launch
                .iter()
                .filter(|effect| matches!(effect, Effect::Detail { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn detail_results_cannot_overwrite_an_observation_reassigned_to_another_game() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        let input = &fixtures["cases"][0]["input"];
        let at = input["at"].as_i64().unwrap();
        let original: Observation =
            serde_json::from_value(input["observations"][0].clone()).unwrap();
        for enrichment_matches_new_owner in [true, false] {
            let mut games = input["games"].as_array().unwrap().clone();
            let mut reassigned = games[0].clone();
            reassigned["id"] = json!("101");
            games[0]["name"] = json!("North at South");
            for (side, name) in [("away", "North"), ("home", "South")] {
                for field in ["name", "short", "abbreviation"] {
                    games[0][side][field] = json!(name);
                }
            }
            games.push(reassigned);
            let mut pipeline = Pipeline::open(":memory:", &json!({"now":at,"sources":input["sources"],"schedules":[{"id":"nfl","league":"nfl","path":"nfl","group":null}]}).to_string()).unwrap();
            pipeline
                .store
                .save_partition(
                    "nfl",
                    &Partition {
                        games: serde_json::from_value(json!(games)).unwrap(),
                        at,
                        week: None,
                    },
                )
                .unwrap();
            pipeline.rebuild(at).unwrap();
            let matched = pipeline.match_observation(&original, at, false);
            assert_eq!(matched.game_id(), Some("101"));
            pipeline.store.observe(&original, &matched).unwrap();
            let mut enriched = serde_json::to_value(&original).unwrap();
            if !enrichment_matches_new_owner {
                enriched["title"] = json!("East at West");
                enriched["teams"] = json!(["East", "West"]);
            }
            let enriched: Observation = serde_json::from_value(enriched).unwrap();
            assert_eq!(
                pipeline.match_observation(&enriched, at, false).game_id(),
                enrichment_matches_new_owner.then_some("101")
            );
            pipeline
                .accept_detail(
                    original.clone(),
                    "100".into(),
                    json!({"observation":enriched,"players":[],"reason":"conflicting-game"}),
                    at + 1,
                )
                .unwrap();
            assert!(
                pipeline.store.detail_for(&original.id).unwrap().is_none(),
                "a completion for game 100 must not replace game 101's observation"
            );
            assert_eq!(
                pipeline.store.observation(&original.id).unwrap(),
                Some(original.clone())
            );
        }
    }

    #[test]
    fn sibling_details_share_the_games_working_feed_count() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        let input = &fixtures["cases"][0]["input"];
        let at = input["at"].as_i64().unwrap();
        let mut pipeline = Pipeline::open(":memory:", &json!({"now":at,"sources":input["sources"],"schedules":[{"id":"nfl","league":"nfl","path":"nfl","group":null}]}).to_string()).unwrap();
        pipeline
            .store
            .save_partition(
                "nfl",
                &Partition {
                    games: serde_json::from_value(input["games"].clone()).unwrap(),
                    at,
                    week: None,
                },
            )
            .unwrap();
        pipeline.rebuild(at).unwrap();
        let mut observation: Observation =
            serde_json::from_value(input["observations"][0].clone()).unwrap();
        pipeline
            .store
            .observe(
                &observation,
                &Match::Matched {
                    game_id: "100".into(),
                },
            )
            .unwrap();
        observation.id = "fixture:second".into();
        observation.url = "https://fixture.example/second".into();
        pipeline
            .store
            .observe(
                &observation,
                &Match::Matched {
                    game_id: "100".into(),
                },
            )
            .unwrap();
        pipeline.resolution_enabled = true;
        DETAIL_NEED_COUNTS.set(0);
        let mut batch = Batch::default();
        pipeline.plan_details(at + 1, &mut batch).unwrap();
        let mut ids: Vec<_> = batch
            .launch
            .iter()
            .filter_map(|effect| match effect {
                Effect::Detail { observation, .. } => observation["id"].as_str(),
                _ => None,
            })
            .collect();
        ids.sort();
        assert_eq!(ids, ["fixture:100", "fixture:second"]);
        assert_eq!(DETAIL_NEED_COUNTS.get(), 1);
    }

    #[test]
    fn blocked_detail_admission_preserves_pending_work_without_reading_the_store() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-views.json"
        ))
        .unwrap();
        let observation: Observation =
            serde_json::from_value(fixtures["cases"][0]["input"]["observations"][0].clone())
                .unwrap();
        for (active, admitted) in [(8, 0), (0, 80)] {
            let mut pipeline = Pipeline::open(":memory:", r#"{"now":100000}"#).unwrap();
            pipeline.resolution_enabled = true;
            pipeline.sources.detail_plan_at = 100_000;
            pipeline.sources.detail_waiting = Some(vec![(observation.clone(), "game".into())]);
            pipeline.sources.detail_admissions = admitted;
            for index in 0..active {
                pipeline.sources.details.insert(
                    Token {
                        id: index,
                        epoch: 0,
                        health_revision: 0,
                    },
                    (observation.clone(), "game".into()),
                );
            }
            pipeline.store.close().unwrap();
            let mut batch = Batch::default();
            assert_eq!(pipeline.plan_details(100_001, &mut batch), Ok(()));
            assert!(batch.launch.is_empty());
            assert_eq!(pipeline.sources.details.len(), active as usize);
            assert_eq!(pipeline.sources.detail_waiting.as_ref().unwrap().len(), 1);
            assert_eq!(pipeline.sources.detail_plan_at, 100_000);
        }
    }
}
