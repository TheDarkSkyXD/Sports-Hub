use crate::types::League;
use chrono::{DateTime, Utc};
use chrono_tz::America::Chicago;
use regex::Regex;
use std::sync::OnceLock;

pub(crate) fn league(title: &str) -> Option<League> {
    let label = title.trim().to_ascii_lowercase();
    static WWE: OnceLock<Regex> = OnceLock::new();
    static TNA: OnceLock<Regex> = OnceLock::new();
    if WWE
        .get_or_init(|| Regex::new(r"^(?:wwe\s+[a-z0-9]|nxt(?:\s+[a-z0-9]|$))").unwrap())
        .is_match(&label)
    {
        Some(League::Wwe)
    } else if TNA
        .get_or_init(|| {
            Regex::new(r"^(?:tna\s+[a-z0-9]|impact wrestling(?:\s+[a-z0-9]|$))").unwrap()
        })
        .is_match(&label)
    {
        Some(League::Tna)
    } else if label.starts_with("aew ") && label.len() > 4
        || label.starts_with("all elite wrestling ") && label.len() > 20 {
        Some(League::Aew)
    } else {
        None
    }
}

pub(crate) fn ppv_route(path: &str, promotion: League, id: i64, kickoff: i64) -> bool {
    static SLUG: OnceLock<Regex> = OnceLock::new();
    if SLUG
        .get_or_init(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]{0,18}$").unwrap())
        .is_match(path)
    {
        return path
            .rsplit_once('-')
            .is_some_and(|(_, value)| value == id.to_string())
            && league(&path.replace('-', " ")).is_none_or(|league| league == promotion);
    }
    dated_ppv_route(path, promotion, kickoff)
}

pub(crate) fn dated_ppv_route(path: &str, promotion: League, kickoff: i64) -> bool {
    static ROUTE: OnceLock<Regex> = OnceLock::new();
    let Some(route) = ROUTE
        .get_or_init(|| Regex::new(r"^(wwe|tna|aew)/(\d{4}-\d{2}-\d{2})$").unwrap())
        .captures(path)
    else {
        return false;
    };
    let expected = match &route[1] {
        "wwe" => League::Wwe,
        "tna" => League::Tna,
        "aew" => League::Aew,
        _ => unreachable!(),
    };
    promotion == expected
        && DateTime::<Utc>::from_timestamp_millis(kickoff)
            .is_some_and(|at| at.with_timezone(&Chicago).format("%Y-%m-%d").to_string() == route[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotion_titles_are_distinct() {
        for title in [
            "WWE Monday Night Raw",
            "WWE Friday Night SmackDown",
            "WWE NXT No Mercy",
            "NXT",
            "NXT No Mercy",
        ] {
            assert_eq!(league(title), Some(League::Wwe), "{title}");
        }
        for title in [
            "TNA Impact",
            "Impact Wrestling",
            "Impact Wrestling Bound For Glory",
            "TNA Bound For Glory",
        ] {
            assert_eq!(league(title), Some(League::Tna), "{title}");
        }
        for title in ["Raw", "Impact", "The Impact of Wrestling", "WWE"] {
            assert_eq!(league(title), None, "{title}");
        }
        assert_eq!(league("AEW Grand Slam: Collision"), Some(League::Aew));
    }

    #[test]
    fn ppv_route_uses_chicago_broadcast_date() {
        assert!(ppv_route(
            "wwe/2026-10-09",
            League::Wwe,
            29976,
            1_791_590_400_000
        ));
        assert!(!ppv_route(
            "wwe/2026-10-10",
            League::Wwe,
            29976,
            1_791_590_400_000
        ));
        assert!(!ppv_route(
            "wwe/2026-10-09/extra",
            League::Wwe,
            29976,
            1_791_590_400_000
        ));
        assert!(!ppv_route(
            "wwe/2026-02-30",
            League::Wwe,
            29976,
            1_791_590_400_000
        ));
        assert!(ppv_route(
            "tna-bound-for-glory-30225",
            League::Tna,
            30225,
            1_791_750_600_000
        ));
        assert!(!ppv_route(
            "tna-bound-for-glory-30225",
            League::Tna,
            30226,
            1_791_750_600_000
        ));
    }
}
