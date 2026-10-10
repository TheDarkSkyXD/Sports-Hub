use regex::Regex;
use std::sync::OnceLock;

pub(crate) fn is_ufc_card_title(title: &str) -> bool {
    let label = title.trim().to_ascii_lowercase();
    static TITLE: OnceLock<Regex> = OnceLock::new();
    TITLE
        .get_or_init(|| {
            Regex::new(r"^(?:ufc(?:\s+fight\s+night|\s+on\s+espn|\s+on\s+abc|\s+\d+)|dana white's contender series)\b")
                .expect("fixed UFC title expression")
        })
        .is_match(&label)
}

pub(crate) fn is_boxing_card_title(title: &str) -> bool {
    let label = title.trim().to_ascii_lowercase();
    static TITLE: OnceLock<Regex> = OnceLock::new();
    TITLE
        .get_or_init(|| Regex::new(r"^(?:bkfc|boxing)\b").expect("fixed boxing title expression"))
        .is_match(&label)
}
