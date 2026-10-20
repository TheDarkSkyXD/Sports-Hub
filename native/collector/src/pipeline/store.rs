use super::model::{Game, Observation, Partition, SourceEventBinding};
use chrono::{Datelike, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{cell::RefCell, path::Path, time::Duration};

type Result<T> = std::result::Result<T, String>;
type CatalogPayloads = (String, Option<String>, Option<String>);
const DAY: i64 = 86_400_000;
const CHECK_RETENTION: i64 = DAY;
const DEFAULT_RETENTION: i64 = 1440;
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS partitions (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS finals (id TEXT PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS source_event_bindings (source_id TEXT NOT NULL, event_id TEXT NOT NULL, url TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(source_id,event_id,url)) STRICT;
CREATE TABLE IF NOT EXISTS details (observation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS working_feeds (game_id TEXT NOT NULL, candidate_id TEXT NOT NULL, identity_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(game_id,candidate_id)) STRICT;
CREATE INDEX IF NOT EXISTS working_identity ON working_feeds(game_id,identity_hash);
CREATE TABLE IF NOT EXISTS feed_checks (game_id TEXT NOT NULL, identity_hash TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(game_id,identity_hash)) STRICT;
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS source_catalogs (id TEXT PRIMARY KEY, current_payload TEXT NOT NULL, complete_payload TEXT, previous_payload TEXT) STRICT;
CREATE TABLE IF NOT EXISTS catalog_attempts (source_id TEXT NOT NULL, league TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source_id,league,at,outcome)) STRICT;
CREATE TABLE IF NOT EXISTS aliases (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS alias_conflicts (id TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, count INTEGER NOT NULL, error TEXT) STRICT;
CREATE TABLE IF NOT EXISTS memberships (season INTEGER PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL) STRICT;";

fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|e| e.to_string())
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| format!("invalid-{key}"))
}
fn number(value: &Value, key: &str) -> Result<i64> {
    value[key].as_i64().ok_or_else(|| format!("invalid-{key}"))
}
fn array(value: &Value) -> Result<&[Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| "invalid-array".into())
}
fn valid_payload(kind: &str, value: &Value) -> bool {
    match kind {
        "attempt" => valid_attempt(value),
        "catalog" => super::catalog::validate_stored_catalog(
            if value["catalog"].get("catalogIssues").is_some() {
                "sportsurge-v2"
            } else {
                "streameast"
            },
            value,
        )
        .is_ok(),
        _ => super::model::validate_payload(kind, value).is_ok(),
    }
}
fn require(kind: &str, value: &Value) -> Result<()> {
    if valid_payload(kind, value) {
        Ok(())
    } else {
        Err(format!("invalid-{kind}"))
    }
}
fn valid_attempt(value: &Value) -> bool {
    value["at"].is_number()
        && matches!(
            value["outcome"].as_str(),
            Some("parsed" | "empty" | "parser-changed" | "failed" | "unsupported")
        )
        && value.get("count").is_none_or(|v| v.as_u64().is_some())
        && value.get("failures").is_none_or(|v| v.as_u64().is_some())
        && value.get("nextEligibleAt").is_none_or(Value::is_number)
        && value
            .get("parserVersion")
            .is_none_or(|v| v.as_u64().is_some_and(|n| n > 0))
        && value.get("failure").is_none_or(|v| {
            matches!(
                v.as_str(),
                Some(
                    "not-found"
                        | "blocked"
                        | "rate-limited"
                        | "timed-out"
                        | "network-unavailable"
                        | "unsupported-address"
                        | "collector-busy"
                        | "response-too-large"
                        | "invalid-response"
                        | "upstream-error"
                )
            )
        })
}
fn canonical_attempt(value: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in [
        "at",
        "outcome",
        "failure",
        "count",
        "failures",
        "nextEligibleAt",
        "parserVersion",
    ] {
        if let Some(value) = value.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    Value::Object(result)
}
fn source_failure(message: &str) -> &'static str {
    if message == "source-page-capacity" {
        "collector-busy"
    } else if matches!(message, "blocked" | "http-403" | "source-page-challenge") {
        "blocked"
    } else if cached_regex!(r"\b404\b").unwrap().is_match(message) {
        "not-found"
    } else if message == "rate-limited" || cached_regex!(r"\b429\b").unwrap().is_match(message) {
        "rate-limited"
    } else if cached_regex!("(?i)timeout|timed out")
        .unwrap()
        .is_match(message)
    {
        "timed-out"
    } else if cached_regex!("(?i)fetch failed|network")
        .unwrap()
        .is_match(message)
        || matches!(message, "source-page-closed" | "source-page-window-closed")
    {
        "network-unavailable"
    } else if matches!(
        message,
        "unsupported-discovery-address" | "source-page-unsupported-address"
    ) {
        "unsupported-address"
    } else if matches!(
        message,
        "response-too-large" | "source-page-response-too-large"
    ) {
        "response-too-large"
    } else if matches!(
        message,
        "empty-response"
            | "redirect-without-location"
            | "redirect-limit"
            | "source-page-page-changed"
            | "source-page-changed"
            | "source-page-invalid-response"
    ) {
        "invalid-response"
    } else {
        "upstream-error"
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn GetLastError() -> u32;
    }
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return GetLastError() == 5;
        }
        let mut code = 0;
        let queried = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        queried != 0 && code == 259
    }
}
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    unsafe { kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1) }
}
#[cfg(not(any(unix, windows)))]
fn process_alive(pid: u32) -> bool {
    pid == std::process::id()
}

pub struct Store {
    db: Option<Connection>,
    owner_token: String,
    previous_catalog_column: bool,
    source_attempt_cache: RefCell<Option<(i64, Value)>>,
    #[cfg(test)]
    attempt_decodes: std::cell::Cell<usize>,
}

impl Store {
    pub fn open(
        path: impl AsRef<Path>,
        owner_token: Option<&str>,
        reclaim_token: Option<&str>,
    ) -> Result<Self> {
        let db = Connection::open(path).map_err(sql)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(sql)?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY CHECK(slot=1), token TEXT NOT NULL, pid INTEGER NOT NULL) STRICT; BEGIN IMMEDIATE;").map_err(sql)?;
        let token = owner_token
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let claim = (|| {
            let owner: Option<(i64, String)> = db
                .query_row("SELECT pid,token FROM owner WHERE slot=1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()
                .map_err(sql)?;
            if let Some((pid, old_token)) = owner {
                if u32::try_from(pid).is_ok_and(process_alive)
                    && Some(old_token.as_str()) != reclaim_token
                {
                    return Err("football-writer-already-active".into());
                }
            }
            db.execute("INSERT INTO owner VALUES (1,?,?) ON CONFLICT(slot) DO UPDATE SET token=excluded.token,pid=excluded.pid",params![token,std::process::id()]).map_err(sql)?;
            db.execute_batch("COMMIT").map_err(sql)
        })();
        if let Err(error) = claim {
            let _ = db.execute_batch("ROLLBACK");
            return Err(error);
        }
        let mut store = Self {
            db: Some(db),
            owner_token: token,
            previous_catalog_column: false,
            source_attempt_cache: RefCell::new(None),
            #[cfg(test)]
            attempt_decodes: std::cell::Cell::new(0),
        };
        store.db()?.execute_batch(SCHEMA).map_err(sql)?;
        // Existing databases keep their schema version and columns. Only a new schema gets version 1.
        let version: i64 = store
            .db()?
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(sql)?;
        if version == 0 {
            store
                .db()?
                .execute_batch("PRAGMA user_version=1")
                .map_err(sql)?;
        }
        let previous_catalog_column = store
            .db()?
            .prepare("PRAGMA table_info(source_catalogs)")
            .map_err(sql)?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?
            .iter()
            .any(|s| s == "previous_payload");
        store.previous_catalog_column = previous_catalog_column;
        if store
            .payload(
                "SELECT payload FROM settings WHERE id='finishedGameRetentionMinutes'",
                [],
            )?
            .is_none()
        {
            store.set_finished_game_retention_minutes(DEFAULT_RETENTION)?;
        }
        Ok(store)
    }
    fn db(&self) -> Result<&Connection> {
        self.db
            .as_ref()
            .ok_or_else(|| "football-store-closed".into())
    }
    fn payload<P: rusqlite::Params>(&self, query: &str, args: P) -> Result<Option<String>> {
        self.db()?
            .query_row(query, args, |r| r.get(0))
            .optional()
            .map_err(sql)
    }
    fn rows<P: rusqlite::Params>(&self, query: &str, args: P, kind: &str) -> Result<Vec<Value>> {
        let payloads = self
            .db()?
            .prepare(query)
            .map_err(sql)?
            .query_map(args, |r| r.get::<_, String>(0))
            .map_err(sql)?
            .map(|row| row.map_err(sql))
            .collect::<Result<Vec<_>>>()?;
        let mut values = Vec::new();
        for payload in payloads {
            let value = match decode::<Value>(&payload) {
                Ok(value) => value,
                Err(_) if kind == "detail" => continue,
                Err(error) => return Err(error),
            };
            if valid_payload(kind, &value) {
                values.push(value);
            }
        }
        Ok(values)
    }
    fn read_payload<T: DeserializeOwned, P: rusqlite::Params>(
        &self,
        query: &str,
        args: P,
        kind: &str,
    ) -> Result<Option<T>> {
        let Some(payload) = self.payload(query, args)? else {
            return Ok(None);
        };
        let value: Value = decode(&payload)?;
        if !valid_payload(kind, &value) {
            return Ok(None);
        }
        serde_json::from_value(value)
            .map(Some)
            .map_err(|error| error.to_string())
    }
    fn transaction<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        self.db()?.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        match operation() {
            Ok(value) => {
                if let Err(e) = self.db()?.execute_batch("COMMIT") {
                    let _ = self.db()?.execute_batch("ROLLBACK");
                    return Err(sql(e));
                }
                Ok(value)
            }
            Err(error) => {
                let _ = self.db()?.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn close(&mut self) -> Result<()> {
        if let Some(db) = self.db.take() {
            db.execute(
                "DELETE FROM owner WHERE slot=1 AND token=?",
                [&self.owner_token],
            )
            .map_err(sql)?;
            db.close().map_err(|(_, e)| sql(e))?;
        }
        Ok(())
    }
    pub fn finished_game_retention_minutes(&self) -> Result<i64> {
        let value = self
            .payload(
                "SELECT payload FROM settings WHERE id='finishedGameRetentionMinutes'",
                [],
            )?
            .map(|v| decode::<i64>(&v))
            .transpose()?
            .unwrap_or(DEFAULT_RETENTION);
        if !(5..=10080).contains(&value) {
            return Err("invalid-finished-game-retention".into());
        }
        Ok(value)
    }
    pub fn set_finished_game_retention_minutes(&self, minutes: i64) -> Result<()> {
        if !(5..=10080).contains(&minutes) {
            return Err("invalid-finished-game-retention".into());
        }
        self.transaction(|| {
            self.db()?.execute("INSERT INTO settings VALUES ('finishedGameRetentionMinutes',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",[minutes.to_string()]).map_err(sql)?;
            self.db()?.execute("UPDATE finals SET payload=json_set(payload,'$.graceEndsAt',at+?,'$.finalObservedAt',at)",[minutes*60000]).map_err(sql)?;
            let finals=self.finals()?;
            let partitions=self.db()?.prepare("SELECT id,payload FROM partitions").map_err(sql)?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql)?;
            for(id,payload)in partitions {if let Ok(mut partition)=decode::<Partition>(&payload) {for game in &mut partition.games {if let Some(final_game)=finals.iter().find(|g|g.id==game.id){*game=final_game.clone();}}self.db()?.execute("UPDATE partitions SET payload=? WHERE id=?",params![encode(&partition)?,id]).map_err(sql)?;}}
            Ok(())
        })
    }
    pub fn partition(&self, id: &str) -> Result<Option<Partition>> {
        self.read_payload(
            "SELECT payload FROM partitions WHERE id=?",
            [id],
            "partition",
        )
    }
    pub fn partition_times(&self) -> Result<std::collections::BTreeMap<String, i64>> {
        let mut statement = self
            .db()?
            .prepare(
                r#"SELECT id,CAST(at AS REAL) FROM (
            SELECT id,CASE WHEN instr(payload,char(92))=0 AND
                instr(substr(payload,instr(payload,'"at"')+4),'"at"')=0
                THEN json_extract(payload,'$.at')
                ELSE (SELECT value FROM json_each(payload) WHERE key='at' ORDER BY id DESC LIMIT 1)
            END AS at FROM partitions WHERE json_valid(payload)
        ) WHERE typeof(at) IN ('integer','real')"#,
            )
            .map_err(sql)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(sql)?;
        rows.filter_map(|row| match row {
            Ok((id, at)) if at.is_finite() && at >= i64::MIN as f64 && at < i64::MAX as f64 => {
                Some(Ok((id, at.ceil() as i64)))
            }
            Ok(_) => None,
            Err(error) => Some(Err(sql(error))),
        })
        .collect()
    }
    pub fn save_partition(&self, id: &str, value: &Partition) -> Result<()> {
        self.transaction(|| {
            let mut partition=value.clone();
            for game in &mut partition.games {
                if game.lifecycle==super::model::GameLifecycle::Final {
                    let observed=self.db()?.query_row("SELECT at FROM finals WHERE id=?",[&game.id],|r|r.get::<_,i64>(0)).optional().map_err(sql)?.unwrap_or(partition.at);
                    *game=super::domain::record_final(game,observed,self.finished_game_retention_minutes()?);
                    self.db()?.execute("INSERT INTO finals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![game.id,encode(game)?,observed]).map_err(sql)?;
                }
            }
            self.db()?.execute("INSERT INTO partitions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![id,encode(&partition)?]).map_err(sql)?;Ok(())
        })
    }
    pub fn finals(&self) -> Result<Vec<Game>> {
        self.rows("SELECT payload FROM finals", [], "game")?
            .into_iter()
            .map(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
            .collect()
    }
    fn observe_value(&self, observation: &Value, result: &Value) -> Result<()> {
        require("observation", observation)?;
        self.db()?.execute("INSERT INTO observations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,result=excluded.result,at=excluded.at",params![field(observation,"id")?,encode(observation)?,encode(result)?,number(observation,"observedAt")?]).map_err(sql)?;
        Ok(())
    }
    pub fn observe(&self, observation: &Observation, result: &super::model::Match) -> Result<()> {
        self.observe_value(
            &serde_json::to_value(observation).map_err(|e| e.to_string())?,
            &serde_json::to_value(result).map_err(|e| e.to_string())?,
        )
    }
    pub fn observations(&self) -> Result<Vec<Observation>> {
        self.rows(
            "SELECT payload FROM observations ORDER BY at DESC LIMIT 10000",
            [],
            "observation",
        )?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
        .collect()
    }
    pub fn observation(&self, id: &str) -> Result<Option<Observation>> {
        self.read_payload(
            "SELECT payload FROM observations WHERE id=?",
            [id],
            "observation",
        )
    }
    pub fn source_attempts(&self) -> Result<Value> {
        let version: i64 = self
            .db()?
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .map_err(sql)?;
        if let Some((cached_version, attempts)) = &*self.source_attempt_cache.borrow() {
            if *cached_version == version {
                return Ok(attempts.clone());
            }
        }
        let mut attempts = serde_json::Map::new();
        let rows = self
            .db()?
            .prepare("SELECT id,payload FROM sources")
            .map_err(sql)?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        for (id, payload) in rows {
            #[cfg(test)]
            self.attempt_decodes.set(self.attempt_decodes.get() + 1);
            let Ok(mut value) = decode::<Value>(&payload) else {
                continue;
            };
            if !valid_attempt(&value) {
                continue;
            }
            if value.get("nextEligibleAt").is_none() {
                value = if value["outcome"] == "failed" {
                    json!({"at":value["at"],"outcome":"failed","failure":source_failure(value["error"].as_str().unwrap_or_default()),"failures":0,"nextEligibleAt":0})
                } else {
                    json!({"at":value["at"],"outcome":value["outcome"],"failures":0,"nextEligibleAt":0})
                };
            }
            attempts.insert(id, canonical_attempt(&value));
        }
        let mut latest = self
            .db()?
            .prepare(
                r#"SELECT payload FROM catalog_attempts WHERE source_id=? AND json_valid(payload)
          ORDER BY CASE WHEN instr(payload,char(92))=0 AND
            instr(substr(payload,instr(payload,'"at"')+4),'"at"')=0
            THEN CAST(json_extract(payload,'$.at') AS REAL)
            ELSE (SELECT CASE WHEN type IN ('integer','real') THEN CAST(value AS REAL) END
              FROM json_each(payload) WHERE key='at' ORDER BY id DESC LIMIT 1)
            END DESC,at DESC,rowid ASC"#,
            )
            .map_err(sql)?;
        let sources = self
            .db()?
            .prepare("SELECT DISTINCT source_id FROM catalog_attempts")
            .map_err(sql)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        for id in sources {
            let mut rows = latest.query([&id]).map_err(sql)?;
            while let Some(row) = rows.next().map_err(sql)? {
                let payload: String = row.get(0).map_err(sql)?;
                #[cfg(test)]
                self.attempt_decodes.set(self.attempt_decodes.get() + 1);
                let Ok(value) = decode::<Value>(&payload) else {
                    continue;
                };
                if attempts.get(&id).is_some_and(|old| {
                    value["at"]
                        .as_f64()
                        .zip(old["at"].as_f64())
                        .is_some_and(|(a, b)| a <= b)
                }) {
                    break;
                }
                if valid_attempt(&value) {
                    attempts.insert(id.clone(), canonical_attempt(&value));
                    break;
                }
            }
        }
        let attempts = Value::Object(attempts);
        *self.source_attempt_cache.borrow_mut() = Some((version, attempts.clone()));
        Ok(attempts)
    }
    pub fn typed_source_attempts(
        &self,
    ) -> Result<std::collections::BTreeMap<String, super::model::SourceAttempt>> {
        let mut attempts = self.source_attempts()?;
        if let Some(attempts) = attempts.as_object_mut() {
            for attempt in attempts.values_mut() {
                for key in ["at", "nextEligibleAt"] {
                    if let Some(value) = attempt.get_mut(key) {
                        if let Some(number) = value.as_f64() {
                            if number.fract() != 0.0 {
                                let rounded = number.ceil();
                                if rounded >= i64::MIN as f64 && rounded <= i64::MAX as f64 {
                                    *value = json!(rounded as i64);
                                }
                            }
                        }
                    }
                }
            }
        }
        serde_json::from_value(attempts).map_err(|e| e.to_string())
    }
    pub fn working_feeds(&self) -> Result<Vec<super::model::WorkingFeed>> {
        let rows = self
            .db()?
            .prepare("SELECT game_id,candidate_id,identity_hash,payload FROM working_feeds")
            .map_err(sql)?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        let mut feeds = Vec::new();
        for (game, id, hash, payload) in rows {
            if let Ok(value) = decode::<Value>(&payload) {
                if valid_payload("working", &value)
                    && value["candidate"]["gameId"] == game
                    && value["candidate"]["id"] == id
                    && value["identityHash"] == hash
                {
                    feeds.push(serde_json::from_value(value).map_err(|e| e.to_string())?);
                    continue;
                }
            }
            self.db()?
                .execute(
                    "DELETE FROM working_feeds WHERE game_id=? AND candidate_id=?",
                    params![game, id],
                )
                .map_err(sql)?;
        }
        Ok(feeds)
    }
    pub fn feed_checks(&self, now: i64) -> Result<Vec<super::model::FeedCheck>> {
        let rows=self.db()?.prepare("SELECT game_id,identity_hash,payload,at FROM feed_checks WHERE at > ? AND at <= ? ORDER BY at DESC LIMIT 10000").map_err(sql)?.query_map(params![now-CHECK_RETENTION,now+60000],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).map_err(sql)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql)?;
        Ok(rows
            .into_iter()
            .filter_map(|(game, hash, payload, at)| {
                decode::<Value>(&payload)
                    .ok()
                    .filter(|v| {
                        valid_payload("check", v)
                            && v["gameId"] == game
                            && v["identityHash"] == hash
                            && v["outcome"]["checkedAt"] == at
                    })
                    .and_then(|v| serde_json::from_value(v).ok())
            })
            .collect())
    }
    pub fn save_feed_check(&self, value: &super::model::FeedCheck) -> Result<()> {
        self.save_feed_check_value(&serde_json::to_value(value).map_err(|e| e.to_string())?)
    }
    fn save_feed_check_value(&self, value: &Value) -> Result<()> {
        require("check", value)?;
        self.transaction(|| {
        self.db()?.execute("INSERT INTO feed_checks VALUES (?,?,?,?) ON CONFLICT(game_id,identity_hash) DO UPDATE SET payload=excluded.payload,at=excluded.at",params![field(value,"gameId")?,field(value,"identityHash")?,encode(value)?,number(&value["outcome"],"checkedAt")?]).map_err(sql)?;
        if value["outcome"]["kind"]=="unavailable" {self.db()?.execute("DELETE FROM working_feeds WHERE game_id=? AND identity_hash=?",params![field(value,"gameId")?,field(value,"identityHash")?]).map_err(sql)?;}Ok(())
    })
    }
    pub fn remove_feed_check(&self, game: &str, hash: &str) -> Result<()> {
        self.db()?
            .execute(
                "DELETE FROM feed_checks WHERE game_id=? AND identity_hash=?",
                params![game, hash],
            )
            .map_err(sql)?;
        Ok(())
    }
    pub fn replace_working_identity(
        &self,
        game: &str,
        hash: &str,
        feeds: &[super::model::WorkingFeed],
    ) -> Result<()> {
        self.replace_working_values(
            game,
            hash,
            &feeds
                .iter()
                .map(serde_json::to_value)
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
        )
    }
    fn replace_working_values(&self, game: &str, hash: &str, feeds: &[Value]) -> Result<()> {
        for feed in feeds {
            require("working", feed)?;
            if feed["candidate"]["gameId"] != game || feed["identityHash"] != hash {
                return Err("working-feed-identity-mismatch".into());
            }
        }
        let mut feeds = feeds.iter().collect::<Vec<_>>();
        feeds.sort_by(|a, b| {
            a["candidate"]["id"]
                .as_str()
                .cmp(&b["candidate"]["id"].as_str())
        });
        let payloads = feeds
            .iter()
            .map(|v| encode(v))
            .collect::<Result<Vec<_>>>()?;
        let previous=self.db()?.prepare("SELECT payload FROM working_feeds WHERE game_id=? AND identity_hash=? ORDER BY candidate_id").map_err(sql)?.query_map(params![game,hash],|r|r.get::<_,String>(0)).map_err(sql)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql)?;
        if previous == payloads {
            return Ok(());
        }
        self.transaction(|| {
            if let Some(at)=feeds.iter().filter_map(|v|v["checkedAt"].as_i64()).max() {self.db()?.execute("DELETE FROM feed_checks WHERE game_id=? AND identity_hash=? AND at <= ?",params![game,hash,at]).map_err(sql)?;}
            self.db()?.execute("DELETE FROM working_feeds WHERE game_id=? AND identity_hash=?",params![game,hash]).map_err(sql)?;
            for(feed,payload)in feeds.iter().zip(payloads) {self.db()?.execute("INSERT INTO working_feeds VALUES (?,?,?,?) ON CONFLICT(game_id,candidate_id) DO UPDATE SET identity_hash=excluded.identity_hash,payload=excluded.payload",params![game,field(&feed["candidate"],"id")?,hash,payload]).map_err(sql)?;}Ok(())
        })
    }
    pub fn remove_working_games(&self, games: &[String]) -> Result<()> {
        for game in games {
            self.db()?
                .execute("DELETE FROM working_feeds WHERE game_id=?", [game])
                .map_err(sql)?;
        }
        Ok(())
    }
    pub fn source_event_bindings(&self) -> Result<Vec<SourceEventBinding>> {
        self.rows(
            "SELECT payload FROM source_event_bindings ORDER BY at DESC LIMIT 10000",
            [],
            "binding",
        )?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
        .collect()
    }
    fn bind(&self, value: &Value) -> Result<()> {
        require("binding", value)?;
        self.db()?.execute("INSERT INTO source_event_bindings VALUES (?,?,?,?,?) ON CONFLICT(source_id,event_id,url) DO UPDATE SET payload=excluded.payload,at=excluded.at",params![field(value,"sourceId")?,field(value,"eventId")?,field(value,"url")?,encode(value)?,number(value,"observedAt")?]).map_err(sql)?;
        Ok(())
    }
    pub fn collection_history(&self, now: i64) -> Result<Value> {
        let rows=self.db()?.prepare("SELECT source_id,at,outcome,count FROM (SELECT source_id,at,outcome,count,ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY at DESC,id DESC) AS rank FROM diagnostics WHERE at>=?) WHERE rank<=16 ORDER BY at DESC").map_err(sql)?.query_map([now-DAY],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).map_err(sql)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql)?;
        Ok(Value::Array(rows.into_iter().filter_map(|(source,at,outcome,count)| {
            if !valid_attempt(&json!({"at":at,"outcome":outcome})){return None;}
            let (id,league)=source.rsplit_once(':').filter(|(_,league)|serde_json::from_value::<super::model::League>(json!(league)).is_ok()).map(|(id,league)|(id.to_owned(),Some(league.to_owned()))).unwrap_or((source,None));
            Some(json!({"sourceId":id,"league":league,"at":at,"outcome":outcome,"count":count}))
        }).collect()))
    }
    fn record_catalog_attempts(&self, id: &str, catalog: &Value) -> Result<()> {
        let Some(categories) = catalog["categories"].as_object() else {
            return Err("invalid-catalog-categories".into());
        };
        for (league, category) in categories {
            let kind = field(category, "kind")?;
            if kind == "pending" {
                continue;
            }
            let at = number(category, "at")?;
            let count = if kind == "collected" {
                catalog["events"].as_array().map_or(0, |events| {
                    events
                        .iter()
                        .filter(|event| event["league"] == *league)
                        .count() as i64
                })
            } else {
                0
            };
            let partial = ["rejectedGames", "catalogIssues"].iter().any(|key| {
                catalog[key]
                    .as_array()
                    .is_some_and(|events| events.iter().any(|event| event["league"] == *league))
            });
            let reason = category["reason"].as_str();
            let outcome = if kind == "collected" {
                if partial {
                    "parser-changed"
                } else if count > 0 {
                    "parsed"
                } else {
                    "empty"
                }
            } else if reason == Some("parser-changed") {
                "parser-changed"
            } else {
                "failed"
            };
            let failure = if kind == "failed" && outcome == "failed" {
                Some(match reason {
                    Some("timeout") => "timed-out",
                    Some("blocked") => "blocked",
                    Some("rate-limited") => "rate-limited",
                    _ => "upstream-error",
                })
            } else {
                None
            };
            let prior=self.payload("SELECT payload FROM catalog_attempts WHERE source_id=? AND league=? ORDER BY at DESC LIMIT 1",params![id,league])?.and_then(|s|decode::<Value>(&s).ok()).filter(valid_attempt);
            let failures = if matches!(outcome, "parsed" | "empty") {
                0
            } else {
                prior
                    .as_ref()
                    .and_then(|v| v["failures"].as_i64())
                    .unwrap_or_default()
                    + 1
            };
            let delay = if kind == "collected" && !partial {
                if count > 0 { 1_800_000 } else { 18_000_000 }
            } else {
                300_000
            };
            let mut attempt = json!({"at":at,"outcome":outcome,"count":count,"failures":failures,"nextEligibleAt":at+delay});
            if let Some(failure) = failure {
                attempt["failure"] = json!(failure);
            }
            if kind == "failed" {
                attempt["catalogReason"] = json!(reason);
            }
            let changes = self
                .db()?
                .execute(
                    "INSERT OR IGNORE INTO catalog_attempts VALUES (?,?,?,?,?)",
                    params![id, league, at, outcome, encode(&attempt)?],
                )
                .map_err(sql)?;
            if changes > 0 {
                self.db()?.execute("INSERT INTO diagnostics (source_id,at,outcome,count,error) VALUES (?,?,?,?,?)",params![format!("{id}:{league}"),at,outcome,count,if kind=="failed"{reason}else{None}]).map_err(sql)?;
            }
        }
        Ok(())
    }
    pub fn save_listing_attempt(
        &self,
        id: &str,
        value: &Value,
        observations: &[Value],
        bindings: &[Value],
    ) -> Result<()> {
        require("attempt", value)?;
        let value = &canonical_attempt(value);
        self.transaction(|| {
            self.db()?.execute("INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![id,encode(value)?]).map_err(sql)?;
            for row in observations {self.observe_value(&row["observation"],&row["result"])?;}
            for binding in bindings {self.bind(binding)?;}
            self.db()?.execute("INSERT INTO diagnostics (source_id,at,outcome,count,error) VALUES (?,?,?,?,?)",params![id,number(value,"at")?,field(value,"outcome")?,value["count"].as_i64().unwrap_or_default(),value["failure"].as_str()]).map_err(sql)?;Ok(())
        })?;
        self.source_attempt_cache.borrow_mut().take();
        Ok(())
    }
    pub fn detail_evidence(&self) -> Result<Vec<super::model::DetailEvidence>> {
        self.rows(
            "SELECT payload FROM details ORDER BY at DESC LIMIT 10000",
            [],
            "detail",
        )?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
        .collect()
    }
    pub fn detail_for(&self, observation_id: &str) -> Result<Option<super::model::DetailEvidence>> {
        self.rows(
            "SELECT payload FROM details WHERE observation_id=?",
            [observation_id],
            "detail",
        )?
        .into_iter()
        .next()
        .map(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
        .transpose()
    }
    pub fn save_detail_evidence(&self, value: &Value, observation: Option<&Value>) -> Result<()> {
        require("detail", value)?;
        self.transaction(|| {
        if let Some(row)=observation {self.observe_value(&row["observation"],&row["result"])?;}
        self.db()?.execute("INSERT INTO details VALUES (?,?,?) ON CONFLICT(observation_id) DO UPDATE SET payload=excluded.payload,at=excluded.at",params![field(value,"observationId")?,encode(value)?,number(value,"at")?]).map_err(sql)?;Ok(())
    })
    }
    fn catalog_payloads(&self, id: &str) -> Result<Option<CatalogPayloads>> {
        let query = if self.previous_catalog_column {
            "SELECT current_payload,complete_payload,previous_payload FROM source_catalogs WHERE id=?"
        } else {
            "SELECT current_payload,complete_payload,NULL FROM source_catalogs WHERE id=?"
        };
        self.db()?
            .query_row(query, [id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .optional()
            .map_err(sql)
    }
    pub fn catalog(&self, id: &str) -> Result<Value> {
        let parse = |s: Option<String>| {
            s.and_then(|s| decode::<Value>(&s).ok())
                .filter(|v| super::catalog::validate_stored_catalog(id, v).is_ok())
        };
        let (current, complete, previous) = self
            .catalog_payloads(id)?
            .map(|(a, b, c)| (parse(Some(a)), parse(b), parse(c)))
            .unwrap_or_default();
        Ok(json!({"current":current,"lastComplete":complete,"previous":previous}))
    }
    pub fn save_catalog(
        &self,
        id: &str,
        value: &Value,
        observations: &[Value],
        bindings: &[Value],
    ) -> Result<()> {
        super::catalog::validate_stored_catalog(id, value)?;
        let payload = encode(value)?;
        self.transaction(|| {
            let old = self.catalog_payloads(id)?;
            let roll_current = if let Some((current, _, _)) = &old {
                let current: Value = decode(current)?;
                super::catalog::validate_stored_catalog(id, &current).is_ok()
                    && current["catalog"]["runId"] != value["catalog"]["runId"]
                    && current["catalog"]["state"]["kind"] != "complete"
            } else {
                false
            };
            let previous = if roll_current {
                old.as_ref().map(|row| row.0.as_str())
            } else {
                old.as_ref().and_then(|row| row.2.as_deref())
            };
            let complete = if value["catalog"]["state"]["kind"] == "complete" {
                Some(payload.as_str())
            } else {
                old.as_ref().and_then(|row| row.1.as_deref())
            };
            if self.previous_catalog_column {self.db()?.execute("INSERT INTO source_catalogs (id,current_payload,complete_payload,previous_payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_payload=excluded.current_payload,complete_payload=excluded.complete_payload,previous_payload=excluded.previous_payload",params![id,payload,complete,previous]).map_err(sql)?;}
            else {self.db()?.execute("INSERT INTO source_catalogs (id,current_payload,complete_payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET current_payload=excluded.current_payload,complete_payload=excluded.complete_payload",params![id,payload,complete]).map_err(sql)?;}
            let replace=id!="streameast"||!observations.is_empty()||value["catalog"]["categories"].as_object().is_some_and(|c|c.values().any(|v|v["kind"]!="pending"));
            if replace {self.db()?.execute("DELETE FROM observations WHERE json_extract(payload,'$.sourceId')=?",[id]).map_err(sql)?;
                for row in observations {let o=&row["observation"];require("observation",o)?;self.db()?.execute("INSERT INTO observations VALUES (?,?,?,?)",params![field(o,"id")?,encode(o)?,encode(&row["result"])?,number(o,"observedAt")?]).map_err(sql)?;}}
            for binding in bindings {self.bind(binding)?;}
            self.record_catalog_attempts(id,&value["catalog"])?;Ok(())
        })?;
        self.source_attempt_cache.borrow_mut().take();
        Ok(())
    }
    pub fn membership(&self, season: i64) -> Result<Option<super::model::SeasonMembership>> {
        self.read_payload(
            "SELECT payload FROM memberships WHERE season=?",
            [season],
            "membership",
        )
    }
    pub fn save_membership(&self, value: &super::model::SeasonMembership) -> Result<()> {
        let v = serde_json::to_value(value).map_err(|e| e.to_string())?;
        self.db()?.execute("INSERT INTO memberships VALUES (?,?,?) ON CONFLICT(season) DO UPDATE SET payload=excluded.payload,at=excluded.at",params![number(&v,"season")?,encode(value)?,number(&v,"at")?]).map_err(sql)?;
        Ok(())
    }
    pub fn alias(&self, old: &str, game: &str) -> Result<()> {
        if self
            .db()?
            .query_row("SELECT id FROM alias_conflicts WHERE id=?", [old], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(sql)?
            .is_some()
        {
            return Ok(());
        }
        if self
            .db()?
            .query_row("SELECT game_id FROM aliases WHERE id=?", [old], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(sql)?
            .is_some_and(|id| id != game)
        {
            self.db()?
                .execute("DELETE FROM aliases WHERE id=?", [old])
                .map_err(sql)?;
            self.db()?
                .execute(
                    "INSERT OR IGNORE INTO alias_conflicts VALUES (?,?)",
                    params![old, Utc::now().timestamp_millis()],
                )
                .map_err(sql)?;
            return Ok(());
        }
        self.db()?
            .execute(
                "INSERT INTO aliases VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
                params![old, game, Utc::now().timestamp_millis()],
            )
            .map_err(sql)?;
        Ok(())
    }
    pub fn aliases(&self) -> Result<Value> {
        let rows = self
            .db()?
            .prepare("SELECT id,game_id FROM aliases")
            .map_err(sql)?
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, Value::String(r.get(1)?)))
            })
            .map_err(sql)?
            .collect::<std::result::Result<serde_json::Map<_, _>, _>>()
            .map_err(sql)?;
        Ok(Value::Object(rows))
    }
    pub fn remove_final_evidence(&self, game_ids: &[String], now: i64) -> Result<()> {
        if game_ids.is_empty() {
            return Ok(());
        }
        let all_finals = self.finals()?;
        let finals = all_finals
            .iter()
            .filter(|g| game_ids.contains(&g.id) && g.grace_ends_at.is_some_and(|at| at <= now))
            .cloned()
            .collect::<Vec<_>>();
        if finals.is_empty() {
            return Ok(());
        }
        let bindings = self.source_event_bindings()?;
        let mut canonical = all_finals;
        for value in self.rows("SELECT payload FROM partitions", [], "partition")? {
            let partition: Partition = serde_json::from_value(value).map_err(|e| e.to_string())?;
            for game in partition.games {
                if !canonical.iter().any(|g| g.id == game.id) {
                    canonical.push(game);
                }
            }
        }
        let selected = super::matching::FinishedGameMatcher::new(&finals);
        let matcher = super::matching::FinishedGameMatcher::new(&canonical);
        let rows = self
            .db()?
            .prepare("SELECT id,payload,result FROM observations")
            .map_err(sql)?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        let mut ids = Vec::new();
        for (id, payload, result) in rows {
            let Ok(observation) = decode::<Observation>(&payload) else {
                continue;
            };
            let result: Value = decode(&result)?;
            let event = cached_regex!(r"^https://v2\.sportsurge\.net/watch-(\d{1,12})-[a-z0-9]+-")
                .unwrap()
                .captures(&observation.url)
                .and_then(|c| {
                    observation
                        .league
                        .as_ref()
                        .and_then(|league| serde_json::to_value(league).ok())
                        .and_then(|league| {
                            league.as_str().map(|league| format!("{league}:{}", &c[1]))
                        })
                });
            let bound = matcher.finished_bound_event(
                &observation,
                event.as_deref().unwrap_or(&observation.id),
                &bindings,
            );
            if result["kind"] == "matched" && finals.iter().any(|g| result["gameId"] == g.id)
                || selected.finished_game_id(&observation, now, None).is_some()
                || bound.is_some_and(|id| finals.iter().any(|g| g.id == id))
            {
                ids.push(id);
            }
        }
        self.transaction(|| {
            self.remove_working_games(&finals.iter().map(|g| g.id.clone()).collect::<Vec<_>>())?;
            for id in ids {
                self.db()?
                    .execute("DELETE FROM details WHERE observation_id=?", [&id])
                    .map_err(sql)?;
                self.db()?
                    .execute("DELETE FROM observations WHERE id=?", [id])
                    .map_err(sql)?;
            }
            Ok(())
        })
    }
    pub fn sweep(&self, now: i64) -> Result<()> {
        let ids = self
            .finals()?
            .into_iter()
            .filter(|g| g.grace_ends_at.is_some_and(|at| at <= now))
            .map(|g| g.id)
            .collect::<Vec<_>>();
        self.remove_final_evidence(&ids, now)?;
        self.transaction(|| {
            self.db()?.execute("DELETE FROM feed_checks WHERE at <= ? OR game_id IN (SELECT id FROM finals WHERE json_extract(payload,'$.graceEndsAt') <= ?)",params![now-CHECK_RETENTION,now]).map_err(sql)?;
            self.db()?.execute_batch("DELETE FROM feed_checks WHERE rowid IN (SELECT rowid FROM feed_checks ORDER BY at DESC LIMIT -1 OFFSET 10000)").map_err(sql)?;
            for table in ["observations","source_event_bindings"] {self.db()?.execute(&format!("DELETE FROM {table} WHERE at < ?"),[now-7*DAY]).map_err(sql)?;}
            self.db()?.execute_batch("DELETE FROM source_event_bindings WHERE rowid IN (SELECT rowid FROM source_event_bindings ORDER BY at DESC LIMIT -1 OFFSET 10000)").map_err(sql)?;
            self.db()?.execute("DELETE FROM details WHERE at < ? OR observation_id NOT IN (SELECT id FROM observations)",[now-7*DAY]).map_err(sql)?;
            self.db()?.execute("DELETE FROM observations WHERE json_extract(result,'$.gameId') IN (SELECT id FROM finals WHERE json_extract(payload,'$.graceEndsAt') <= ?)",[now]).map_err(sql)?;
            self.db()?.execute_batch("DELETE FROM observations WHERE id IN (SELECT id FROM observations ORDER BY at DESC LIMIT -1 OFFSET 10000)").map_err(sql)?;
            for table in ["finals","aliases","alias_conflicts"] {self.db()?.execute(&format!("DELETE FROM {table} WHERE at < ?"),[now-2*366*DAY]).map_err(sql)?;}
            for table in ["diagnostics","catalog_attempts"] {self.db()?.execute(&format!("DELETE FROM {table} WHERE at < ?"),[now-30*DAY]).map_err(sql)?;}
            let year=chrono::DateTime::from_timestamp_millis(now).ok_or("invalid-time")?.year();
            self.db()?.execute("DELETE FROM memberships WHERE season < ?",[year-2]).map_err(sql)?;
            self.db()?.execute_batch("DELETE FROM diagnostics WHERE id IN (SELECT id FROM diagnostics ORDER BY at DESC LIMIT -1 OFFSET 10000)").map_err(sql)?;Ok(())
        })?;
        self.source_attempt_cache.borrow_mut().take();
        Ok(())
    }
    pub fn call(&mut self, operation: &str, args: Value) -> Result<Value> {
        let args = array(&args)?;
        let get = |index: usize| {
            args.get(index)
                .ok_or_else(|| format!("missing-argument-{index}"))
        };
        let string = |index: usize| {
            get(index)?
                .as_str()
                .ok_or_else(|| format!("invalid-argument-{index}"))
        };
        let int = |index: usize| {
            get(index)?
                .as_i64()
                .ok_or_else(|| format!("invalid-argument-{index}"))
        };
        let list = |index: usize| array(get(index)?);
        let strings = |index: usize| {
            serde_json::from_value::<Vec<String>>(get(index)?.clone()).map_err(|e| e.to_string())
        };
        let output =
            match operation {
                "finishedGameRetentionMinutes" => json!(self.finished_game_retention_minutes()?),
                "setFinishedGameRetentionMinutes" => {
                    self.set_finished_game_retention_minutes(int(0)?)?;
                    Value::Null
                }
                "partition" => {
                    serde_json::to_value(self.partition(string(0)?)?).map_err(|e| e.to_string())?
                }
                "savePartition" => {
                    self.save_partition(
                        string(0)?,
                        &serde_json::from_value(get(1)?.clone()).map_err(|e| e.to_string())?,
                    )?;
                    Value::Null
                }
                "finals" => serde_json::to_value(self.finals()?).map_err(|e| e.to_string())?,
                "observe" => {
                    self.observe_value(get(0)?, get(1)?)?;
                    Value::Null
                }
                "observations" => {
                    serde_json::to_value(self.observations()?).map_err(|e| e.to_string())?
                }
                "observation" => serde_json::to_value(self.observation(string(0)?)?)
                    .map_err(|e| e.to_string())?,
                "sourceAttempts" => self.source_attempts()?,
                "workingFeeds" => {
                    serde_json::to_value(self.working_feeds()?).map_err(|e| e.to_string())?
                }
                "feedChecks" => {
                    serde_json::to_value(self.feed_checks(int(0)?)?).map_err(|e| e.to_string())?
                }
                "saveFeedCheck" => {
                    self.save_feed_check_value(get(0)?)?;
                    Value::Null
                }
                "removeFeedCheck" => {
                    self.remove_feed_check(string(0)?, string(1)?)?;
                    Value::Null
                }
                "replaceWorkingIdentity" => {
                    self.replace_working_values(string(0)?, string(1)?, list(2)?)?;
                    Value::Null
                }
                "removeWorkingGames" => {
                    self.remove_working_games(&strings(0)?)?;
                    Value::Null
                }
                "sourceEventBindings" => serde_json::to_value(self.source_event_bindings()?)
                    .map_err(|e| e.to_string())?,
                "removeFinalEvidence" => {
                    self.remove_final_evidence(&strings(0)?, int(1)?)?;
                    Value::Null
                }
                "collectionHistory" => self.collection_history(int(0)?)?,
                "saveListingAttempt" => {
                    self.save_listing_attempt(
                        string(0)?,
                        get(1)?,
                        list(2)?,
                        args.get(3).map(array).transpose()?.unwrap_or_default(),
                    )?;
                    Value::Null
                }
                "detailEvidence" => {
                    serde_json::to_value(self.detail_evidence()?).map_err(|e| e.to_string())?
                }
                "saveDetailEvidence" => {
                    self.save_detail_evidence(get(0)?, args.get(1).filter(|v| !v.is_null()))?;
                    Value::Null
                }
                "sportsurgeCatalog" => self.catalog("sportsurge-v2")?,
                "streameastCatalog" => self.catalog("streameast")?,
                "saveSportsurgeCatalog" => {
                    self.save_catalog(
                        "sportsurge-v2",
                        get(0)?,
                        list(1)?,
                        args.get(2).map(array).transpose()?.unwrap_or_default(),
                    )?;
                    Value::Null
                }
                "saveStreameastCatalog" => {
                    self.save_catalog("streameast", get(0)?, list(1)?, &[])?;
                    Value::Null
                }
                "membership" => {
                    serde_json::to_value(self.membership(int(0)?)?).map_err(|e| e.to_string())?
                }
                "saveMembership" => {
                    self.save_membership(
                        &serde_json::from_value(get(0)?.clone()).map_err(|e| e.to_string())?,
                    )?;
                    Value::Null
                }
                "alias" => {
                    self.alias(string(0)?, string(1)?)?;
                    Value::Null
                }
                "aliases" => self.aliases()?,
                "sweep" => {
                    self.sweep(int(0)?)?;
                    Value::Null
                }
                _ => return Err(format!("unknown-store-operation:{operation}")),
            };
        Ok(output)
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_lookup_reads_one_current_row_and_skips_invalid_payloads() {
        let store = Store::open(":memory:", None, None).unwrap();
        let expected = json!({"outcome":"unresolved","observationId":"wanted","generation":"generation","at":100,"reason":"not-yet-published","failures":0,"nextEligibleAt":200});
        store.save_detail_evidence(&expected, None).unwrap();
        for (id, payload) in [
            ("broken", "{"),
            ("invalid", "{}"),
            ("wrong-shape", r#"{"outcome":"resolved","players":false}"#),
        ] {
            store
                .db()
                .unwrap()
                .execute(
                    "INSERT INTO details VALUES (?,?,?)",
                    params![id, payload, 1000],
                )
                .unwrap();
        }
        assert_eq!(
            serde_json::to_value(store.detail_for("wanted").unwrap()).unwrap(),
            expected
        );
        for id in [
            "missing",
            "broken",
            "invalid",
            "wrong-shape",
            "missing' OR 1=1 --",
        ] {
            assert!(store.detail_for(id).unwrap().is_none(), "{id}");
        }
        let mut updated = expected;
        updated["at"] = json!(150);
        store.save_detail_evidence(&updated, None).unwrap();
        assert_eq!(
            serde_json::to_value(store.detail_for("wanted").unwrap()).unwrap(),
            updated
        );
    }

    #[test]
    fn catalog_saves_preserve_raw_history_and_only_roll_valid_current_runs() {
        let store = Store::open(":memory:", None, None).unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-store.json"
        ))
        .unwrap();
        let catalogs: Vec<_> = fixture["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["operation"] == "saveSportsurgeCatalog")
            .map(|step| &step["args"][0])
            .collect();
        let complete = format!(" \n{}\n ", catalogs[0]);
        let collecting = format!(" \n{}\n ", catalogs[1]);
        let old_complete = "not JSON, preserved until replaced by a complete run";
        let old_previous = r#"{"legacy":"preserved verbatim"}"#;
        let history = || {
            store.db().unwrap().query_row(
                "SELECT current_payload,complete_payload,previous_payload FROM source_catalogs WHERE id='sportsurge-v2'",
                [],
                |row| Ok((row.get::<_, String>(0)?,row.get::<_, Option<String>>(1)?,row.get::<_, Option<String>>(2)?)),
            ).unwrap()
        };
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO source_catalogs VALUES ('sportsurge-v2',?,?,?)",
                params![complete, old_complete, old_previous],
            )
            .unwrap();
        store
            .save_catalog("sportsurge-v2", catalogs[1], &[], &[])
            .unwrap();
        assert_eq!(history().1.as_deref(), Some(old_complete));
        assert_eq!(history().2.as_deref(), Some(old_previous));

        store
            .db()
            .unwrap()
            .execute(
                "UPDATE source_catalogs SET current_payload=? WHERE id='sportsurge-v2'",
                [&collecting],
            )
            .unwrap();
        store
            .save_catalog("sportsurge-v2", catalogs[2], &[], &[])
            .unwrap();
        assert_eq!(history().1.as_deref(), Some(old_complete));
        assert_eq!(history().2.as_deref(), Some(collecting.as_str()));

        store
            .db()
            .unwrap()
            .execute(
                "UPDATE source_catalogs SET current_payload='{}' WHERE id='sportsurge-v2'",
                [],
            )
            .unwrap();
        store
            .save_catalog("sportsurge-v2", catalogs[1], &[], &[])
            .unwrap();
        assert_eq!(history().1.as_deref(), Some(old_complete));
        assert_eq!(history().2.as_deref(), Some(collecting.as_str()));

        store
            .db()
            .unwrap()
            .execute(
                "UPDATE source_catalogs SET current_payload='{' WHERE id='sportsurge-v2'",
                [],
            )
            .unwrap();
        assert!(
            store
                .save_catalog("sportsurge-v2", catalogs[1], &[], &[])
                .is_err()
        );
        assert_eq!(history().0, "{");
    }

    #[test]
    fn partition_times_read_current_metadata_without_decoding_games() {
        let store = Store::open(":memory:", None, None).unwrap();
        for (id, payload) in [
            ("nfl", r#"{"games":[],"at":100}"#),
            ("fbs", r#"{"games":[],"at":1,"at":200}"#),
            ("fcs", r#"{"games":[],"a\u0074":300.5}"#),
            ("invalid", r#"{"games":[],"at":"bad"}"#),
            ("broken", "{"),
        ] {
            store
                .db()
                .unwrap()
                .execute("INSERT INTO partitions VALUES (?,?)", params![id, payload])
                .unwrap();
        }
        assert_eq!(
            store.partition_times().unwrap(),
            std::collections::BTreeMap::from([
                ("nfl".into(), 100),
                ("fbs".into(), 200),
                ("fcs".into(), 301)
            ])
        );
        store
            .save_partition(
                "nfl",
                &Partition {
                    games: vec![],
                    at: 500,
                    week: None,
                },
            )
            .unwrap();
        assert_eq!(store.partition_times().unwrap()["nfl"], 500);
    }

    #[test]
    fn stored_final_accepts_integral_float_json_timestamps() {
        let store = Store::open(":memory:", None, None).unwrap();
        let payload = r##"{"id":"401872954","league":"nfl","name":"New York Jets at Detroit Lions","date":"2026-09-27T17:00Z","home":{"name":"Detroit Lions","short":"Lions","abbreviation":"DET","color":"0076b6","score":"31"},"away":{"name":"New York Jets","short":"Jets","abbreviation":"NYJ","color":"115740","score":"24"},"detail":"Final","redzone":false,"status":"post","lifecycle":"final","finalObservedAt":1790539550644,"graceEndsAt":1790539850644.0}"##;
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO finals VALUES ('401872954',?,1790539550644)",
                [payload],
            )
            .unwrap();
        let games = store.finals().unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].final_observed_at, Some(1790539550644));
        assert_eq!(games[0].grace_ends_at, Some(1790539850644));
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO partitions VALUES ('nfl',?)",
                [format!(r#"{{"games":[{payload}],"at":1790539550644}}"#)],
            )
            .unwrap();
        assert_eq!(store.partition("nfl").unwrap().unwrap().games, games);
    }

    #[test]
    fn frozen_typescript_repository_contract() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-pipeline-store.json"
        ))
        .unwrap();
        let mut store = Store::open(":memory:", Some("parity"), None).unwrap();
        for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
            let operation = step["operation"].as_str().unwrap();
            assert_eq!(
                store.call(operation, step["args"].clone()),
                Ok(step["expected"].clone()),
                "step {index}: {operation}"
            );
        }
    }

    #[test]
    fn latest_source_attempt_uses_last_json_timestamp_and_stable_ties() {
        let store = Store::open(":memory:", None, None).unwrap();
        for (league, at, payload) in [
            ("nfl", 500, r#"{"at":100,"outcome":"parsed","count":1}"#),
            ("ncaaf", 100, r#"{"at":1,"at":200,"outcome":"empty"}"#),
            (
                "nba",
                900,
                r#"{"at":200,"outcome":"failed","failure":"blocked"}"#,
            ),
            ("nhl", 1000, r#"{"at":300,"outcome":"invalid"}"#),
        ] {
            store
                .db()
                .unwrap()
                .execute(
                    "INSERT INTO catalog_attempts VALUES ('source',?,?, 'parsed',?)",
                    params![league, at, payload],
                )
                .unwrap();
        }
        assert_eq!(
            store.source_attempts().unwrap()["source"],
            json!({"at":200,"outcome":"failed","failure":"blocked"})
        );
        // Same-connection writes invalidate the cache even though data_version does not change.
        store
            .save_listing_attempt(
                "source",
                &json!({"at":400,"outcome":"empty","nextEligibleAt":500}),
                &[],
                &[],
            )
            .unwrap();
        assert_eq!(store.source_attempts().unwrap()["source"]["at"], 400);
    }

    #[test]
    fn malformed_json_keeps_each_repository_read_error_contract() {
        let store = Store::open(":memory:", None, None).unwrap();
        store
            .db()
            .unwrap()
            .execute("INSERT INTO partitions VALUES ('nfl','{')", [])
            .unwrap();
        assert!(store.partition("nfl").is_err());
        store
            .db()
            .unwrap()
            .execute("INSERT INTO finals VALUES ('1','{',0)", [])
            .unwrap();
        assert!(store.finals().is_err());
        store
            .db()
            .unwrap()
            .execute("INSERT INTO observations VALUES ('1','{','{}',0)", [])
            .unwrap();
        assert!(store.observations().is_err());
        assert!(store.observation("1").is_err());
        store
            .db()
            .unwrap()
            .execute("INSERT INTO memberships VALUES (2026,'{',0)", [])
            .unwrap();
        assert!(store.membership(2026).is_err());
        store
            .db()
            .unwrap()
            .execute("INSERT INTO details VALUES ('1','{',0)", [])
            .unwrap();
        assert!(store.detail_evidence().unwrap().is_empty());
    }

    #[test]
    fn native_attempt_cache_decodes_latest_rows_once_and_observes_external_commits() {
        let path = std::env::temp_dir().join(format!(
            "sports-hub-rust-cache-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut store = Store::open(&path, None, None).unwrap();
        let mut external = Connection::open(&path).unwrap();
        let transaction = external.transaction().unwrap();
        for at in 0..2048 {
            transaction
                .execute(
                    "INSERT INTO catalog_attempts VALUES (?,'nfl',?,'parsed',?)",
                    params![
                        format!("source-{}", at % 4),
                        at,
                        format!(r#"{{"at":{at},"outcome":"parsed","count":{at}}}"#)
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        let expected = store.source_attempts().unwrap();
        for _ in 0..19 {
            assert_eq!(store.source_attempts().unwrap(), expected);
        }
        assert_eq!(store.attempt_decodes.get(), 4);
        external.execute_batch("BEGIN").unwrap();
        external
            .execute("UPDATE catalog_attempts SET payload='{}'", [])
            .unwrap();
        assert_eq!(store.source_attempts().unwrap(), expected);
        external.execute_batch("ROLLBACK").unwrap();
        assert_eq!(store.source_attempts().unwrap(), expected);
        assert_eq!(store.attempt_decodes.get(), 4);
        external
            .execute(
                "INSERT INTO sources VALUES ('fresh',?)",
                [r#"{"at":3000.5,"outcome":"empty","nextEligibleAt":3001.5}"#],
            )
            .unwrap();
        assert_eq!(
            store.source_attempts().unwrap()["fresh"]["at"],
            json!(3000.5)
        );
        assert_eq!(store.typed_source_attempts().unwrap()["fresh"].at, 3001);
        assert_eq!(store.attempt_decodes.get(), 9);
        store.close().unwrap();
        drop(external);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_catalog_column_and_live_writer_reclaim_preserve_schema() {
        let path = std::env::temp_dir().join(format!(
            "sports-hub-rust-store-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let initial = Connection::open(&path).unwrap();
        initial.execute_batch("CREATE TABLE source_catalogs (id TEXT PRIMARY KEY,current_payload TEXT NOT NULL,complete_payload TEXT) STRICT; PRAGMA user_version=1;").unwrap();
        drop(initial);
        let mut first = Store::open(&path, Some("first"), None).unwrap();
        assert!(
            matches!(Store::open(&path,Some("second"),None),Err(e)if e=="football-writer-already-active")
        );
        let mut reclaimed = Store::open(&path, Some("second"), Some("first")).unwrap();
        first.close().unwrap();
        assert_eq!(
            reclaimed
                .db()
                .unwrap()
                .query_row("SELECT token FROM owner", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "second"
        );
        assert!(!reclaimed.previous_catalog_column);
        let catalog = json!({"receivedAt":1,"catalog":{"runId":"11111111-1111-4111-8111-111111111111","sequence":1,"startedAt":1,"state":{"kind":"complete","at":1},"categories":{"nfl":{"kind":"collected","at":1},"ncaaf":{"kind":"collected","at":1}},"events":[],"rejectedGames":[],"catalogIssues":[]}});
        reclaimed
            .save_catalog("sportsurge-v2", &catalog, &[], &[])
            .unwrap();
        let read = reclaimed.catalog("sportsurge-v2").unwrap();
        assert_eq!(read["current"], catalog);
        assert_eq!(read["previous"], Value::Null);
        assert_eq!(
            reclaimed
                .db()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        reclaimed.close().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
