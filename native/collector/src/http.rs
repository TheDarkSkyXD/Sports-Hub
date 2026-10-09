use crate::registry::SourceRegistry;
use regex::Regex;
use url::Url;

pub const SWAC_CATALOG_URL: &str = "https://ott.gideo.video/api/legacy?cmd=getCategoryChildren&AccountID=Southwestern-Athletic-Conference&CategoryID=e1dbe7ec9a7e686b42b53ab33c3e30e4";
const SWAC_API: &str = "https://ott.gideo.video/api/legacy";
const SWAC_TENANT: &str = "Southwestern-Athletic-Conference";
const SWAC_CATEGORY: &str = "e1dbe7ec9a7e686b42b53ab33c3e30e4";

fn matches(expression: &str, value: &str) -> bool {
    Regex::new(expression)
        .expect("fixed discovery expression")
        .is_match(value)
}

fn invalid_fixture_escape(value: &str) -> bool {
    value.match_indices('%').any(|(at, _)| {
        value
            .get(at + 1..at + 3)
            .is_none_or(|escape| !escape.eq_ignore_ascii_case("20"))
    })
}

pub fn swac_program_url(id: &str) -> String {
    format!("https://tv.swac.org/program-group/{SWAC_CATEGORY}/program/{id}")
}

pub fn swac_program_id(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let id = url.path_segments()?.next_back()?;
    (matches(r"^[a-f0-9]{32}$", id) && value == swac_program_url(id)).then(|| id.to_string())
}

pub fn swac_api_url(command: &str, id: &str) -> Option<String> {
    if !matches(r"^[a-f0-9]{32}$", id) {
        return None;
    }
    Some(if command == "getVideoUrls" {
        format!("{SWAC_API}?cmd={command}&accountId={SWAC_TENANT}&videoId={id}")
    } else if command == "getVideo" {
        format!("{SWAC_API}?cmd={command}&AccountID={SWAC_TENANT}&VideoID={id}")
    } else {
        return None;
    })
}

pub fn allowed_discovery_url(value: &str, registry: &SourceRegistry) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    match host {
        "streamed.st" => {
            value == "https://streamed.st/api/matches/all"
                || matches(
                    r"^https://streamed\.st/api/stream/[a-z][a-z0-9-]{0,39}/[a-zA-Z0-9_-]{1,160}$",
                    value,
                )
                || matches(r"^https://streamed\.st/watch/[a-zA-Z0-9_-]{1,160}$", value)
        }
        "api.kultsport.com" => {
            value == "https://api.kultsport.com/api/matches/all"
                || matches(
                    r"^https://api\.kultsport\.com/api/matches/all#[a-zA-Z0-9_-]{1,160}$",
                    value,
                )
                || !value.to_ascii_lowercase().contains("%25")
                    && matches(
                        r"^https://api\.kultsport\.com/api/stream/[a-zA-Z0-9%:-]{1,80}/[a-zA-Z0-9%_-]{1,160}$",
                        value,
                    )
        }
        "bestfreestreaming.app" => {
            matches!(
                value,
                "https://bestfreestreaming.app/api/xhr" | "https://bestfreestreaming.app/api/xhrs"
            )
        }
        "sportsfeed24.st" => {
            matches(
                r"^https://sportsfeed24\.st/fixture/[A-Za-z0-9%._~-]+-vs-[A-Za-z0-9%._~-]+$",
                value,
            ) && !invalid_fixture_escape(value)
                && value == url.as_str()
        }
        "totalsportek1.is" | "links.totalsportek1.is" => {
            url.query().is_none()
                && url.fragment().is_none()
                && matches(
                    r"^/(?:game/)?[a-z0-9]+(?:-[a-z0-9]+)*/[0-9]{1,10}/$",
                    url.path(),
                )
                && value == url.as_str()
        }
        "crichd.pk" | "m.crichd.pk" => {
            url.query().is_none()
                && url.fragment().is_none()
                && (url.path() == "/" || matches(r"^/event/[a-z0-9]+(?:-[a-z0-9]+)*$", url.path()))
                && value == url.as_str()
        }
        "sportsbite.org" => {
            value == "https://sportsbite.org/matches"
                || matches(
                    r"^https://sportsbite\.org/event/fg-[a-z0-9]+(?:-[a-z0-9]+)*$",
                    value,
                )
        }
        "ott.gideo.video" => {
            value == SWAC_CATALOG_URL
                || url
                    .query_pairs()
                    .find(|(key, _)| key == "VideoID")
                    .is_some_and(|(_, id)| {
                        matches(r"^[a-f0-9]{32}$", &id)
                            && swac_api_url("getVideo", &id).as_deref() == Some(value)
                    })
        }
        "tv.swac.org" => swac_program_id(value).is_some(),
        _ => {
            registry.contains_host(host)
                || host == "gooz.aapmains.net"
                || host == "streame.center"
                || url.query().is_none()
                    && url.fragment().is_none()
                    && match host {
                        "tvapp1.pk" => matches(r"^/watch/[a-zA-Z0-9-]{1,120}$", url.path()),
                        "ppv.st" => {
                            matches(
                                r"^/live/(?:cfb|nfl|nba|wnba|nhl|mlb)/[0-9]{4}-[0-9]{2}-[0-9]{2}/[a-z0-9-]+$",
                                url.path(),
                            ) || matches(
                                r"^/live/f1/[0-9]{4}/[a-z0-9-]+/(?:fp[123]|sprint-q|sprint|qualifying|race)$",
                                url.path(),
                            )
                        }
                        _ => false,
                    }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_policy_keeps_source_specific_paths() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        assert!(allowed_discovery_url(
            "https://ms.buffstream.io/cfb-streams/montana-state-live-stream",
            &registry
        ));
        assert!(allowed_discovery_url(
            "https://streamed.st/watch/event_123",
            &registry
        ));
        assert!(!allowed_discovery_url(
            "https://streamed.st/other",
            &registry
        ));
        assert!(!allowed_discovery_url("https://example.com/", &registry));
    }
}
