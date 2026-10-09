use chrono::{LocalResult, NaiveDate, TimeZone};
use chrono_tz::America::New_York;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

fn utc_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})\b")
            .expect("fixed UTC expression")
    })
}

fn eastern_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(\d{4})-(\d{2})-(\d{2})(?:,\s*[a-z]+)?(?:\s*-\s*|[ T])(\d{1,2}):(\d{2})\s*(AM|PM)?\s*ET\b")
            .expect("fixed Eastern expression")
    })
}

pub fn parse_kickoff(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if matches!(trimmed.len(), 10 | 13) && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        let epoch: i64 = trimmed.parse().ok()?;
        let millis = if trimmed.len() == 10 {
            epoch.checked_mul(1000)?
        } else {
            epoch
        };
        return (946_684_800_000..4_102_444_800_000)
            .contains(&millis)
            .then_some(millis);
    }

    if let Some(found) = utc_pattern().captures(raw) {
        let full = found.get(0)?.as_str();
        let normalized;
        let input = if found.get(2).is_some() {
            full
        } else {
            normalized = format!("{}:00{}", &found[1], &found[3]);
            &normalized
        };
        return chrono::DateTime::parse_from_rfc3339(input)
            .ok()
            .map(|date| date.timestamp_millis());
    }

    let parts = eastern_pattern().captures(raw)?;
    let year: i32 = parts[1].parse().ok()?;
    let month: u32 = parts[2].parse().ok()?;
    let day: u32 = parts[3].parse().ok()?;
    let mut hour: u32 = parts[4].parse().ok()?;
    let minute: u32 = parts[5].parse().ok()?;
    if let Some(period) = parts.get(6) {
        hour = hour % 12
            + if period.as_str().eq_ignore_ascii_case("PM") {
                12
            } else {
                0
            };
    }
    let local = NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, 0)?;
    match New_York.from_local_datetime(&local) {
        LocalResult::Single(date) => Some(date.timestamp_millis()),
        LocalResult::Ambiguous(_, _) | LocalResult::None => None,
    }
}

pub fn digest(value: &str) -> String {
    let hash = Sha256::digest(value.as_bytes());
    hex::encode(&hash[..12])
}

pub fn player_id(provider: &str, identity_json: &str) -> String {
    format!("{provider}:{}", digest(identity_json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kickoff_matches_the_existing_collector_examples() {
        let expected = 1_790_438_400_000;
        assert_eq!(parse_kickoff("2026-09-26T16:00:00Z"), Some(expected));
        assert_eq!(parse_kickoff("2026-09-26T16:00:00.000Z"), Some(expected));
        assert_eq!(parse_kickoff("1790438400"), Some(expected));
        assert_eq!(parse_kickoff("1790438400000"), Some(expected));
        assert_eq!(parse_kickoff("2026-09-26T16:00"), None);
        assert_eq!(
            parse_kickoff("2026-09-25, Friday - 04:00 pm ET"),
            Some(1_790_366_400_000)
        );
        assert_eq!(
            parse_kickoff("2026-01-10 04:00 pm ET"),
            Some(1_768_078_800_000)
        );
        assert_eq!(parse_kickoff("2026-11-01 01:30 ET"), None);
        assert_eq!(parse_kickoff("2026-03-08 02:30 ET"), None);
    }

    #[test]
    fn digest_is_the_first_twelve_sha256_bytes() {
        assert_eq!(digest("abc"), "ba7816bf8f01cfea414140de");
        assert_eq!(
            player_id("event-page", "[\"g\",\"u\"]"),
            "event-page:0f2263384ee01986930042e4"
        );
    }
}
