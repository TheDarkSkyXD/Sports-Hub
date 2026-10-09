use crate::{
    browser::{
        BrowserFailure, BrowserKind, CatalogIssue, CatalogState, CategoryState, RejectedGame,
        ServerPlayer, SportsurgeDetail, SportsurgeEvent, StreameastDetail, StreameastEvent,
        sportsurge_category, sportsurge_detail, streameast_active_free_server_url,
        streameast_category, streameast_detail, streameast_free_server_urls,
        streameast_server_player,
    },
    registry::SourceRegistry,
    types::League,
};
use serde::{
    Deserialize, Serialize,
    ser::{SerializeMap, Serializer},
};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub struct OrderedCategories(pub Vec<(League, CategoryState)>);

impl OrderedCategories {
    fn set(&mut self, league: League, state: CategoryState) {
        if let Some((_, slot)) = self.0.iter_mut().find(|(item, _)| *item == league) {
            *slot = state;
        }
    }

    fn first_failure(&self) -> Option<BrowserFailure> {
        self.0.iter().find_map(|(_, state)| match state {
            CategoryState::Failed { reason, .. } => Some(*reason),
            _ => None,
        })
    }

    fn all_collected(&self) -> bool {
        self.0
            .iter()
            .all(|(_, state)| matches!(state, CategoryState::Collected { .. }))
    }
}

impl Serialize for OrderedCategories {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (league, category) in &self.0 {
            let key = serde_json::to_string(league).map_err(serde::ser::Error::custom)?;
            map.serialize_entry(key.trim_matches('"'), category)?;
        }
        map.end()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SportsurgeCatalog {
    pub run_id: String,
    pub sequence: u64,
    pub started_at: i64,
    pub state: CatalogState,
    pub categories: OrderedCategories,
    pub events: Vec<SportsurgeEvent>,
    pub rejected_games: Vec<RejectedGame>,
    pub catalog_issues: Vec<CatalogIssue>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreameastCatalog {
    pub run_id: String,
    pub sequence: u64,
    pub started_at: i64,
    pub state: CatalogState,
    pub categories: OrderedCategories,
    pub events: Vec<StreameastEvent>,
    pub rejected_games: Vec<RejectedGame>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BrowserCatalog {
    Sportsurge(SportsurgeCatalog),
    Streameast(StreameastCatalog),
}

impl BrowserCatalog {
    fn sequence(&self) -> u64 {
        match self {
            Self::Sportsurge(value) => value.sequence,
            Self::Streameast(value) => value.sequence,
        }
    }

    fn increment_sequence(&mut self) {
        match self {
            Self::Sportsurge(value) => value.sequence += 1,
            Self::Streameast(value) => value.sequence += 1,
        }
    }

    fn set_sequence(&mut self, sequence: u64) {
        match self {
            Self::Sportsurge(value) => value.sequence = sequence,
            Self::Streameast(value) => value.sequence = sequence,
        }
    }

    fn state(&self) -> &CatalogState {
        match self {
            Self::Sportsurge(value) => &value.state,
            Self::Streameast(value) => &value.state,
        }
    }

    fn set_state(&mut self, state: CatalogState) {
        match self {
            Self::Sportsurge(value) => value.state = state,
            Self::Streameast(value) => value.state = state,
        }
    }

    fn categories(&self) -> &OrderedCategories {
        match self {
            Self::Sportsurge(value) => &value.categories,
            Self::Streameast(value) => &value.categories,
        }
    }

    fn categories_mut(&mut self) -> &mut OrderedCategories {
        match self {
            Self::Sportsurge(value) => &mut value.categories,
            Self::Streameast(value) => &mut value.categories,
        }
    }

    fn event_urls(&self) -> Vec<String> {
        match self {
            Self::Sportsurge(value) => value.events.iter().map(|event| event.url.clone()).collect(),
            Self::Streameast(value) => value.events.iter().map(|event| event.url.clone()).collect(),
        }
    }

    fn event_is_pending(&self, url: &str) -> bool {
        match self {
            Self::Sportsurge(value) => value
                .events
                .iter()
                .any(|event| event.url == url && matches!(event.detail, SportsurgeDetail::Pending)),
            Self::Streameast(value) => value
                .events
                .iter()
                .any(|event| event.url == url && matches!(event.detail, StreameastDetail::Pending)),
        }
    }

    fn event_league(&self, url: &str) -> Option<League> {
        match self {
            Self::Sportsurge(value) => value
                .events
                .iter()
                .find(|event| event.url == url)
                .map(|event| event.league),
            Self::Streameast(value) => value
                .events
                .iter()
                .find(|event| event.url == url)
                .map(|event| event.league),
        }
    }

    fn event_kickoff(&self, url: &str) -> Option<i64> {
        match self {
            Self::Sportsurge(value) => value
                .events
                .iter()
                .find(|event| event.url == url)
                .and_then(|event| event.kickoff),
            Self::Streameast(value) => value
                .events
                .iter()
                .find(|event| event.url == url)
                .and_then(|event| event.kickoff),
        }
    }

    fn event_failure(&self) -> Option<BrowserFailure> {
        match self {
            Self::Sportsurge(value) => value.events.iter().find_map(|event| match event.detail {
                SportsurgeDetail::Failed { reason, .. } => Some(reason),
                _ => None,
            }),
            Self::Streameast(value) => value.events.iter().find_map(|event| match event.detail {
                StreameastDetail::Failed { reason, .. } => Some(reason),
                _ => None,
            }),
        }
    }

    fn all_events_collected(&self) -> bool {
        match self {
            Self::Sportsurge(value) => value
                .events
                .iter()
                .all(|event| matches!(event.detail, SportsurgeDetail::Collected { .. })),
            Self::Streameast(value) => value
                .events
                .iter()
                .all(|event| matches!(event.detail, StreameastDetail::Collected { .. })),
        }
    }

    fn rejected_empty(&self) -> bool {
        match self {
            Self::Sportsurge(value) => value.rejected_games.is_empty(),
            Self::Streameast(value) => value.rejected_games.is_empty(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind")]
pub enum ReuseDetails {
    #[serde(rename = "sportsurge-v2")]
    Sportsurge { events: Vec<SportsurgeEvent> },
    #[serde(rename = "streameast")]
    Streameast { events: Vec<StreameastEvent> },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAck {
    pub kind: String,
    pub skip_detail_event_ids: Vec<String>,
    #[serde(default)]
    pub skip_detail_event_urls: Vec<String>,
    #[serde(default)]
    pub reuse_details: Option<ReuseDetails>,
    #[serde(default)]
    pub source_refresh_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserRole {
    Category,
    Detail,
    Server,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SweepAction {
    Read {
        id: u64,
        url: String,
        role: BrowserRole,
        league: League,
    },
    Publish {
        id: u64,
        catalog: BrowserCatalog,
    },
    Done {
        catalog: BrowserCatalog,
        #[serde(rename = "sourceRefreshMs")]
        source_refresh_ms: u64,
    },
    Failed {
        reason: BrowserFailure,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SweepResult {
    ReadOk { id: u64, body: String },
    ReadFailed { id: u64, reason: BrowserFailure },
    PublishOk { id: u64, ack: Option<CatalogAck> },
    PublishFailed { id: u64, reason: BrowserFailure },
}

#[derive(Clone, Debug)]
enum ReadResult {
    Ok(String),
    Failed(BrowserFailure),
}

#[derive(Clone, Debug)]
enum ReadContext {
    Category(usize),
    Detail(String),
    Server(String, String),
}

#[derive(Clone, Debug)]
enum AfterPublish {
    Initial,
    Category(usize),
    DetailPreparse(String, ReadResult),
    ServerPreparse(String, String, ReadResult),
    DetailFinal,
    Final,
    RateLimit,
    Fallback(BrowserFailure),
}

#[derive(Clone, Debug)]
enum Phase {
    AwaitRead { id: u64, context: ReadContext },
    AwaitPublish { id: u64, next: AfterPublish },
    Done,
}

struct CurrentDetail {
    event_url: String,
    html: String,
    server_urls: Vec<String>,
    free_pages: HashMap<String, ServerPlayer>,
    unresolved_read: bool,
}

pub struct BrowserSweep {
    kind: BrowserKind,
    catalog: BrowserCatalog,
    accepted: BrowserCatalog,
    category_urls: Vec<(League, String)>,
    category_pages: HashMap<String, ReadResult>,
    pending: Vec<String>,
    admitted: usize,
    current_detail: Option<CurrentDetail>,
    unresolved_read: bool,
    source_refresh_ms: u64,
    next_action_id: u64,
    phase: Phase,
}

impl BrowserSweep {
    pub fn begin(
        registry: &SourceRegistry,
        kind: BrowserKind,
        run_id: String,
        now: i64,
    ) -> Result<(Self, SweepAction), String> {
        let source = registry
            .get(kind.source_id())
            .ok_or("missing browser source")?;
        let categories = source
            .browser_categories
            .as_ref()
            .ok_or("missing browser categories")?;
        if categories.is_empty() {
            return Err("empty browser categories".into());
        }
        let category_urls: Vec<_> = categories
            .iter()
            .map(|category| (category.league, category.url.clone()))
            .collect();
        let categories = OrderedCategories(
            categories
                .iter()
                .map(|category| (category.league, CategoryState::Pending))
                .collect(),
        );
        let catalog = match kind {
            BrowserKind::Sportsurge => BrowserCatalog::Sportsurge(SportsurgeCatalog {
                run_id,
                sequence: 0,
                started_at: now,
                state: CatalogState::Collecting,
                categories,
                events: Vec::new(),
                rejected_games: Vec::new(),
                catalog_issues: Vec::new(),
            }),
            BrowserKind::Streameast => BrowserCatalog::Streameast(StreameastCatalog {
                run_id,
                sequence: 0,
                started_at: now,
                state: CatalogState::Collecting,
                categories,
                events: Vec::new(),
                rejected_games: Vec::new(),
            }),
        };
        let mut sweep = Self {
            kind,
            accepted: catalog.clone(),
            catalog,
            category_urls,
            category_pages: HashMap::new(),
            pending: Vec::new(),
            admitted: 0,
            current_detail: None,
            unresolved_read: false,
            source_refresh_ms: 300_000,
            next_action_id: 1,
            phase: Phase::Done,
        };
        let action = sweep.publish(AfterPublish::Initial);
        Ok((sweep, action))
    }

    fn read(
        &mut self,
        url: String,
        role: BrowserRole,
        league: League,
        context: ReadContext,
    ) -> SweepAction {
        let id = self.next_action_id;
        self.next_action_id += 1;
        self.phase = Phase::AwaitRead { id, context };
        SweepAction::Read {
            id,
            url,
            role,
            league,
        }
    }

    fn publish(&mut self, next: AfterPublish) -> SweepAction {
        let id = self.next_action_id;
        self.next_action_id += 1;
        self.phase = Phase::AwaitPublish { id, next };
        SweepAction::Publish {
            id,
            catalog: self.catalog.clone(),
        }
    }

    fn done(&mut self) -> SweepAction {
        self.phase = Phase::Done;
        SweepAction::Done {
            catalog: self.catalog.clone(),
            source_refresh_ms: self.source_refresh_ms,
        }
    }

    fn failed(&mut self, reason: BrowserFailure) -> SweepAction {
        self.phase = Phase::Done;
        SweepAction::Failed { reason }
    }

    pub fn advance(
        &mut self,
        registry: &SourceRegistry,
        result: SweepResult,
        now: i64,
    ) -> Result<SweepAction, String> {
        let phase = std::mem::replace(&mut self.phase, Phase::Done);
        match (phase, result) {
            (Phase::AwaitRead { id, context }, SweepResult::ReadOk { id: received, body })
                if id == received =>
            {
                if body.len() > self.kind.page_cap() {
                    return Ok(self.after_read(
                        registry,
                        context,
                        ReadResult::Failed(BrowserFailure::Limit),
                        now,
                    ));
                }
                Ok(self.after_read(registry, context, ReadResult::Ok(body), now))
            }
            (
                Phase::AwaitRead { id, context },
                SweepResult::ReadFailed {
                    id: received,
                    reason,
                },
            ) if id == received => {
                Ok(self.after_read(registry, context, ReadResult::Failed(reason), now))
            }
            (Phase::AwaitPublish { id, next }, SweepResult::PublishOk { id: received, ack })
                if id == received =>
            {
                self.accepted = self.catalog.clone();
                self.apply_ack(ack)?;
                self.catalog.increment_sequence();
                Ok(self.after_publish(registry, next, now))
            }
            (
                Phase::AwaitPublish { id, next },
                SweepResult::PublishFailed {
                    id: received,
                    reason,
                },
            ) if id == received => {
                if matches!(next, AfterPublish::Fallback(_)) {
                    return Ok(self.failed(reason));
                }
                if reason == BrowserFailure::Limit
                    && self.accepted.sequence() < self.catalog.sequence()
                {
                    let mut fallback = self.accepted.clone();
                    fallback.set_sequence(self.catalog.sequence());
                    fallback.set_state(CatalogState::Partial {
                        at: now,
                        reason: BrowserFailure::Limit,
                    });
                    self.catalog = fallback;
                    return Ok(self.publish(AfterPublish::Fallback(reason)));
                }
                Ok(self.failed(reason))
            }
            (phase, _) => {
                self.phase = phase;
                Err("unexpected sweep effect or action id".into())
            }
        }
    }

    fn after_read(
        &mut self,
        registry: &SourceRegistry,
        context: ReadContext,
        read: ReadResult,
        now: i64,
    ) -> SweepAction {
        match context {
            ReadContext::Category(index) => self.category_read(registry, index, read, now),
            ReadContext::Detail(url) => self.publish(AfterPublish::DetailPreparse(url, read)),
            ReadContext::Server(event_url, server_url) => {
                self.publish(AfterPublish::ServerPreparse(event_url, server_url, read))
            }
        }
    }

    fn category_read(
        &mut self,
        registry: &SourceRegistry,
        index: usize,
        read: ReadResult,
        now: i64,
    ) -> SweepAction {
        let (league, url) = self.category_urls[index].clone();
        if self.kind == BrowserKind::Sportsurge {
            self.category_pages.insert(url, read.clone());
        }
        let failure = match read {
            ReadResult::Ok(body) => match &mut self.catalog {
                BrowserCatalog::Sportsurge(catalog) => {
                    let parsed = sportsurge_category(&body, league, registry);
                    catalog.events.extend(parsed.events);
                    catalog.rejected_games.extend(parsed.rejected_games);
                    catalog.catalog_issues.extend(parsed.catalog_issues);
                    parsed.failure
                }
                BrowserCatalog::Streameast(catalog) => {
                    let parsed = streameast_category(&body, league, registry);
                    catalog.events.extend(parsed.events);
                    catalog.rejected_games.extend(parsed.rejected_games);
                    parsed.failure
                }
            },
            ReadResult::Failed(reason) => Some(reason),
        };
        self.catalog.categories_mut().set(
            league,
            match failure {
                Some(reason) => CategoryState::Failed { at: now, reason },
                None => CategoryState::Collected { at: now },
            },
        );
        if failure == Some(BrowserFailure::RateLimited) {
            self.catalog.set_state(CatalogState::Partial {
                at: now,
                reason: BrowserFailure::RateLimited,
            });
            self.publish(AfterPublish::RateLimit)
        } else {
            self.publish(AfterPublish::Category(index + 1))
        }
    }

    fn after_publish(
        &mut self,
        registry: &SourceRegistry,
        next: AfterPublish,
        now: i64,
    ) -> SweepAction {
        match next {
            AfterPublish::Initial => self.next_category(registry, 0, now),
            AfterPublish::Category(index) => self.next_category(registry, index, now),
            AfterPublish::DetailPreparse(url, read) => self.detail_read_settled(&url, read, now),
            AfterPublish::ServerPreparse(event_url, server_url, read) => {
                self.server_read_settled(&event_url, &server_url, read, now)
            }
            AfterPublish::DetailFinal => self.next_detail_or_finish(now),
            AfterPublish::Final | AfterPublish::RateLimit => self.done(),
            AfterPublish::Fallback(reason) => self.failed(reason),
        }
    }

    fn next_category(&mut self, registry: &SourceRegistry, index: usize, now: i64) -> SweepAction {
        if let Some((league, url)) = self.category_urls.get(index).cloned() {
            if self.kind == BrowserKind::Sportsurge
                && let Some(read) = self.category_pages.get(&url).cloned()
            {
                return self.category_read(registry, index, read, now);
            }
            self.read(
                url,
                BrowserRole::Category,
                league,
                ReadContext::Category(index),
            )
        } else {
            self.build_pending(now);
            self.next_detail_or_finish(now)
        }
    }

    fn urgency(&self, url: &str, now: i64) -> u8 {
        let kickoff = self.catalog.event_kickoff(url);
        match self.kind {
            BrowserKind::Sportsurge => {
                let live = match &self.catalog {
                    BrowserCatalog::Sportsurge(catalog) => catalog
                        .events
                        .iter()
                        .find(|event| event.url == url)
                        .is_some_and(|event| {
                            event.source_status == crate::browser::SourceStatus::Live
                        }),
                    _ => false,
                };
                if live {
                    0
                } else if kickoff.is_some_and(|time| time >= now && time <= now + 60 * 60_000) {
                    1
                } else {
                    2
                }
            }
            BrowserKind::Streameast => {
                if kickoff.is_some_and(|time| time >= now - 6 * 3_600_000 && time <= now) {
                    0
                } else if kickoff.is_some_and(|time| time > now && time <= now + 60 * 60_000) {
                    1
                } else {
                    2
                }
            }
        }
    }

    fn build_pending(&mut self, now: i64) {
        self.pending = self
            .catalog
            .event_urls()
            .into_iter()
            .filter(|url| self.catalog.event_is_pending(url))
            .collect();
        let catalog = &self.catalog;
        let kind = self.kind;
        self.pending.sort_by_key(|url| {
            let urgency = match kind {
                BrowserKind::Sportsurge => {
                    let live = match catalog {
                        BrowserCatalog::Sportsurge(value) => value
                            .events
                            .iter()
                            .find(|event| event.url == *url)
                            .is_some_and(|event| {
                                event.source_status == crate::browser::SourceStatus::Live
                            }),
                        _ => false,
                    };
                    let kickoff = catalog.event_kickoff(url);
                    if live {
                        0
                    } else if kickoff.is_some_and(|time| time >= now && time <= now + 60 * 60_000) {
                        1
                    } else {
                        2
                    }
                }
                BrowserKind::Streameast => {
                    let kickoff = catalog.event_kickoff(url);
                    if kickoff.is_some_and(|time| time >= now - 6 * 3_600_000 && time <= now) {
                        0
                    } else if kickoff.is_some_and(|time| time > now && time <= now + 60 * 60_000) {
                        1
                    } else {
                        2
                    }
                }
            };
            (urgency, catalog.event_kickoff(url).unwrap_or(i64::MAX))
        });
    }

    fn next_detail_or_finish(&mut self, now: i64) -> SweepAction {
        while !self.pending.is_empty() {
            let background = if self.admitted % 4 == 3 {
                self.pending
                    .iter()
                    .position(|url| self.urgency(url, now) == 2)
            } else {
                None
            };
            let url = self.pending.remove(background.unwrap_or(0));
            self.admitted += 1;
            if !self.catalog.event_is_pending(&url) {
                continue;
            }
            let league = self
                .catalog
                .event_league(&url)
                .expect("pending event has league");
            return self.read(
                url.clone(),
                BrowserRole::Detail,
                league,
                ReadContext::Detail(url),
            );
        }
        let complete = self.catalog.categories().all_collected()
            && self.catalog.all_events_collected()
            && self.catalog.rejected_empty()
            && !self.unresolved_read;
        self.catalog.set_state(if complete {
            CatalogState::Complete { at: now }
        } else {
            CatalogState::Partial {
                at: now,
                reason: self
                    .catalog
                    .categories()
                    .first_failure()
                    .or_else(|| self.catalog.event_failure())
                    .unwrap_or(if self.unresolved_read {
                        BrowserFailure::Unavailable
                    } else {
                        BrowserFailure::ParserChanged
                    }),
            }
        });
        self.publish(AfterPublish::Final)
    }

    fn fail_event(&mut self, url: &str, reason: BrowserFailure, now: i64) {
        match &mut self.catalog {
            BrowserCatalog::Sportsurge(catalog) => {
                if let Some(event) = catalog.events.iter_mut().find(|event| event.url == url) {
                    event.detail = SportsurgeDetail::Failed { at: now, reason };
                }
            }
            BrowserCatalog::Streameast(catalog) => {
                if let Some(event) = catalog.events.iter_mut().find(|event| event.url == url) {
                    event.detail = StreameastDetail::Failed { at: now, reason };
                }
            }
        }
    }

    fn rate_limited(&mut self, now: i64) -> SweepAction {
        self.catalog.set_state(CatalogState::Partial {
            at: now,
            reason: BrowserFailure::RateLimited,
        });
        self.publish(AfterPublish::RateLimit)
    }

    fn detail_read_settled(&mut self, url: &str, read: ReadResult, now: i64) -> SweepAction {
        if !self.catalog.event_is_pending(url) {
            return self.next_detail_or_finish(now);
        }
        match read {
            ReadResult::Failed(reason) => {
                self.fail_event(url, reason, now);
                if reason == BrowserFailure::RateLimited {
                    self.rate_limited(now)
                } else {
                    self.publish(AfterPublish::DetailFinal)
                }
            }
            ReadResult::Ok(html) => match &mut self.catalog {
                BrowserCatalog::Sportsurge(catalog) => {
                    if let Some(event) = catalog.events.iter_mut().find(|event| event.url == url) {
                        event.detail = sportsurge_detail(&html, event, now);
                    }
                    self.publish(AfterPublish::DetailFinal)
                }
                BrowserCatalog::Streameast(catalog) => {
                    let event = catalog
                        .events
                        .iter()
                        .find(|event| event.url == url)
                        .expect("pending event exists");
                    let server_urls = streameast_free_server_urls(&html, event);
                    let mut free_pages = HashMap::new();
                    if let Some(active) = streameast_active_free_server_url(&html, event) {
                        free_pages.insert(
                            active.clone(),
                            streameast_server_player(&html, event, &active),
                        );
                    }
                    self.current_detail = Some(CurrentDetail {
                        event_url: url.to_owned(),
                        html,
                        server_urls,
                        free_pages,
                        unresolved_read: false,
                    });
                    self.next_server_or_finalize(now)
                }
            },
        }
    }

    fn next_server_or_finalize(&mut self, now: i64) -> SweepAction {
        let Some(current) = self.current_detail.as_mut() else {
            return self.next_detail_or_finish(now);
        };
        if !self.catalog.event_is_pending(&current.event_url) {
            self.current_detail = None;
            return self.next_detail_or_finish(now);
        }
        while !current.server_urls.is_empty() {
            let server_url = current.server_urls.remove(0);
            if current.free_pages.contains_key(&server_url) {
                continue;
            }
            let event_url = current.event_url.clone();
            let league = self
                .catalog
                .event_league(&event_url)
                .expect("pending event has league");
            return self.read(
                server_url.clone(),
                BrowserRole::Server,
                league,
                ReadContext::Server(event_url, server_url),
            );
        }
        let current = self.current_detail.take().unwrap();
        self.unresolved_read |= current.unresolved_read;
        if let BrowserCatalog::Streameast(catalog) = &mut self.catalog
            && let Some(event) = catalog
                .events
                .iter_mut()
                .find(|event| event.url == current.event_url)
        {
            event.detail = streameast_detail(&current.html, event, now, &current.free_pages);
        }
        self.publish(AfterPublish::DetailFinal)
    }

    fn server_read_settled(
        &mut self,
        event_url: &str,
        server_url: &str,
        read: ReadResult,
        now: i64,
    ) -> SweepAction {
        if !self.catalog.event_is_pending(event_url) {
            self.current_detail = None;
            return self.next_detail_or_finish(now);
        }
        match read {
            ReadResult::Failed(BrowserFailure::RateLimited) => {
                self.fail_event(event_url, BrowserFailure::RateLimited, now);
                self.current_detail = None;
                self.rate_limited(now)
            }
            ReadResult::Failed(_) => {
                if let Some(current) = self.current_detail.as_mut() {
                    current
                        .free_pages
                        .insert(server_url.to_owned(), ServerPlayer::Unknown);
                    current.unresolved_read = true;
                }
                self.next_server_or_finalize(now)
            }
            ReadResult::Ok(page) => {
                if let BrowserCatalog::Streameast(catalog) = &self.catalog
                    && let Some(event) = catalog.events.iter().find(|event| event.url == event_url)
                {
                    let player = streameast_server_player(&page, event, server_url);
                    if let Some(current) = self.current_detail.as_mut() {
                        current.free_pages.insert(server_url.to_owned(), player);
                    }
                }
                self.next_server_or_finalize(now)
            }
        }
    }

    fn apply_ack(&mut self, ack: Option<CatalogAck>) -> Result<(), String> {
        let Some(ack) = ack else {
            return Ok(());
        };
        if ack.kind != "catalog-ack" {
            return Err("invalid catalog acknowledgement kind".into());
        }
        if let Some(refresh) = ack.source_refresh_ms {
            if ![60_000, 300_000, 600_000, 900_000].contains(&refresh) {
                return Err("invalid catalog refresh interval".into());
            }
            self.source_refresh_ms = refresh;
        }
        if !matches!(self.catalog.state(), CatalogState::Collecting) {
            return Ok(());
        }
        let skip_ids: HashSet<_> = ack.skip_detail_event_ids.into_iter().collect();
        let skip_urls: HashSet<_> = ack.skip_detail_event_urls.into_iter().collect();
        if !skip_urls
            .iter()
            .all(|url| self.catalog.event_urls().contains(url))
        {
            return Err("catalog acknowledgement contains unknown URL".into());
        }
        match &mut self.catalog {
            BrowserCatalog::Sportsurge(catalog) => {
                catalog.events.retain(|event| {
                    !skip_ids.contains(&event.id) && !skip_urls.contains(&event.url)
                });
                if let Some(reuse) = ack.reuse_details {
                    let ReuseDetails::Sportsurge { events } = reuse else {
                        return Err("retained detail source mismatch".into());
                    };
                    if serde_json::to_vec(&events)
                        .map_err(|error| error.to_string())?
                        .len()
                        > 512 * 1024
                    {
                        return Err("retained details exceed limit".into());
                    }
                    for event in &mut catalog.events {
                        if !matches!(event.detail, SportsurgeDetail::Pending) {
                            continue;
                        }
                        if let Some(row) = events.iter().find(|row| sportsurge_identity(event, row))
                            && matches!(
                                row.detail,
                                SportsurgeDetail::Collected {
                                    retained_from_run_id: Some(_),
                                    ..
                                }
                            )
                        {
                            event.detail = row.detail.clone();
                        }
                    }
                }
            }
            BrowserCatalog::Streameast(catalog) => {
                catalog.events.retain(|event| {
                    !skip_ids.contains(&event.id) && !skip_urls.contains(&event.url)
                });
                if let Some(reuse) = ack.reuse_details {
                    let ReuseDetails::Streameast { events } = reuse else {
                        return Err("retained detail source mismatch".into());
                    };
                    if serde_json::to_vec(&events)
                        .map_err(|error| error.to_string())?
                        .len()
                        > 512 * 1024
                    {
                        return Err("retained details exceed limit".into());
                    }
                    for event in &mut catalog.events {
                        if !matches!(event.detail, StreameastDetail::Pending) {
                            continue;
                        }
                        if let Some(row) = events.iter().find(|row| streameast_identity(event, row))
                            && matches!(
                                row.detail,
                                StreameastDetail::Collected {
                                    retained_from_run_id: Some(_),
                                    ..
                                }
                            )
                        {
                            event.detail = row.detail.clone();
                        }
                    }
                }
            }
        }
        self.pending
            .retain(|url| self.catalog.event_is_pending(url));
        Ok(())
    }
}

fn sportsurge_identity(left: &SportsurgeEvent, right: &SportsurgeEvent) -> bool {
    left.id == right.id
        && left.url == right.url
        && left.league == right.league
        && left.title == right.title
        && left.teams == right.teams
        && left.source_status == right.source_status
        && left.kickoff == right.kickoff
        && left.advertised_link_count == right.advertised_link_count
}

fn streameast_identity(left: &StreameastEvent, right: &StreameastEvent) -> bool {
    left.id == right.id
        && left.url == right.url
        && left.league == right.league
        && left.title == right.title
        && left.teams == right.teams
        && left.kickoff == right.kickoff
        && left.espn_event_id == right.espn_event_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn checkpoint(catalog: &BrowserCatalog) -> Value {
        let value = serde_json::to_value(catalog).unwrap();
        let events = value["events"].as_array().unwrap();
        let mut result = json!({"sequence": value["sequence"], "state": value["state"], "categories": value["categories"],
            "eventIds": events.iter().map(|event| event["id"].clone()).collect::<Vec<_>>(),
            "detailKinds": events.iter().map(|event| event["detail"]["kind"].clone()).collect::<Vec<_>>(),
            "rejectedGames": value["rejectedGames"].as_array().unwrap().len()});
        if catalog_is_sportsurge(catalog) {
            result["catalogIssues"] = json!(value["catalogIssues"].as_array().unwrap().len());
        }
        result
    }

    fn catalog_is_sportsurge(catalog: &BrowserCatalog) -> bool {
        matches!(catalog, BrowserCatalog::Sportsurge(_))
    }

    fn run_fixture(kind: BrowserKind, partial: bool, at: i64, registry: &SourceRegistry) -> Value {
        let run_id = "11111111-1111-4111-8111-111111111111".to_owned();
        let (mut sweep, mut action) = BrowserSweep::begin(registry, kind, run_id, at).unwrap();
        let mut checkpoints = Vec::new();
        let east_url =
            "https://v2.streameast.ga/cfb/montana-state-bobcats-vs-idaho-vandals-1790994600/";
        let surge_positive = "<main id=\"match-list-container\"><a class=\"match-row\" href=\"watch-123-cfb-away-home/\"><span class=\"match-row-team-name\">Away</span><span class=\"match-row-team-name\">Home</span></a></main>";
        let surge_empty = "<main id=\"match-list-container\"><div class=\"watch-empty-state\">There are no live or upcoming games here right now.</div></main>";
        let east_category = format!(
            "<article class=\"m-card\" data-match-id=\"12345\" data-team-names=\"Montana State Bobcats|Idaho Vandals\" data-time=\"1790994600\"><a class=\"m-card__link\" aria-label=\"Montana State Bobcats vs Idaho Vandals\" href=\"{east_url}\"></a></article>"
        );
        let east_detail = format!(
            "<div class=\"stream-alt-list\"><a class=\"stream-alt-item\" href=\"{east_url}1\"><span class=\"stream-alt-name\">Free 1</span><span class=\"stream-alt-free-badge\">Free</span></a><a class=\"stream-alt-item stream-alt-item-pro\" href=\"{east_url}2\"><span class=\"stream-alt-name\">Paid</span><span class=\"stream-alt-pro-icon\"></span></a></div>"
        );
        loop {
            let result = match action {
                SweepAction::Read {
                    id, role, league, ..
                } => {
                    if partial && role == BrowserRole::Category && league == League::Nfl {
                        SweepResult::ReadFailed {
                            id,
                            reason: BrowserFailure::Timeout,
                        }
                    } else {
                        let body = match kind {
                            BrowserKind::Sportsurge => match role {
                                BrowserRole::Category if league == League::Ncaaf => surge_positive.to_owned(),
                                BrowserRole::Category => surge_empty.to_owned(),
                                BrowserRole::Detail => "<div class=\"stream-list\"><div class=\"stream-item\" data-href=\"https://example.com/watch\"><span class=\"stream-row-site-name\">Example</span></div></div>".to_owned(),
                                BrowserRole::Server => panic!("Sportsurge does not read server pages"),
                            },
                            BrowserKind::Streameast => match role {
                                BrowserRole::Category if league == League::Ncaaf => east_category.clone(),
                                BrowserRole::Category => {
                                    let league = serde_json::to_string(&league).unwrap().trim_matches('"').to_uppercase();
                                    format!("<div id=\"m-schedule-empty\" class=\"m-empty\"><h2 class=\"m-empty__title\">No {} available</h2></div>", if league == "F1" { "F1 races".to_owned() } else { format!("{league} games") })
                                }
                                BrowserRole::Detail => east_detail.clone(),
                                BrowserRole::Server => "<iframe src=\"https://streame.center/stream-east/ch33.php\"></iframe>".to_owned(),
                            },
                        };
                        SweepResult::ReadOk { id, body }
                    }
                }
                SweepAction::Publish { id, catalog } => {
                    checkpoints.push(checkpoint(&catalog));
                    SweepResult::PublishOk { id, ack: None }
                }
                SweepAction::Done { catalog, .. } => {
                    return json!({"final": catalog, "checkpoints": checkpoints});
                }
                SweepAction::Failed { reason } => panic!("unexpected failure: {reason:?}"),
            };
            action = sweep.advance(registry, result, at).unwrap();
        }
    }

    #[test]
    fn four_frozen_sweep_traces_match() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/collector-parity.json"
        ))
        .unwrap();
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let at = corpus["at"].as_i64().unwrap();
        for (name, kind, partial) in [
            ("sportsurge", BrowserKind::Sportsurge, false),
            ("sportsurge-partial", BrowserKind::Sportsurge, true),
            ("streameast", BrowserKind::Streameast, false),
            ("streameast-partial", BrowserKind::Streameast, true),
        ] {
            assert_eq!(
                run_fixture(kind, partial, at, &registry),
                corpus["expected"]["sweeps"][name],
                "{name}"
            );
        }
    }

    #[test]
    fn limit_replays_the_accepted_pre_ack_payload_at_the_failed_sequence() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let at = 1_791_493_800_000;
        let (mut sweep, action) = BrowserSweep::begin(
            &registry,
            BrowserKind::Sportsurge,
            "11111111-1111-4111-8111-111111111111".into(),
            at,
        )
        .unwrap();
        let SweepAction::Publish { id, .. } = action else {
            panic!("initial checkpoint")
        };
        let action = sweep
            .advance(&registry, SweepResult::PublishOk { id, ack: None }, at)
            .unwrap();
        let SweepAction::Read {
            id,
            role: BrowserRole::Category,
            league: League::Ncaaf,
            ..
        } = action
        else {
            panic!("first category")
        };
        let body = "<main id=\"match-list-container\"><a class=\"match-row\" href=\"watch-123-cfb-away-home/\"><span class=\"match-row-team-name\">Away</span><span class=\"match-row-team-name\">Home</span></a></main>".into();
        let action = sweep
            .advance(&registry, SweepResult::ReadOk { id, body }, at)
            .unwrap();
        let SweepAction::Publish {
            id,
            catalog: accepted,
        } = action
        else {
            panic!("first category checkpoint")
        };
        assert_eq!(accepted.event_urls().len(), 1);
        let ack = CatalogAck {
            kind: "catalog-ack".into(),
            skip_detail_event_ids: vec!["ncaaf:123".into()],
            skip_detail_event_urls: vec![],
            reuse_details: None,
            source_refresh_ms: Some(60_000),
        };
        let action = sweep
            .advance(&registry, SweepResult::PublishOk { id, ack: Some(ack) }, at)
            .unwrap();
        let SweepAction::Read {
            id,
            role: BrowserRole::Category,
            league: League::Nfl,
            ..
        } = action
        else {
            panic!("second category")
        };
        let body = "<main id=\"match-list-container\"><div class=\"watch-empty-state\">No live or upcoming games</div></main>".into();
        let action = sweep
            .advance(&registry, SweepResult::ReadOk { id, body }, at)
            .unwrap();
        let SweepAction::Publish {
            id,
            catalog: attempted,
        } = action
        else {
            panic!("second category checkpoint")
        };
        assert!(attempted.event_urls().is_empty());
        let action = sweep
            .advance(
                &registry,
                SweepResult::PublishFailed {
                    id,
                    reason: BrowserFailure::Limit,
                },
                at,
            )
            .unwrap();
        let SweepAction::Publish {
            id,
            catalog: fallback,
        } = action
        else {
            panic!("fallback checkpoint")
        };
        assert_eq!(fallback.sequence(), attempted.sequence());
        assert_eq!(fallback.event_urls(), accepted.event_urls());
        assert!(
            matches!(fallback.state(), CatalogState::Partial { at: time, reason: BrowserFailure::Limit } if *time == at)
        );
        let action = sweep
            .advance(&registry, SweepResult::PublishOk { id, ack: None }, at)
            .unwrap();
        assert!(matches!(
            action,
            SweepAction::Failed {
                reason: BrowserFailure::Limit
            }
        ));
        assert_eq!(sweep.source_refresh_ms, 60_000);
    }

    #[test]
    fn acknowledgement_after_detail_read_prevents_stale_server_visits() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let at = 1_791_493_800_000;
        let event_url = "https://v2.streameast.ga/cfb/away-vs-home/";
        let (mut sweep, mut action) = BrowserSweep::begin(
            &registry,
            BrowserKind::Streameast,
            "11111111-1111-4111-8111-111111111111".into(),
            at,
        )
        .unwrap();
        let mut saw_detail = false;
        let mut saw_server = false;
        loop {
            let result = match action {
                SweepAction::Read {
                    id,
                    role: BrowserRole::Category,
                    league,
                    ..
                } => {
                    let body = if league == League::Ncaaf {
                        format!(
                            "<article class=\"m-card\" data-match-id=\"12345\" data-team-names=\"Away|Home\" data-time=\"1791493800\"><a class=\"m-card__link\" aria-label=\"Away vs Home\" href=\"{event_url}\"></a></article>"
                        )
                    } else {
                        let category = registry.browser_category("streameast", league).unwrap();
                        format!(
                            "<div id=\"m-schedule-empty\" class=\"m-empty\"><h2 class=\"m-empty__title\">{}</h2></div>",
                            category.empty_titles.as_ref().unwrap()[0]
                        )
                    };
                    SweepResult::ReadOk { id, body }
                }
                SweepAction::Read {
                    id,
                    role: BrowserRole::Detail,
                    ..
                } => {
                    saw_detail = true;
                    let body = format!(
                        "<div class=\"stream-alt-list\"><a class=\"stream-alt-item\" href=\"{event_url}1\"><span class=\"stream-alt-free-badge\">Free</span></a></div>"
                    );
                    SweepResult::ReadOk { id, body }
                }
                SweepAction::Read {
                    id,
                    role: BrowserRole::Server,
                    ..
                } => {
                    saw_server = true;
                    SweepResult::ReadOk {
                        id,
                        body:
                            "<iframe src=\"https://streame.center/stream-east/ch33.php\"></iframe>"
                                .into(),
                    }
                }
                SweepAction::Publish { id, ref catalog } => {
                    let skip = if saw_detail
                        && catalog.event_urls().len() == 1
                        && catalog.event_is_pending(event_url)
                    {
                        vec!["ncaaf:12345".into()]
                    } else {
                        vec![]
                    };
                    SweepResult::PublishOk {
                        id,
                        ack: Some(CatalogAck {
                            kind: "catalog-ack".into(),
                            skip_detail_event_ids: skip,
                            skip_detail_event_urls: vec![],
                            reuse_details: None,
                            source_refresh_ms: None,
                        }),
                    }
                }
                SweepAction::Done { catalog, .. } => {
                    assert!(saw_detail);
                    assert!(!saw_server);
                    assert!(catalog.event_urls().is_empty());
                    assert!(matches!(catalog.state(), CatalogState::Complete { .. }));
                    break;
                }
                SweepAction::Failed { reason } => panic!("unexpected failure: {reason:?}"),
            };
            action = sweep.advance(&registry, result, at).unwrap();
        }
    }

    #[test]
    fn exact_identity_retained_detail_avoids_browser_detail_read() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let at = 1_791_493_800_000;
        let (mut sweep, mut action) = BrowserSweep::begin(
            &registry,
            BrowserKind::Sportsurge,
            "11111111-1111-4111-8111-111111111111".into(),
            at,
        )
        .unwrap();
        let reused = loop {
            let result = match action {
                SweepAction::Read {
                    id,
                    role: BrowserRole::Category,
                    league,
                    ..
                } => {
                    let body = if league == League::Ncaaf {
                        "<main id=\"match-list-container\"><a class=\"match-row\" href=\"watch-123-cfb-away-home/\"><span class=\"match-row-team-name\">Away</span><span class=\"match-row-team-name\">Home</span></a></main>".into()
                    } else {
                        "<main id=\"match-list-container\"><div class=\"watch-empty-state\">No live or upcoming games</div></main>".into()
                    };
                    SweepResult::ReadOk { id, body }
                }
                SweepAction::Read {
                    role: BrowserRole::Detail,
                    ..
                } => panic!("retained detail was read"),
                SweepAction::Read {
                    role: BrowserRole::Server,
                    ..
                } => panic!("Sportsurge server read"),
                SweepAction::Publish {
                    id,
                    catalog: BrowserCatalog::Sportsurge(catalog),
                } => {
                    let reuse_details = if catalog.sequence == 1 {
                        let mut event = catalog.events[0].clone();
                        event.detail = SportsurgeDetail::Collected {
                            at,
                            retained_from_run_id: Some(
                                "22222222-2222-4222-8222-222222222222".into(),
                            ),
                            providers: vec![],
                        };
                        Some(ReuseDetails::Sportsurge {
                            events: vec![event],
                        })
                    } else {
                        None
                    };
                    SweepResult::PublishOk {
                        id,
                        ack: Some(CatalogAck {
                            kind: "catalog-ack".into(),
                            skip_detail_event_ids: vec![],
                            skip_detail_event_urls: vec![],
                            reuse_details,
                            source_refresh_ms: None,
                        }),
                    }
                }
                SweepAction::Publish { .. } => panic!("wrong catalog source"),
                SweepAction::Done {
                    catalog: BrowserCatalog::Sportsurge(catalog),
                    ..
                } => {
                    assert!(matches!(catalog.state, CatalogState::Complete { .. }));
                    break matches!(
                        catalog.events[0].detail,
                        SportsurgeDetail::Collected {
                            retained_from_run_id: Some(_),
                            ..
                        }
                    );
                }
                SweepAction::Done { .. } => panic!("wrong catalog source"),
                SweepAction::Failed { reason } => panic!("unexpected failure: {reason:?}"),
            };
            action = sweep.advance(&registry, result, at).unwrap();
        };
        assert!(reused);
    }

    #[test]
    fn every_fourth_detail_admission_serves_background_work() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let now = 1_791_493_800_000;
        let (mut sweep, _) = BrowserSweep::begin(
            &registry,
            BrowserKind::Sportsurge,
            "11111111-1111-4111-8111-111111111111".into(),
            now,
        )
        .unwrap();
        if let BrowserCatalog::Sportsurge(catalog) = &mut sweep.catalog {
            for index in 0..5 {
                catalog.events.push(SportsurgeEvent {
                    id: format!("ncaaf:{index}"),
                    url: format!("https://v2.sportsurge.net/watch-{index}-cfb-away-home/"),
                    league: League::Ncaaf,
                    title: "Away vs Home".into(),
                    teams: Some(["Away".into(), "Home".into()]),
                    source_status: if index == 4 {
                        crate::browser::SourceStatus::Unknown
                    } else {
                        crate::browser::SourceStatus::Live
                    },
                    kickoff: None,
                    advertised_link_count: None,
                    detail: SportsurgeDetail::Pending,
                });
            }
        }
        sweep.build_pending(now);
        let mut read_ids = Vec::new();
        for _ in 0..5 {
            let SweepAction::Read {
                url,
                role: BrowserRole::Detail,
                ..
            } = sweep.next_detail_or_finish(now)
            else {
                panic!("expected detail read")
            };
            read_ids.push(
                url.split("watch-")
                    .nth(1)
                    .unwrap()
                    .split('-')
                    .next()
                    .unwrap()
                    .to_owned(),
            );
        }
        assert_eq!(read_ids, ["0", "1", "2", "4", "3"]);
    }

    #[test]
    fn shared_nascar_category_reuses_failed_read_without_second_navigation() {
        let registry =
            SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json"))
                .unwrap();
        let now = 1_791_493_800_000;
        let (mut sweep, _) = BrowserSweep::begin(
            &registry,
            BrowserKind::Sportsurge,
            "11111111-1111-4111-8111-111111111111".into(),
            now,
        )
        .unwrap();
        assert_eq!(sweep.category_urls[9].1, sweep.category_urls[10].1);
        assert!(matches!(
            sweep.category_read(
                &registry,
                9,
                ReadResult::Failed(BrowserFailure::Timeout),
                now
            ),
            SweepAction::Publish { .. }
        ));
        assert!(matches!(
            sweep.next_category(&registry, 10, now),
            SweepAction::Publish { .. }
        ));
        assert!(matches!(
            sweep.catalog.categories().0[10].1,
            CategoryState::Failed {
                reason: BrowserFailure::Timeout,
                ..
            }
        ));
    }
}
