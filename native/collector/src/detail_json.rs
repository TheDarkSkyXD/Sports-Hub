use crate::{
    event_policy::valid_event_page_pair,
    html::{HtmlDoc, attr, text_without_excluded},
    listing_json::{
        SportsbiteEvent, SportsfeedGame, StreamedEvent, SwacEvent, sportsbite_event_url,
        sportsfeed_event_url, sportsfeed_kickoff, sportsfeed_link_id, streamed_event_url,
        swac_matchup, valid_sportsbite_event, valid_streamed_event, valid_streamed_id,
    },
    time::{digest, player_id},
    types::{CandidateLocator, MissingPlayerReason, Observation, ResolvedPlayer},
};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

fn prospective_reason(observation: &Observation) -> MissingPlayerReason {
    if observation
        .kickoff
        .is_some_and(|at| at > observation.observed_at)
    {
        MissingPlayerReason::NotYetPublished
    } else {
        MissingPlayerReason::NoPublishedPlayer
    }
}

fn event_page(
    game_id: &str,
    event_url: &str,
    server_url: &str,
    label: String,
) -> Option<ResolvedPlayer> {
    valid_event_page_pair(event_url, server_url).then(|| ResolvedPlayer {
        id: format!(
            "event-page:{}",
            digest(
                &serde_json::to_string(&(game_id, event_url, server_url)).expect("string identity")
            )
        ),
        label,
        locator: CandidateLocator::EventPage {
            game_id: game_id.to_string(),
            event_url: event_url.to_string(),
            server_url: server_url.to_string(),
        },
    })
}

fn swac_player(observation: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    let Ok(event) = serde_json::from_str::<SwacEvent>(body) else {
        return vec![];
    };
    let Some((teams, kickoff)) = swac_matchup(&event) else {
        return vec![];
    };
    if observation.url
        != format!(
            "https://tv.swac.org/program-group/e1dbe7ec9a7e686b42b53ab33c3e30e4/program/{}",
            event.id
        )
        || observation.kickoff != Some(kickoff)
        || observation.title != format!("{} vs {}", teams[0], teams[1])
        || observation.teams != Some(teams)
    {
        return vec![];
    }
    vec![ResolvedPlayer {
        id: format!("swac:{}", event.id),
        label: "SWAC TV".to_string(),
        locator: CandidateLocator::Swac { event_id: event.id },
    }]
}

fn tvapp_missing(body: &str) -> MissingPlayerReason {
    static PENDING: OnceLock<Regex> = OnceLock::new();
    static EMPTY: OnceLock<Regex> = OnceLock::new();
    let doc = HtmlDoc::parse(body);
    let text = doc
        .select("body")
        .first()
        .map(|node| text_without_excluded(*node))
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if PENDING.get_or_init(|| Regex::new(r"(?i)(?:this |the )?stream (?:will be|is going to be) available (?:shortly|soon)|stream (?:has not|hasn't) started yet").unwrap()).is_match(&text) {
        MissingPlayerReason::NotYetPublished
    } else if EMPTY.get_or_init(|| Regex::new(r"(?i)no channels? (?:is |are )?available").unwrap()).is_match(&text) {
        MissingPlayerReason::NoPublishedPlayer
    } else { MissingPlayerReason::NoCompatibleMedia }
}

fn tvapp_html_player(game_id: &str, observation: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    if tvapp_missing(body) == MissingPlayerReason::NotYetPublished
        || observation.teams.is_none()
        || observation.kickoff.is_none()
    {
        return vec![];
    }
    let doc = HtmlDoc::parse(body);
    let first_attr = |selector: &str, name: &str| {
        doc.select(selector)
            .first()
            .and_then(|node| attr(*node, name))
    };
    if first_attr("link[rel=canonical]", "href") != Some(observation.url.as_str())
        || first_attr("meta[property='og:url']", "content") != Some(observation.url.as_str())
        || first_attr("meta[property='og:title']", "content")
            != Some(format!("{} - Live Stream Free in HD | TheTVApp", observation.title).as_str())
        || !first_attr("meta[name=description]", "content").is_some_and(|value| {
            value.starts_with(&format!(
                "Watch {} live stream free in HD on TheTVApp.",
                observation.title
            ))
        })
        || doc.select("#player-frame").len() != 1
    {
        return vec![];
    }
    event_page(game_id, &observation.url, &observation.url, "TVApp".into())
        .into_iter()
        .collect()
}

#[derive(Deserialize)]
struct PpvPlayer {
    id: i64,
    name: String,
    tag: String,
    uri_name: String,
    iframe: Option<String>,
    source_tag: Option<String>,
    #[serde(rename = "premium")]
    _premium: Option<bool>,
    #[serde(rename = "paid")]
    _paid: Option<bool>,
}

#[derive(Deserialize)]
struct PpvPlayerEvent {
    #[serde(flatten)]
    player: PpvPlayer,
    starts_at: i64,
    #[serde(default)]
    substreams: Vec<PpvPlayer>,
}

fn valid_ppv_player(row: &PpvPlayer) -> bool {
    row.id > 0
        && row
            .iframe
            .as_ref()
            .is_none_or(|url| url::Url::parse(url).is_ok())
}

fn ppv_players(game_id: &str, observation: &Observation, body: &str) -> Vec<ResolvedPlayer> {
    let Ok(event) = serde_json::from_str::<PpvPlayerEvent>(body) else {
        return vec![];
    };
    let root = &event.player;
    if !valid_ppv_player(root)
        || event.substreams.iter().any(|row| !valid_ppv_player(row))
        || event.starts_at <= 0
        || observation.url != format!("https://ppv.st/live/{}", root.uri_name)
        || observation.kickoff != event.starts_at.checked_mul(1000)
        || observation.league == Some(crate::types::League::Wwe) && root.tag != "Wrestling"
        || (root.tag == "Wrestling"
            && (observation.league != Some(crate::types::League::Wwe)
                || observation.teams.is_some()
                || observation.id != format!("ppv:{}", root.id)
                || observation.title != root.name.split_whitespace().collect::<Vec<_>>().join(" ")
                || crate::wrestling::league(&root.name) != Some(crate::types::League::Wwe)
                || !observation.kickoff.is_some_and(|kickoff| {
                    crate::wrestling::wwe_ppv_route(&root.uri_name, kickoff)
                })))
        || !matches!(
            root.tag.as_str(),
            "College Football" | "NFL" | "NBA" | "WNBA" | "NHL" | "MLB" | "Formula 1" | "Wrestling"
        )
    {
        return vec![];
    }
    let mut players = Vec::new();
    let mut seen = HashMap::new();
    for row in std::iter::once(root).chain(event.substreams.iter()) {
        let Some(iframe) = row.iframe.as_deref() else {
            continue;
        };
        if row.tag != root.tag
            || row.name != root.name
            || (root.tag == "Wrestling"
                && (row.uri_name != root.uri_name
                    || iframe != format!("https://taifood-blog.asia/embed/{}", root.uri_name)))
            || (root.tag != "Wrestling"
                && !["embedindia.st", "taifood-blog.asia"]
                    .iter()
                    .any(|host| iframe == format!("https://{host}/embed/{}", row.uri_name)))
        {
            continue;
        }
        if let Some(player) = event_page(
            game_id,
            &observation.url,
            iframe,
            format!(
                "PPV · {}",
                row.source_tag
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Server")
            ),
        ) {
            if let Some(index) = seen.get(iframe) {
                players[*index] = player;
            } else {
                seen.insert(iframe, players.len());
                players.push(player);
            }
        }
    }
    players
}

fn sportsbite_identity(event: &SportsbiteEvent, observation: &Observation) -> bool {
    let teams = event
        .teams
        .as_ref()
        .map(|teams| [teams.home.name.clone(), teams.away.name.clone()]);
    sportsbite_event_url(&event.event_key).as_deref() == Some(observation.url.as_str())
        && observation.title == event.title
        && observation.kickoff == Some(event.kickoff_ms)
        && observation.teams == teams
}

fn sportsbite_players(
    game_id: &str,
    observation: &Observation,
    body: &str,
) -> Result<Vec<ResolvedPlayer>, MissingPlayerReason> {
    let event: SportsbiteEvent =
        serde_json::from_str(body).map_err(|_| MissingPlayerReason::ParserChanged)?;
    if !valid_sportsbite_event(&event) {
        return Err(MissingPlayerReason::ParserChanged);
    }
    if !sportsbite_identity(&event, observation) {
        return Ok(vec![]);
    }
    let mut players = Vec::new();
    let mut seen = HashMap::new();
    static STREAM_ID: OnceLock<Regex> = OnceLock::new();
    let stream_id = STREAM_ID.get_or_init(|| {
        Regex::new(r"^fg-[a-z0-9-]+$").expect("fixed SportsBite stream expression")
    });
    for stream in event.streams {
        if stream.format != "iframe"
            || !stream_id.is_match(&stream.id)
            || !valid_event_page_pair(&observation.url, &stream.manifest_url)
        {
            continue;
        }
        let player = ResolvedPlayer {
            id: player_id(
                "event-page",
                &serde_json::to_string(&(
                    game_id,
                    "sportsbite",
                    &event.event_key,
                    &stream.id,
                    &stream.manifest_url,
                ))
                .expect("string identity"),
            ),
            label: format!("SportsBite · {}", players.len() + 1),
            locator: CandidateLocator::EventPage {
                game_id: game_id.to_string(),
                event_url: observation.url.clone(),
                server_url: stream.manifest_url.clone(),
            },
        };
        if let Some(index) = seen.get(&stream.manifest_url) {
            players[*index] = player;
        } else {
            seen.insert(stream.manifest_url, players.len());
            players.push(player);
        }
    }
    Ok(players)
}

fn sportsbite_missing(observation: &Observation, body: &str) -> MissingPlayerReason {
    let Ok(event) = serde_json::from_str::<SportsbiteEvent>(body) else {
        return MissingPlayerReason::ParserChanged;
    };
    if !valid_sportsbite_event(&event) {
        return MissingPlayerReason::ParserChanged;
    }
    if sportsbite_event_url(&event.event_key).as_deref() != Some(&observation.url)
        || event.title != observation.title
        || Some(event.kickoff_ms) != observation.kickoff
    {
        return MissingPlayerReason::ConflictingGame;
    }
    if !event.streams.is_empty() {
        MissingPlayerReason::UnsupportedPlayer
    } else {
        prospective_reason(observation)
    }
}

#[derive(Deserialize)]
struct SportsfeedDetail {
    game: SportsfeedGame,
}

fn valid_sportsfeed_game(game: &SportsfeedGame) -> bool {
    !game.team_a.is_empty() && !game.team_b.is_empty() && url::Url::parse(&game.source_link).is_ok()
}

fn sportsfeed_identity(game: &SportsfeedGame, observation: &Observation, with_time: bool) -> bool {
    let Some(link_id) = sportsfeed_link_id(&game.source_link) else {
        return false;
    };
    if observation.id != format!("sportsfeed24:{link_id}")
        || observation.url != sportsfeed_event_url(&game.team_a, &game.team_b)
        || observation.title != format!("{} vs {}", game.team_a, game.team_b)
    {
        return false;
    }
    if !with_time {
        return true;
    }
    let (Some(expected), Some(actual)) =
        (observation.kickoff, sportsfeed_kickoff(&game.match_date))
    else {
        return false;
    };
    (expected - actual).abs() <= 3_600_000
}

fn sportsfeed_players(
    game_id: &str,
    observation: &Observation,
    body: &str,
) -> Result<Vec<ResolvedPlayer>, MissingPlayerReason> {
    let detail: SportsfeedDetail =
        serde_json::from_str(body).map_err(|_| MissingPlayerReason::ParserChanged)?;
    let game = detail.game;
    if !valid_sportsfeed_game(&game) {
        return Err(MissingPlayerReason::ParserChanged);
    }
    if !sportsfeed_identity(&game, observation, true) {
        return Ok(vec![]);
    }
    let mut players = Vec::new();
    let mut seen = HashMap::new();
    let links = game
        .streamer_links
        .iter()
        .flatten()
        .map(|link| link.website_link.as_str())
        .chain(game.player2.as_deref())
        .chain(game.website_link.as_deref());
    for url in links.filter(|value| !value.is_empty()) {
        if !valid_event_page_pair(&observation.url, url) {
            continue;
        }
        let player = ResolvedPlayer {
            id: player_id(
                "event-page",
                &serde_json::to_string(&(game_id, "sportsfeed24", &observation.url, url))
                    .expect("string identity"),
            ),
            label: format!("SportsFeed24 · Player {}", players.len() + 1),
            locator: CandidateLocator::EventPage {
                game_id: game_id.to_string(),
                event_url: observation.url.clone(),
                server_url: url.to_string(),
            },
        };
        if let Some(index) = seen.get(url) {
            players[*index] = player;
        } else {
            seen.insert(url.to_string(), players.len());
            players.push(player);
        }
    }
    Ok(players)
}

fn sportsfeed_missing(observation: &Observation, body: &str) -> MissingPlayerReason {
    let Ok(detail) = serde_json::from_str::<SportsfeedDetail>(body) else {
        return MissingPlayerReason::ParserChanged;
    };
    let game = detail.game;
    if !valid_sportsfeed_game(&game) {
        return MissingPlayerReason::ParserChanged;
    }
    if !sportsfeed_identity(&game, observation, false) {
        return MissingPlayerReason::ConflictingGame;
    }
    if game.streamer_links.is_some_and(|rows| !rows.is_empty())
        || game.player2.as_ref().is_some_and(|value| !value.is_empty())
        || game
            .website_link
            .as_ref()
            .is_some_and(|value| !value.is_empty())
    {
        MissingPlayerReason::UnsupportedPlayer
    } else {
        prospective_reason(observation)
    }
}

pub(crate) fn streamed_identity(event: &StreamedEvent, observation: &Observation) -> bool {
    let teams = event
        .teams
        .as_ref()
        .map(|teams| [teams.home.name.clone(), teams.away.name.clone()]);
    valid_streamed_id(&event.id)
        && observation.url == streamed_event_url(&observation.source_id, &event.id)
        && observation.title == event.title
        && observation.kickoff == Some(event.date)
        && observation.teams == teams
        && (!matches!(
            observation.league,
            Some(crate::types::League::Wwe | crate::types::League::Tna)
        ) || matches!(event.category.as_str(), "fight" | "wrestling")
            && crate::wrestling::league(&event.title) == observation.league)
}

fn streamed_missing(observation: &Observation, body: &str) -> MissingPlayerReason {
    let Ok(event) = serde_json::from_str::<StreamedEvent>(body) else {
        return MissingPlayerReason::ParserChanged;
    };
    if !valid_streamed_event(&event) {
        return MissingPlayerReason::ParserChanged;
    }
    if !streamed_identity(&event, observation) {
        return MissingPlayerReason::ConflictingGame;
    }
    if !event.sources.is_empty() {
        MissingPlayerReason::UnsupportedPlayer
    } else {
        prospective_reason(observation)
    }
}

pub fn compatible_json_players(
    game_id: &str,
    observation: &Observation,
    body: &str,
) -> Option<Vec<ResolvedPlayer>> {
    match observation.source_id.as_str() {
        "tvapp" | "tvapp-nba" | "tvapp-nhl" | "tvapp-mlb" => {
            Some(tvapp_html_player(game_id, observation, body))
        }
        "swac" => Some(swac_player(observation, body)),
        "ppv" => Some(ppv_players(game_id, observation, body)),
        "sportsbite" | "sportsfeed24" | "streamed" | "livesportpro" => Some(vec![]),
        _ => None,
    }
}

pub fn resolved_json_players(
    game_id: &str,
    observation: &Observation,
    body: &str,
) -> Option<Result<Vec<ResolvedPlayer>, MissingPlayerReason>> {
    match observation.source_id.as_str() {
        "sportsbite" => Some(sportsbite_players(game_id, observation, body)),
        "sportsfeed24" => Some(sportsfeed_players(game_id, observation, body)),
        _ => None,
    }
}

pub fn missing_json_reason(observation: &Observation, body: &str) -> Option<MissingPlayerReason> {
    match observation.source_id.as_str() {
        "tvapp" | "tvapp-nba" | "tvapp-nhl" | "tvapp-mlb" => Some(tvapp_missing(body)),
        "sportsbite" => Some(sportsbite_missing(observation, body)),
        "sportsfeed24" => Some(sportsfeed_missing(observation, body)),
        "streamed" | "livesportpro" => Some(streamed_missing(observation, body)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ppv_migrated_api_iframes_preserve_published_urls_and_substream_identity() {
        let observation: Observation = serde_json::from_value(serde_json::json!({
            "id":"ppv:29844", "sourceId":"ppv", "url":"https://ppv.st/live/cfb/2026-10-09/isu-byu",
            "title":"Iowa State Cyclones at BYU Cougars", "league":"ncaaf",
            "teams":["Iowa State Cyclones", "BYU Cougars"], "kickoff":1791598500000_i64,
            "rawTime":"2026-10-10T02:15:00.000Z", "observedAt":1791598500000_i64, "parserVersion":2
        }))
        .unwrap();
        for host in ["taifood-blog.asia", "embedindia.st"] {
            let main_url = format!("https://{host}/embed/cfb/2026-10-09/isu-byu");
            let skycast_url = format!("{main_url}/skycast");
            let skycast = serde_json::json!({
                "id":29845, "name":"Iowa State Cyclones at BYU Cougars", "tag":"College Football",
                "uri_name":"cfb/2026-10-09/isu-byu/skycast", "iframe":skycast_url, "source_tag":"Skycast"
            });
            let detail = serde_json::json!({
                "id":29844, "name":"Iowa State Cyclones at BYU Cougars", "tag":"College Football",
                "uri_name":"cfb/2026-10-09/isu-byu", "starts_at":1791598500,
                "iframe":main_url, "source_tag":"ESPN", "substreams":[skycast]
            });
            let players =
                compatible_json_players("ncaaf-1", &observation, &detail.to_string()).unwrap();
            assert_eq!(players.len(), 2, "{host}");
            for (player, expected) in players.iter().zip([&main_url, &skycast_url]) {
                assert!(
                    matches!(&player.locator, CandidateLocator::EventPage { event_url, server_url, .. }
                    if event_url == &observation.url && server_url == expected)
                );
            }
            for (field, replacement) in [
                ("name", serde_json::json!("Other game")),
                ("tag", serde_json::json!("NFL")),
                (
                    "uri_name",
                    serde_json::json!("cfb/2026-10-09/other-game/skycast"),
                ),
                (
                    "iframe",
                    serde_json::json!(skycast_url.replace("isu-byu", "other-game")),
                ),
                (
                    "iframe",
                    serde_json::json!(skycast_url.replace("/cfb/", "/nfl/")),
                ),
                (
                    "iframe",
                    serde_json::json!(skycast_url.replace("2026-10-09", "2026-10-10")),
                ),
                (
                    "iframe",
                    serde_json::json!(skycast_url.replace(host, "other.example")),
                ),
            ] {
                let mut changed = detail.clone();
                changed["substreams"][0][field] = replacement;
                assert_eq!(
                    compatible_json_players("ncaaf-1", &observation, &changed.to_string())
                        .unwrap()
                        .len(),
                    1,
                    "{field}"
                );
            }
            for (field, replacement) in [
                ("uri_name", serde_json::json!("cfb/2026-10-09/other-game")),
                ("iframe", serde_json::json!(skycast_url)),
            ] {
                let mut changed = detail.clone();
                changed[field] = replacement;
                changed["substreams"] = serde_json::json!([]);
                assert!(
                    compatible_json_players("ncaaf-1", &observation, &changed.to_string())
                        .unwrap()
                        .is_empty(),
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn wwe_ppv_detail_requires_the_listed_event_and_exact_dated_embed() {
        let observation: Observation = serde_json::from_value(serde_json::json!({
            "id":"ppv:29976", "sourceId":"ppv", "url":"https://ppv.st/live/wwe/2026-10-09",
            "title":"WWE Friday Night Smackdown", "league":"wwe", "teams":null,
            "kickoff":1791590400000_i64, "rawTime":"2026-10-10T00:00:00.000Z",
            "observedAt":1791590400000_i64, "parserVersion":2
        }))
        .unwrap();
        let detail = serde_json::json!({
            "id":29976, "name":"WWE Friday Night Smackdown", "tag":"Wrestling",
            "uri_name":"wwe/2026-10-09", "starts_at":1791590400,
            "iframe":"https://taifood-blog.asia/embed/wwe/2026-10-09",
            "source_tag":"Main"
        });
        let players = compatible_json_players("wwe-1", &observation, &detail.to_string()).unwrap();
        assert_eq!(players.len(), 1);
        assert!(matches!(
            players[0].locator,
            CandidateLocator::EventPage { .. }
        ));
        for (field, replacement) in [
            ("id", serde_json::json!(29977)),
            ("name", serde_json::json!("AEW Grand Slam: Collision")),
            ("uri_name", serde_json::json!("wwe/2026-10-10")),
            ("starts_at", serde_json::json!(1791595800)),
            (
                "iframe",
                serde_json::json!("https://taifood-blog.asia/embed/wwe/2026-10-10"),
            ),
            ("tag", serde_json::json!("NHL")),
        ] {
            let mut changed = detail.clone();
            changed[field] = replacement;
            assert!(
                compatible_json_players("wwe-1", &observation, &changed.to_string())
                    .unwrap()
                    .is_empty(),
                "{field}"
            );
        }
    }

    #[test]
    fn ppv_exposes_both_frozen_policy_approved_servers() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let input = golden["inputs"]["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "ppv")
            .unwrap();
        let observation: Observation =
            serde_json::from_value(golden["expected"]["listings"]["ppv"]["enriched"].clone())
                .unwrap();
        let mut event: serde_json::Value =
            serde_json::from_str(input["body"].as_str().unwrap()).unwrap();
        let root = event["streams"][0]["streams"][0].as_object_mut().unwrap();
        root.insert(
            "iframe".into(),
            "https://embedindia.st/embed/cfb/2026-09-26/miss-fla".into(),
        );
        root.insert("source_tag".into(), "Main".into());
        root.insert("substreams".into(), serde_json::json!([{
            "id":2,"name":"Ole Miss Rebels at Florida Gators","tag":"College Football",
            "uri_name":"cfb/2026-09-26/miss-fla/skycast",
            "iframe":"https://embedindia.st/embed/cfb/2026-09-26/miss-fla/skycast","source_tag":"Skycast"
        }]));
        let detail = event["streams"][0]["streams"][0].to_string();
        let players = compatible_json_players("ncaaf-1", &observation, &detail).unwrap();
        assert_eq!(
            players
                .iter()
                .map(|player| player.id.as_str())
                .collect::<Vec<_>>(),
            [
                "event-page:8df15bed5ebe68507167d37c",
                "event-page:2569441fa8485a0748e41e0f"
            ]
        );
        assert_eq!(
            players
                .iter()
                .map(|player| player.label.as_str())
                .collect::<Vec<_>>(),
            ["PPV · Main", "PPV · Skycast"]
        );
    }
}
