use super::model::*;
use super::protocol::Token;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const WORKING_FRESH_MS: i64 = 30 * 60_000;
pub const WORKING_RECHECK_MS: i64 = 25 * 60_000;
pub const FAILED_RETRY_MS: i64 = 5 * 60_000;
pub const INCOMPLETE_DELAYS: [i64; 5] = [30_000, 60_000, 120_000, 300_000, 600_000];
pub const QUEUE_LIMIT: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Forced,
    Recheck,
    Unknown,
    Retry,
}

#[derive(Clone, Debug)]
pub struct ProbeJob {
    pub key: String,
    pub candidate: Candidate,
    pub owner: FeedOwner,
    pub priority: Priority,
    pub revision: u64,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub phase_at: i64,
    pub active_phase: bool,
    pub incomplete_attempts: u8,
    pub expected_checked_at: Option<i64>,
    pub target: Option<VerificationTarget>,
    pub deadline: i64,
}

#[derive(Clone, Debug)]
pub enum TerminalOutcome {
    Playable {
        checked_at: i64,
        proof: AdvancingVideo,
        timings: Option<MediaTimings>,
    },
    Unavailable {
        checked_at: i64,
        retry_at: i64,
        reason: MediaFailureReason,
        phase: Option<MediaPhase>,
        timings: Option<MediaTimings>,
    },
}
#[derive(Clone, Debug)]
pub struct Terminal {
    pub owner: FeedOwner,
    pub outcome: TerminalOutcome,
}
#[derive(Clone, Debug)]
pub struct Deferred {
    pub candidate: Candidate,
    pub owner: FeedOwner,
    pub since: i64,
    pub until: i64,
    pub incomplete_attempts: u8,
    pub reason: Option<MediaDeferralReason>,
    pub phase: Option<MediaPhase>,
    pub timings: Option<MediaTimings>,
}

#[derive(Default)]
pub struct FeedBook {
    pub terminal: BTreeMap<String, Terminal>,
    pub queue: Vec<ProbeJob>,
    pub active: BTreeMap<Token, ProbeJob>,
    pub deferred: BTreeMap<String, Deferred>,
    pub health_revision: BTreeMap<String, u64>,
    pub decoded: BTreeMap<String, (i64, u32)>,
    pub check_targets: Vec<(String, i64)>,
    pub forced: BTreeSet<String>,
    pub completed: u64,
    pub recent: Vec<Value>,
    pub admissions: u64,
    pub urgent_admissions: u64,
    pub unknown_admissions: u64,
    pub background_cursor: usize,
    pub protected_background: Option<String>,
    pub protected_after_admission: u64,
}

impl FeedBook {
    pub fn revision(&self, key: &str) -> u64 {
        *self.health_revision.get(key).unwrap_or(&0)
    }
    pub fn invalidate(&mut self, key: &str) -> Vec<Token> {
        *self.health_revision.entry(key.into()).or_default() += 1;
        self.queue.retain(|job| job.key != key);
        self.deferred.remove(key);
        self.active
            .iter()
            .filter(|(_, job)| job.key == key)
            .map(|(token, _)| *token)
            .collect()
    }
    pub fn demand(&mut self, ids: &[String], at: i64) {
        self.check_targets
            .retain(|(id, requested)| at - *requested <= 90_000 && !ids.contains(id));
        self.check_targets
            .extend(ids.iter().cloned().map(|id| (id, at)));
        if self.check_targets.len() > 16 {
            self.check_targets.drain(..self.check_targets.len() - 16);
        }
    }
    pub fn availability(&self, candidate: &Candidate, key: &str, at: i64) -> Value {
        if let Some(Terminal {
            outcome:
                TerminalOutcome::Playable {
                    checked_at,
                    proof,
                    timings,
                },
            ..
        }) = self.terminal.get(key)
        {
            if at - *checked_at < WORKING_FRESH_MS && *checked_at <= at + 60_000 {
                let mut value = json!({"kind":"playable","checkedAt":checked_at,"proof":proof});
                if let Some(timings) = timings {
                    value["timings"] = json!(timings);
                }
                return value;
            }
        }
        if let Some(job) = self.active.values().find(|job| job.key == key) {
            return json!({"kind":"checking","progress":{"kind":if job.active_phase{"active"}else{"queued"},"since":job.phase_at}});
        }
        if let Some(job) = self.queue.iter().find(|job| job.key == key) {
            return json!({"kind":"checking","progress":{"kind":"queued","since":job.phase_at}});
        }
        if let Some(deferred) = self
            .deferred
            .get(key)
            .filter(|deferred| deferred.incomplete_attempts > 0 || deferred.until > at)
        {
            let mut progress = json!({"kind":"deferred","since":deferred.since,"retryAt":deferred.until,"retryAfterMs":deferred.until-deferred.since});
            if let Some(reason) = deferred.reason {
                progress["reason"] = json!(reason);
            }
            if let Some(phase) = deferred.phase {
                progress["phase"] = json!(phase);
            }
            if let Some(timings) = &deferred.timings {
                progress["timings"] = json!(timings);
            }
            return json!({"kind":"checking","progress":progress});
        }
        if let Some(Terminal {
            outcome:
                TerminalOutcome::Unavailable {
                    checked_at,
                    retry_at,
                    reason,
                    phase,
                    timings,
                },
            ..
        }) = self.terminal.get(key)
        {
            let mut value = json!({"kind":"unavailable","checkedAt":checked_at,"retryAt":retry_at,"reason":reason});
            if let Some(phase) = phase {
                value["phase"] = json!(phase);
            }
            if let Some(timings) = timings {
                value["timings"] = json!(timings);
            }
            return value;
        }
        let _ = candidate;
        json!({"kind":"unknown"})
    }
    pub fn playable(&self, key: &str, at: i64) -> bool {
        matches!(self.terminal.get(key),Some(Terminal{outcome:TerminalOutcome::Playable{checked_at,..},..}) if at-*checked_at<WORKING_FRESH_MS&&*checked_at<=at+60_000)
    }
    pub fn classify(&self, key: &str, at: i64, force: bool) -> Option<(Priority, Option<i64>)> {
        if self.active.values().any(|job| job.key == key)
            || self.queue.iter().any(|job| job.key == key)
        {
            return None;
        }
        if self.deferred.get(key).is_some_and(|row| row.until > at) {
            return None;
        }
        match self.terminal.get(key).map(|terminal| &terminal.outcome) {
            Some(TerminalOutcome::Playable { checked_at, .. }) => {
                (*checked_at + WORKING_RECHECK_MS <= at)
                    .then_some((Priority::Recheck, Some(*checked_at)))
            }
            _ if force => Some((Priority::Forced, None)),
            Some(TerminalOutcome::Unavailable { retry_at, .. }) => {
                (*retry_at <= at).then_some((Priority::Retry, None))
            }
            None if self
                .deferred
                .get(key)
                .is_some_and(|row| row.incomplete_attempts > 0) =>
            {
                Some((Priority::Retry, None))
            }
            None => Some((Priority::Unknown, None)),
        }
    }
    pub fn enqueue(
        &mut self,
        candidate: Candidate,
        key: String,
        owner: FeedOwner,
        priority: Priority,
        expected_checked_at: Option<i64>,
        at: i64,
    ) {
        if self.queue.len() >= QUEUE_LIMIT {
            if priority == Priority::Forced {
                if let Some(index) = self
                    .queue
                    .iter()
                    .rposition(|job| job.priority != Priority::Forced)
                {
                    self.queue.remove(index);
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        let incomplete_attempts = self
            .deferred
            .get(&key)
            .map_or(0, |row| row.incomplete_attempts);
        self.queue.push(ProbeJob {
            revision: self.revision(&key),
            key,
            candidate,
            owner,
            priority,
            queued_at: at,
            started_at: None,
            phase_at: at,
            active_phase: false,
            incomplete_attempts,
            expected_checked_at,
            target: None,
            deadline: at + 60_000,
        });
    }
    pub fn next(
        &mut self,
        demand: &BTreeSet<String>,
        needing_feeds: &BTreeSet<String>,
        recovery_keys: &BTreeSet<String>,
    ) -> Option<ProbeJob> {
        if self.queue.is_empty() {
            return None;
        }
        let mut priority = self.queue.iter().map(|job| job.priority).min()?;
        if matches!(priority, Priority::Forced | Priority::Recheck) && self.urgent_admissions >= 3 {
            if self
                .queue
                .iter()
                .any(|job| matches!(job.priority, Priority::Unknown | Priority::Retry))
            {
                priority = Priority::Unknown;
            }
        }
        if priority == Priority::Unknown {
            if self.unknown_admissions >= 3
                && self.queue.iter().any(|job| job.priority == Priority::Retry)
            {
                priority = Priority::Retry;
            } else if !self
                .queue
                .iter()
                .any(|job| job.priority == Priority::Unknown)
            {
                priority = Priority::Retry;
            }
        }
        let background = self.admissions % 4 == 3;
        let recovery = if priority == Priority::Retry {
            self.queue
                .iter()
                .position(|job| job.priority == priority && recovery_keys.contains(&job.key))
        } else {
            None
        };
        let protected = self
            .protected_background
            .as_ref()
            .filter(|_| self.admissions >= self.protected_after_admission)
            .and_then(|key| {
                self.queue
                    .iter()
                    .position(|job| job.key == *key && job.priority == priority)
            });
        let below_target = if background {
            None
        } else {
            self.queue
                .iter()
                .position(|job| {
                    job.priority == priority
                        && demand.contains(&job.candidate.game_id)
                        && needing_feeds.contains(&job.candidate.game_id)
                })
                .or_else(|| {
                    self.queue.iter().position(|job| {
                        job.priority == priority && needing_feeds.contains(&job.candidate.game_id)
                    })
                })
        };
        let index = recovery.or(protected).or(below_target).or_else(|| {
            self.queue
                .iter()
                .position(|job| {
                    job.priority == priority
                        && demand.contains(&job.candidate.game_id) != background
                })
                .or_else(|| self.queue.iter().position(|job| job.priority == priority))
        })?;
        let job = self.queue.remove(index);
        if matches!(priority, Priority::Forced | Priority::Recheck) {
            self.urgent_admissions += 1;
        } else {
            self.urgent_admissions = 0;
            self.unknown_admissions = if priority == Priority::Unknown {
                self.unknown_admissions + 1
            } else {
                0
            };
        }
        self.admissions += 1;
        if !demand.is_empty() && !demand.contains(&job.candidate.game_id) {
            self.background_cursor += 1;
        }
        Some(job)
    }
    pub fn accept(
        &mut self,
        job: &ProbeJob,
        result: MediaCheckResult,
        at: i64,
    ) -> Option<FeedCheckOutcome> {
        if job.revision != self.revision(&job.key) {
            return None;
        }
        if self.protected_background.as_deref() == Some(&job.key) {
            self.protected_background = None;
        }
        self.completed += 1;
        let mut recent = json!({"candidateId":job.candidate.id,"gameId":job.candidate.game_id,"checkedAt":at,"queueMs":(job.started_at.unwrap_or(at)-job.queued_at).max(0),"activeMs":(at-job.started_at.unwrap_or(at)).max(0)});
        let persisted = match result {
            MediaCheckResult::Playable { proof, timings } => {
                recent["outcome"] = json!("playable");
                if let Some(timings) = &timings {
                    recent["timings"] = json!(timings);
                }
                self.terminal.insert(
                    job.key.clone(),
                    Terminal {
                        owner: job.owner.clone(),
                        outcome: TerminalOutcome::Playable {
                            checked_at: at,
                            proof,
                            timings,
                        },
                    },
                );
                self.deferred.remove(&job.key);
                None
            }
            MediaCheckResult::Unavailable {
                reason,
                phase,
                timings,
            } => {
                recent["outcome"] = json!("unavailable");
                recent["reason"] = json!(reason);
                self.terminal.insert(
                    job.key.clone(),
                    Terminal {
                        owner: job.owner.clone(),
                        outcome: TerminalOutcome::Unavailable {
                            checked_at: at,
                            retry_at: at + FAILED_RETRY_MS,
                            reason,
                            phase,
                            timings: timings.clone(),
                        },
                    },
                );
                self.deferred.remove(&job.key);
                Some(FeedCheckOutcome::Unavailable {
                    checked_at: at,
                    retry_at: at + FAILED_RETRY_MS,
                    reason,
                    phase,
                    timings,
                })
            }
            MediaCheckResult::Deferred {
                retry_after_ms,
                reason,
                phase,
                timings,
            } => {
                let resource = matches!(
                    reason,
                    Some(MediaDeferralReason::Capacity | MediaDeferralReason::Cancelled)
                );
                let attempts = if resource {
                    job.incomplete_attempts
                } else {
                    job.incomplete_attempts.saturating_add(1).min(5)
                };
                let provider = (retry_after_ms.min(300_000) as i64).max(2000);
                let delay = if resource {
                    provider
                } else {
                    provider.max(INCOMPLETE_DELAYS[attempts.saturating_sub(1) as usize])
                };
                recent["outcome"] = json!("deferred");
                recent["retryAfterMs"] = json!(retry_after_ms);
                if let Some(reason) = reason {
                    recent["reason"] = json!(reason);
                }
                self.deferred.insert(
                    job.key.clone(),
                    Deferred {
                        candidate: job.candidate.clone(),
                        owner: job.owner.clone(),
                        since: at,
                        until: at + delay,
                        incomplete_attempts: attempts,
                        reason,
                        phase,
                        timings: timings.clone(),
                    },
                );
                (!resource).then_some(FeedCheckOutcome::Incomplete {
                    checked_at: at,
                    retry_at: at + delay,
                    incomplete_attempts: attempts,
                    reason,
                    phase,
                    timings,
                })
            }
        };
        self.recent.insert(0, recent);
        self.recent.truncate(32);
        persisted
    }
    pub fn next_deadline(&self, at: i64) -> Option<i64> {
        self.deferred
            .values()
            .map(|row| row.until)
            .chain(
                self.terminal
                    .values()
                    .map(|terminal| match terminal.outcome {
                        TerminalOutcome::Playable { checked_at, .. } => {
                            checked_at + WORKING_RECHECK_MS
                        }
                        TerminalOutcome::Unavailable { retry_at, .. } => retry_at,
                    }),
            )
            .filter(|deadline| *deadline > at)
            .min()
    }
    pub fn checks(&self, limit: usize) -> Value {
        json!({"limit":limit,"active":self.active.len(),"queued":self.queue.len(),"completed":self.completed,"recent":self.recent})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_does_not_create_a_completed_check() {
        let mut book = FeedBook::default();
        let job = job();
        let outcome = book.accept(
            &job,
            MediaCheckResult::Deferred {
                retry_after_ms: 2000,
                reason: Some(MediaDeferralReason::Capacity),
                phase: None,
                timings: None,
            },
            10_000,
        );
        assert!(outcome.is_none());
        assert_eq!(
            book.availability(&job.candidate, &job.key, 10_000),
            json!({"kind":"checking","progress":{"kind":"deferred","since":10000,"retryAt":12000,"retryAfterMs":2000,"reason":"capacity"}})
        );
    }
    fn job() -> ProbeJob {
        ProbeJob {
            key: "route".into(),
            candidate: Candidate {
                id: "candidate".into(),
                game_id: "game".into(),
                label: "Feed".into(),
                source_ids: vec!["source".into()],
                observed_at: 0,
                locator: CandidateLocator::Streameast {
                    channel_id: "1".into(),
                },
            },
            owner: FeedOwner::Matchup {
                league: League::Nfl,
                home: TeamIdentity {
                    id: Some("home".into()),
                    name: "Home".into(),
                },
                away: TeamIdentity {
                    id: Some("away".into()),
                    name: "Away".into(),
                },
                partition_ids: vec!["nfl".into()],
            },
            priority: Priority::Unknown,
            revision: 0,
            queued_at: 0,
            started_at: Some(0),
            phase_at: 0,
            active_phase: true,
            incomplete_attempts: 0,
            expected_checked_at: None,
            target: None,
            deadline: 60_000,
        }
    }
    #[test]
    fn incomplete_results_preserve_an_exponential_retry_count() {
        let mut book = FeedBook::default();
        let mut job = job();
        let first = book.accept(
            &job,
            MediaCheckResult::Deferred {
                retry_after_ms: 2000,
                reason: Some(MediaDeferralReason::Unverified),
                phase: Some(MediaPhase::Decode),
                timings: None,
            },
            10_000,
        );
        assert!(matches!(
            first,
            Some(FeedCheckOutcome::Incomplete {
                retry_at: 40000,
                incomplete_attempts: 1,
                ..
            })
        ));
        job.incomplete_attempts = 1;
        let second = book.accept(
            &job,
            MediaCheckResult::Deferred {
                retry_after_ms: 2000,
                reason: Some(MediaDeferralReason::Timeout),
                phase: None,
                timings: None,
            },
            40_000,
        );
        assert!(matches!(
            second,
            Some(FeedCheckOutcome::Incomplete {
                retry_at: 100000,
                incomplete_attempts: 2,
                ..
            })
        ));
    }
    #[test]
    fn a_forced_request_does_not_bypass_a_new_active_attempt_deferral() {
        let mut book = FeedBook::default();
        let job = job();
        book.accept(
            &job,
            MediaCheckResult::Deferred {
                retry_after_ms: 2000,
                reason: Some(MediaDeferralReason::Unverified),
                phase: None,
                timings: None,
            },
            10_000,
        );
        assert!(book.classify(&job.key, 10_000, true).is_none());
        assert_eq!(
            book.classify(&job.key, 40_000, true),
            Some((Priority::Forced, None))
        );
    }
    #[test]
    fn invalidated_jobs_cannot_publish_terminal_health() {
        let mut book = FeedBook::default();
        let job = job();
        book.invalidate(&job.key);
        assert!(
            book.accept(
                &job,
                MediaCheckResult::Unavailable {
                    reason: MediaFailureReason::Upstream,
                    phase: None,
                    timings: None
                },
                10_000
            )
            .is_none()
        );
        assert_eq!(
            book.availability(&job.candidate, &job.key, 10_000),
            json!({"kind":"unknown"})
        );
        assert_eq!(book.completed, 0);
    }

    #[test]
    fn a_reserved_retry_turn_keeps_watched_recovery_even_on_a_background_turn() {
        let mut book = FeedBook::default();
        book.admissions = 3;
        book.unknown_admissions = 3;
        let mut background = job();
        background.key = "background".into();
        background.candidate.game_id = "background".into();
        background.priority = Priority::Retry;
        let mut watched = job();
        watched.key = "watched".into();
        watched.candidate.game_id = "watched".into();
        watched.priority = Priority::Retry;
        book.queue = vec![background, watched];
        assert_eq!(
            book.next(
                &BTreeSet::from(["watched".into()]),
                &BTreeSet::new(),
                &BTreeSet::from(["watched".into()])
            )
            .unwrap()
            .key,
            "watched"
        );
    }

    #[test]
    fn a_game_below_the_working_feed_target_precedes_a_covered_viewer_game() {
        let mut book = FeedBook::default();
        let mut covered = job();
        covered.candidate.game_id = "covered".into();
        covered.key = "covered".into();
        let mut needing = job();
        needing.candidate.game_id = "needing".into();
        needing.key = "needing".into();
        book.queue = vec![covered, needing];
        assert_eq!(
            book.next(
                &BTreeSet::from(["covered".into()]),
                &BTreeSet::from(["needing".into()]),
                &BTreeSet::new()
            )
            .unwrap()
            .key,
            "needing"
        );
    }
}
