use regex::Regex;
use std::{collections::HashMap, sync::OnceLock};
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

fn sportsfeed_pair(event_url: &str, server_url: &str) -> bool {
    let (Some(event), Some(server)) = (open_url(event_url), open_url(server_url)) else {
        return false;
    };
    if event.host_str() != Some("sportsfeed24.st")
        || event.query().is_some()
        || event.fragment().is_some()
        || event_url.len() > 2000
        || server.fragment().is_some()
        || server_url.len() > 2048
    {
        return false;
    }
    let Some(fixture) = event.path().strip_prefix("/fixture/") else {
        return false;
    };
    let names = fixture.split("-vs-").collect::<Vec<_>>();
    if names.len() != 2 {
        return false;
    }
    let mut teams = Vec::new();
    for name in names {
        let encoded = format!("name={name}");
        let Some((_, decoded)) = url::form_urlencoded::parse(encoded.as_bytes()).next() else {
            return false;
        };
        if decoded.is_empty()
            || crate::listing_json::component(&decoded) != name
            || !decoded
                .chars()
                .all(|c| c.is_alphanumeric() || " -_.!'~()&".contains(c))
        {
            return false;
        }
        let slug = decoded
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        if slug.is_empty() {
            return false;
        }
        teams.push(slug);
    }
    let host=server.host_str().unwrap_or_default();
    if host=="domainx.rest" {
        return server.path()=="/file/" && server.query().is_some_and(|query|matches(r"^[1-9][0-9]{0,12}$",query));
    }
    if matches!(host,"trend48.st"|"embed.st") {
        if server.query().is_some(){return false;}
        let pattern=if host=="trend48.st" {r"^/event/ppv-([a-z0-9-]+-vs-[a-z0-9-]+)$"}
            else {r"^/embed/admin/ppv-([a-z0-9-]+-vs-[a-z0-9-]+)/[1-9][0-9]{0,2}$"};
        let Some(found)=Regex::new(pattern).unwrap().captures(server.path()) else {return false;};
        return published_matchup(&teams,&found[1]);
    }
    published_provider_pair(&teams,&server)
}


fn sportsurge_player_paths() -> &'static HashMap<&'static str, Regex> {
    static PATHS:OnceLock<HashMap<&'static str,Regex>>=OnceLock::new();
    PATHS.get_or_init(||[
            ("alphastreams.mom", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("goalstream.cfd", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("apexztreams.xyz", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("smlbn.cyou", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("bizzstreamz.online", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("sportsworld.best", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("sportzworld.ru", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("ripplestream.cyou", r"^/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("footyicon.online", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)-live-stream-\d{4}-\d{2}-\d{2}/$"),
            ("opturspapa.xyz", r"^/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)$"),
            ("hadcrak.cyou", r"^/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)-live-stream-\d{4}-\d{2}-\d{2}/$"),
            ("wildgames.bz", r"^/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-v-[a-z0-9-]+)/$"),
            ("techydeals.store", r"^/totalsportek[1-9]\d{0,11}/(?:nhl|nba|nfl|mlb|cfb)/[1-9]\d{0,2}\.php$"),
            ("techydeals.best", r"^/totalsportek[1-9]\d{0,11}/extraplayer/[1-9]\d{0,2}\.php$"),
            ("sports247.ru", r"^/watch/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)-\d{4}-\d{2}-\d{2}$"),
            ("mjumbo.icu", r"^/\d{6}-[1-9]\d{0,2}/ch-[1-9]\d{0,2}\.html$"),
            ("topstreams.click", r"^/index\.php/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("playnex.online", r"^/index\.php/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("liveverse.online", r"^/index\.php/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("sportsstreams.online", r"^/index\.php/\d{4}/\d{2}/\d{2}/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)/$"),
            ("iohit.st", r"^/watch/(?P<matchup>[a-z0-9-]+-vs-[a-z0-9-]+)-[1-9]\d{0,11}$"),
        ].into_iter().map(|(host,pattern)|(host,Regex::new(pattern).expect("fixed published provider route"))).collect())
}

fn sportsurge_published_pair(event:&Url,server:&Url) -> bool {
    let event_path=Regex::new(r"^/([A-Za-z0-9-]+)/[1-9][0-9]{0,11}$").unwrap();
    let Some(event_slug)=event_path.captures(event.path()).map(|found|found[1].to_lowercase()) else {return false;};
    let Some(event_teams)=slug_pair(&event_slug) else {return false;};
    published_provider_pair(&event_teams,server)
}

fn published_provider_pair(event_teams:&[String],server:&Url) -> bool {
    let host=server.host_str().unwrap_or_default();
    let query=match host {"goomdstea.click"=>Some("ch"),"poscihub.ru"=>Some("post"),"topstream.help"|"1ststreams.xyz"=>Some("p"),_=>None};
    if let Some(key)=query {
        let Some(value)=server.query().and_then(|query|query.strip_prefix(&format!("{key}="))) else {return false;};
        return server.path()==(if key=="ch" {"/stream.php"} else {"/"}) && !value.is_empty() && value.len()<=13
            && !value.starts_with('0') && value.bytes().all(|byte|byte.is_ascii_digit());
    }
    if server.query().is_some(){return false;}
    let Some(found)=sportsurge_player_paths().get(host).and_then(|path|path.captures(server.path())) else {return false;};
    let Some(matchup)=found.name("matchup").map(|group|group.as_str().replace("-v-","-vs-")) else {return true;};
    published_matchup(event_teams,&matchup)
}

fn published_matchup(event_teams:&[String],matchup:&str) -> bool {
    let Some(server_teams)=slug_pair(&matchup) else {return false;};
    let contains=|side:&str,team:&str|format!("-{side}-").contains(&format!("-{team}-"));
    contains(&server_teams[0],&event_teams[0]) && contains(&server_teams[1],&event_teams[1])
        || contains(&server_teams[0],&event_teams[1]) && contains(&server_teams[1],&event_teams[0])
}

fn published_pair(event_url:&str,server_url:&str)->Option<bool> {
    let (Some(event),Some(server))=(open_url(event_url),open_url(server_url)) else {return None;};
    let host=event.host_str()?;
    if !matches!(host,"iohit.st"|"trend48.st"|"foxiy.st"|"buffstreams.ch"|"sportsurgei.is"|"nbabitez.com"|"dudestream1.com"|"mlbbite.org"|"ihdstreams.top") {return None;}
    if event.query().is_some() || event.fragment().is_some()
        || server.fragment().is_some_and(|fragment|!matches!(fragment,"player=clappr"|"player=clappr&autoplay=true")) {return Some(false);}
    let server_host=server.host_str()?;
    if host=="sportsurgei.is" && server_host=="live3.totalsportek.vg" {
        return Some(server.query().is_none() && server.fragment().is_none() && event.path()==server.path()
            && matches(r"^/[A-Za-z0-9-]+/[1-9][0-9]{0,11}$",event.path()));
    }
    if host=="sportsurgei.is" && !matches!(server_host,"live.totalsportek.vg"|"live4.totalsportek.vg") {
        return Some(sportsurge_published_pair(&event,&server));
    }
    if server.query().is_some() {return Some(false);}
    if host=="ihdstreams.top" {
        return Some(matches(r"^/watch/[a-z0-9]+(?:-[a-z0-9]+)*$",event.path()) && server_host==host
            && matches(r"^/embed/(?:nba|nfl|nhl|mlb|cfb|wnba|ufc|boxing|wwe|f1)/ch[1-9][0-9]{0,2}\.php$",server.path()));
    }
    if host=="trend48.st" && server_host=="trendy48.site" {
        return Some(matches(r"^/event/m-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{4}$",event.path())
            && matches(r"^/embed/[a-z0-9]{1,64}-[1-9][0-9]{0,11}$",server.path()));
    }
    if host=="trend48.st" && server_host=="embed.st" {
        let Some(slug)=Regex::new(r"^/event/(ppv-[a-z0-9]+(?:-[a-z0-9]+)*)$").unwrap().captures(event.path()).map(|found|found[1].to_string()) else {return Some(false);};
        return Some(matches(&format!(r"^/embed-noads/admin/{}/[1-9][0-9]{{0,2}}$",regex::escape(&slug)),server.path()));
    }
    if matches!(host,"sportsurgei.is"|"nbabitez.com") && matches!(server_host,"live.totalsportek.vg"|"live4.totalsportek.vg") {
        return Some(event.path()==server.path() && matches(r"^/[A-Za-z0-9-]+/[1-9][0-9]{0,11}$",event.path()));
    }
    if matches!(server_host,"foxiy.st"|"fxtrend.st") && matches!(host,"foxiy.st"|"trend48.st"|"buffstreams.ch"|"mlbbite.org") {
        let event_path=event.path();
        let path=if host=="mlbbite.org" {format!("/event{}",event_path)} else {event_path.to_string()};
        if matches(r"^/event/(?:m-|ppv-)[a-z0-9]+(?:-[a-z0-9]+)*$",&path) {
            return Some(server.path()==path || matches(&format!(r"^{}/(?:hotel|core|vector|vertex|foxtrot)/[1-9][0-9]{{0,2}}$",regex::escape(&path)),server.path()));
        }
    }
    if host=="dudestream1.com" && server_host=="embedsports.me" {
        return Some(matches(r"^/[a-z0-9]+(?:-[a-z0-9]+)*/$",event.path()) && matches(r"^/(?:basketball|american-football|ice-hockey|baseball)/[a-z0-9]+(?:-[a-z0-9]+)*-vs-[a-z0-9]+(?:-[a-z0-9]+)*-stream-[12]$",server.path()));
    }
    if host=="iohit.st" && server_host=="embed.st" {
        let event_slug=event.path().strip_prefix("/event/")?;
        let event_slug=Regex::new(r"-[0-9]+$").unwrap().replace(event_slug,"");
        let Some(event_pair)=slug_pair(&event_slug) else {return Some(false);};
        if matches(r"^/embed-noads/golf/[1-9][0-9]{0,11}/[1-9][0-9]{0,2}$",server.path()) {return Some(true);}
        let hotel=Regex::new(r"^/embed-noads/hotel/([a-z0-9]+(?:-[a-z0-9]+)*)-(?:nba|wnba|nfl|cfb|nhl|mlb)-[0-9]{10}/[1-9][0-9]{0,2}$").unwrap();
        let admin=Regex::new(r"^/embed-noads/admin/ppv-([a-z0-9]+(?:-[a-z0-9]+)*)/[1-9][0-9]{0,2}$").unwrap();
        let Some(found)=hotel.captures(server.path()).or_else(||admin.captures(server.path())) else {return Some(false);};
        return Some(slug_pair(&found[1]).as_ref()==Some(&event_pair));
    }
    if matches!(host,"buffstreams.ch"|"foxiy.st") {return None;}
    Some(false)
}

pub fn valid_event_page_pair(event_url: &str, server_url: &str) -> bool {
    if let Some(valid)=published_pair(event_url,server_url) {return valid;}
    if event_url.starts_with("https://sportsfeed24.st/fixture/") {
        return sportsfeed_pair(event_url, server_url);
    }
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
        (Some("ms.buffstream.io" | "streameasthd.app"), Some("embedsports.me")) => {
            if let Some(event)=Regex::new(r"^/(mma|boxing|wwe|f1|motor)-streams/([a-z0-9]+(?:-[a-z0-9]+)*)-live-stream$").unwrap().captures(event.path()) {
                let Some(player)=Regex::new(r"^/(boxing|motorsports)/([a-z0-9]+(?:-[a-z0-9]+)*)-stream-[12]$").unwrap().captures(server.path()) else {return false;};
                let event_slug=event[2].replace('-',"");
                let player_slug=player[2].replace('-',"");
                return match &event[1] {
                    "mma"|"wwe" => player[1]==*"boxing" && event_slug==player_slug,
                    "boxing" => player[1]==*"boxing" && slug_pair(&player[2]).is_some_and(|names|names.iter().any(|name|name.replace('-',"")==event_slug)),
                    "f1"|"motor" => player[1]==*"motorsports" && (event_slug==player_slug
                        || (event[2].starts_with("f1-")||event[2].starts_with("formula-1-")) && player[2]==*"sky-sports-f1-sky-f1"
                        || event[2].starts_with("motogp-") && player[2]==*"motogp-qualifying-motogp-main-race"),
                    _ => false,
                };
            }
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
        (Some("buffstreams.ch" | "methstreams.vg"), Some("foxiy.st")) => {
            matches(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", event.path())
                && matches(
                    &format!(
                        r"^{}-nascar-cup-series-[0-9]{{10}}/hotel/[1-9][0-9]{{0,2}}$",
                        regex::escape(event.path())
                    ),
                    server.path(),
                )
        }
        (Some("methstreams.st" | "crackstreams.st"), Some("fxtrend.st" | "foxiy.st")) => {
            let path = event.path();
            let server_path = server.path();
            if server.host_str() == Some("foxiy.st")
                && matches(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", path)
                && matches(
                    &format!(
                        r"^{}-nascar-cup-series-[0-9]{{10}}/hotel/[1-9][0-9]{{0,2}}$",
                        regex::escape(path)
                    ),
                    server_path,
                )
            {
                return true;
            }
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
            server.host_str() == Some("fxtrend.st")
                && matches(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", path)
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
        (Some("ppv.st"), Some("embedindia.st" | "taifood-blog.asia")) => {
            let path = event.path();
            if let Some(wrestling) = Regex::new(r"^/live/((?:wwe|tna|aew)/[0-9]{4}-[0-9]{2}-[0-9]{2}|[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]{0,18})$")
                .unwrap()
                .captures(path)
            {
                return server.host_str() == Some("taifood-blog.asia")
                    && server.path() == format!("/embed/{}", &wrestling[1]);
            }
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
    fn sportsurgei_bkfc_live3_requires_the_exact_published_route() {
        let event = "https://sportsurgei.is/Jamel-Herring-vs-John-Dodson/79537";
        let server = "https://live3.totalsportek.vg/Jamel-Herring-vs-John-Dodson/79537";
        assert!(valid_event_page_pair(event, server));
        for invalid in [
            server.replace("live3.totalsportek.vg", "live3.totalsportek.vg.evil.test"),
            server.replace("/79537", "/79538"),
            server.replace("Jamel-Herring-vs-John-Dodson", "Dmitry-Bivol-vs-Michael-Eifert"),
            format!("{server}?next=1"), format!("{server}#player"), format!("{server}#player=clappr"),
            server.replace("live3.", "live2."), server.replace("live3.", "live5."),
            server.replace("https:", "http:"),
        ] {
            assert!(!valid_event_page_pair(event, &invalid), "{invalid}");
        }
        assert!(!valid_event_page_pair(&event.replace("sportsurgei.is", "nbabitez.com"), server));
    }

    #[test]
    fn ppv_migrated_hosts_preserve_exact_sports_and_race_routes() {
        for host in ["embedindia.st", "taifood-blog.asia"] {
            for league in ["cfb", "nfl", "nba", "wnba", "nhl", "mlb"] {
                let event = format!("https://ppv.st/live/{league}/2026-10-09/isu-byu");
                let server = format!("https://{host}/embed/{league}/2026-10-09/isu-byu");
                assert!(valid_event_page_pair(&event, &server), "{server}");
                assert!(valid_event_page_pair(&event, &format!("{server}/skycast")));
                for invalid in [
                    server.replace("isu-byu", "other-game"),
                    server.replace(league, "cfl"),
                    server.replace("2026-10-09", "2026-10-10"),
                    server.replace(host, "other.example"),
                    format!("{server}?next=other"),
                    format!("{server}#player"),
                ] {
                    assert!(!valid_event_page_pair(&event, &invalid), "{invalid}");
                }
            }
            for (session, alternate) in [
                ("fp1", "practice-1"),
                ("sprint-q", "sprint-qualifying"),
                ("race", "race"),
            ] {
                let event = format!("https://ppv.st/live/f1/2026/japan/{session}");
                assert!(valid_event_page_pair(
                    &event,
                    &format!("https://{host}/embed/f1/2026/japan/{session}")
                ));
                assert!(valid_event_page_pair(
                    &event,
                    &format!("https://{host}/embed/japan-grand-prix---{alternate}-1")
                ));
                for invalid in [
                    format!("https://{host}/embed/f1/2026/china/{session}"),
                    format!("https://{host}/embed/f1/2025/japan/{session}"),
                    format!("https://{host}/embed/japan-grand-prix---qualifying-1"),
                ] {
                    assert!(!valid_event_page_pair(&event, &invalid), "{invalid}");
                }
            }
        }
    }

    #[test]
    fn wwe_ppv_embed_requires_the_same_dated_route() {
        assert!(valid_event_page_pair(
            "https://ppv.st/live/wwe/2026-10-09",
            "https://taifood-blog.asia/embed/wwe/2026-10-09"
        ));
        for server in [
            "https://taifood-blog.asia/embed/wwe/2026-10-10",
            "https://taifood-blog.asia/embed/aew/2026-10-09",
            "https://taifood-blog.asia/embed/wwe/2026-10-09?next=other",
            "https://embedindia.st/embed/wwe/2026-10-09",
        ] {
            assert!(
                !valid_event_page_pair("https://ppv.st/live/wwe/2026-10-09", server),
                "{server}"
            );
        }
    }

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
