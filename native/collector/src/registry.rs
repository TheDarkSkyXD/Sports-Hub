use crate::{
    error::CollectorError,
    types::{League, ListingSource},
};
use std::collections::HashMap;

#[derive(Debug)]
pub struct SourceRegistry {
    sources: Vec<ListingSource>,
    by_id: HashMap<String, usize>,
}

impl SourceRegistry {
    pub fn parse(json: &str) -> Result<Self, CollectorError> {
        let sources: Vec<ListingSource> = serde_json::from_str(json)
            .map_err(|error| CollectorError::InvalidRegistry(error.to_string()))?;
        let mut by_id = HashMap::with_capacity(sources.len());
        for (index, source) in sources.iter().enumerate() {
            if source.id.is_empty() || source.family.is_empty() || source.leagues.is_empty() {
                return Err(CollectorError::InvalidRegistry(format!(
                    "incomplete source at index {index}"
                )));
            }
            if url::Url::parse(&source.url).is_err() {
                return Err(CollectorError::InvalidRegistry(format!(
                    "invalid source URL at index {index}"
                )));
            }
            if by_id.insert(source.id.clone(), index).is_some() {
                return Err(CollectorError::InvalidRegistry(format!(
                    "duplicate source ID: {}",
                    source.id
                )));
            }
        }
        Ok(Self { sources, by_id })
    }

    pub fn get(&self, id: &str) -> Option<&ListingSource> {
        self.by_id.get(id).map(|index| &self.sources[*index])
    }

    pub fn sources(&self) -> &[ListingSource] {
        &self.sources
    }

    pub fn browser_category(
        &self,
        source_id: &str,
        league: League,
    ) -> Option<&crate::types::BrowserCategory> {
        self.get(source_id)?
            .browser_categories
            .as_ref()?
            .iter()
            .find(|category| category.league == league)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_committed_source_registry() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        assert_eq!(registry.sources().len(), 47);
        assert_eq!(registry.get("sportsurge").unwrap().family, "sportsurge");
        assert!(
            registry
                .browser_category("sportsurge-v2", League::Nfl)
                .is_some()
        );
    }
}
