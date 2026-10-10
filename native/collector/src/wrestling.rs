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
    } else {
        None
    }
}

pub(crate) fn wwe_ppv_route(path: &str, kickoff: i64) -> bool {
    static ROUTE: OnceLock<Regex> = OnceLock::new();
    let Some(date) = ROUTE
        .get_or_init(|| Regex::new(r"^wwe/(\d{4}-\d{2}-\d{2})$").unwrap())
        .captures(path)
        .map(|capture| capture[1].to_string())
    else {
        return false;
    };
    DateTime::<Utc>::from_timestamp_millis(kickoff)
        .is_some_and(|at| at.with_timezone(&Chicago).format("%Y-%m-%d").to_string() == date)
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
        for title in [
            "AEW Grand Slam: Collision",
            "Raw",
            "Impact",
            "The Impact of Wrestling",
            "WWE",
        ] {
            assert_eq!(league(title), None, "{title}");
        }
    }

    #[test]
    fn ppv_route_uses_chicago_broadcast_date() {
        assert!(wwe_ppv_route("wwe/2026-10-09", 1_791_590_400_000));
        assert!(!wwe_ppv_route("wwe/2026-10-10", 1_791_590_400_000));
        assert!(!wwe_ppv_route("wwe/2026-10-09/extra", 1_791_590_400_000));
        assert!(!wwe_ppv_route("wwe/2026-02-30", 1_791_590_400_000));
    }
}
