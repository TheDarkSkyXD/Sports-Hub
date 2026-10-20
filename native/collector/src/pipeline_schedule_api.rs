use crate::pipeline::schedule::{self, ScheduleClient, ScheduleSource};
use napi::bindgen_prelude::{Function, Object};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;
use parking_lot::Mutex;
use std::{collections::HashMap, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct ScheduleRequests {
    next: u32,
    closed: bool,
    tokens: HashMap<u32, (CancellationToken, bool)>,
}

#[napi]
pub struct NativeSchedule {
    client: Arc<ScheduleClient>,
    fixture: Option<Arc<crate::http::FixtureTransport>>,
    requests: Arc<Mutex<ScheduleRequests>>,
}

impl NativeSchedule {
    fn token(&self, id: u32) -> napi::Result<CancellationToken> {
        let mut requests = self.requests.lock();
        let (token, started) = requests
            .tokens
            .get_mut(&id)
            .ok_or_else(|| napi::Error::from_reason("unknown-schedule-request"))?;
        if *started {
            return Err(napi::Error::from_reason("schedule-request-already-started"));
        }
        *started = true;
        Ok(token.clone())
    }
}

#[napi]
impl NativeSchedule {
    #[napi(constructor)]
    pub fn new(registry_json: String, fixture_mode: Option<bool>) -> napi::Result<Self> {
        let registry = Arc::new(crate::registry::SourceRegistry::parse(&registry_json)?);
        let (client, fixture) = if fixture_mode.unwrap_or(false) {
            let (client, fixture) = ScheduleClient::fixture(registry);
            (client, Some(fixture))
        } else {
            (
                ScheduleClient::new(registry).map_err(napi::Error::from_reason)?,
                None,
            )
        };
        Ok(Self {
            client,
            fixture,
            requests: Arc::new(Mutex::new(ScheduleRequests::default())),
        })
    }

    #[napi]
    pub fn begin(&self) -> napi::Result<u32> {
        let mut requests = self.requests.lock();
        if requests.closed {
            return Err(napi::Error::from_reason("schedule-closed"));
        }
        let id = requests.next;
        requests.next = id
            .checked_add(1)
            .ok_or_else(|| napi::Error::from_reason("schedule-request-id-exhausted"))?;
        requests
            .tokens
            .insert(id, (CancellationToken::new(), false));
        Ok(id)
    }

    #[napi]
    pub fn cancel(&self, request_id: u32) {
        if let Some((token, _)) = self.requests.lock().tokens.remove(&request_id) {
            token.cancel();
        }
    }

    #[napi]
    pub fn close(&self) {
        let mut requests = self.requests.lock();
        requests.closed = true;
        for (_, (token, _)) in requests.tokens.drain() {
            token.cancel();
        }
    }

    #[napi]
    pub fn read<'env>(
        &self,
        env: &'env napi::Env,
        source_json: String,
        now: f64,
        request_id: u32,
        on_progress: Function<'env, String, ()>,
    ) -> napi::Result<Object<'env>> {
        let source: ScheduleSource = serde_json::from_str(&source_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let now = crate::epoch_ms(now)?;
        let callback = on_progress
            .build_threadsafe_function::<String>()
            .callee_handled::<false>()
            .max_queue_size::<64>()
            .build()?;
        let runtime = crate::runtime()?;
        let (deferred, promise) = env.create_deferred::<String, _>()?;
        let token = self.token(request_id)?;
        let requests = self.requests.clone();
        let client = self.client.clone();
        runtime.spawn(async move {
            let acknowledgements = Arc::new(Mutex::new(Vec::new()));
            let acknowledgements_out = acknowledgements.clone();
            let progress_token = token.clone();
            let progress_error = Arc::new(Mutex::new(None::<String>));
            let progress_error_out = progress_error.clone();
            let result =
                schedule::read_schedule(source, now, token.clone(), client, move |result| {
                    let value = match serde_json::to_string(&result) {
                        Ok(value) => value,
                        Err(error) => {
                            *progress_error_out.lock() = Some(error.to_string());
                            progress_token.cancel();
                            return;
                        }
                    };
                    let (send, receive) = tokio::sync::oneshot::channel();
                    let error_out = progress_error_out.clone();
                    let error_token = progress_token.clone();
                    let status = callback.call_with_return_value(
                        value,
                        ThreadsafeFunctionCallMode::NonBlocking,
                        move |result, _| {
                            if let Err(error) = result {
                                *error_out.lock() = Some(error.to_string());
                                error_token.cancel();
                            }
                            let _ = send.send(());
                            Ok(())
                        },
                    );
                    if status == napi::Status::Ok {
                        acknowledgements_out.lock().push(receive);
                    } else {
                        *progress_error_out.lock() = Some(format!("schedule-progress-{status:?}"));
                        progress_token.cancel();
                    }
                })
                .await;
            let pending = std::mem::take(&mut *acknowledgements.lock());
            for acknowledgement in pending {
                tokio::select! {_ = acknowledgement=>{},_ = token.cancelled()=>break}
            }
            requests.lock().tokens.remove(&request_id);
            let error = progress_error.lock().take();
            let result = match error {
                Some(error) => Err(error),
                None => result.and_then(|value| {
                    serde_json::to_string(&value).map_err(|error| error.to_string())
                }),
            };
            match result {
                Ok(value) => deferred.resolve(move |_| Ok(value)),
                Err(error) => deferred.reject(napi::Error::from_reason(error)),
            }
        });
        Ok(promise)
    }

    #[napi]
    pub fn membership<'env>(
        &self,
        env: &'env napi::Env,
        season: i32,
        request_id: u32,
    ) -> napi::Result<Object<'env>> {
        let runtime = crate::runtime()?;
        let (deferred, promise) = env.create_deferred::<String, _>()?;
        let token = self.token(request_id)?;
        let requests = self.requests.clone();
        let client = self.client.clone();
        runtime.spawn(async move {
            let result = schedule::read_membership(season, client, token)
                .await
                .and_then(|value| serde_json::to_string(&value).map_err(|error| error.to_string()));
            requests.lock().tokens.remove(&request_id);
            match result {
                Ok(value) => deferred.resolve(move |_| Ok(value)),
                Err(error) => deferred.reject(napi::Error::from_reason(error)),
            }
        });
        Ok(promise)
    }

    #[napi]
    pub fn enqueue_fixture(&self, script_json: String) -> napi::Result<()> {
        let fixture = self
            .fixture
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("schedule-not-in-fixture-mode"))?;
        fixture.enqueue_script(
            serde_json::from_str(&script_json)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?,
        )?;
        Ok(())
    }

    #[napi]
    pub fn fixture_requests(&self) -> napi::Result<String> {
        let fixture = self
            .fixture
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("schedule-not-in-fixture-mode"))?;
        serde_json::to_string(&fixture.requests())
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn fixture_cancels(&self) -> napi::Result<String> {
        let fixture = self
            .fixture
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("schedule-not-in-fixture-mode"))?;
        serde_json::to_string(&fixture.cancels())
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn release_fixture_gate(&self, gate: String) -> napi::Result<()> {
        let fixture = self
            .fixture
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("schedule-not-in-fixture-mode"))?;
        fixture.release_gate(&gate);
        Ok(())
    }
}

impl Drop for NativeSchedule {
    fn drop(&mut self) {
        self.close();
    }
}
