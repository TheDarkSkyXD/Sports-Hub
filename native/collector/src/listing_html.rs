use crate::{
    html::{HtmlDoc, attr, clean_text, closest, select, text},
    time::{digest, parse_kickoff},
    types::{League, ListingOutcome, ListingResult, ListingSource, Observation},
};
use regex::Regex;
use scraper::ElementRef;
use url::Url;

fn pattern(expression: &str, value: &str) -> bool {
    Regex::new(expression)
        .expect("fixed listing expression")
        .is_match(value)
}

fn result(observations: Vec<Observation>, empty: bool) -> ListingResult {
    let outcome = if !observations.is_empty() {
        ListingOutcome::Parsed
    } else if empty {
        ListingOutcome::Empty
    } else {
        ListingOutcome::ParserChanged
    };
    ListingResult {
        observations,
        outcome,
    }
}

fn content(element: ElementRef<'_>) -> String {
    text(element)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn team_identity(names: &[String; 2]) -> String {
    let mut names = names.clone().map(|name| {
        name.to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    });
    names.sort();
    names.join("|")
}

fn nfl_identity(names: &[String; 2]) -> String {
    names
        .iter()
        .map(|name| {
            name.to_lowercase()
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn live_tv_team_pair(value: &str) -> Option<[String; 2]> {
    let split = Regex::new(r"\s*[-–—]\s*").unwrap();
    let teams: Vec<String> = split
        .split(value)
        .map(|part| part.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    (teams.len() == 2 && teams.iter().all(|part| !part.is_empty()))
        .then(|| [teams[0].clone(), teams[1].clone()])
}

fn live_tv(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let path = Regex::new(r"^/enx/eventinfo/([1-9][0-9]{0,19})_[a-z0-9_]*/$").unwrap();
    let mut observations: Vec<Observation> = Vec::new();
    let mut conflicting = false;
    for anchor in doc.select("a[href]") {
        let marker = closest(anchor, "tr")
            .and_then(|row| select(row, "img[alt]").first().copied())
            .and_then(|image| attr(image, "alt"))
            .unwrap_or("");
        let league = match marker {
            "USA. NFL" => League::Nfl,
            "NCAA" => League::Ncaaf,
            _ => continue,
        };
        let href = attr(anchor, "href").unwrap_or("");
        let (Some(event), Some(teams)) = (path.captures(href), live_tv_team_pair(&text(anchor)))
        else {
            continue;
        };
        let Ok(url) = Url::parse(&source.url).and_then(|base| base.join(href)) else {
            continue;
        };
        let id = format!("{}:{}", source.id, &event[1]);
        if let Some(previous) = observations.iter().find(|row| row.id == id) {
            if previous.url != url.as_str()
                || previous
                    .teams
                    .as_ref()
                    .is_some_and(|old| team_identity(old) != team_identity(&teams))
            {
                conflicting = true;
            }
            continue;
        }
        observations.push(Observation {
            id,
            source_id: source.id.clone(),
            url: url.to_string(),
            title: teams.join(" vs "),
            teams: Some(teams),
            league: Some(league),
            kickoff: None,
            raw_time: String::new(),
            observed_at: now,
            parser_version: 2,
            legacy_id: None,
            kickoff_lineage: None,
        });
    }
    if conflicting {
        return result(Vec::new(), false);
    }
    let body_text = doc
        .select("body")
        .first()
        .copied()
        .map(content)
        .unwrap_or_default();
    result(
        observations,
        pattern(
            r"(?i)no (?:upcoming )?(?:matches|broadcasts|events)",
            &body_text,
        ),
    )
}

fn team_url(value: &str, base: &str) -> Option<String> {
    let url = Url::parse(base).ok()?.join(value).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some("nflstreams.org")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && pattern(r"^/teams/[a-z0-9]+(?:-[a-z0-9]+)*-live/$", url.path()))
    .then(|| url.to_string())
}

fn slug(name: &str) -> String {
    let lower = name.to_lowercase();
    Regex::new(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&lower, "-")
        .trim_matches('-')
        .to_string()
}

fn published_time(card: ElementRef<'_>) -> Option<(i64, String)> {
    let raw = attr(card, "data-kickoff-ts")?;
    if raw.len() != 13 || !raw.bytes().all(|part| part.is_ascii_digit()) {
        return None;
    }
    let kickoff: i64 = raw.parse().ok()?;
    if !(1_577_836_800_000..=4_102_444_800_000).contains(&kickoff) {
        return None;
    }
    let dates: Vec<&str> = select(card, "[datetime],[data-datetime]")
        .into_iter()
        .map(|element| {
            attr(element, "datetime")
                .or_else(|| attr(element, "data-datetime"))
                .unwrap_or("")
        })
        .collect();
    if dates.is_empty()
        || dates.iter().any(|date| {
            !pattern(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", date)
                || parse_kickoff(date) != Some(kickoff)
        })
    {
        return None;
    }
    Some((kickoff, dates[0].to_string()))
}

fn nflstreams(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let mut observations: Vec<Observation> = Vec::new();
    let mut conflicting = false;
    for card in doc.select(".fixture_main_container") {
        let anchors: Vec<_> = select(card, "a[href]")
            .into_iter()
            .filter(|anchor| {
                !attr(*anchor, "class")
                    .unwrap_or("")
                    .split_whitespace()
                    .any(|class| matches!(class, "home_watch_btn" | "home_hd_btn"))
                    && attr(*anchor, "href")
                        .and_then(|href| team_url(href, &source.url))
                        .is_some()
            })
            .collect();
        let watches = select(card, "a.home_watch_btn[href]");
        let time = published_time(card);
        let espn_id = attr(card, "data-espn-id").unwrap_or("");
        if anchors.len() != 2
            || watches.len() != 1
            || time.is_none()
            || !pattern(r"^\d{5,12}$", espn_id)
        {
            conflicting = true;
            continue;
        }
        let teams: Vec<String> = anchors
            .iter()
            .map(|anchor| {
                select(*anchor, "span:not(.mobile-abbr)")
                    .first()
                    .copied()
                    .map(content)
                    .unwrap_or_default()
            })
            .collect();
        let team_urls: Vec<Option<String>> = anchors
            .iter()
            .map(|anchor| attr(*anchor, "href").and_then(|href| team_url(href, &source.url)))
            .collect();
        let url = attr(watches[0], "href").and_then(|href| team_url(href, &source.url));
        if teams.iter().any(String::is_empty)
            || url.is_none()
            || !team_urls.contains(&url)
            || attr(card, "data-away-slug") != Some(slug(&teams[0]).as_str())
            || attr(card, "data-home-slug") != Some(slug(&teams[1]).as_str())
        {
            conflicting = true;
            continue;
        }
        let url = url.unwrap();
        let (kickoff, raw_time) = time.unwrap();
        let pair = [teams[0].clone(), teams[1].clone()];
        let id = format!("{}:{}", source.id, digest(&url));
        let row = Observation {
            id: id.clone(),
            source_id: source.id.clone(),
            url,
            title: pair.join(" vs "),
            teams: Some(pair),
            league: Some(League::Nfl),
            kickoff: Some(kickoff),
            raw_time,
            observed_at: now,
            parser_version: 2,
            legacy_id: None,
            kickoff_lineage: None,
        };
        if let Some(previous) = observations.iter_mut().find(|previous| previous.id == id) {
            if previous.kickoff != row.kickoff
                || previous.teams.as_ref().map(nfl_identity) != row.teams.as_ref().map(nfl_identity)
            {
                conflicting = true;
            } else {
                *previous = row;
            }
        } else {
            observations.push(row);
        }
    }
    if conflicting {
        return result(Vec::new(), false);
    }
    let body_text = doc
        .select("body")
        .first()
        .copied()
        .map(content)
        .unwrap_or_default();
    result(
        observations,
        pattern(
            r"(?i)no (?:live )?(?:games|matches) (?:available|scheduled)",
            &body_text,
        ),
    )
}

fn streamcenter(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let link = Regex::new(r"^/api/stream-link/iframe/event-espn-league-(football-college-football|basketball-(?:nba|wnba)|hockey-nhl|baseball-mlb)-(\d{5,12})/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$").unwrap();
    let mut observations = Vec::new();
    let mut invalid = false;
    let cards = doc.select("article.game-card-row");
    for card in &cards {
        let label = select(*card, ".game-card-league")
            .first()
            .copied()
            .map(content)
            .unwrap_or_default();
        let league = match label.as_str() {
            "NCAA Football" => League::Ncaaf,
            "NBA" => League::Nba,
            "WNBA" => League::Wnba,
            "NHL" => League::Nhl,
            "MLB" => League::Mlb,
            _ => continue,
        };
        if (source.id == "streamcenter-nhl") != (league == League::Nhl)
            || (source.id == "streamcenter-mlb") != (league == League::Mlb)
            || (source.id == "streamcenter-nba") != matches!(league, League::Nba | League::Wnba)
        {
            continue;
        }
        let teams: Vec<String> = select(*card, ".game-card-team[title]")
            .into_iter()
            .filter_map(|item| attr(item, "title").map(str::trim).map(str::to_string))
            .collect();
        let raw_time = select(*card, "time[datetime]")
            .first()
            .and_then(|item| attr(*item, "datetime"))
            .unwrap_or("");
        let kickoff = parse_kickoff(raw_time);
        if teams.len() != 2 || kickoff.is_none() {
            invalid = true;
            continue;
        }
        for anchor in select(*card, "a.game-card-open-link[href]") {
            let href = attr(anchor, "href").unwrap_or("");
            let Some(found) = link.captures(href) else {
                invalid = true;
                continue;
            };
            let expected = match league {
                League::Ncaaf => "football-college-football",
                League::Nhl => "hockey-nhl",
                League::Mlb => "baseball-mlb",
                League::Nba => "basketball-nba",
                League::Wnba => "basketball-wnba",
                _ => unreachable!(),
            };
            if &found[1] != expected {
                invalid = true;
                continue;
            }
            observations.push(Observation {
                id: format!("{}:{}", source.id, digest(href)),
                source_id: source.id.clone(),
                url: Url::parse("https://streamcenter.st")
                    .unwrap()
                    .join(href)
                    .unwrap()
                    .to_string(),
                title: format!("{} vs {}", teams[0], teams[1]),
                teams: Some([teams[0].clone(), teams[1].clone()]),
                league: Some(league),
                kickoff,
                raw_time: raw_time.to_string(),
                observed_at: now,
                parser_version: 2,
                legacy_id: None,
                kickoff_lineage: None,
            });
        }
    }
    if invalid {
        return result(Vec::new(), false);
    }
    result(observations, !cards.is_empty())
}

fn motorsports(source: &ListingSource, body: &str, now: i64) -> ListingResult {
    let doc = HtmlDoc::parse(body);
    let mut observations = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in doc.select("a.ev[data-start][href]") {
        let title = attr(row, "title")
            .map(str::to_string)
            .or_else(|| select(row, ".ev-t").first().copied().map(clean_text))
            .unwrap_or_default();
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        let section = closest(row, "section.lg")
            .and_then(|section| attr(section, "id"))
            .unwrap_or("");
        let league = if pattern(r"^g-lg-f1-\d{8}$", section) {
            Some(League::F1)
        } else if pattern(r"^g-lg-nascar-truck-\d{8}$", section) {
            Some(League::NascarTruck)
        } else if pattern(r"^g-lg-nascar-premier-\d{8}$", section) {
            Some(League::NascarCup)
        } else if pattern(r"^g-cat-motogp-\d{8}$", section) {
            Some(League::Motogp)
        } else if pattern(r"^g-cat-motorsport-\d{8}$", section) {
            Some(League::Motorsport)
        } else {
            None
        };
        let Some(league) = league.filter(|_| !title.is_empty()) else {
            continue;
        };
        let Ok(base) = Url::parse(&source.url) else {
            continue;
        };
        let Ok(url) = base.join(attr(row, "href").unwrap_or("")) else {
            continue;
        };
        if url.host_str() != base.host_str()
            || !pattern(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", url.path())
            || url.query().is_some()
            || url.fragment().is_some()
        {
            continue;
        }
        let raw_time = attr(row, "data-start").unwrap_or("");
        let Some(kickoff) = parse_kickoff(raw_time) else {
            continue;
        };
        if !seen.insert(url.to_string()) {
            continue;
        }
        observations.push(Observation {
            id: format!("{}:{}", source.id, digest(url.as_str())),
            source_id: source.id.clone(),
            url: url.to_string(),
            title,
            teams: None,
            league: Some(league),
            kickoff: Some(kickoff),
            raw_time: raw_time.to_string(),
            observed_at: now,
            parser_version: 2,
            legacy_id: None,
            kickoff_lineage: None,
        });
    }
    result(observations, !doc.select("a.ev[data-start]").is_empty())
}

pub fn parse_html(source: &ListingSource, body: &str, now: i64) -> Option<ListingResult> {
    match (source.id.as_str(), source.family.as_str()) {
        ("livetv", _) => Some(live_tv(source, body, now)),
        ("nflstreams", _) => Some(nflstreams(source, body, now)),
        (_, "streamcenter") => Some(streamcenter(source, body, now)),
        (_, "motorsports") => Some(motorsports(source, body, now)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::SourceRegistry;

    #[test]
    fn first_html_families_match_frozen_type_script_outputs() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let now = fixture["at"].as_i64().unwrap();
        for case_id in ["livetv", "nflstreams", "streamcenter", "motorsports"] {
            let case = fixture["inputs"]["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["id"] == case_id)
                .unwrap();
            let source_id = case["sourceId"].as_str().unwrap();
            let source = registry.get(source_id).unwrap();
            let result = parse_html(source, case["body"].as_str().unwrap(), now).unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                fixture["expected"]["listings"][case_id]["parsed"],
                "{case_id}"
            );
        }
    }
}
