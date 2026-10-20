use napi_derive::napi;
use parking_lot::Mutex;
use std::sync::Arc;

enum StoreAccess {
    Standalone(Option<crate::pipeline::store::Store>),
    Attached(Arc<Mutex<crate::pipeline::Pipeline>>),
}

#[napi]
pub struct NativeStore {
    inner: Mutex<StoreAccess>,
}

#[napi]
impl NativeStore {
    #[napi(constructor)]
    pub fn new(
        path: String,
        owner_token: Option<String>,
        reclaim_token: Option<String>,
    ) -> napi::Result<Self> {
        let store = crate::pipeline::store::Store::open(
            &path,
            owner_token.as_deref(),
            reclaim_token.as_deref(),
        )
        .map_err(napi::Error::from_reason)?;
        Ok(Self {
            inner: Mutex::new(StoreAccess::Standalone(Some(store))),
        })
    }

    #[napi]
    pub fn call(&self, operation: String, args_json: String) -> napi::Result<String> {
        let args = serde_json::from_str(&args_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let result = match &mut *self.inner.lock() {
            StoreAccess::Standalone(store) => store
                .as_mut()
                .ok_or_else(|| napi::Error::from_reason("store-closed"))?
                .call(&operation, args),
            StoreAccess::Attached(pipeline) => pipeline.lock().store.call(&operation, args),
        }
        .map_err(napi::Error::from_reason)?;
        serde_json::to_string(&result).map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        match &mut *self.inner.lock() {
            StoreAccess::Standalone(store) => store.as_mut().map_or(Ok(()), |store| store.close()),
            StoreAccess::Attached(pipeline) => pipeline.lock().store.close(),
        }
        .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn create_pipeline(&self, config_json: String) -> napi::Result<NativePipeline> {
        let mut access = self.inner.lock();
        let store = match &mut *access {
            StoreAccess::Standalone(store) => store
                .take()
                .ok_or_else(|| napi::Error::from_reason("store-closed"))?,
            StoreAccess::Attached(_) => {
                return Err(napi::Error::from_reason("pipeline-already-attached"));
            }
        };
        let pipeline = crate::pipeline::Pipeline::with_store(store, &config_json)
            .map_err(napi::Error::from_reason)?;
        let inner = Arc::new(Mutex::new(pipeline));
        *access = StoreAccess::Attached(Arc::clone(&inner));
        Ok(NativePipeline { inner })
    }
}

#[napi]
pub fn pipeline_domain(operation: String, input_json: String) -> napi::Result<String> {
    let input = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let result = crate::pipeline::domain::domain_call(&operation, input)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&result).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub struct NativePipeline {
    inner: Arc<Mutex<crate::pipeline::Pipeline>>,
}

#[napi]
impl NativePipeline {
    #[napi(constructor)]
    pub fn new(path: String, config_json: String) -> napi::Result<Self> {
        let pipeline = crate::pipeline::Pipeline::open(path, &config_json)
            .map_err(napi::Error::from_reason)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(pipeline)),
        })
    }

    #[napi]
    pub fn step(&self, input_json: String, at: Option<i64>) -> napi::Result<String> {
        let input = serde_json::from_str(&input_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let batch = self
            .inner
            .lock()
            .step(
                input,
                at.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
            )
            .map_err(napi::Error::from_reason)?;
        serde_json::to_string(&batch).map_err(|error| napi::Error::from_reason(error.to_string()))
    }
}

#[napi]
pub fn pipeline_view(operation: String, input_json: String) -> napi::Result<String> {
    let input = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let value = crate::pipeline::views::external_view_call(&operation, input)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&value).map_err(|error| napi::Error::from_reason(error.to_string()))
}
