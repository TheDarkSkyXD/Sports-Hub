use crate::{
    detail_json::{compatible_json_players, resolved_json_players, streamed_identity},
    listing_json::{
        StreamRef, StreamedEvent, component, preferred_catalog_teams, valid_streamed_event,
    },
    time::{digest, player_id},
    types::{CandidateLocator, Observation, ResolvedPlayer},
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadRequest {
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveFailure {
    pub name: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_error_id: Option<u32>,
}

impl ResolveFailure {
    fn parser_changed() -> Self {
        Self {
            name: "Error".into(),
            message: "parser-changed".into(),
            read_error_id: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ResolveAction {
    ReadBatch {
        requests: Vec<ReadRequest>,
        abort_siblings_on_failure: bool,
    },
    Done {
        players: Vec<ResolvedPlayer>,
    },
    Failed {
        error: ResolveFailure,
    },
}

#[derive(Clone)]
enum Stage {
    Done,
    TvappCatalog,
    TvappStreams {
        refs: Vec<StreamRef>,
    },
    Streamed {
        event: StreamedEvent,
        refs: Vec<StreamRef>,
        offset: usize,
    },
}

pub struct Resolver {
    game_id: String,
    observation: Observation,
    stage: Stage,
    players: Vec<ResolvedPlayer>,
    keys: HashMap<String, usize>,
}

impl Resolver {
    pub fn begin(game_id: &str, observation: &Observation, body: &str) -> (Self, ResolveAction) {
        let mut state = Self {
            game_id: game_id.into(),
            observation: observation.clone(),
            stage: Stage::Done,
            players: vec![],
            keys: HashMap::new(),
        };
        match observation.source_id.as_str() {
            "tvapp" | "tvapp-nba" | "tvapp-nhl" | "tvapp-mlb" => {
                let compatible =
                    compatible_json_players(game_id, observation, body).unwrap_or_default();
                if observation.teams.is_none()
                    || observation.kickoff.is_none()
                    || compatible.len() != 1
                {
                    return (state, ResolveAction::Done { players: vec![] });
                }
                state.stage = Stage::TvappCatalog;
                let category = match observation.source_id.as_str() {
                    "tvapp-nba" => "basketball",
                    "tvapp-nhl" => "hockey",
                    "tvapp-mlb" => "baseball",
                    _ => "american-football",
                };
                (
                    state,
                    ResolveAction::ReadBatch {
                        requests: vec![ReadRequest {
                            url: format!(
                                "https://api-backups.handleapi.win/matches/sport/{category}"
                            ),
                        }],
                        abort_siblings_on_failure: false,
                    },
                )
            }
            "streamed" | "livesportpro" => {
                let Ok(event) = serde_json::from_str::<StreamedEvent>(body) else {
                    return (
                        state,
                        ResolveAction::Failed {
                            error: ResolveFailure::parser_changed(),
                        },
                    );
                };
                if !valid_streamed_event(&event) {
                    return (
                        state,
                        ResolveAction::Failed {
                            error: ResolveFailure::parser_changed(),
                        },
                    );
                }
                if !streamed_identity(&event, observation) {
                    return (state, ResolveAction::Done { players: vec![] });
                }
                let refs = event.sources.clone();
                if refs.len() > 24
                    || refs
                        .iter()
                        .map(|reference| format!("{}/{}", reference.source, reference.id))
                        .collect::<HashSet<_>>()
                        .len()
                        != refs.len()
                {
                    return (
                        state,
                        ResolveAction::Failed {
                            error: ResolveFailure::parser_changed(),
                        },
                    );
                }
                state.stage = Stage::Streamed {
                    event,
                    refs,
                    offset: 0,
                };
                let action = state.action();
                (state, action)
            }
            _ => match resolved_json_players(game_id, observation, body) {
                Some(Ok(players)) => (state, ResolveAction::Done { players }),
                Some(Err(_)) => (
                    state,
                    ResolveAction::Failed {
                        error: ResolveFailure::parser_changed(),
                    },
                ),
                None => (
                    state,
                    ResolveAction::Done {
                        players: compatible_json_players(game_id, observation, body)
                            .unwrap_or_default(),
                    },
                ),
            },
        }
    }

    pub fn action(&self) -> ResolveAction {
        match &self.stage {
            Stage::Done => ResolveAction::Done {
                players: self.players.clone(),
            },
            Stage::TvappCatalog => unreachable!("begin supplies the catalog URL"),
            Stage::TvappStreams { refs } => ResolveAction::ReadBatch {
                requests: refs
                    .iter()
                    .map(|reference| ReadRequest {
                        url: format!(
                            "https://api-backups.handleapi.win/streams/{}/{}",
                            reference.source, reference.id
                        ),
                    })
                    .collect(),
                abort_siblings_on_failure: false,
            },
            Stage::Streamed { refs, offset, .. } => {
                if *offset >= refs.len() {
                    return ResolveAction::Done {
                        players: self.players.clone(),
                    };
                }
                let mut requests = Vec::new();
                for reference in refs.iter().skip(*offset).take(4) {
                    let Some(url) = stream_api_url(&self.observation.source_id, reference) else {
                        return ResolveAction::Failed {
                            error: ResolveFailure::parser_changed(),
                        };
                    };
                    requests.push(ReadRequest { url });
                }
                ResolveAction::ReadBatch {
                    requests,
                    abort_siblings_on_failure: true,
                }
            }
        }
    }

    pub fn requires_streamed_validation(&self, request_index: usize) -> Result<bool, String> {
        let (count, streamed) = match &self.stage {
            Stage::TvappCatalog => (1, false),
            Stage::TvappStreams { refs } => (refs.len(), false),
            Stage::Streamed { refs, offset, .. } => {
                (refs.len().saturating_sub(*offset).min(4), true)
            }
            Stage::Done => return Err("collector resolver has no pending reads".into()),
        };
        if request_index >= count {
            return Err("collector resolver request index is out of range".into());
        }
        Ok(streamed)
    }

    pub fn advance(&mut self, responses: Vec<Result<String, ResolveFailure>>) -> ResolveAction {
        let stage = std::mem::replace(&mut self.stage, Stage::Done);
        let expected = match &stage {
            Stage::TvappCatalog => 1,
            Stage::TvappStreams { refs } => refs.len(),
            Stage::Streamed { refs, offset, .. } => refs.len().saturating_sub(*offset).min(4),
            Stage::Done => {
                return ResolveAction::Failed {
                    error: ResolveFailure::parser_changed(),
                };
            }
        };
        if responses.len() != expected {
            return ResolveAction::Failed {
                error: ResolveFailure::parser_changed(),
            };
        }
        if let Some(error) = responses
            .iter()
            .find_map(|response| response.as_ref().err())
        {
            return ResolveAction::Failed {
                error: error.clone(),
            };
        }
        let bodies: Vec<String> = responses
            .into_iter()
            .map(|response| response.expect("errors handled above"))
            .collect();
        let next = match stage {
            Stage::TvappCatalog => self.catalog_response(&bodies[0]),
            Stage::TvappStreams { refs } => self.tvapp_stream_responses(&refs, &bodies),
            Stage::Streamed {
                event,
                refs,
                offset,
            } => self.streamed_responses(event, refs, offset, &bodies),
            Stage::Done => unreachable!(),
        };
        match next {
            Ok(Some(stage)) => {
                self.stage = stage;
                self.action()
            }
            Ok(None) => ResolveAction::Done {
                players: self.players.clone(),
            },
            Err(error) => ResolveAction::Failed { error },
        }
    }

    fn catalog_response(&mut self, body: &str) -> Result<Option<Stage>, ResolveFailure> {
        let catalog: Vec<serde_json::Value> =
            serde_json::from_str(body).map_err(|_| ResolveFailure::parser_changed())?;
        let matches: Vec<_> = catalog
            .into_iter()
            .filter_map(|value| serde_json::from_value::<TvappDetail>(value).ok())
            .filter_map(TvappDetail::identity)
            .filter(|identity| {
                identity.watch_url == self.observation.url
                    && identity.title == self.observation.title
                    && Some(identity.kickoff) == self.observation.kickoff
                    && Some(identity.teams.clone()) == self.observation.teams
            })
            .collect();
        if matches.len() != 1 {
            return Ok(None);
        }
        let refs = matches.into_iter().next().unwrap().sources;
        if refs
            .iter()
            .map(|reference| format!("{}:{}", reference.source, reference.id))
            .collect::<HashSet<_>>()
            .len()
            != refs.len()
        {
            return Ok(None);
        }
        if refs.is_empty() {
            return Ok(None);
        }
        Ok(Some(Stage::TvappStreams { refs }))
    }

    fn tvapp_stream_responses(
        &mut self,
        refs: &[StreamRef],
        bodies: &[String],
    ) -> Result<Option<Stage>, ResolveFailure> {
        let mut streams = Vec::new();
        for (reference, body) in refs.iter().zip(bodies) {
            let rows: Vec<TvappStream> =
                serde_json::from_str(body).map_err(|_| ResolveFailure::parser_changed())?;
            if rows.len() > 100 {
                return Err(ResolveFailure::parser_changed());
            }
            let mut seen = HashSet::new();
            for row in rows {
                if !row.valid(reference) || !seen.insert(row.stream_no) {
                    return Err(ResolveFailure::parser_changed());
                }
                streams.push(row);
            }
        }
        let mut seen = HashSet::new();
        let mut hd_count = 0;
        let mut sd_count = 0;
        for row in streams
            .iter()
            .filter(|row| row.hd)
            .chain(streams.iter().filter(|row| !row.hd))
        {
            let key = format!("{}:{}:{}", row.source, row.id, row.stream_no);
            if !seen.insert(key.clone()) {
                continue;
            }
            let count = if row.hd {
                hd_count += 1;
                hd_count
            } else {
                sd_count += 1;
                sd_count
            };
            let identity = serde_json::to_string(&(&self.game_id, &self.observation.url, &key))
                .expect("string identity");
            self.players.push(ResolvedPlayer {
                id: format!("tvapp:{}", digest(&identity)),
                label: format!(
                    "TVApp · Premium {count} {}",
                    if row.hd { "HD" } else { "SD" }
                ),
                locator: CandidateLocator::Tvapp {
                    game_id: self.game_id.clone(),
                    event_url: self.observation.url.clone(),
                    source: row.source.clone(),
                    source_id: row.id.clone(),
                    stream_no: row.stream_no,
                    kickoff: self.observation.kickoff.expect("validated at begin"),
                    title: self.observation.title.clone(),
                    teams: self.observation.teams.clone().expect("validated at begin"),
                },
            });
        }
        Ok(None)
    }

    fn streamed_responses(
        &mut self,
        event: StreamedEvent,
        refs: Vec<StreamRef>,
        offset: usize,
        bodies: &[String],
    ) -> Result<Option<Stage>, ResolveFailure> {
        for (reference, body) in refs.iter().skip(offset).zip(bodies) {
            let rows: Vec<CatalogStream> =
                serde_json::from_str(body).map_err(|_| ResolveFailure::parser_changed())?;
            for row in rows {
                if row.stream_no == 0
                    || url::Url::parse(&row.embed_url).is_err()
                    || row.id != reference.id
                    || self.observation.source_id == "streamed"
                        && row.source.as_deref() != Some(&reference.source)
                {
                    return Err(ResolveFailure::parser_changed());
                }
                if !valid_stream_target(
                    &self.observation.source_id,
                    reference,
                    row.stream_no,
                    &row.embed_url,
                ) {
                    continue;
                }
                let key = format!("{}:{}:{}", reference.source, reference.id, row.stream_no);
                let identity = serde_json::to_string(&(
                    &self.game_id,
                    &self.observation.source_id,
                    &event.id,
                    &reference.source,
                    &reference.id,
                    row.stream_no,
                ))
                .expect("string identity");
                let player = ResolvedPlayer {
                    id: player_id("catalog-stream", &identity),
                    label: format!(
                        "{} · {} {}",
                        if self.observation.source_id == "streamed" {
                            "Streamed"
                        } else {
                            "LiveSportPro"
                        },
                        reference.source,
                        row.stream_no
                    ),
                    locator: CandidateLocator::CatalogStream {
                        game_id: self.game_id.clone(),
                        source: self.observation.source_id.clone(),
                        event_url: self.observation.url.clone(),
                        event_id: event.id.clone(),
                        source_name: reference.source.clone(),
                        source_id: reference.id.clone(),
                        stream_no: row.stream_no,
                        kickoff: event.date,
                        title: event.title.clone(),
                        teams: event
                            .teams
                            .as_ref()
                            .map(|teams| [teams.home.name.clone(), teams.away.name.clone()]),
                    },
                };
                if let Some(index) = self.keys.get(&key) {
                    self.players[*index] = player;
                } else {
                    self.keys.insert(key, self.players.len());
                    self.players.push(player);
                }
            }
        }
        let next = offset + bodies.len();
        if next >= refs.len() {
            Ok(None)
        } else {
            Ok(Some(Stage::Streamed {
                event,
                refs,
                offset: next,
            }))
        }
    }
}

pub fn valid_streamed_response(body: &str) -> bool {
    serde_json::from_str::<Vec<CatalogStream>>(body)
        .ok()
        .is_some_and(|rows| {
            rows.iter()
                .all(|row| row.stream_no > 0 && url::Url::parse(&row.embed_url).is_ok())
        })
}

#[derive(Deserialize)]
struct TvappDetail {
    id: String,
    title: String,
    category: TvappCategory,
    date: i64,
    teams: Option<crate::listing_json::Teams>,
    sources: Vec<StreamRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TvappCategory {
    AmericanFootball,
    Basketball,
    Hockey,
    Baseball,
}

struct TvappIdentity {
    watch_url: String,
    title: String,
    teams: [String; 2],
    kickoff: i64,
    sources: Vec<StreamRef>,
}

impl TvappDetail {
    fn identity(self) -> Option<TvappIdentity> {
        if self.id.is_empty()
            || self.title.is_empty()
            || self.date < 946_684_800_000
            || self.date >= 4_102_444_800_000
            || self
                .teams
                .as_ref()
                .is_some_and(|teams| teams.home.name.is_empty() || teams.away.name.is_empty())
            || self.sources.len() > 32
            || self
                .sources
                .iter()
                .any(|reference| !tvapp_reference(reference))
        {
            return None;
        }
        let _ = self.category;
        let title = self.title.split_whitespace().collect::<Vec<_>>().join(" ");
        let structured = self.teams.map(|teams| {
            [
                teams.home.name.trim().to_string(),
                teams.away.name.trim().to_string(),
            ]
        });
        let teams = preferred_catalog_teams(&title, structured)?;
        let slug =
            if self.id.starts_with("ppv-") || self.id.bytes().all(|byte| byte.is_ascii_digit()) {
                self.id.as_str()
            } else {
                self.id.rsplit_once('-')?.1
            };
        if slug.is_empty()
            || slug.len() > 120
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !self.id.starts_with("ppv-")
                && !self.id.bytes().all(|byte| byte.is_ascii_digit())
                && !slug.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        Some(TvappIdentity {
            watch_url: format!("https://tvapp1.pk/watch/{slug}"),
            title,
            teams,
            kickoff: self.date,
            sources: self.sources,
        })
    }
}

fn tvapp_reference(reference: &StreamRef) -> bool {
    static SOURCE: OnceLock<Regex> = OnceLock::new();
    static ID: OnceLock<Regex> = OnceLock::new();
    SOURCE
        .get_or_init(|| Regex::new(r"^[a-z0-9-]{1,32}$").unwrap())
        .is_match(&reference.source)
        && ID
            .get_or_init(|| Regex::new(r"^[a-zA-Z0-9_-]{1,120}$").unwrap())
            .is_match(&reference.id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TvappStream {
    id: String,
    source: String,
    stream_no: u32,
    language: String,
    hd: bool,
    embed_url: String,
}

impl TvappStream {
    fn valid(&self, reference: &StreamRef) -> bool {
        tvapp_reference(&StreamRef {
            source: self.source.clone(),
            id: self.id.clone(),
        }) && (1..=100).contains(&self.stream_no)
            && !self.language.is_empty()
            && self.source == reference.source
            && self.id == reference.id
            && self.embed_url
                == format!(
                    "https://embed.st/embed/{}/{}/{}",
                    self.source, self.id, self.stream_no
                )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogStream {
    id: String,
    stream_no: u32,
    embed_url: String,
    source: Option<String>,
}

fn stream_api_url(variant: &str, reference: &StreamRef) -> Option<String> {
    static SOURCE: OnceLock<Regex> = OnceLock::new();
    static ID: OnceLock<Regex> = OnceLock::new();
    if !SOURCE
        .get_or_init(|| Regex::new(r"^[a-z][a-z0-9:-]{0,39}$").unwrap())
        .is_match(&reference.source)
        || !ID
            .get_or_init(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,159}$").unwrap())
            .is_match(&reference.id)
        || reference.id.contains("//")
        || reference.id.contains("..")
    {
        return None;
    }
    let host = if variant == "streamed" {
        "https://streamed.st"
    } else {
        "https://api.kultsport.com"
    };
    Some(format!(
        "{host}/api/stream/{}/{}",
        component(&reference.source),
        component(&reference.id)
    ))
}

fn valid_stream_target(variant: &str, reference: &StreamRef, number: u32, value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.as_str() != value
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let host = url.host_str().unwrap_or_default();
    if host == "embed.st" {
        return url.path()
            == format!(
                "/embed/{}/{}/{}",
                reference
                    .source
                    .strip_prefix("sp:")
                    .unwrap_or(&reference.source),
                reference.id,
                number
            );
    }
    if host == "embedindia.st" {
        return reference.source == "ppv:s" && url.path() == format!("/embed/{}", reference.id);
    }
    static HOST: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    variant == "livesportpro" && HOST.get_or_init(|| Regex::new(r"^lb\d{1,3}\.strmd\.st$").unwrap()).is_match(host)
        && PATH.get_or_init(|| Regex::new(r"^/secure/[A-Za-z0-9_-]{16,160}/ingest/stream/[a-zA-Z0-9_-]{1,100}/[1-9]\d{0,2}/playlist\.m3u8$").unwrap()).is_match(url.path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detail_json::{compatible_json_players, missing_json_reason};

    #[test]
    fn json_details_match_the_frozen_collector() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        for case in [
            "tvapp",
            "ppv",
            "swac",
            "streamed",
            "livesportpro",
            "sportsbite",
            "sportsfeed24",
        ] {
            let input = golden["inputs"]["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == case)
                .unwrap();
            let expected = &golden["expected"]["listings"][case];
            let observation: Observation =
                serde_json::from_value(expected["enriched"].clone()).unwrap();
            let body = input["detail"].as_str().unwrap();
            let game_id = input["gameId"].as_str().unwrap_or("ncaaf-1");
            let compatible = compatible_json_players(game_id, &observation, body).unwrap();
            assert_eq!(
                serde_json::to_value(compatible).unwrap(),
                expected["compatible"],
                "{case} compatible"
            );
            if let Some(reason) = missing_json_reason(&observation, body) {
                assert_eq!(
                    serde_json::to_value(reason).unwrap(),
                    expected["missing"],
                    "{case} missing"
                );
            }
            let (mut resolver, mut action) = Resolver::begin(game_id, &observation, body);
            let mut steps = 0;
            loop {
                steps += 1;
                assert!(steps < 10, "{case} resolver did not settle");
                action = match action {
                    ResolveAction::ReadBatch { requests, .. } => {
                        let replies = requests
                            .iter()
                            .map(|request| {
                                let body = input["reads"][request.url.as_str()]
                                    .as_str()
                                    .or_else(|| {
                                        input["streamRows"].as_str().filter(|_| {
                                            request.url.ends_with("/golf/2123")
                                                || request.url.ends_with("sp%3Agolf/2123")
                                        })
                                    })
                                    .unwrap_or("[]");
                                Ok(body.to_string())
                            })
                            .collect();
                        resolver.advance(replies)
                    }
                    ResolveAction::Done { players } => {
                        assert_eq!(
                            serde_json::to_value(players).unwrap(),
                            expected["resolved"],
                            "{case} resolved"
                        );
                        break;
                    }
                    ResolveAction::Failed { error } => panic!("{case}: {}", error.message),
                };
            }
        }
    }

    #[test]
    fn streamed_starts_four_reads_and_reports_failed_read_after_settlement() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let input = golden["inputs"]["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "streamed")
            .unwrap();
        let observation: Observation =
            serde_json::from_value(golden["expected"]["listings"]["streamed"]["enriched"].clone())
                .unwrap();
        let mut event: serde_json::Value =
            serde_json::from_str(input["detail"].as_str().unwrap()).unwrap();
        event["sources"] = serde_json::json!([
            {"source":"admin","id":"one"}, {"source":"admin","id":"two"},
            {"source":"admin","id":"three"}, {"source":"admin","id":"four"}
        ]);
        let (mut resolver, action) = Resolver::begin("game", &observation, &event.to_string());
        let ResolveAction::ReadBatch {
            requests,
            abort_siblings_on_failure,
        } = action
        else {
            panic!("expected four reads");
        };
        assert_eq!(requests.len(), 4);
        assert!(abort_siblings_on_failure);
        assert_eq!(resolver.requires_streamed_validation(0), Ok(true));
        assert_eq!(resolver.requires_streamed_validation(3), Ok(true));
        assert!(resolver.requires_streamed_validation(4).is_err());
        assert!(valid_streamed_response("[]"));
        assert!(valid_streamed_response(
            r#"[{"id":"different","source":"other","streamNo":1,"embedUrl":"https://embed.st/embed/other/different/1"}]"#
        ));
        for malformed in [
            "not json",
            r#"{"id":"one"}"#,
            r#"[{"id":"one","streamNo":0,"embedUrl":"https://embed.st/embed/admin/one/1"}]"#,
            r#"[{"id":"one","streamNo":1,"embedUrl":"not-a-url"}]"#,
        ] {
            assert!(!valid_streamed_response(malformed), "{malformed}");
        }
        let error = ResolveFailure {
            name: "AbortError".into(),
            message: "cancelled".into(),
            read_error_id: Some(37),
        };
        let action = resolver.advance(vec![
            Ok("[]".into()),
            Err(error.clone()),
            Err(ResolveFailure {
                name: "TimeoutError".into(),
                message: "timed out".into(),
                read_error_id: Some(38),
            }),
            Err(error.clone()),
        ]);
        assert_eq!(action, ResolveAction::Failed { error });
        assert_eq!(
            serde_json::to_value(action).unwrap()["error"]["readErrorId"],
            37
        );
    }

    #[test]
    fn tvapp_rejects_duplicate_references_and_mismatched_streams() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let input = golden["inputs"]["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "tvapp")
            .unwrap();
        let observation: Observation =
            serde_json::from_value(golden["expected"]["listings"]["tvapp"]["enriched"].clone())
                .unwrap();
        let (mut resolver, first) = Resolver::begin(
            "ncaaf-401858472",
            &observation,
            input["detail"].as_str().unwrap(),
        );
        assert!(matches!(first, ResolveAction::ReadBatch { .. }));
        assert_eq!(resolver.requires_streamed_validation(0), Ok(false));
        let mut event: serde_json::Value = serde_json::from_str(
            input["reads"]["https://api-backups.handleapi.win/matches/sport/american-football"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let reference = event[0]["sources"][0].clone();
        event[0]["sources"] = serde_json::json!([reference.clone(), reference]);
        assert_eq!(
            resolver.advance(vec![Ok(event.to_string())]),
            ResolveAction::Done { players: vec![] }
        );

        let (mut resolver, _) = Resolver::begin(
            "ncaaf-401858472",
            &observation,
            input["detail"].as_str().unwrap(),
        );
        let catalog =
            input["reads"]["https://api-backups.handleapi.win/matches/sport/american-football"]
                .as_str()
                .unwrap();
        let action = resolver.advance(vec![Ok(catalog.into())]);
        assert!(matches!(action, ResolveAction::ReadBatch { .. }));
        let bad_stream = r#"[{"id":"different","source":"delta","streamNo":1,"language":"English","hd":true,"embedUrl":"https://embed.st/embed/delta/different/1"}]"#;
        assert_eq!(
            resolver.advance(vec![Ok(bad_stream.into())]),
            ResolveAction::Failed {
                error: ResolveFailure::parser_changed()
            }
        );
    }
}
