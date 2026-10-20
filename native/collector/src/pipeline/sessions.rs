use super::model::{Recovery, Session, SessionPhase};
use super::protocol::{Reply, error};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const SESSION_LEASE_MS: i64 = 90_000;

impl Recovery {
    pub fn new(at: i64) -> Self {
        Self {
            attempted: Vec::new(),
            cooled: BTreeMap::new(),
            failures: BTreeMap::new(),
            cycle_started_at: at,
        }
    }
    pub fn fail(&mut self, id: &str, at: i64) {
        let count = self.failures.entry(id.into()).or_default();
        *count += 1;
        let delay = 60_000i64
            .saturating_mul(1i64.checked_shl((*count - 1).min(30)).unwrap_or(i64::MAX))
            .min(600_000);
        self.cooled.insert(id.into(), at + delay);
        if !self.attempted.iter().any(|attempted| attempted == id) {
            self.attempted.push(id.into());
        }
    }
    pub fn next<'a>(
        &self,
        choices: &'a [Choice],
        at: i64,
        exclude: Option<&str>,
    ) -> Option<&'a Choice> {
        if self.attempted.len() >= 3 {
            return None;
        }
        choices
            .iter()
            .filter(|choice| {
                choice.playable
                    && Some(choice.id.as_str()) != exclude
                    && !self.attempted.contains(&choice.id)
                    && self.cooled.get(&choice.id).copied().unwrap_or(0) <= at
            })
            .min_by_key(|choice| self.failures.get(&choice.id).copied().unwrap_or(0))
    }
}

#[derive(Clone, Debug)]
pub struct Choice {
    pub id: String,
    pub owner: String,
    pub playable: bool,
    pub current: bool,
    pub visible: bool,
    pub recovery_ready: bool,
    pub summary: Value,
}

#[derive(Default)]
pub struct SessionBook {
    pub sessions: BTreeMap<String, OwnedSession>,
}

pub struct OwnedSession {
    pub value: Session,
    pub last_seen: i64,
    pub recovery: Recovery,
    pub refreshes: u8,
    pub drain_refreshes: u8,
    pub exhausted: Option<Exhausted>,
    pub request_id: Option<String>,
    pub selection: Option<String>,
    pub last_evidence: Option<(u64, i64)>,
}
pub struct Exhausted {
    pub until: i64,
    pub known_ids: BTreeSet<String>,
}

pub struct SessionAction {
    pub reply: Reply,
    pub failed: Option<String>,
    pub evidence: Option<(String, Value)>,
}

impl SessionAction {
    fn reply(reply: Reply) -> Self {
        Self {
            reply,
            failed: None,
            evidence: None,
        }
    }
}

impl SessionBook {
    pub fn sweep(&mut self, deadlines: &BTreeMap<String, i64>, at: i64) {
        self.sessions.retain(|_, owned| {
            let deadline = deadlines
                .get(&owned.value.game_id)
                .copied()
                .or(owned.value.grace_ends_at());
            if let Some(grace_ends_at) = deadline {
                owned.value.phase = if at >= grace_ends_at {
                    SessionPhase::Closed { grace_ends_at }
                } else {
                    SessionPhase::Draining { grace_ends_at }
                };
            }
            at - owned.last_seen <= SESSION_LEASE_MS && !owned.value.is_closed()
        });
    }

    pub fn prior(
        &mut self,
        request: &str,
        game_id: &str,
        manual: bool,
        at: i64,
        choices: &[Choice],
    ) -> Option<Reply> {
        let owned = self.sessions.values_mut().find(|owned| {
            owned.request_id.as_deref() == Some(request)
                && owned.value.game_id == game_id
                && (owned.value.candidate_id == "manual") == manual
                && !owned.value.is_closed()
        })?;
        owned.last_seen = at;
        Some(playback_reply(owned, choices, true))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        id: String,
        game_id: String,
        manual: bool,
        request_id: Option<String>,
        initial_candidate_id: Option<&str>,
        grace: Option<i64>,
        choices: &[Choice],
        at: i64,
    ) -> Reply {
        if manual && initial_candidate_id.is_some() {
            return error(400, "A manual feed cannot select a listed server.");
        }
        let choice = choices.iter().find(|choice| {
            choice.playable && initial_candidate_id.is_none_or(|id| id == choice.id)
        });
        if !manual && choice.is_none() {
            return error(
                404,
                if initial_candidate_id.is_some() {
                    "This server is no longer verified playable."
                } else {
                    "No playable server has been verified yet."
                },
            );
        }
        if self.sessions.len() >= 32 {
            return error(429, "Too many playback sessions.");
        }
        let session = Session {
            id: id.clone(),
            game_id,
            candidate_id: if manual {
                "manual".into()
            } else {
                choice.expect("choice checked").id.clone()
            },
            generation: 0,
            phase: grace.map_or(
                SessionPhase::Active { grace_ends_at: () },
                |grace_ends_at| SessionPhase::Draining { grace_ends_at },
            ),
        };
        let owned = OwnedSession {
            value: session,
            last_seen: at,
            recovery: Recovery::new(at),
            refreshes: 0,
            drain_refreshes: 0,
            exhausted: None,
            request_id,
            selection: choice.map(|choice| choice.owner.clone()),
            last_evidence: None,
        };
        let reply = playback_reply(&owned, choices, true);
        self.sessions.insert(id, owned);
        reply
    }

    pub fn handle(
        &mut self,
        command: &super::protocol::Command,
        choices: &[Choice],
        at: i64,
    ) -> SessionAction {
        use super::protocol::Command;
        let session_id = match command {
            Command::Session { session_id, .. }
            | Command::Authorize { session_id, .. }
            | Command::PlaybackEvidence { session_id, .. } => session_id,
            _ => return SessionAction::reply(error(400, "Invalid playback command.")),
        };
        let Some(owned) = self.sessions.get_mut(session_id) else {
            return SessionAction::reply(error(410, "Playback session ended."));
        };
        match command {
            Command::Authorize {
                candidate_id,
                generation,
                ..
            } => {
                let valid = owned.value.candidate_id == *candidate_id
                    && owned.value.generation == *generation
                    && choices.iter().any(|choice| {
                        choice.id == *candidate_id
                            && Some(&choice.owner) == owned.selection.as_ref()
                            && choice.current
                    });
                if !valid {
                    return SessionAction::reply(error(410, "Stream generation expired."));
                }
                owned.last_seen = at;
                return SessionAction::reply(json!({"kind":"authorized","session":owned.value}));
            }
            Command::PlaybackEvidence {
                candidate_id,
                generation,
                evidence,
                ..
            } => {
                let valid = owned.value.candidate_id != "manual"
                    && owned.value.candidate_id == *candidate_id
                    && owned.value.generation == *generation
                    && !owned.value.is_closed()
                    && choices.iter().any(|choice| {
                        choice.id == *candidate_id
                            && Some(&choice.owner) == owned.selection.as_ref()
                            && choice.current
                    });
                if !valid {
                    return SessionAction::reply(error(410, "Stream generation expired."));
                }
                if owned
                    .last_evidence
                    .is_some_and(|(last_generation, last_at)| {
                        last_generation == *generation && at - last_at < 60_000
                    })
                {
                    return SessionAction::reply(json!({"kind":"ok"}));
                }
                owned.last_evidence = Some((*generation, at));
                return SessionAction {
                    reply: json!({"kind":"ok"}),
                    failed: None,
                    evidence: Some((candidate_id.clone(), evidence.clone())),
                };
            }
            _ => {}
        }
        let Command::Session {
            generation,
            candidate_id,
            failure,
            retry,
            ..
        } = command
        else {
            unreachable!()
        };
        if owned.value.generation != *generation {
            return SessionAction::reply(error(
                409,
                "Playback state changed. Refresh this stream.",
            ));
        }
        owned.last_seen = at;
        let mut failed = None;
        if matches!(owned.value.phase, SessionPhase::Active { .. })
            && owned.value.candidate_id != "manual"
            && !choices
                .iter()
                .any(|choice| choice.id == owned.value.candidate_id)
        {
            let Some(next) = choices.iter().find(|choice| choice.playable) else {
                return SessionAction::reply(checking(at + 1000));
            };
            select(owned, next, at, true);
            return SessionAction::reply(playback_reply(owned, choices, false));
        }
        if matches!(owned.value.phase, SessionPhase::Draining { .. }) {
            owned.exhausted = None;
            if let Some(id) = candidate_id
                .as_deref()
                .filter(|id| *id != owned.value.candidate_id)
            {
                let Some(choice) = choices
                    .iter()
                    .find(|choice| choice.id == id && choice.playable)
                else {
                    return SessionAction::reply(error(
                        404,
                        "This server is no longer verified playable.",
                    ));
                };
                select(owned, choice, at, false);
                owned.drain_refreshes = 0;
                return SessionAction::reply(playback_reply(owned, choices, false));
            }
            if *failure && owned.value.candidate_id != "manual" {
                if choices.iter().any(|choice| {
                    choice.id == owned.value.candidate_id
                        && Some(&choice.owner) == owned.selection.as_ref()
                        && choice.current
                }) {
                    failed = Some(owned.value.candidate_id.clone());
                }
                if let Some(next) = choices
                    .iter()
                    .find(|choice| choice.playable && choice.id != owned.value.candidate_id)
                {
                    select(owned, next, at, false);
                    owned.drain_refreshes = 0;
                    return SessionAction {
                        reply: playback_reply(owned, choices, false),
                        failed,
                        evidence: None,
                    };
                }
            }
            if *failure || *retry {
                if owned.drain_refreshes >= 1 {
                    return SessionAction {
                        reply: json!({"kind":"error","status":503,"code":"drain-exhausted","message":"This game has ended. The current stream cannot refresh again."}),
                        failed,
                        evidence: None,
                    };
                }
                owned.drain_refreshes += 1;
                owned.value.generation += 1;
            }
            return SessionAction {
                reply: playback_reply(owned, choices, false),
                failed,
                evidence: None,
            };
        }
        if *retry {
            owned.recovery.attempted.clear();
            owned.recovery.cycle_started_at = at;
            owned.refreshes = 0;
            owned.exhausted = None;
            if owned.value.candidate_id != "manual" {
                owned.value.generation += 1;
            }
            return SessionAction::reply(playback_reply(owned, choices, false));
        }
        if owned.value.candidate_id == "manual" {
            return SessionAction::reply(playback_reply(owned, choices, false));
        }
        if let Some(id) = candidate_id
            .as_deref()
            .filter(|id| *id != owned.value.candidate_id)
        {
            let Some(choice) = choices
                .iter()
                .find(|choice| choice.id == id && choice.playable)
            else {
                return SessionAction::reply(error(
                    404,
                    "This server is no longer verified playable.",
                ));
            };
            select(owned, choice, at, false);
            return SessionAction::reply(playback_reply(owned, choices, false));
        }
        if let Some(exhausted) = owned.exhausted.as_ref() {
            let fresh: Vec<_> = choices
                .iter()
                .filter(|choice| choice.playable || choice.current && choice.recovery_ready)
                .cloned()
                .collect();
            let eligible: Vec<_> = fresh
                .iter()
                .filter(|choice| at >= exhausted.until || !exhausted.known_ids.contains(&choice.id))
                .cloned()
                .map(|mut choice| {
                    choice.playable = true;
                    choice
                })
                .collect();
            let mut recovery = owned.recovery.clone();
            recovery.attempted.clear();
            let next = recovery
                .next(&eligible, at, Some(&owned.value.candidate_id))
                .or_else(|| {
                    if at >= exhausted.until {
                        recovery.next(&eligible, at, None)
                    } else {
                        None
                    }
                });
            if let Some(choice) = next {
                select(owned, choice, at, false);
                return SessionAction::reply(playback_reply(owned, choices, false));
            }
            if at >= exhausted.until {
                owned.exhausted = Some(exhausted_phase(&fresh, &owned.recovery, at));
            }
            return SessionAction::reply(checking(
                owned
                    .exhausted
                    .as_ref()
                    .expect("exhausted phase retained")
                    .until,
            ));
        }
        if *failure {
            if choices.iter().any(|choice| {
                choice.id == owned.value.candidate_id
                    && Some(&choice.owner) == owned.selection.as_ref()
                    && choice.current
            }) {
                failed = Some(owned.value.candidate_id.clone());
            }
            if owned.refreshes < 1 {
                owned.refreshes += 1;
                owned.value.generation += 1;
                return SessionAction {
                    reply: playback_reply(owned, choices, false),
                    failed,
                    evidence: None,
                };
            }
            owned.recovery.fail(&owned.value.candidate_id, at);
            owned.refreshes = 0;
            let next = owned
                .recovery
                .next(choices, at, Some(&owned.value.candidate_id));
            let Some(next) = next else {
                owned.exhausted = Some(exhausted_phase(choices, &owned.recovery, at));
                return SessionAction {
                    reply: checking(owned.exhausted.as_ref().expect("phase set").until),
                    failed,
                    evidence: None,
                };
            };
            owned.value.candidate_id = next.id.clone();
            owned.value.generation += 1;
            owned.selection = Some(next.owner.clone());
        }
        SessionAction {
            reply: playback_reply(owned, choices, false),
            failed,
            evidence: None,
        }
    }
}

fn checking(until: i64) -> Reply {
    json!({"kind":"error","status":503,"message":"Checking the next available stream.","retryAfter":until})
}
fn select(owned: &mut OwnedSession, choice: &Choice, at: i64, clear_failures: bool) {
    owned.value.candidate_id = choice.id.clone();
    owned.value.generation += 1;
    owned.selection = Some(choice.owner.clone());
    owned.refreshes = 0;
    owned.exhausted = None;
    if clear_failures {
        owned.recovery = Recovery::new(at);
    } else {
        owned.recovery.attempted.clear();
        owned.recovery.cycle_started_at = at;
    }
}
fn exhausted_phase(choices: &[Choice], recovery: &Recovery, at: i64) -> Exhausted {
    Exhausted {
        until: choices
            .iter()
            .filter(|choice| choice.playable)
            .map(|choice| {
                recovery
                    .cooled
                    .get(&choice.id)
                    .copied()
                    .unwrap_or(at + 30_000)
                    .max(at + 1000)
            })
            .min()
            .unwrap_or(at + 30_000)
            .min(at + 30_000),
        known_ids: choices
            .iter()
            .filter(|choice| choice.playable)
            .map(|choice| choice.id.clone())
            .collect(),
    }
}
fn playback_reply(owned: &OwnedSession, choices: &[Choice], open: bool) -> Reply {
    let candidates: Vec<_> = choices
        .iter()
        .filter(|choice| {
            choice.current && (choice.visible || owned.value.candidate_id == "manual")
                || choice.id == owned.value.candidate_id
        })
        .map(|choice| choice.summary.clone())
        .collect();
    if open {
        json!({"kind":"playback","playback":{"session":owned.value,"candidates":candidates}})
    } else {
        json!({"kind":"session","session":owned.value,"candidates":candidates})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn choice(id: &str) -> Choice {
        Choice {
            id: id.into(),
            owner: id.into(),
            playable: true,
            current: true,
            visible: true,
            recovery_ready: false,
            summary: json!({"id":id}),
        }
    }
    #[test]
    fn recovery_marks_failed_choice_and_doubles_its_cooldown() {
        let mut recovery = Recovery::new(0);
        recovery.fail("a", 1_000);
        assert_eq!(recovery.cooled.get("a"), Some(&61_000));
        recovery.fail("a", 62_000);
        assert_eq!(recovery.cooled.get("a"), Some(&182_000));
        assert_eq!(recovery.attempted.len(), 1);
    }
    #[test]
    fn recovery_limits_a_cycle_to_three_distinct_failures() {
        let mut recovery = Recovery::new(0);
        for id in ["a", "b", "c"] {
            recovery.fail(id, 0);
        }
        assert!(recovery.next(&[choice("d")], 1_000_000, None).is_none());
    }
    #[test]
    fn draining_allows_one_refresh_and_rejects_the_next() {
        let mut book = SessionBook::default();
        let choices = [choice("a")];
        book.open(
            "session".into(),
            "game".into(),
            false,
            None,
            None,
            Some(60_000),
            &choices,
            0,
        );
        let first = book.handle(
            &super::super::protocol::Command::Session {
                session_id: "session".into(),
                generation: 0,
                candidate_id: None,
                failure: false,
                retry: true,
            },
            &choices,
            1000,
        );
        assert_eq!(first.reply["session"]["generation"], 1);
        let second = book.handle(
            &super::super::protocol::Command::Session {
                session_id: "session".into(),
                generation: 1,
                candidate_id: None,
                failure: false,
                retry: true,
            },
            &choices,
            2000,
        );
        assert_eq!(second.reply["code"], "drain-exhausted");
    }
    #[test]
    fn authorization_rejects_a_reassigned_selection() {
        let mut book = SessionBook::default();
        let mut choices = [choice("a")];
        book.open(
            "session".into(),
            "game".into(),
            false,
            None,
            None,
            None,
            &choices,
            0,
        );
        choices[0].owner = "a-different-game-owner".into();
        let reply = book.handle(
            &super::super::protocol::Command::Authorize {
                session_id: "session".into(),
                candidate_id: "a".into(),
                generation: 0,
            },
            &choices,
            1000,
        );
        assert_eq!(reply.reply["status"], 410);
    }
    #[test]
    fn exhausted_polling_keeps_its_original_retry_deadline() {
        let mut book = SessionBook::default();
        let mut choices = [choice("a")];
        book.open(
            "session".into(),
            "game".into(),
            false,
            None,
            None,
            None,
            &choices,
            0,
        );
        let failed = |generation| super::super::protocol::Command::Session {
            session_id: "session".into(),
            generation,
            candidate_id: None,
            failure: true,
            retry: false,
        };
        book.handle(&failed(0), &choices, 1000);
        choices[0].playable = false;
        let exhausted = book.handle(&failed(1), &choices, 2000);
        assert_eq!(exhausted.reply["retryAfter"], 32_000);
        let polled = book.handle(&failed(1), &choices, 10_000);
        assert_eq!(polled.reply["retryAfter"], 32_000);
    }
}
