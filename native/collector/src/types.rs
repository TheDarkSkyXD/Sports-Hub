use serde::{Deserialize, Deserializer, Serialize, de::Error};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum League {
    Nfl,
    Ncaaf,
    Nba,
    Wnba,
    Nhl,
    Mlb,
    F1,
    NascarCup,
    NascarTruck,
    Motogp,
    Motorsport,
    Ufc,
    Boxing,
    Wwe,
    Tna,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    Catalog,
    Pending,
    BrowserCatalog,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserCategory {
    pub league: League,
    pub url: String,
    pub path_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub espn_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_titles: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListingSource {
    pub id: String,
    pub url: String,
    pub family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<SourceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_urls: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parser_version: Option<u32>,
    #[serde(default)]
    pub leagues: Vec<League>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_categories: Option<Vec<BrowserCategory>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undated_listing_evidence: Option<UndatedListingEvidence>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UndatedListingEvidence {
    PublishedListing,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KickoffLineage {
    pub observed_at: i64,
    pub raw_time: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub source_id: String,
    pub url: String,
    pub title: String,
    pub league: Option<League>,
    pub teams: Option<[String; 2]>,
    pub kickoff: Option<i64>,
    pub raw_time: String,
    pub observed_at: i64,
    #[serde(deserialize_with = "parse_parser_version")]
    pub parser_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kickoff_lineage: Option<KickoffLineage>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ListingOutcome {
    Parsed,
    Empty,
    Unsupported,
    ParserChanged,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingResult {
    pub observations: Vec<Observation>,
    pub outcome: ListingOutcome,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissingPlayerReason {
    NoCompatibleMedia,
    NotYetPublished,
    NoPublishedPlayer,
    UnsupportedPlayer,
    PaidOnly,
    ConflictingGame,
    ParserChanged,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all_fields = "camelCase")]
pub enum CandidateLocator {
    #[serde(rename = "swac")]
    Swac { event_id: String },
    #[serde(rename = "gooz")]
    Gooz { player_id: String },
    #[serde(rename = "streamcenter")]
    Streamcenter {
        event_id: String,
        link_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        league: Option<League>,
    },
    #[serde(rename = "event-page")]
    EventPage {
        game_id: String,
        event_url: String,
        server_url: String,
    },
    #[serde(rename = "catalog-stream")]
    CatalogStream {
        game_id: String,
        source: String,
        event_url: String,
        event_id: String,
        source_name: String,
        source_id: String,
        stream_no: u32,
        kickoff: i64,
        title: String,
        teams: Option<[String; 2]>,
    },
    #[serde(rename = "tvapp")]
    Tvapp {
        game_id: String,
        event_url: String,
        source: String,
        source_id: String,
        stream_no: u32,
        kickoff: i64,
        title: String,
        teams: [String; 2],
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ResolvedPlayer {
    pub id: String,
    pub label: String,
    pub locator: CandidateLocator,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchFailure {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReadOutcome {
    Complete(String),
    Partial { body: String, failure: FetchFailure },
    Failed(FetchFailure),
}

fn parse_parser_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u8::deserialize(deserializer)?;
    if matches!(value, 1..=3) {
        Ok(value)
    } else {
        Err(D::Error::custom("parserVersion must be 1, 2, or 3"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locators_use_the_existing_provider_and_field_names() {
        let locator = CandidateLocator::EventPage {
            game_id: "123".into(),
            event_url: "https://example.org/event".into(),
            server_url: "https://example.org/server".into(),
        };
        assert_eq!(
            serde_json::to_string(&locator).unwrap(),
            r#"{"provider":"event-page","gameId":"123","eventUrl":"https://example.org/event","serverUrl":"https://example.org/server"}"#
        );
    }

    #[test]
    fn observation_rejects_an_unknown_parser_version() {
        let json = r#"{"id":"a","sourceId":"a","url":"https://example.org","title":"A","league":null,"teams":null,"kickoff":null,"rawTime":"","observedAt":0,"parserVersion":4}"#;
        assert!(serde_json::from_str::<Observation>(json).is_err());
    }
}
