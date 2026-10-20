//! Schedule and source-event matching.
use super::{
    domain::{feed_calendar_day, feed_eligible},
    model::*,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, OnceLock},
};
use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
thread_local! {
    static ALIAS_PREPARATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
pub(super) fn alias_preparations(reset: bool) -> usize {
    ALIAS_PREPARATIONS.with(|counter| {
        if reset {
            counter.replace(0)
        } else {
            counter.get()
        }
    })
}

pub fn normalized_name(value: &str) -> String {
    let decomposed: String = value
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect::<String>()
        .to_lowercase();
    cached_regex!(r"\band\b")
        .unwrap()
        .replace_all(&decomposed, "&")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchMode {
    #[default]
    Current,
    InventoryLive,
}

#[derive(Deserialize)]
struct CollegeTeam {
    id: String,
    aliases: Vec<String>,
}
struct CollegeAliases {
    by_id: HashMap<String, HashSet<String>>,
    owners: HashMap<String, HashSet<String>>,
}
fn college_aliases() -> &'static CollegeAliases {
    static ALIASES: OnceLock<CollegeAliases> = OnceLock::new();
    ALIASES.get_or_init(|| {
        let source = include_str!("../../../../lib/football/domain/college-teams.generated.ts");
        let raw = source
            .split_once(" = [")
            .expect("college catalog declaration")
            .1;
        let json = format!("[{}", raw.trim().trim_end_matches(';'));
        let rows: Vec<CollegeTeam> =
            serde_json::from_str(&json).expect("committed college catalog");
        let mut aliases = CollegeAliases {
            by_id: HashMap::new(),
            owners: HashMap::new(),
        };
        for row in rows {
            let names: HashSet<_> = row
                .aliases
                .iter()
                .map(|name| normalized_name(name))
                .filter(|name| !name.is_empty())
                .collect();
            for name in &names {
                aliases
                    .owners
                    .entry(name.clone())
                    .or_default()
                    .insert(format!("ncaaf:{}", row.id));
            }
            aliases.by_id.insert(row.id, names);
        }
        aliases
    })
}

struct PreparedMatchup {
    index: usize,
    home: HashSet<String>,
    away: HashSet<String>,
    home_id: String,
    away_id: String,
}
struct MatchupAliases {
    home: HashSet<String>,
    away: HashSet<String>,
    home_id: String,
    away_id: String,
}
pub struct GamePreparation {
    games: Vec<Game>,
    matchups: Vec<Option<MatchupAliases>>,
}
impl GamePreparation {
    pub fn new(games: &[Game]) -> Self {
        Self {
            games: games.to_vec(),
            matchups: games
                .iter()
                .map(|game| {
                    game.home()
                        .zip(game.away())
                        .map(|(home, away)| MatchupAliases {
                            home: aliases(game, home),
                            away: aliases(game, away),
                            home_id: team_id(game, home),
                            away_id: team_id(game, away),
                        })
                })
                .collect(),
        }
    }
    pub fn games(&self) -> &[Game] {
        &self.games
    }
}
pub struct ObservationMatcher {
    games: Vec<Game>,
    mode: MatchMode,
    prepared: Vec<PreparedMatchup>,
    home_by_alias: HashMap<String, Vec<usize>>,
    away_by_alias: HashMap<String, Vec<usize>>,
    live_owners: HashMap<String, HashSet<String>>,
    college_by_team: HashMap<String, Vec<usize>>,
}
fn team_id(game: &Game, team: &Team) -> String {
    format!(
        "{}:{}",
        league_name(game.league),
        team.id
            .clone()
            .unwrap_or_else(|| normalized_name(&team.name))
    )
}
pub fn league_name(league: League) -> &'static str {
    match league {
        League::Nfl => "nfl",
        League::Ncaaf => "ncaaf",
        League::Nba => "nba",
        League::Wnba => "wnba",
        League::Nhl => "nhl",
        League::Mlb => "mlb",
        League::F1 => "f1",
        League::NascarCup => "nascar-cup",
        League::NascarTruck => "nascar-truck",
        League::Motogp => "motogp",
        League::Motorsport => "motorsport",
        League::Ufc => "ufc",
        League::Boxing => "boxing",
        League::Wwe => "wwe",
        League::Tna => "tna",
        League::Aew => "aew",
        League::Wrestling => "wrestling",
    }
}
fn aliases(game: &Game, team: &Team) -> HashSet<String> {
    #[cfg(test)]
    ALIAS_PREPARATIONS.set(ALIAS_PREPARATIONS.get() + 1);
    let mut result = if game.league == League::Ncaaf {
        team.id
            .as_ref()
            .and_then(|id| college_aliases().by_id.get(id))
            .cloned()
            .unwrap_or_default()
    } else {
        HashSet::new()
    };
    for value in [&team.name, &team.short, &team.abbreviation]
        .into_iter()
        .chain(team.aliases.iter().flatten())
    {
        let name = normalized_name(value);
        if !name.is_empty() {
            result.insert(name);
        }
    }
    if game.league == League::Nhl {
        let extra = match team.id.as_deref() {
            Some("espn:nhl:21") => Some("Maple Leaf"),
            Some("espn:nhl:10") => Some("Canadeins"),
            _ => None,
        };
        if let Some(name) = extra {
            result.insert(normalized_name(name));
        }
    }
    result
}
fn rejected(reason: &str, ids: Vec<String>) -> Match {
    Match::Unmatched {
        reason: reason.into(),
        possible_game_ids: ids,
    }
}
fn matched(game: &Game) -> Match {
    Match::Matched {
        game_id: game.id.clone(),
    }
}
fn stale(observation: &Observation, now: i64, fresh_until: Option<i64>) -> bool {
    now > fresh_until
        .unwrap_or(0)
        .max(observation.observed_at + 30 * 60_000)
}

impl ObservationMatcher {
    pub fn new(games: &[Game], mode: MatchMode) -> Self {
        Self::with_preparation(&GamePreparation::new(games), mode, None)
    }
    fn with_preparation(
        preparation: &GamePreparation,
        mode: MatchMode,
        leagues: Option<&[League]>,
    ) -> Self {
        let selected: Vec<_> = preparation
            .games
            .iter()
            .enumerate()
            .filter(|(_, game)| leagues.is_none_or(|leagues| leagues.contains(&game.league)))
            .collect();
        let games: Vec<_> = selected.iter().map(|(_, game)| (*game).clone()).collect();
        let pairs: Vec<_> = selected
            .iter()
            .map(|(index, _)| preparation.matchups[*index].as_ref())
            .collect();
        let mut live_owners: HashMap<String, HashSet<String>> = HashMap::new();
        for (index, game) in games.iter().enumerate() {
            if let Some(pair) = pairs[index] {
                for (id, names) in [(&pair.home_id, &pair.home), (&pair.away_id, &pair.away)] {
                    for name in names {
                        live_owners
                            .entry(format!("{}:{name}", league_name(game.league)))
                            .or_default()
                            .insert(id.clone());
                    }
                }
            }
        }
        let mut matcher = Self {
            games: games.clone(),
            mode,
            prepared: Vec::new(),
            home_by_alias: HashMap::new(),
            away_by_alias: HashMap::new(),
            live_owners,
            college_by_team: HashMap::new(),
        };
        for (index, game) in games.iter().enumerate() {
            let (Some(home), Some(away)) = (game.home(), game.away()) else {
                continue;
            };
            let pair = pairs[index].expect("matchup aliases follow matchup games");
            let clean = |names: &HashSet<String>, owner: &String| {
                names
                    .iter()
                    .filter(|name| {
                        let live = matcher
                            .live_owners
                            .get(&format!("{}:{name}", league_name(game.league)));
                        let catalog = if game.league == League::Ncaaf {
                            college_aliases().owners.get(*name)
                        } else {
                            None
                        };
                        live.is_none_or(|owners| owners.len() == 1 && owners.contains(owner))
                            && catalog
                                .is_none_or(|owners| owners.len() == 1 && owners.contains(owner))
                    })
                    .cloned()
                    .collect::<HashSet<_>>()
            };
            let row = PreparedMatchup {
                index,
                home: clean(&pair.home, &pair.home_id),
                away: clean(&pair.away, &pair.away_id),
                home_id: pair.home_id.clone(),
                away_id: pair.away_id.clone(),
            };
            let p = matcher.prepared.len();
            for alias in &row.home {
                matcher
                    .home_by_alias
                    .entry(alias.clone())
                    .or_default()
                    .push(p);
            }
            for alias in &row.away {
                matcher
                    .away_by_alias
                    .entry(alias.clone())
                    .or_default()
                    .push(p);
            }
            if game.league == League::Ncaaf
                && home
                    .id
                    .as_ref()
                    .is_some_and(|id| college_aliases().by_id.contains_key(id))
                && away
                    .id
                    .as_ref()
                    .is_some_and(|id| college_aliases().by_id.contains_key(id))
            {
                matcher
                    .college_by_team
                    .entry(row.home_id.clone())
                    .or_default()
                    .push(p);
                if row.away_id != row.home_id {
                    matcher
                        .college_by_team
                        .entry(row.away_id.clone())
                        .or_default()
                        .push(p);
                }
            }
            matcher.prepared.push(row);
        }
        matcher
    }

    fn anchored(&self, anchor: &str, other: &str) -> Vec<usize> {
        let (Some(owners), Some(other_owners), Some(active), Some(active_other)) = (
            college_aliases().owners.get(anchor),
            college_aliases().owners.get(other),
            self.live_owners.get(&format!("ncaaf:{anchor}")),
            self.live_owners.get(&format!("ncaaf:{other}")),
        ) else {
            return Vec::new();
        };
        if owners.len() != 1
            || other_owners.len() <= 1
            || active.len() != 1
            || active_other.iter().any(|id| !other_owners.contains(id))
        {
            return Vec::new();
        }
        let owner = owners.iter().next().unwrap();
        if !active.contains(owner) {
            return Vec::new();
        }
        self.college_by_team
            .get(owner)
            .into_iter()
            .flatten()
            .copied()
            .filter(|p| {
                let row = &self.prepared[*p];
                row.home_id == *owner
                    && other_owners.contains(&row.away_id)
                    && active_other.contains(&row.away_id)
                    || row.away_id == *owner
                        && other_owners.contains(&row.home_id)
                        && active_other.contains(&row.home_id)
            })
            .collect()
    }

    pub fn match_observation(
        &self,
        observation: &Observation,
        now: i64,
        fresh_until: Option<i64>,
    ) -> Match {
        if observation.league.is_some_and(is_motorsports_league) {
            return match_race(observation, &self.games, now, self.mode, fresh_until);
        }
        if observation.league.is_some_and(is_combat_league) {
            return match_combat(observation, &self.games, now, self.mode, fresh_until);
        }
        if observation.league.is_some_and(is_wrestling_league) {
            return match_wrestling(observation, &self.games, now, self.mode, fresh_until);
        }
        let Some(teams) = &observation.teams else {
            return rejected("not-a-matchup", vec![]);
        };
        let is_stale = stale(observation, now, fresh_until);
        if observation.observed_at > now + 60_000 || is_stale && self.mode == MatchMode::Current {
            return rejected("stale-observation", vec![]);
        }
        let first = normalized_name(&teams[0]);
        let second = normalized_name(&teams[1]);
        if first.is_empty() || second.is_empty() || first == second {
            return rejected("not-a-matchup", vec![]);
        }
        let mut strict = Vec::new();
        for (p, other) in self
            .home_by_alias
            .get(&first)
            .into_iter()
            .flatten()
            .map(|p| (*p, &self.prepared[*p].away))
            .chain(
                self.away_by_alias
                    .get(&first)
                    .into_iter()
                    .flatten()
                    .map(|p| (*p, &self.prepared[*p].home)),
            )
        {
            let row = &self.prepared[p];
            if observation
                .league
                .is_none_or(|league| self.games[row.index].league == league)
                && other.contains(&second)
                && !strict.contains(&p)
            {
                strict.push(p)
            }
        }
        strict.sort_unstable_by_key(|p| self.prepared[*p].index);
        let mut contextual = if observation.league.is_some_and(|league| {
            matches!(
                league,
                League::Nfl | League::Nba | League::Wnba | League::Nhl | League::Mlb
            )
        }) {
            Vec::new()
        } else {
            self.anchored(&first, &second)
                .into_iter()
                .chain(self.anchored(&second, &first))
                .collect::<Vec<_>>()
        };
        contextual.sort_unstable_by_key(|p| self.prepared[*p].index);
        contextual.dedup();
        let mut possible = Vec::new();
        for p in strict.iter().chain(&contextual) {
            if !possible
                .iter()
                .any(|previous: &&Game| previous.id == self.games[self.prepared[*p].index].id)
            {
                possible.push(&self.games[self.prepared[*p].index]);
            }
        }
        let ids = possible.iter().map(|game| game.id.clone()).collect();
        let Some(kickoff) = observation.kickoff else {
            return rejected(
                if possible.is_empty() {
                    "unknown-teams"
                } else if possible.len() == 1 && possible[0].lifecycle == GameLifecycle::Final {
                    "finished-game"
                } else if !contextual.is_empty() {
                    "unverified-contextual-kickoff"
                } else {
                    "unverified-kickoff"
                },
                ids,
            );
        };
        let dated: Vec<_> = possible
            .iter()
            .filter(|game| {
                game.kickoff()
                    .is_some_and(|date| (date - kickoff).abs() <= 3 * 60 * 60_000)
            })
            .copied()
            .collect();
        if dated.len() != 1 {
            return rejected(
                if !dated.is_empty() {
                    "ambiguous-matchup"
                } else if !possible.is_empty() {
                    "conflicting-date"
                } else {
                    "unknown-teams"
                },
                ids,
            );
        }
        finish(dated[0], is_stale)
    }
}
fn finish(game: &Game, is_stale: bool) -> Match {
    if is_stale && game.lifecycle != GameLifecycle::Live {
        return rejected("stale-observation", vec![game.id.clone()]);
    }
    if game.lifecycle == GameLifecycle::Final {
        return rejected("finished-game", vec![game.id.clone()]);
    }
    matched(game)
}
pub fn match_observation(observation: &Observation, games: &[Game], now: i64) -> Match {
    ObservationMatcher::new(games, MatchMode::Current).match_observation(observation, now, None)
}
pub fn detail_candidate_game_ids(result: &Match) -> Vec<String> {
    match result {
        Match::Matched { game_id } => vec![game_id.clone()],
        Match::Unmatched {
            reason,
            possible_game_ids,
        } if matches!(
            reason.as_str(),
            "unverified-kickoff" | "unverified-contextual-kickoff" | "unverified-race"
        ) =>
        {
            possible_game_ids.clone()
        }
        _ => Vec::new(),
    }
}

fn clean_wrestling_title(title: &str) -> String {
    let value: String = title
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect::<String>()
        .to_lowercase();
    let value = cached_regex!(r"\s+(?:watch\s+)?(?:live\s+stream|live)$")
        .unwrap()
        .replace(&value, "");
    cached_regex!(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&value, " ")
        .trim()
        .to_string()
}
pub fn wrestling_promotion(title: &str) -> Option<League> {
    crate::wrestling::league(&clean_wrestling_title(title))
}
pub fn wrestling_show_key(league: League, title: &str) -> Option<String> {
    let value = clean_wrestling_title(title);
    let strip = |prefix: &str| {
        value
            .strip_prefix(prefix)
            .filter(|tail| tail.starts_with(|c: char| c.is_ascii_alphanumeric()))
            .map(str::to_string)
    };
    match league {
        League::Wwe => {
            if cached_regex!(r"^(?:wwe )?(?:monday night )?raw$")
                .unwrap()
                .is_match(&value)
            {
                Some("raw".into())
            } else if cached_regex!(r"^(?:wwe )?(?:friday night )?smackdown$")
                .unwrap()
                .is_match(&value)
            {
                Some("smackdown".into())
            } else if cached_regex!(r"^(?:wwe )?nxt$").unwrap().is_match(&value) {
                Some("nxt".into())
            } else if cached_regex!(r"^(?:wwe )?nxt [a-z0-9]")
                .unwrap()
                .is_match(&value)
            {
                Some(value.strip_prefix("wwe ").unwrap_or(&value).to_string())
            } else {
                strip("wwe ")
            }
        }
        League::Tna => {
            if cached_regex!(r"^(?:tna )?impact(?: wrestling)?$")
                .unwrap()
                .is_match(&value)
            {
                Some("impact".into())
            } else {
                strip("impact wrestling ").or_else(|| {
                    strip("tna ").map(|name| {
                        name.strip_prefix("impact wrestling ")
                            .unwrap_or(&name)
                            .to_string()
                    })
                })
            }
        }
        League::Aew => strip("aew ").or_else(|| strip("all elite wrestling ")),
        League::Wrestling => (!value.is_empty()).then_some(value),
        _ => None,
    }
}
pub fn wrestling_event_key(league: League, title: &str, kickoff: i64) -> Option<String> {
    let show = wrestling_show_key(league, title)?;
    let day = feed_calendar_day(kickoff)?;
    let date = chrono::DateTime::from_timestamp_millis(day * 86_400_000)?;
    Some(format!(
        "{}|{show}|{}",
        league_name(league),
        date.format("%Y-%m-%d")
    ))
}
fn match_wrestling(
    observation: &Observation,
    games: &[Game],
    now: i64,
    mode: MatchMode,
    fresh: Option<i64>,
) -> Match {
    let is_stale = stale(observation, now, fresh);
    if observation.observed_at > now + 60_000 || is_stale && mode == MatchMode::Current {
        return rejected("stale-observation", vec![]);
    }
    let (Some(kickoff), Some(league)) = (observation.kickoff, observation.league) else {
        return rejected("unverified-kickoff", vec![]);
    };
    if observation.teams.is_some() || !is_wrestling_league(league) {
        return rejected("unverified-kickoff", vec![]);
    }
    let (Some(key), Some(show)) = (
        wrestling_event_key(league, &observation.title, kickoff),
        wrestling_show_key(league, &observation.title),
    ) else {
        return rejected("unknown-teams", vec![]);
    };
    let same: Vec<_> = games
        .iter()
        .filter(|game| {
            game.wrestling().is_some()
                && game.league == league
                && wrestling_show_key(game.league, &game.name).as_deref() == Some(&show)
        })
        .collect();
    let dated: Vec<_> = same
        .iter()
        .filter(|game| {
            game.kickoff().is_some_and(|date| {
                wrestling_event_key(game.league, &game.name, date).as_deref() == Some(&key)
                    && (date - kickoff).abs() <= 90 * 60_000
            })
        })
        .copied()
        .collect();
    if dated.len() != 1 {
        let conflicts: Vec<_> = same
            .iter()
            .filter(|game| {
                game.kickoff().is_some_and(|date| {
                    wrestling_event_key(game.league, &game.name, date).as_deref() == Some(&key)
                        || (date - kickoff).abs() <= 90 * 60_000
                })
            })
            .copied()
            .collect();
        return rejected(
            if !dated.is_empty() {
                "ambiguous-matchup"
            } else if !conflicts.is_empty() {
                "conflicting-date"
            } else {
                "unknown-teams"
            },
            if !dated.is_empty() { dated } else { conflicts }
                .iter()
                .map(|game| game.id.clone())
                .collect(),
        );
    }
    finish(dated[0], is_stale)
}

pub fn combat_card_title(value: &str) -> (String, Option<String>) {
    let title = cached_regex!(r"(?i)\s+vs\s+live(?:\s+broadcast)?$")
        .unwrap()
        .replace(value.trim(), "");
    let title = cached_regex!(r"(?i)\s+(?:watch\s+)?(?:live\s+stream|live)$")
        .unwrap()
        .replace(&title, "")
        .to_string();
    if !cached_regex!(r"(?i)^ufc\b").unwrap().is_match(&title) {
        return (title, None);
    }
    let stage=cached_regex!(r"(?i)\s*(?:[:\-–—]\s*|\(\s*|\s+)((?:early\s+)?(?:prelims|preliminary\s+card)|main\s+card)\s*\)?$").unwrap();
    if let Some(capture) = stage.captures(&title) {
        let label = capture[1].to_lowercase();
        let segment = if label.starts_with("early") {
            "Early Prelims"
        } else if label.starts_with("main") {
            "Main Card"
        } else {
            "Prelims"
        };
        return (
            title[..capture.get(0).unwrap().start()].trim().to_string(),
            Some(segment.into()),
        );
    }
    (title, None)
}
struct Fighters {
    card: Option<String>,
    rematch: Option<String>,
    first: Vec<String>,
    second: Vec<String>,
}
fn combat_fighters(value: &str) -> Option<Fighters> {
    let (title, _) = combat_card_title(value);
    let card_re =
        cached_regex!(r"(?i)^(UFC\s+(?:Fight\s+Night|\d{1,4})|BKFC\s+\d{1,4})\s*[:\-]?\s+")
            .unwrap();
    let card = card_re.captures(&title);
    let tail = card
        .as_ref()
        .map(|capture| &title[capture.get(0).unwrap().end()..])
        .unwrap_or(&title);
    let pair_re = cached_regex!(r"(?i)^(.+?)\s+vs?\.?\s+(.+?)(?:\s+(\d{1,2}))?$").unwrap();
    let pair = pair_re.captures(tail)?;
    let valid = cached_regex!(r"^[\p{L}\p{M}'’.-]+$").unwrap();
    let mut first: Vec<_> = pair[1].split_whitespace().collect();
    let second: Vec<_> = pair[2].split_whitespace().collect();
    if first
        .iter()
        .chain(&second)
        .any(|word| !valid.is_match(word))
    {
        return None;
    }
    if card
        .as_ref()
        .is_some_and(|capture| capture[1].to_uppercase().starts_with("BKFC"))
    {
        first = first.into_iter().rev().take(1).collect()
    }
    Some(Fighters {
        card: card.as_ref().map(|capture| normalized_name(&capture[1])),
        rematch: pair.get(3).map(|word| word.as_str().to_string()),
        first: first.into_iter().map(normalized_name).collect(),
        second: second.into_iter().map(normalized_name).collect(),
    })
}
fn combat_titles_match(observed: &str, scheduled: &str) -> bool {
    let (left_title, _) = combat_card_title(observed);
    let (right_title, _) = combat_card_title(scheduled);
    let left_name = normalized_name(&left_title);
    let right_name = normalized_name(&right_title);
    if left_name == right_name {
        return true;
    }
    let contender =
        cached_regex!(r"^danawhitescontenderseries(?:season(\d{1,3}))?(?:week(\d{1,3}))?$")
            .unwrap();
    if let (Some(left), Some(right)) = (
        contender.captures(&left_name),
        contender.captures(&right_name),
    ) {
        return (left.get(1).is_none()
            || left.get(1).map(|x| x.as_str()) == right.get(1).map(|x| x.as_str()))
            && (left.get(2).is_none()
                || left.get(2).map(|x| x.as_str()) == right.get(2).map(|x| x.as_str()));
    }
    let abbrev = cached_regex!(r"(?i)^ufc\s+(\d{1,4})$").unwrap();
    let number = cached_regex!(r"(?i)^ufc\s+(\d{1,4})\b").unwrap();
    if let (Some(left), Some(right)) = (
        abbrev.captures(&left_title),
        number.captures(scheduled.trim()),
    ) {
        return left[1] == right[1];
    }
    let (Some(left), Some(right)) = (combat_fighters(observed), combat_fighters(scheduled)) else {
        return false;
    };
    if left.card.is_some() && left.card != right.card
        || left.rematch.is_some() && left.rematch != right.rematch
    {
        return false;
    }
    let same = |a: &Vec<String>, b: &Vec<String>| {
        a.concat() == b.concat()
            || a.len() == 1 && a.last() == b.last()
            || b.len() == 1 && b.last() == a.last()
    };
    same(&left.first, &right.first) && same(&left.second, &right.second)
        || same(&left.first, &right.second) && same(&left.second, &right.first)
}
fn match_combat(
    observation: &Observation,
    games: &[Game],
    now: i64,
    mode: MatchMode,
    fresh: Option<i64>,
) -> Match {
    let is_stale = stale(observation, now, fresh);
    if observation.observed_at > now + 60_000 || is_stale && mode == MatchMode::Current {
        return rejected("stale-observation", vec![]);
    }
    let Some(kickoff) = observation.kickoff else {
        return rejected("unverified-kickoff", vec![]);
    };
    let same: Vec<_> = games
        .iter()
        .filter(|game| {
            game.combat().is_some()
                && Some(game.league) == observation.league
                && combat_titles_match(&observation.title, &game.name)
        })
        .collect();
    let segment = combat_card_title(&observation.title).1;
    let dated: Vec<_> = same
        .iter()
        .filter(|game| {
            let window = if observation.league == Some(League::Ufc) {
                if segment.is_some() || combat_card_title(&game.name).1.is_some() {
                    4 * 60 * 60_000
                } else {
                    3 * 60 * 60_000
                }
            } else {
                90 * 60_000
            };
            game.kickoff()
                .is_some_and(|date| (date - kickoff).abs() <= window)
        })
        .copied()
        .collect();
    if dated.len() != 1 {
        return rejected(
            if !dated.is_empty() {
                "ambiguous-matchup"
            } else if !same.is_empty() {
                "conflicting-date"
            } else {
                "unknown-teams"
            },
            if !dated.is_empty() { dated } else { same }
                .iter()
                .map(|game| game.id.clone())
                .collect(),
        );
    }
    finish(dated[0], is_stale)
}
fn race_session_in_title(title: &str, session: &str, league: League) -> bool {
    let value = title.to_lowercase();
    let sprint_qual = cached_regex!(r"sprint[\s-]*(?:qualifying|quali|q\b|shootout)")
        .unwrap()
        .is_match(&value);
    match session {
        "sprint-qualifying" => sprint_qual,
        "sprint" => !sprint_qual && cached_regex!(r"\bsprint\b").unwrap().is_match(&value),
        "qualifying" => {
            !sprint_qual
                && cached_regex!(r"\b(?:qualifying|quali)\b")
                    .unwrap()
                    .is_match(&value)
        }
        "practice" => {
            cached_regex!(r"\b(?:free\s+)?practice\b")
                .unwrap()
                .is_match(&value)
                && !cached_regex!(r"\bpractice\s*[1-4]\b|\bfp[1-4]\b")
                    .unwrap()
                    .is_match(&value)
        }
        session if session.starts_with("practice-") => {
            if !cached_regex!(r"\b(?:free\s+)?practice\b|\bfp[1-4]\b")
                .unwrap()
                .is_match(&value)
            {
                return false;
            }
            let re = cached_regex!(r"\b(?:practice\s*|fp)([1-4])\b").unwrap();
            re.captures(&value)
                .map(|capture| session == format!("practice-{}", &capture[1]))
                .unwrap_or(league == League::F1)
        }
        _ => {
            !cached_regex!(r"\b(?:practice|qualifying|quali|sprint|fp[123])\b")
                .unwrap()
                .is_match(&value)
                && (league != League::F1 || cached_regex!(r"\brace\b").unwrap().is_match(&value))
        }
    }
}
fn match_race(
    observation: &Observation,
    games: &[Game],
    now: i64,
    mode: MatchMode,
    fresh: Option<i64>,
) -> Match {
    let is_stale = stale(observation, now, fresh);
    if observation.observed_at > now + 60_000 || is_stale && mode == MatchMode::Current {
        return rejected("stale-observation", vec![]);
    }
    if observation.teams.is_some() {
        return rejected("unverified-race", vec![]);
    }
    let conflicting = match observation.league {
        Some(League::NascarCup) => {
            cached_regex!(r"(?i)\b(?:nascar\s+(?:truck|xfinity)\s+series|motogp|formula\s*1|f1)\b")
                .unwrap()
                .is_match(&observation.title)
        }
        Some(League::NascarTruck) => {
            cached_regex!(r"(?i)\b(?:nascar\s+(?:cup|xfinity)\s+series|motogp|formula\s*1|f1)\b")
                .unwrap()
                .is_match(&observation.title)
        }
        _ => false,
    };
    if conflicting {
        return rejected("unknown-race", vec![]);
    }
    let title = normalized_name(&observation.title);
    let track = if observation.league == Some(League::Motorsport) {
        Some(normalized_name(
            &cached_regex!(r"(?i)\s+vs\s+live$")
                .unwrap()
                .replace(&observation.title, ""),
        ))
    } else {
        None
    };
    let possible: Vec<_> = games
        .iter()
        .filter(|game| {
            let Some(race) = game.race() else {
                return false;
            };
            let nascar = matches!(game.league, League::NascarCup | League::NascarTruck);
            let unspecified = nascar
                && track.as_ref().is_some_and(|title| {
                    ["Motor Speedway", "Raceway"].iter().any(|suffix| {
                        *title == normalized_name(&format!("NASCAR {} {suffix}", race.round))
                            || *title == normalized_name(&format!("{} {suffix}", race.round))
                    })
                });
            (Some(game.league) == observation.league || unspecified)
                && title.contains(&normalized_name(&race.round))
                && race_session_in_title(&observation.title, &race.session, game.league)
        })
        .collect();
    let Some(kickoff) = observation.kickoff else {
        return rejected(
            "unverified-race",
            if matches!(
                observation.league,
                Some(League::NascarCup | League::NascarTruck)
            ) {
                possible.iter().map(|game| game.id.clone()).collect()
            } else {
                vec![]
            },
        );
    };
    let dated: Vec<_> = possible
        .iter()
        .filter(|game| {
            game.kickoff().is_some_and(|date| {
                (date - kickoff).abs()
                    <= if matches!(game.league, League::NascarCup | League::NascarTruck) {
                        90 * 60_000
                    } else {
                        20 * 60_000
                    }
            })
        })
        .copied()
        .collect();
    if dated.len() != 1 {
        return rejected(
            if !dated.is_empty() {
                "ambiguous-race"
            } else {
                "unknown-race"
            },
            dated.iter().map(|game| game.id.clone()).collect(),
        );
    }
    finish(dated[0], is_stale)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum UndatedEvidence {
    #[default]
    None,
    PublishedListing,
    LiveClaim,
    RetainedLiveDetail,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEventEvidence {
    pub undated: UndatedEvidence,
    pub external_game_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SourceEventDecision {
    Matched {
        game_id: String,
        #[serde(rename = "match")]
        match_result: Match,
    },
    Possible {
        game_ids: Vec<String>,
        reason: String,
        #[serde(rename = "match")]
        match_result: Match,
    },
    Rejected {
        reason: String,
        #[serde(rename = "match")]
        match_result: Match,
    },
}
impl SourceEventDecision {
    pub fn match_result(&self) -> &Match {
        match self {
            Self::Matched { match_result, .. }
            | Self::Possible { match_result, .. }
            | Self::Rejected { match_result, .. } => match_result,
        }
    }
}
pub fn source_coverage(source_id: &str) -> &'static [League] {
    static REGISTRY: OnceLock<crate::registry::SourceRegistry> = OnceLock::new();
    REGISTRY
        .get_or_init(|| {
            crate::registry::SourceRegistry::parse(include_str!(
                "../../../../lib/football/source-registry.json"
            ))
            .expect("committed registry")
        })
        .get(source_id)
        .map(|source| source.leagues.as_slice())
        .unwrap_or(&[])
}
pub fn listing_event_evidence(source_id: &str) -> SourceEventEvidence {
    static SOURCES: OnceLock<Vec<ListingSource>> = OnceLock::new();
    let sources = SOURCES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../lib/football/source-registry.json"
        ))
        .expect("committed registry")
    });
    SourceEventEvidence {
        undated: if sources
            .iter()
            .any(|source| source.id == source_id && source.undated_listing_evidence.is_some())
        {
            UndatedEvidence::PublishedListing
        } else {
            UndatedEvidence::None
        },
        external_game_id: None,
    }
}
pub struct SourceEventMatcher {
    preparation: Arc<GamePreparation>,
    mode: MatchMode,
    prepared: HashMap<Vec<String>, ObservationMatcher>,
}
impl SourceEventMatcher {
    pub fn new(games: &[Game], mode: MatchMode) -> Self {
        Self::with_preparation(Arc::new(GamePreparation::new(games)), mode)
    }
    pub fn with_preparation(preparation: Arc<GamePreparation>, mode: MatchMode) -> Self {
        Self {
            preparation,
            mode,
            prepared: HashMap::new(),
        }
    }
    pub fn match_event(
        &mut self,
        observation: &Observation,
        evidence: &SourceEventEvidence,
        now: i64,
        fresh_until: Option<i64>,
    ) -> SourceEventDecision {
        let declared = source_coverage(&observation.source_id);
        let leagues = if !declared.is_empty() {
            declared.to_vec()
        } else if let Some(league) = observation.league {
            vec![league]
        } else {
            self.preparation
                .games
                .iter()
                .map(|game| game.league)
                .collect()
        };
        let mut key: Vec<_> = leagues
            .iter()
            .map(|league| league_name(*league).to_string())
            .collect();
        key.sort();
        key.dedup();
        let matcher = self.prepared.entry(key).or_insert_with(|| {
            ObservationMatcher::with_preparation(&self.preparation, self.mode, Some(&leagues))
        });
        let mut result = matcher.match_observation(observation, now, fresh_until);
        let fresh = (now - observation.observed_at < 30 * 60_000
            || fresh_until.is_some_and(|until| now <= until))
            && observation.observed_at <= now + 60_000;
        if let Match::Unmatched {
            reason,
            possible_game_ids,
        } = &result
        {
            if observation.kickoff.is_none()
                && reason == "unverified-kickoff"
                && possible_game_ids.len() == 1
                && (matches!(evidence.undated, UndatedEvidence::RetainedLiveDetail) || fresh)
            {
                if let Some(game) = self
                    .preparation
                    .games
                    .iter()
                    .find(|game| game.id == possible_game_ids[0])
                {
                    let eligible = match evidence.undated {
                        UndatedEvidence::PublishedListing => feed_eligible(game, now),
                        UndatedEvidence::RetainedLiveDetail => {
                            (game.lifecycle == GameLifecycle::Live || fresh)
                                && feed_eligible(game, now)
                        }
                        UndatedEvidence::LiveClaim => {
                            feed_eligible(game, now)
                                && game
                                    .kickoff()
                                    .is_some_and(|date| (date - now).abs() <= 30 * 60_000)
                        }
                        UndatedEvidence::None => false,
                    };
                    if game.lifecycle != GameLifecycle::Final
                        && observation.league == Some(game.league)
                        && eligible
                    {
                        result = matched(game)
                    }
                }
            }
        }
        if let Some(expected) = &evidence.external_game_id {
            match &result {
                Match::Matched { game_id } if game_id != expected => {
                    result = rejected("conflicting-game-id", vec![game_id.clone()])
                }
                Match::Unmatched {
                    possible_game_ids, ..
                } if !possible_game_ids.is_empty() && !possible_game_ids.contains(expected) => {
                    result = rejected("conflicting-game-id", possible_game_ids.clone())
                }
                _ => {}
            }
        }
        match &result {
            Match::Matched { game_id } => SourceEventDecision::Matched {
                game_id: game_id.clone(),
                match_result: result,
            },
            Match::Unmatched {
                reason,
                possible_game_ids,
            } if !possible_game_ids.is_empty()
                && reason != "finished-game"
                && reason != "conflicting-game-id" =>
            {
                SourceEventDecision::Possible {
                    game_ids: possible_game_ids.clone(),
                    reason: reason.clone(),
                    match_result: result,
                }
            }
            Match::Unmatched { reason, .. } => SourceEventDecision::Rejected {
                reason: reason.clone(),
                match_result: result,
            },
        }
    }
}
pub struct FinishedGameMatcher {
    final_ids: HashSet<String>,
    matcher: ObservationMatcher,
}
impl FinishedGameMatcher {
    pub fn new(games: &[Game]) -> Self {
        Self::with_preparation(Arc::new(GamePreparation::new(games)))
    }
    pub fn with_preparation(preparation: Arc<GamePreparation>) -> Self {
        Self {
            final_ids: preparation
                .games
                .iter()
                .filter(|game| game.lifecycle == GameLifecycle::Final)
                .map(|game| game.id.clone())
                .collect(),
            matcher: ObservationMatcher::with_preparation(
                &preparation,
                MatchMode::InventoryLive,
                None,
            ),
        }
    }
    pub fn finished_game_id(
        &self,
        observation: &Observation,
        now: i64,
        expected: Option<&str>,
    ) -> Option<String> {
        if self.final_ids.is_empty() || observation.kickoff.is_none() {
            return None;
        }
        let mut observation = observation.clone();
        observation.observed_at = now;
        let result = self.matcher.match_observation(&observation, now, None);
        match result {
            Match::Unmatched {
                reason,
                possible_game_ids,
            } if reason == "finished-game"
                && possible_game_ids.len() == 1
                && expected.is_none_or(|id| id == possible_game_ids[0]) =>
            {
                Some(possible_game_ids[0].clone())
            }
            _ => None,
        }
    }
    pub fn finished_bound_event(
        &self,
        observation: &Observation,
        event_id: &str,
        bindings: &[SourceEventBinding],
    ) -> Option<String> {
        if self.final_ids.is_empty() || observation.kickoff.is_some() {
            return None;
        }
        let teams = observation.teams.as_ref()?;
        let pair = |teams: &[String; 2]| {
            let mut names = teams.each_ref().map(|name| normalized_name(name));
            names.sort();
            names
        };
        let binding = bindings.iter().find(|row| {
            row.source_id == observation.source_id
                && row.event_id == event_id
                && row.url == observation.url
                && Some(row.league) == observation.league
                && pair(&row.teams) == pair(teams)
        })?;
        if !self.final_ids.contains(&binding.game_id) {
            return None;
        }
        let result = self
            .matcher
            .match_observation(observation, observation.observed_at, None);
        match result {
            Match::Unmatched {
                possible_game_ids, ..
            } if possible_game_ids.len() == 1 && possible_game_ids[0] == binding.game_id => {
                Some(binding.game_id.clone())
            }
            _ => None,
        }
    }
}
pub fn merge_schedule_partitions(partitions: &[Vec<Game>]) -> Vec<Game> {
    let mut merged: Vec<Game> = Vec::new();
    let mut conflicts = HashSet::new();
    for games in partitions {
        for game in games {
            if conflicts.contains(&game.id) {
                continue;
            }
            let previous = merged.iter().position(|row| row.id == game.id);
            if let Some(index) = previous {
                let before = &merged[index];
                let shape_conflict = match (&before.kind, &game.kind) {
                    (GameKind::Race { race: a }, GameKind::Race { race: b }) => {
                        a.event_id != b.event_id
                            || a.session_id != b.session_id
                            || a.session != b.session
                            || a.round != b.round
                    }
                    (
                        GameKind::Wrestling { wrestling: a },
                        GameKind::Wrestling { wrestling: b },
                    ) => a.event_id != b.event_id,
                    (GameKind::Combat { combat: a }, GameKind::Combat { combat: b }) => {
                        a.event_id != b.event_id
                    }
                    (
                        GameKind::Matchup {
                            home: a, away: b, ..
                        },
                        GameKind::Matchup {
                            home: c, away: d, ..
                        },
                    ) => {
                        a.id.clone().unwrap_or_else(|| normalized_name(&a.name))
                            != c.id.clone().unwrap_or_else(|| normalized_name(&c.name))
                            || b.id.clone().unwrap_or_else(|| normalized_name(&b.name))
                                != d.id.clone().unwrap_or_else(|| normalized_name(&d.name))
                    }
                    _ => false,
                };
                if before.league != game.league
                    || shape_conflict
                    || before
                        .kickoff()
                        .zip(game.kickoff())
                        .is_some_and(|(a, b)| (a - b).abs() > 3 * 60 * 60_000)
                {
                    merged.remove(index);
                    conflicts.insert(game.id.clone());
                    continue;
                }
                let mut ids = before.partitions.clone().unwrap_or_default();
                for id in game.partitions.iter().flatten() {
                    if !ids.contains(id) {
                        ids.push(id.clone())
                    }
                }
                merged[index].partitions = Some(ids);
            } else {
                let mut value = game.clone();
                let mut ids = Vec::new();
                for id in game.partitions.iter().flatten() {
                    if !ids.contains(id) {
                        ids.push(id.clone())
                    }
                }
                value.partitions = Some(ids);
                merged.push(value)
            }
        }
    }
    merged
}
