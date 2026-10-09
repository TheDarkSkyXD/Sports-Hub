pub mod error;
pub mod event_policy;
pub mod html;
pub mod http;
pub mod listing_html;
pub mod registry;
pub mod time;
pub mod types;

use napi_derive::napi;
use parking_lot::Mutex;
use registry::SourceRegistry;
use std::{collections::HashMap, sync::OnceLock};
use tokio_util::sync::CancellationToken;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("two-worker collector runtime")
    })
}

pub struct CatalogSnapshot {
    pub body: String,
    pub at: i64,
}

pub struct SportsfeedEvent {
    pub team_a: String,
    pub team_b: String,
    pub at: i64,
}

pub struct CollectorState {
    pub registry: SourceRegistry,
    pub catalogs: HashMap<String, CatalogSnapshot>,
    pub sportsfeed_events: HashMap<String, SportsfeedEvent>,
    pub inflight: HashMap<u64, CancellationToken>,
    pub next_request_id: u64,
}

#[napi]
pub struct Collector {
    state: Mutex<CollectorState>,
}

#[napi]
impl Collector {
    #[napi(constructor)]
    pub fn new(registry_json: String) -> napi::Result<Self> {
        let registry = SourceRegistry::parse(&registry_json)?;
        Ok(Self {
            state: Mutex::new(CollectorState {
                registry,
                catalogs: HashMap::new(),
                sportsfeed_events: HashMap::new(),
                inflight: HashMap::new(),
                next_request_id: 1,
            }),
        })
    }

    #[napi]
    pub fn source_count(&self) -> u32 {
        self.state.lock().registry.sources().len() as u32
    }
}
