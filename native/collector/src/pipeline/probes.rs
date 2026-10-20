use super::*;

fn probe_day(game: &Game, today: i64) -> i64 {
    if game.lifecycle == GameLifecycle::Live {
        today
    } else {
        game.kickoff()
            .and_then(domain::feed_calendar_day)
            .unwrap_or(today)
            .max(today)
    }
}

fn frontier_allows(day: i64, priority: Priority, frontier: i64, today: i64) -> bool {
    frontier == i64::MAX
        || match priority {
            Priority::Forced => true,
            Priority::Unknown => day == frontier,
            Priority::Retry => day <= today,
            Priority::Recheck => day <= today && frontier > today,
        }
}

impl Pipeline {
    pub(super) fn plan_probes(&mut self, at: i64, batch: &mut Batch) -> Result<(), String> {
        let before_queue: Vec<_> = self
            .feeds
            .queue
            .iter()
            .map(|job| (job.key.clone(), job.priority))
            .collect();
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
            self.revision += 1;
        }
        let mut queue = std::mem::take(&mut self.feeds.queue);
        queue.retain(|job| self.current_probe(job, at));
        self.feeds.queue = queue;
        let demand = self.demand(at);
        let viewed: BTreeSet<_> = self
            .sessions
            .sessions
            .values()
            .filter(|owned| {
                !owned.value.is_closed() && at - owned.last_seen <= sessions::SESSION_LEASE_MS
            })
            .map(|owned| owned.value.game_id.clone())
            .collect();
        let today = domain::feed_calendar_day(at).unwrap_or(0);
        let mut eligible: Vec<_> = self
            .games
            .iter()
            .filter(|game| self.feed_game(game, at))
            .cloned()
            .collect();
        eligible.sort_by_key(|game| (urgency(game, at), game.kickoff().unwrap_or(i64::MAX)));
        let mut grouped = Vec::new();
        let mut frontier = i64::MAX;
        for game in eligible {
            let mut rows = self.candidates.get(&game.id).cloned().unwrap_or_default();
            rows.retain(|candidate| self.current_candidate(candidate, at));
            rows.sort_by(|a, b| self.rank(a, b, at));
            let mut sources_by_key: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for row in &rows {
                sources_by_key
                    .entry(self.key(row))
                    .or_default()
                    .extend(row.source_ids.iter().cloned());
            }
            let mut seen_sources = BTreeSet::new();
            let mut first = Vec::new();
            let mut siblings = Vec::new();
            let mut seen_keys = BTreeSet::new();
            for row in &rows {
                let key = self.key(row);
                if self.feeds.terminal.contains_key(&key)
                    || self.feeds.active.values().any(|job| job.key == key)
                    || self.feeds.deferred.contains_key(&key)
                {
                    seen_sources.extend(sources_by_key.get(&key).into_iter().flatten().cloned());
                    seen_keys.insert(key);
                }
            }
            for row in rows {
                let key = self.key(&row);
                if !seen_keys.contains(&key)
                    && sources_by_key
                        .get(&key)
                        .into_iter()
                        .flatten()
                        .any(|id| !seen_sources.contains(id))
                {
                    seen_sources.extend(sources_by_key.get(&key).into_iter().flatten().cloned());
                    seen_keys.insert(key);
                    first.push(row);
                } else {
                    siblings.push(row);
                }
            }
            first.extend(siblings);
            let day = probe_day(&game, today);
            for candidate in &first {
                let key = self.key(candidate);
                if !self.feeds.terminal.contains_key(&key)
                    && !self
                        .feeds
                        .deferred
                        .get(&key)
                        .is_some_and(|deferred| deferred.incomplete_attempts > 0)
                {
                    frontier = frontier.min(day);
                }
            }
            grouped.push((game, day, first));
        }
        grouped.sort_by_key(|(game, _, rows)| {
            (
                urgency(game, at),
                rows.iter()
                    .any(|candidate| self.feeds.playable(&self.key(candidate), at)),
                rows.iter()
                    .all(|candidate| domain::playback_resolution(&candidate.locator) == "browser"),
                game.kickoff().unwrap_or(i64::MAX),
            )
        });
        let mut ordered = Vec::new();
        let maximum = grouped.iter().map(|row| row.2.len()).max().unwrap_or(0);
        for index in 0..maximum {
            for demanded in [true, false] {
                for (game, day, rows) in &grouped {
                    if demand.contains(&game.id) == demanded {
                        if let Some(candidate) = rows.get(index) {
                            ordered.push((game.clone(), *day, candidate.clone()));
                        }
                    }
                }
            }
        }
        let days: BTreeMap<_, _> = grouped
            .iter()
            .map(|(game, day, _)| (game.id.clone(), *day))
            .collect();
        let allowed = |game_id: &str, priority: Priority| {
            let day = days.get(game_id).copied().unwrap_or(i64::MAX);
            frontier_allows(day, priority, frontier, today)
        };
        self.feeds
            .queue
            .retain(|job| allowed(&job.candidate.game_id, job.priority));
        let queued_priority = |game_id: &str, priority: Priority| match priority {
            Priority::Forced => 0,
            Priority::Recheck => 1,
            _ if self
                .feeds
                .check_targets
                .iter()
                .any(|(id, requested)| id == game_id && at - *requested <= 90_000) =>
            {
                2
            }
            _ if self
                .games
                .iter()
                .find(|game| game.id == game_id)
                .is_some_and(|game| urgency(game, at) < 2) =>
            {
                3
            }
            Priority::Unknown => 4,
            Priority::Retry => 5,
        };
        let best = ordered
            .iter()
            .filter_map(|(_, _, candidate)| {
                self.feeds
                    .classify(
                        &self.key(candidate),
                        at,
                        self.feeds.forced.contains(&self.key(candidate)),
                    )
                    .filter(|(priority, _)| allowed(&candidate.game_id, *priority))
                    .map(|(priority, _)| queued_priority(&candidate.game_id, priority))
            })
            .chain(
                self.feeds
                    .queue
                    .iter()
                    .map(|job| queued_priority(&job.candidate.game_id, job.priority)),
            )
            .min()
            .unwrap_or(u8::MAX);
        let displaced: Vec<_> = self
            .feeds
            .active
            .iter()
            .filter(|(_, job)| {
                !job.active_phase
                    && self.feeds.protected_background.as_deref() != Some(&job.key)
                    && (!allowed(&job.candidate.game_id, job.priority)
                        || queued_priority(&job.candidate.game_id, job.priority) > best)
            })
            .map(|(token, _)| *token)
            .collect();
        for token in displaced {
            if let Some(mut job) = self.feeds.active.remove(&token) {
                self.jobs.remove(&token);
                batch.cancel.push(token);
                self.revision += 1;
                if allowed(&job.candidate.game_id, job.priority) {
                    if self.feeds.protected_background.is_none() {
                        self.feeds.protected_background = Some(job.key.clone());
                        self.feeds.protected_after_admission = self.feeds.admissions + 1;
                    }
                    job.started_at = None;
                    job.target = None;
                    job.active_phase = false;
                    job.phase_at = at;
                    self.feeds.queue.push(job);
                }
            }
        }
        let mut ranks = BTreeMap::new();
        for (index, (_, _, candidate)) in ordered.iter().enumerate() {
            ranks.entry(self.key(candidate)).or_insert(index);
        }
        let mut additions: Vec<_> = ordered
            .into_iter()
            .filter_map(|(game, day, candidate)| {
                let key = self.key(&candidate);
                self.feeds
                    .classify(&key, at, self.feeds.forced.contains(&key))
                    .map(|(priority, expected)| (game, day, candidate, key, priority, expected))
            })
            .filter(|(game, _, _, _, priority, _)| allowed(&game.id, *priority))
            .collect();
        let pending_games: BTreeSet<_> = self
            .feeds
            .active
            .values()
            .chain(self.feeds.queue.iter())
            .map(|job| job.candidate.game_id.as_str())
            .chain(
                additions
                    .iter()
                    .map(|(game, _, _, _, _, _)| game.id.as_str()),
            )
            .collect();
        let demanded_games = pending_games
            .iter()
            .filter(|id| demand.contains(**id))
            .count()
            .max(1);
        let demanded_limit = self
            .config
            .probe_concurrency
            .div_ceil(demanded_games)
            .max(2);
        let background_limit = self
            .config
            .probe_concurrency
            .div_ceil(pending_games.len().max(1))
            .max(1);
        additions.sort_by_key(|(_, _, _, _, priority, _)| *priority);
        let mut reserved_retry = self
            .feeds
            .queue
            .iter()
            .any(|job| job.priority == Priority::Retry);
        let mut recovery_reserved = self.feeds.queue.iter().any(|job| {
            viewed.contains(&job.candidate.game_id)
                && matches!(
                    self.feeds
                        .terminal
                        .get(&job.key)
                        .map(|terminal| &terminal.outcome),
                    Some(TerminalOutcome::Unavailable {
                        reason: MediaFailureReason::Playback,
                        ..
                    })
                )
        });
        for (game, _day, candidate, key, priority, expected) in additions {
            if self.feeds.queue.iter().any(|job| job.key == key)
                || self.feeds.active.values().any(|job| job.key == key)
            {
                continue;
            }
            if !allowed(&game.id, priority) {
                continue;
            }
            let recovery = priority == Priority::Retry
                && !recovery_reserved
                && viewed.contains(&game.id)
                && matches!(
                    self.feeds
                        .terminal
                        .get(&key)
                        .map(|terminal| &terminal.outcome),
                    Some(TerminalOutcome::Unavailable {
                        reason: MediaFailureReason::Playback,
                        ..
                    })
                );
            let fair_retry = recovery
                || priority == Priority::Retry
                    && self.feeds.unknown_admissions >= 3
                    && !reserved_retry;
            let fair_unknown = priority == Priority::Unknown && self.feeds.urgent_admissions >= 3;
            let admitted = self
                .feeds
                .active
                .values()
                .chain(self.feeds.queue.iter())
                .filter(|job| job.candidate.game_id == game.id)
                .count();
            if admitted
                >= if demand.contains(&game.id) {
                    demanded_limit
                } else {
                    background_limit
                }
            {
                let replacement = self.feeds.queue.iter().rposition(|job| {
                    job.candidate.game_id == game.id
                        && (fair_retry && job.priority == Priority::Unknown
                            || fair_unknown && job.priority == Priority::Recheck
                            || priority == Priority::Forced && job.priority != Priority::Forced)
                });
                if let Some(index) = replacement {
                    self.feeds.queue.remove(index);
                } else if !recovery {
                    continue;
                }
            }
            if self.feeds.queue.len() >= feeds::QUEUE_LIMIT && fair_retry {
                if let Some(index) = self
                    .feeds
                    .queue
                    .iter()
                    .rposition(|job| job.priority == Priority::Unknown)
                {
                    self.feeds.queue.remove(index);
                }
            }
            let owner = self
                .feeds
                .terminal
                .get(&key)
                .filter(|terminal| matches!(terminal.outcome, TerminalOutcome::Playable { .. }))
                .map(|terminal| terminal.owner.clone())
                .unwrap_or_else(|| self.owner(&game));
            self.feeds
                .enqueue(candidate, key.clone(), owner, priority, expected, at);
            self.feeds.forced.remove(&key);
            if priority == Priority::Retry {
                reserved_retry = true;
            }
            if recovery {
                recovery_reserved = true;
            }
        }
        let maintenance_due = |job: &feeds::ProbeJob| match self
            .feeds
            .terminal
            .get(&job.key)
            .map(|terminal| &terminal.outcome)
        {
            Some(TerminalOutcome::Playable { checked_at, .. }) => {
                checked_at + feeds::WORKING_RECHECK_MS
            }
            Some(TerminalOutcome::Unavailable { retry_at, .. }) => *retry_at,
            None => self
                .feeds
                .deferred
                .get(&job.key)
                .map_or(0, |deferred| deferred.until),
        };
        let due: BTreeMap<_, _> = self
            .feeds
            .queue
            .iter()
            .map(|job| (job.key.clone(), maintenance_due(job)))
            .collect();
        self.feeds.queue.sort_by_key(|job| {
            (
                job.priority,
                if matches!(job.priority, Priority::Retry | Priority::Recheck) {
                    due.get(&job.key).copied().unwrap_or(0)
                } else {
                    0
                },
                self.games
                    .iter()
                    .find(|game| game.id == job.candidate.game_id)
                    .map_or(2, |game| urgency(game, at)),
                domain::playback_resolution(&job.candidate.locator) == "browser",
                ranks.get(&job.key).copied().unwrap_or(usize::MAX),
            )
        });
        if before_queue
            != self
                .feeds
                .queue
                .iter()
                .map(|job| (job.key.clone(), job.priority))
                .collect::<Vec<_>>()
        {
            self.revision += 1;
        }
        Ok(())
    }

    pub(super) fn pump_probes(&mut self, at: i64, batch: &mut Batch) -> Result<(), String> {
        let today = domain::feed_calendar_day(at).unwrap_or(0);
        let mut frontier = i64::MAX;
        for game in self.games.iter().filter(|game| self.feed_game(game, at)) {
            let day = probe_day(game, today);
            if day >= frontier {
                continue;
            }
            if self
                .candidates
                .get(&game.id)
                .into_iter()
                .flatten()
                .any(|candidate| {
                    let key = self.key(candidate);
                    !self.feeds.terminal.contains_key(&key)
                        && !self
                            .feeds
                            .deferred
                            .get(&key)
                            .is_some_and(|deferred| deferred.incomplete_attempts > 0)
                        && self.current_candidate(candidate, at)
                })
            {
                frontier = day;
                if frontier == today {
                    break;
                }
            }
        }
        if frontier != i64::MAX {
            let days: BTreeMap<_, _> = self
                .games
                .iter()
                .map(|game| (game.id.as_str(), probe_day(game, today)))
                .collect();
            let before = self.feeds.queue.len();
            self.feeds.queue.retain(|job| {
                frontier_allows(
                    days.get(job.candidate.game_id.as_str())
                        .copied()
                        .unwrap_or(i64::MAX),
                    job.priority,
                    frontier,
                    today,
                )
            });
            if before != self.feeds.queue.len() {
                self.revision += 1;
            }
        }
        let demand = self.demand(at);
        let viewed_games: BTreeSet<_> = self
            .sessions
            .sessions
            .values()
            .filter(|owned| {
                !owned.value.is_closed() && at - owned.last_seen <= sessions::SESSION_LEASE_MS
            })
            .map(|owned| owned.value.game_id.clone())
            .collect();
        let recovery_keys: BTreeSet<_> = self
            .feeds
            .queue
            .iter()
            .filter(|job| {
                viewed_games.contains(&job.candidate.game_id)
                    && matches!(
                        self.feeds
                            .terminal
                            .get(&job.key)
                            .map(|terminal| &terminal.outcome),
                        Some(TerminalOutcome::Unavailable {
                            reason: MediaFailureReason::Playback,
                            ..
                        })
                    )
            })
            .map(|job| job.key.clone())
            .collect();
        let needing_feeds: BTreeSet<_> = self
            .games
            .iter()
            .filter(|game| {
                let mut working = BTreeSet::new();
                self.feed_game(game, at)
                    && self
                        .candidates
                        .get(&game.id)
                        .into_iter()
                        .flatten()
                        .filter_map(|candidate| {
                            let key = self.key(candidate);
                            (self.feeds.playable(&key, at) && self.current_candidate(candidate, at))
                                .then_some(key)
                        })
                        .filter(|key| working.insert(key.clone()))
                        .take(verification_policy().working_feeds_per_game)
                        .count()
                        < verification_policy().working_feeds_per_game
            })
            .map(|game| game.id.clone())
            .collect();
        let viewed = !self.sessions.sessions.is_empty();
        let limit = if viewed {
            self.config
                .probe_concurrency
                .min(verification_policy().viewing_concurrency)
        } else {
            self.config.probe_concurrency
        };
        while self.feeds.active.len() < limit {
            let Some(mut job) = self.feeds.next(&demand, &needing_feeds, &recovery_keys) else {
                break;
            };
            if !self.current_probe(&job, at) {
                continue;
            }
            if job.priority != Priority::Recheck {
                self.feeds.terminal.remove(&job.key);
            }
            job.started_at = Some(at);
            job.phase_at = at;
            job.active_phase = true;
            job.deadline = at + 60_000;
            let token = self.token(job.revision);
            self.feeds.active.insert(token, job);
            self.revision += 1;
            if self.config.fixture_operations.contains("id") {
                self.jobs.insert(token, Job::ProbeId);
                batch.launch.push(Effect::Id { token });
            } else {
                self.launch_probe(token, uuid::Uuid::new_v4().to_string(), at, batch)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const AT: i64 = 1_791_741_600_000;

    fn pipeline(count: usize) -> Pipeline {
        let mut pipeline = Pipeline::open(":memory:", &json!({"sources":[{"id":"source","url":"https://example.com","family":"fixture"}],"schedules":[{"id":"nfl","league":"nfl","path":"","group":null}],"now":AT,"probeConcurrency":1}).to_string()).unwrap();
        let game: Game = serde_json::from_value(json!({"id":"game","league":"nfl","name":"Away at Home","date":iso(AT),"home":{"name":"Home","short":"Home","abbreviation":"H","color":"000000","score":null},"away":{"name":"Away","short":"Away","abbreviation":"A","color":"ffffff","score":null},"redzone":false,"status":"in","lifecycle":"live","detail":"Live","partitions":["nfl"]})).unwrap();
        pipeline
            .store
            .save_partition(
                "nfl",
                &Partition {
                    games: vec![game],
                    at: AT,
                    week: None,
                },
            )
            .unwrap();
        pipeline.rebuild(AT).unwrap();
        pipeline.candidates.insert(
            "game".into(),
            (1..=count)
                .map(|index| Candidate {
                    id: format!("candidate-{index}"),
                    game_id: "game".into(),
                    label: format!("Server {index}"),
                    source_ids: vec!["source".into()],
                    observed_at: AT,
                    locator: CandidateLocator::Streameast {
                        channel_id: index.to_string(),
                    },
                })
                .collect(),
        );
        pipeline
    }

    #[test]
    fn pumping_a_published_today_frontier_does_not_start_an_older_tomorrow_job() {
        let mut pipeline = pipeline(1);
        let mut tomorrow = pipeline.games[0].clone();
        tomorrow.id = "tomorrow".into();
        tomorrow.lifecycle = GameLifecycle::Scheduled;
        tomorrow.status = GameStatus::Pre;
        tomorrow.date = Some(iso(AT + 86_400_000));
        let mut candidate = pipeline.candidates["game"][0].clone();
        candidate.game_id = "tomorrow".into();
        let key = pipeline.key(&candidate);
        let owner = pipeline.owner(&tomorrow);
        pipeline.games.push(tomorrow);
        pipeline
            .candidates
            .insert("tomorrow".into(), vec![candidate.clone()]);
        pipeline
            .feeds
            .enqueue(candidate, key, owner, Priority::Unknown, None, AT);
        pipeline.pump_probes(AT, &mut Batch::default()).unwrap();
        assert!(pipeline.feeds.active.is_empty());
        assert!(pipeline.feeds.queue.is_empty());
    }

    #[test]
    fn a_future_blocked_game_does_not_reduce_todays_admission_capacity() {
        let mut pipeline = pipeline(3);
        pipeline.config.probe_concurrency = 2;
        pipeline.games[0].lifecycle = GameLifecycle::Scheduled;
        pipeline.games[0].status = GameStatus::Pre;
        let mut tomorrow = pipeline.games[0].clone();
        tomorrow.id = "tomorrow".into();
        tomorrow.date = Some(iso(AT + 86_400_000));
        pipeline.games.push(tomorrow);
        let mut candidate = pipeline.candidates["game"][0].clone();
        candidate.game_id = "tomorrow".into();
        pipeline
            .candidates
            .insert("tomorrow".into(), vec![candidate]);
        pipeline.plan_probes(AT, &mut Batch::default()).unwrap();
        assert_eq!(
            pipeline
                .feeds
                .queue
                .iter()
                .map(|job| job.candidate.game_id.as_str())
                .collect::<Vec<_>>(),
            vec!["game", "game"]
        );
    }

    #[test]
    fn a_due_retry_reserves_a_queued_turn_when_first_checks_fill_the_game_limit() {
        let mut pipeline = pipeline(6);
        let candidate = pipeline.candidates["game"][0].clone();
        let key = pipeline.key(&candidate);
        for row in pipeline.candidates["game"][1..3].to_vec() {
            pipeline.feeds.enqueue(
                row.clone(),
                pipeline.key(&row),
                pipeline.owner(&pipeline.games[0]),
                Priority::Unknown,
                None,
                AT,
            );
        }
        pipeline.feeds.deferred.insert(
            key.clone(),
            feeds::Deferred {
                candidate,
                owner: pipeline.owner(&pipeline.games[0]),
                since: AT - 30_000,
                until: AT,
                incomplete_attempts: 1,
                reason: None,
                phase: None,
                timings: None,
            },
        );
        pipeline.feeds.unknown_admissions = 3;
        pipeline.plan_probes(AT, &mut Batch::default()).unwrap();
        assert!(
            pipeline
                .feeds
                .queue
                .iter()
                .any(|job| job.key == key && job.priority == Priority::Retry)
        );
        assert_eq!(
            pipeline
                .feeds
                .next(
                    &BTreeSet::from(["game".into()]),
                    &BTreeSet::new(),
                    &BTreeSet::new()
                )
                .unwrap()
                .key,
            key
        );
    }

    #[test]
    fn newly_published_today_first_checks_remove_queued_tomorrow_alternatives() {
        let mut pipeline = pipeline(1);
        let today = pipeline.games[0].clone();
        let mut tomorrow = today.clone();
        tomorrow.id = "tomorrow".into();
        tomorrow.lifecycle = GameLifecycle::Scheduled;
        tomorrow.status = GameStatus::Pre;
        tomorrow.date = Some(iso(AT + 86_400_000));
        let mut candidate = pipeline.candidates["game"][0].clone();
        candidate.game_id = "tomorrow".into();
        let key = pipeline.key(&candidate);
        let owner = pipeline.owner(&tomorrow);
        pipeline.games.push(tomorrow);
        pipeline
            .candidates
            .insert("tomorrow".into(), vec![candidate.clone()]);
        pipeline
            .feeds
            .enqueue(candidate, key.clone(), owner, Priority::Unknown, None, AT);
        pipeline.plan_probes(AT, &mut Batch::default()).unwrap();
        assert!(!pipeline.feeds.queue.iter().any(|job| job.key == key));
        assert!(
            pipeline
                .feeds
                .queue
                .iter()
                .any(|job| job.candidate.game_id == "game")
        );
    }

    #[test]
    fn a_direct_first_feed_precedes_browser_only_games_at_the_same_urgency() {
        let mut pipeline = pipeline(1);
        let mut browser_game = pipeline.games[0].clone();
        browser_game.id = "browser-game".into();
        pipeline.games.insert(0, browser_game);
        let mut browser = pipeline.candidates["game"][0].clone();
        browser.game_id = "browser-game".into();
        browser.locator = CandidateLocator::EventPage {
            game_id: "browser-game".into(),
            event_url: "https://example.com/event".into(),
            server_url: "https://example.com/server".into(),
        };
        pipeline
            .candidates
            .insert("browser-game".into(), vec![browser]);
        pipeline.plan_probes(AT, &mut Batch::default()).unwrap();
        assert_eq!(
            pipeline
                .feeds
                .next(&pipeline.demand(AT), &BTreeSet::new(), &BTreeSet::new())
                .unwrap()
                .candidate
                .game_id,
            "game"
        );
    }

    #[test]
    fn aliases_cover_their_source_without_displacing_a_distinct_ppv_first_check() {
        let mut pipeline = pipeline(2);
        pipeline.config.probe_concurrency = 2;
        for id in ["alias", "ppv"] {
            pipeline.config.sources.push(
                serde_json::from_value(
                    json!({"id":id,"url":"https://example.com","family":"fixture"}),
                )
                .unwrap(),
            );
        }
        let mut alias = pipeline.candidates["game"][0].clone();
        alias.id = "z-alias".into();
        alias.source_ids = vec!["alias".into()];
        let mut sibling = alias.clone();
        sibling.id = "z-alias-5".into();
        sibling.locator = CandidateLocator::Streameast {
            channel_id: "5".into(),
        };
        let mut ppv = alias.clone();
        ppv.id = "z-ppv".into();
        ppv.source_ids = vec!["ppv".into()];
        ppv.locator = CandidateLocator::Streameast {
            channel_id: "9".into(),
        };
        pipeline
            .candidates
            .get_mut("game")
            .unwrap()
            .extend([alias, sibling, ppv]);
        pipeline.plan_probes(AT, &mut Batch::default()).unwrap();
        let ids: Vec<_> = pipeline
            .feeds
            .queue
            .iter()
            .map(|job| job.candidate.id.as_str())
            .collect();
        assert_eq!(ids, vec!["candidate-1", "z-ppv"]);
    }
}
