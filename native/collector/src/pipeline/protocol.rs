use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

pub type Reply = Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Board,
    SetRetention {
        minutes: i64,
    },
    Sources,
    RoomSources,
    FeedLink {
        game_id: String,
        candidate_id: String,
    },
    CheckSources {
        game_ids: Vec<String>,
        #[serde(default)]
        retry: bool,
    },
    Open {
        game_id: String,
        #[serde(default)]
        manual: bool,
        request_id: Option<String>,
        initial_candidate_id: Option<String>,
    },
    Session {
        session_id: String,
        generation: u64,
        candidate_id: Option<String>,
        #[serde(default)]
        failure: bool,
        #[serde(default)]
        retry: bool,
    },
    Close {
        session_id: String,
    },
    Authorize {
        session_id: String,
        candidate_id: String,
        generation: u64,
    },
    PlaybackEvidence {
        session_id: String,
        candidate_id: String,
        generation: u64,
        evidence: Value,
    },
    Refresh,
    SportsurgeCatalog {
        catalog: Value,
    },
    StreameastCatalog {
        catalog: Value,
    },
    CollectorPolling {
        source: String,
    },
    Stop,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: u64,
    pub epoch: u64,
    pub health_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Input {
    Command {
        request_id: u64,
        value: Command,
    },
    Start,
    Configure {
        sources: Vec<super::model::Source>,
    },
    Refresh {
        request_id: u64,
        #[serde(default)]
        force: bool,
    },
    Wake,
    Progress {
        token: Token,
        value: Value,
    },
    Complete {
        token: Token,
        result: Value,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Effect {
    Schedule {
        token: Token,
        source: Value,
        at: i64,
    },
    Membership {
        token: Token,
        season: i64,
    },
    Listing {
        token: Token,
        source: Value,
        at: i64,
    },
    Detail {
        token: Token,
        game_id: String,
        observation: Value,
        at: i64,
    },
    Resolve {
        token: Token,
        game_id: String,
        observation: Value,
        body: String,
        at: i64,
    },
    Metadata {
        token: Token,
        locators: Vec<Value>,
    },
    Verify {
        token: Token,
        locator: Value,
        target: Value,
    },
    Id {
        token: Token,
    },
    CloseSchedule {
        token: Token,
    },
    FlushProbes {
        token: Token,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedRequest {
    pub request_id: u64,
    pub value: CompletedReply,
}

#[derive(Clone, Debug)]
pub enum CompletedReply {
    Owned(Reply),
    Sources { snapshot: Arc<Value>, room: bool },
}

impl Serialize for CompletedReply {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Owned(value) => value.serialize(serializer),
            Self::Sources { snapshot, room } => {
                use serde::ser::SerializeStruct;
                let mut reply = serializer.serialize_struct("Reply", 2)?;
                reply.serialize_field("kind", if *room { "room-sources" } else { "sources" })?;
                reply.serialize_field("snapshot", snapshot.as_ref())?;
                reply.end()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Wake {
    pub at: i64,
    pub version: u64,
}

#[derive(Default, Debug, Serialize)]
pub struct Batch {
    pub replies: Vec<CompletedRequest>,
    pub launch: Vec<Effect>,
    pub cancel: Vec<Token>,
    pub wake: Option<Wake>,
}

pub fn error(status: u16, message: &str) -> Reply {
    serde_json::json!({"kind":"error","status":status,"message":message})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_fixture_preserves_camel_case() {
        let command: Command = serde_json::from_value(
            serde_json::json!({"kind":"open","gameId":"game","requestId":"request"}),
        )
        .unwrap();
        assert!(
            matches!(command,Command::Open{game_id,manual:false,request_id:Some(request),..} if game_id=="game" && request=="request")
        );
    }
}
