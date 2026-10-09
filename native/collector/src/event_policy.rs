use regex::Regex;
use url::Url;

fn matches(pattern: &str, value: &str) -> bool {
    Regex::new(pattern)
        .expect("fixed event URL pattern")
        .is_match(value)
}

fn exact_page(value: &str) -> Option<Url> {
    let authority = value
        .strip_prefix("https://")?
        .split(&['/', '?', '#'][..])
        .next()?;
    let url = Url::parse(value).ok()?;
    (authority == url.host_str()?
        && value == url.as_str()
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && value.len() <= 2000
        && !url.path().contains('%'))
    .then_some(url)
}

fn open_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (value == url.as_str()
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none())
    .then_some(url)
}

fn slug_pair(value: &str) -> Option<[String; 2]> {
    let mut teams = value.split("-vs-");
    let first = teams.next()?;
    let second = teams.next()?;
    if teams.next().is_some()
        || !matches(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", first)
        || !matches(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", second)
    {
        return None;
    }
    let mut pair = [first.to_string(), second.to_string()];
    pair.sort();
    Some(pair)
}

pub fn valid_event_page_pair(event_url: &str, server_url: &str) -> bool {
    if event_url.starts_with("https://streamed.st/watch/")
        || event_url.starts_with("https://api.kultsport.com/api/matches/all#")
    {
        let (Some(event), Some(server)) = (open_url(event_url), open_url(server_url)) else {
            return false;
        };
        let streamed = event.host_str() == Some("streamed.st")
            && event.fragment().is_none()
            && matches(r"^/watch/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$", event.path());
        let live = event.host_str() == Some("api.kultsport.com")
            && event.path() == "/api/matches/all"
            && event
                .fragment()
                .is_some_and(|part| matches(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$", part));
        return event.query().is_none()
            && server.query().is_none()
            && server.fragment().is_none()
            && (streamed || live)
            && (server.host_str() == Some("embed.st")
                && matches(
                    r"^/embed/[a-z][a-z0-9-]{0,39}/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}/[1-9][0-9]{0,2}$",
                    server.path(),
                )
                || live
                    && server.host_str() == Some("embedindia.st")
                    && matches(
                        r"^/embed/(?:nfl|cfb|nba|wnba|nhl|mlb|f1)/[a-zA-Z0-9/-]{1,150}$",
                        server.path(),
                    ));
    }

    if event_url.starts_with("https://crichd.pk/event/")
        || event_url.starts_with("https://m.crichd.pk/event/")
    {
        let (Some(event), Some(server)) = (exact_page(event_url), exact_page(server_url)) else {
            return false;
        };
        let Some(slug) = Regex::new(r"^/event/([a-z0-9]+(?:-[a-z0-9]+)*)$")
            .unwrap()
            .captures(event.path())
            .map(|capture| capture[1].to_string())
        else {
            return false;
        };
        return matches!(event.host_str(), Some("crichd.pk" | "m.crichd.pk"))
            && server.host_str() == Some("playerbee.top")
            && matches(
                &format!(r"^/charlie/{slug}/[1-9][0-9]{{0,9}}$"),
                server.path(),
            );
    }

    if event_url.starts_with("https://sportsbite.org/event/") {
        let (Some(event), Some(server)) = (exact_page(event_url), open_url(server_url)) else {
            return false;
        };
        let Some(event_slug) = Regex::new(r"^/event/fg-([a-z0-9]+(?:-[a-z0-9]+)*)$")
            .unwrap()
            .captures(event.path())
            .map(|capture| capture[1].to_string())
        else {
            return false;
        };
        let Some(server_slug) =
            Regex::new(r"^/(?:lol-embed|rs-embed)/embed/([a-z0-9]+(?:-[a-z0-9]+)*)$")
                .unwrap()
                .captures(server.path())
                .map(|capture| capture[1].to_string())
        else {
            return false;
        };
        let sides: Vec<_> = event_slug.split("-vs-").collect();
        let matchup = sides.len() == 2
            && [event_slug.clone(), format!("{}-vs-{}", sides[1], sides[0])]
                .iter()
                .any(|pair| {
                    server_slug == *pair
                        || server.path().starts_with("/rs-embed/")
                            && matches(
                                &format!(r"^(?:nfl|nba|nhl|mlb|cfb)-streams-[1-9][0-9]{{0,2}}-{pair}-(?:nfl|nba|nhl[1-9]?|mlb|espn[1-9]?)-(?:admin|temp|tedesco)$"),
                                &server_slug,
                            )
                });
        return (!event_slug.contains("-vs-") || matchup)
            && server.host_str() == Some("sportsbite.org")
            && server.fragment().is_none()
            && server
                .query()
                .is_some_and(|query| matches(r"^v=high&emb=[1-9][0-9]{0,5}$", query));
    }

    if event_url.starts_with("https://nflstreams.org/")
        || server_url.starts_with("https://piratecat.store/")
    {
        let (Some(event), Some(server)) = (exact_page(event_url), open_url(server_url)) else {
            return false;
        };
        let mut pairs = server.query_pairs();
        let Some((key, value)) = pairs.next() else {
            return false;
        };
        return event.host_str() == Some("nflstreams.org")
            && matches(r"^/teams/[a-z0-9]+(?:-[a-z0-9]+)*-live/$", event.path())
            && server.host_str() == Some("piratecat.store")
            && server.fragment().is_none()
            && server.path() == "/sports/player.php"
            && server_url.len() <= 2000
            && pairs.next().is_none()
            && key == "hd"
            && server.query() == Some(format!("hd={value}").as_str())
            && matches(r"^[A-Za-z0-9-]{1,20}=[A-Za-z0-9-]{1,20}$", &value)
            && value.contains('-');
    }

    if event_url.starts_with("https://livetv.sx/") || server_url.starts_with("https://livetv.sx/") {
        let (Some(event), Some(server)) = (exact_page(event_url), open_url(server_url)) else {
            return false;
        };
        let Some(id) = Regex::new(r"^/enx/eventinfo/([1-9][0-9]{0,19})_[a-z0-9_]*/$")
            .unwrap()
            .captures(event.path())
            .map(|capture| capture[1].to_string())
        else {
            return false;
        };
        let pairs: Vec<_> = server.query_pairs().collect();
        if event.host_str() != Some("livetv.sx")
            || server.host_str() != Some("livetv.sx")
            || server.fragment().is_some()
            || server.path() != "/webplayer.php"
            || server_url.len() > 2000
            || pairs.len() != 7
        {
            return false;
        }
        let keys = ["t", "c", "lang", "eid", "lid", "ci", "si"];
        if keys
            .iter()
            .any(|key| pairs.iter().filter(|(actual, _)| actual == key).count() != 1)
        {
            return false;
        }
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(actual, _)| actual == key)
                .map(|(_, value)| value.as_ref())
        };
        return get("t") == Some("ifr")
            && get("lang") == Some("en")
            && get("si") == Some("27")
            && get("eid") == Some(id.as_str())
            && get("c").is_some_and(|value| matches(r"^[1-9][0-9]{0,19}$", value))
            && get("c") == get("lid")
            && get("ci").is_some_and(|value| matches(r"^[1-9][0-9]{0,5}$", value));
    }

    let (Some(event), Some(server)) = (exact_page(event_url), exact_page(server_url)) else {
        return false;
    };
    match (event.host_str(), server.host_str()) {
        (Some("ms.buffstream.io"), Some("embedsports.me")) => {
            let team = Regex::new(
                r"^/(nfl|cfb|nba|nhl|mlb)-streams/([a-z0-9]+(?:-[a-z0-9]+)*)-live-stream$",
            )
            .unwrap();
            let pair = Regex::new(r"^/(american-football|basketball|ice-hockey|baseball)/([a-z0-9]+(?:-[a-z0-9]+)*)-vs-([a-z0-9]+(?:-[a-z0-9]+)*)-stream-[12]$").unwrap();
            let (Some(team), Some(pair)) =
                (team.captures(event.path()), pair.captures(server.path()))
            else {
                return false;
            };
            let sport = match &team[1] {
                "nba" => "basketball",
                "nhl" => "ice-hockey",
                "mlb" => "baseball",
                _ => "american-football",
            };
            pair[1] == *sport && (team[2] == pair[2] || team[2] == pair[3])
        }
        (Some("mlbbox.me"), Some("embedsports.me")) => {
            let matchup = Regex::new(r"^/mlb/([a-z0-9-]+)-vs-([a-z0-9-]+)-stream$").unwrap();
            let player =
                Regex::new(r"^/baseball/([a-z0-9-]+)-vs-([a-z0-9-]+)-stream-[12]$").unwrap();
            let (Some(matchup), Some(player)) = (
                matchup.captures(event.path()),
                player.captures(server.path()),
            ) else {
                return false;
            };
            (matchup[1] == player[1] && matchup[2] == player[2])
                || (matchup[1] == player[2] && matchup[2] == player[1])
        }
        (Some("tvapp1.pk"), _) => {
            event_url == server_url && matches(r"^/watch/[a-zA-Z0-9-]{1,120}$", event.path())
        }
        (Some("methstreams.st" | "crackstreams.st"), Some("fxtrend.st")) => {
            let path = event.path();
            let server_path = server.path();
            if matches(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", path) && path == server_path {
                return true;
            }
            if matches(r"^/event/ppv-[a-z0-9]+(?:-[a-z0-9]+)*$", path)
                && matches(
                    &format!(
                        r"^{}\/(?:core|vector|vertex|hotel)/[1-9][0-9]{{0,2}}$",
                        regex::escape(path)
                    ),
                    server_path,
                )
            {
                return true;
            }
            if let Some(published) = Regex::new(
                r"^/event/ppv-([a-z0-9-]+)/(?:core|vector|vertex|hotel)/[1-9][0-9]{0,2}$",
            )
            .unwrap()
            .captures(server_path)
            {
                let event_teams = path.strip_prefix("/event/").and_then(slug_pair);
                let server_teams = slug_pair(&published[1]);
                if event_teams.is_some() && event_teams == server_teams {
                    return true;
                }
            }
            if matches(r"^/event/m-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{4}$", path) {
                return path == server_path
                    || matches(
                        &format!(
                            r"^{}\/(?:core|vector|vertex|foxtrot|main|hotel)/[1-9][0-9]{{0,2}}$",
                            regex::escape(path)
                        ),
                        server_path,
                    );
            }
            matches(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", path)
                && matches(
                    r"^/event/live_(?:cfb|nfl)_[a-z0-9]+(?:-[a-z0-9]+)*-live-streaming-[0-9]{1,20}/(?:vector|vertex|foxtrot)/[1-9][0-9]{0,2}$",
                    server_path,
                )
        }
        (Some("vipbox.fm"), Some("vipbox.fm")) => {
            let pattern =
                Regex::new(r"^/onair/(ncaaf|nfl|nba|nhl)/([a-z0-9]+(?:-[a-z0-9]+)*)$").unwrap();
            pattern.captures(event.path()).is_some_and(|capture| {
                matches(
                    &format!(r"^/live/{}/{}-[1-9][0-9]{{0,3}}$", &capture[1], &capture[2]),
                    server.path(),
                )
            })
        }
        (Some("www.vipboxtv.sk"), Some("www.vipboxtv.sk")) => {
            let pattern = Regex::new(r"^/cfb/([a-z0-9]+(?:-[a-z0-9]+)*)-stream-live$").unwrap();
            pattern.captures(event.path()).is_some_and(|capture| {
                matches(
                    &format!(r"^/cfb/[1-9][0-9]{{0,3}}/stream-{}-live$", &capture[1]),
                    server.path(),
                )
            })
        }
        (Some("strikeout.im"), Some("strikeout.im")) => {
            let pattern = Regex::new(
                r"^/(college-football|nfl|nba|nhl|mlb)/stream-([a-z0-9]+(?:-[a-z0-9]+)*)-live$",
            )
            .unwrap();
            pattern.captures(event.path()).is_some_and(|capture| {
                matches(
                    &format!(
                        r"^/{}/[1-9][0-9]{{0,3}}/{}-stream$",
                        &capture[1], &capture[2]
                    ),
                    server.path(),
                )
            })
        }
        (Some("ppv.st"), Some("embedindia.st")) => {
            let path = event.path();
            if let Some(race) = Regex::new(r"^/live/f1/([0-9]{4})/([a-z0-9]+(?:-[a-z0-9]+)*)/(fp[123]|sprint-q|sprint|qualifying|race)$")
                .unwrap()
                .captures(path)
            {
                let direct = format!("/embed/f1/{}/{}/{}", &race[1], &race[2], &race[3]);
                if server.path() == direct {
                    return true;
                }
                let session = if race[3].starts_with("fp") {
                    format!("practice-{}", &race[3][2..])
                } else if &race[3] == "sprint-q" {
                    "sprint-qualifying".to_string()
                } else {
                    race[3].to_string()
                };
                return matches(&format!(r"^/embed/{}-grand-prix---{}-[1-9][0-9]{{0,9}}$", &race[2], session), server.path());
            }
            let pattern = Regex::new(r"^/live/(cfb|nfl|nba|wnba|nhl|mlb)/([0-9]{4}-[0-9]{2}-[0-9]{2})/([a-z0-9]+(?:-[a-z0-9]+)*)$").unwrap();
            pattern.captures(path).is_some_and(|capture| {
                let base = format!("/embed/{}/{}/{}", &capture[1], &capture[2], &capture[3]);
                server.path() == base || server.path() == format!("{base}/skycast")
            })
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_a_published_buffstream_pair() {
        assert!(valid_event_page_pair(
            "https://ms.buffstream.io/cfb-streams/montana-state-live-stream",
            "https://embedsports.me/american-football/montana-state-vs-idaho-stream-1"
        ));
        assert!(!valid_event_page_pair(
            "https://ms.buffstream.io/cfb-streams/montana-state-live-stream",
            "https://embedsports.me/baseball/montana-state-vs-idaho-stream-1"
        ));
    }
}
