//! Rooms Protocol v1 — the single definition of every wire type.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub use ts_rs::TS;

pub mod layout;

pub const PROTOCOL_VERSION: &str = "1";
pub const JOURNAL_ROOM_ID: &str = "journal";
/// Every permission a plugin manifest may declare. The app's enable card has copy for each.
pub const PERMISSIONS: [&str; 5] = ["rooms.read", "clipboard", "downloads", "artifact.content", "surfaces.text"];
/// The id of the inbox, the owned room every home has (its folder is `<home>/inbox`).
pub const INBOX_ROOM_ID: &str = "inbox";

pub type RoomId = String;
pub type ArtifactId = String;
pub type IsoDate = String;

macro_rules! wire {
    ($item:item) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
        #[serde(rename_all = "camelCase")]
        #[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
        $item
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum RoomKind { Owned, Linked, Journal }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum RoomStatus { Ok, Unavailable }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum Author { Agent, Me }

/// The tint a room is pinned with. A room without one is neutral and unpinned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum RoomColor { Stone, Dusk, Sage, Clay, Oat, Lilac, Sea, Rose }

wire!(pub struct Room {
    pub id: RoomId,
    pub name: String,
    pub kind: RoomKind,
    pub path: String,
    pub status: RoomStatus,
    pub artifact_count: u32,
    pub updated_at: Option<String>,
    /// Set = pinned. `GET /v1/rooms` lists pinned rooms before the others; the inbox keeps its place.
    pub color: Option<RoomColor>,
});

wire!(#[derive(Default)] pub struct Source {
    pub agent: Option<String>,
    pub session: Option<String>,
    pub cwd: Option<String>,
    pub machine: Option<String>,
});

wire!(pub struct Artifact {
    pub id: ArtifactId,
    pub room_id: RoomId,
    pub rel_path: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub author: Author,
    pub source: Source,
    /// Stable key of the original file: set when the artifact is first indexed, kept when Rooms
    /// moves it. Artifacts linking the same original share it.
    pub file_key: String,
});

wire!(pub struct Note {
    pub date: IsoDate,
    pub name: String,
    pub rel_path: String,
    pub updated_at: String,
    pub author: Author,
});

wire!(pub struct JournalDay {
    pub date: IsoDate,
    pub artifacts: Vec<Artifact>,
    pub notes: Vec<Note>,
    pub conversations: Vec<JournalConversation>,
});

/// A coding agent whose conversations Rooms reads from its own logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum Agent {
    #[serde(rename = "claude-code")] ClaudeCode,
    #[serde(rename = "codex")] Codex,
    #[serde(rename = "aside")] Aside,
}

impl Agent {
    pub const ALL: [Agent; 3] = [Agent::ClaudeCode, Agent::Codex, Agent::Aside];

    /// The name on the wire and in the agents' log records (`claude-code`, `codex`, `aside`).
    pub fn as_str(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude-code",
            Agent::Codex => "codex",
            Agent::Aside => "aside",
        }
    }

    pub fn parse(s: &str) -> Option<Agent> { Agent::ALL.into_iter().find(|a| a.as_str() == s) }

    /// The command line that continues `session` in a terminal.
    pub fn resume_argv(self, session: &SessionId) -> Vec<String> {
        let s = session.as_str().to_string();
        match self {
            Agent::ClaudeCode => vec!["claude".into(), "--resume".into(), s],
            Agent::Codex => vec!["codex".into(), "resume".into(), s],
            Agent::Aside => vec!["aside".into(), "session".into(), "resume".into(), s],
        }
    }
}

/// An agent's session id: `^[A-Za-z0-9_-]{1,128}$`. It ends up in a resume command line, so
/// nothing else gets through.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SessionId(String);

impl SessionId {
    pub fn parse(s: &str) -> Option<SessionId> {
        let ok = (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        ok.then(|| SessionId(s.to_string()))
    }

    pub fn as_str(&self) -> &str { &self.0 }
}

impl TryFrom<String> for SessionId {
    type Error = String;
    fn try_from(s: String) -> Result<Self, String> { SessionId::parse(&s).ok_or_else(|| format!("invalid session id {s:?}")) }
}

impl From<SessionId> for String {
    fn from(s: SessionId) -> String { s.0 }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}

/// One conversation: an agent's session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS, JsonSchema)]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub struct ConversationId {
    pub agent: Agent,
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub session: SessionId,
}

impl ConversationId {
    /// `<agent>:<session>`, the key it is stored under.
    pub fn key(&self) -> String { format!("{}:{}", self.agent.as_str(), self.session) }

    pub fn parse_key(key: &str) -> Option<ConversationId> {
        let (agent, session) = key.split_once(':')?;
        Some(ConversationId { agent: Agent::parse(agent)?, session: SessionId::parse(session)? })
    }

    pub fn resume_argv(&self) -> Vec<String> { self.agent.resume_argv(&self.session) }
}

wire!(
/// A conversation as the Journal and a room show it. Times are UTC (`YYYY-MM-DDTHH:MM:SSZ`).
pub struct Conversation {
    pub id: ConversationId,
    /// The title the user gave it, else the agent's, else its first prompt; `None` when it has none.
    pub title: Option<String>,
    /// The folder it started in.
    pub cwd: Option<String>,
    pub started_at: String,
    pub ended_at: String,
    pub messages: u32,
    /// The start of the agent's last message.
    pub last_reply: Option<String>,
    /// Absolute paths of the artifacts it wrote, first written first.
    pub artifacts_written: Vec<String>,
    /// The room the user added it to, if any (at most one).
    pub room_id: Option<RoomId>,
});

wire!(
/// A conversation on one Journal day, placed at its first message that day (UTC).
pub struct JournalConversation {
    pub at: String,
    pub conversation: Conversation,
});

wire!(pub struct Info {
    pub version: String,
    pub read_only: bool,
    pub home: String,
    pub journal_room_id: String,
    pub files_origin: String,
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum PluginStatus { Ok, Invalid }

wire!(pub struct SidePanelSlot {
    pub title: String,
    pub icon: Option<String>,
});

wire!(pub struct TabSlot {
    pub title: String,
    pub icon: Option<String>,
    pub sidebar: bool,
});

wire!(
/// The slots a manifest declares (`slots["artifact.sidePanel"]`, `slots["tab"]`).
#[derive(Default)] pub struct PluginSlots {
    pub artifact_side_panel: Option<SidePanelSlot>,
    pub tab: Option<TabSlot>,
});

wire!(
/// A plugin folder under `<home>/.rooms/plugins/`. When `status` is `invalid`, only `id` (the
/// folder name), `status` and `reason` are meaningful.
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub min_app_version: String,
    pub description: Option<String>,
    pub entry: String,
    pub permissions: Vec<String>,
    pub slots: PluginSlots,
    pub status: PluginStatus,
    pub reason: Option<String>,
    pub enabled: bool,
    /// The permissions the user approved; `None` until they first turn the plugin on.
    pub granted: Option<Vec<String>>,
    /// Valid, and either never approved or declaring permissions beyond `granted`. Turning a
    /// plugin off keeps its approval, so an off plugin doesn't need approval to come back.
    pub needs_approval: bool,
    /// Changes when the manifest, the entry file, a content script or the background page changes.
    pub rev: String,
    /// The HTML page the app runs hidden while the plugin is on (manifest `background`); needs `surfaces.text`.
    pub background: Option<String>,
});

wire!(pub struct ApiError {
    pub error: String,
    pub message: String,
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum AskStatus { Running, Done, Failed, Cancelled }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum AskMode {
    /// A fork of the conversation that made the doc.
    Resume,
    /// A fresh conversation: that one couldn't be found.
    New,
    /// The agent session an earlier question in this thread started (`AskTurn::session`).
    Continue,
}

/// What a turn is: a question, or a command typed in the ask bar (`/new`, `/compact`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum AskKind {
    #[default]
    Question,
    /// Starts over: earlier Q&A is no longer sent along. Nothing runs.
    Clear,
    /// The agent summarizes the Q&A so far; the summary (the answer) is sent along in its place.
    Compact,
}

/// What an ask thread is about, and the one thread it keeps: a doc (by the file key its rooms
/// share), a room, a Journal day, or an agent conversation (asked in a fork of its own session).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum AskScope {
    #[serde(rename_all = "camelCase")] Doc { file_key: String },
    #[serde(rename_all = "camelCase")] Room { room_id: RoomId },
    Day { date: IsoDate },
    Conversation {
        agent: Agent,
        #[ts(type = "string")]
        #[schemars(with = "String")]
        session: SessionId,
    },
}

wire!(
/// One question and its answer in a scope's thread (spec v2 ask). A doc's go to the agent that
/// made it.
pub struct AskTurn {
    pub id: String,
    pub scope: AskScope,
    pub question: String,
    /// The answer: the agent's stdout (ANSI stripped, trimmed), or what its profile's event rules
    /// read from it. Empty while running (`ask.progress` carries the answer so far).
    pub answer: String,
    pub agent: String,
    /// The model picked for this turn; `None` = the agent's own default.
    pub model: Option<String>,
    pub mode: AskMode,
    pub status: AskStatus,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// Ids of the images attached to the question (`<home>/.rooms/asks/images/<id>`).
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub kind: AskKind,
    /// Earlier answers in this conversation that were too many or too long to send along.
    #[serde(default)]
    pub left_out: u32,
    /// The agent's own session this turn ran in, read from its output; the next question
    /// continues it. `None` when the profile doesn't say how to read it.
    #[serde(default)]
    pub session: Option<String>,
});

wire!(
/// A tool a plugin declares in its manifest; `input` is a JSON Schema for the agent (stored, not enforced).
pub struct ToolInfo {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    #[ts(type = "unknown")]
    pub input: serde_json::Value,
});

wire!(pub struct ToolCall {
    pub plugin_id: String,
    pub name: String,
    #[ts(type = "unknown")]
    pub input: serde_json::Value,
});

wire!(
/// The data path (under the plugin's `data/`) a tool call appended to.
pub struct ToolResult {
    pub path: String,
});

wire!(pub struct StartAsk {
    pub scope: AskScope,
    pub question: String,
    /// One of `AskTarget::models`; `None` or empty = the agent's own default.
    pub model: Option<String>,
    /// Ids from `POST /v1/asks/images`, at most 5.
    #[serde(default)]
    #[ts(optional)]
    pub images: Option<Vec<String>>,
    /// `None` = a question. `clear` and `compact` ignore `question` and `images`.
    #[serde(default)]
    #[ts(optional)]
    pub kind: Option<AskKind>,
});

wire!(
/// A stored question image (`POST /v1/asks/images`); its file is served at `<filesOrigin>/_asks/images/<id>`.
pub struct AskImage {
    pub id: String,
});

wire!(
/// Which agent an ask in this scope would go to, and the models it can pick from (empty = no choice).
pub struct AskTarget {
    pub agent: String,
    pub mode: AskMode,
    pub models: Vec<String>,
    /// A room or day ask whose agent is made to read only the listed files (the claude-code
    /// `--settings` rules), not just asked to. Always false for a doc.
    pub scoped: bool,
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "type")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum EventKind {
    #[serde(rename = "room.added")] RoomAdded { room: Room },
    #[serde(rename = "room.updated")] RoomUpdated { room: Room },
    #[serde(rename = "room.removed", rename_all = "camelCase")] RoomRemoved { room_id: RoomId },
    /// The sidebar order changed; `room_ids` is the full new order (as `GET /v1/rooms` lists it).
    #[serde(rename = "rooms.reordered", rename_all = "camelCase")] RoomsReordered { room_ids: Vec<RoomId> },
    /// Something under `.rooms/plugins/` changed (outside plugins' `data/`) or a plugin was turned on/off: list again.
    #[serde(rename = "plugins.changed")] PluginsChanged {},
    /// A tool call appended to a plugin's data file (bridge writes do not emit this).
    #[serde(rename = "plugin.data.changed", rename_all = "camelCase")] PluginDataChanged { plugin_id: String, path: String },
    #[serde(rename = "artifact.added")] ArtifactAdded { artifact: Artifact },
    #[serde(rename = "artifact.updated")] ArtifactUpdated { artifact: Artifact },
    #[serde(rename = "artifact.removed", rename_all = "camelCase")] ArtifactRemoved { room_id: RoomId, artifact_id: ArtifactId },
    #[serde(rename = "note.saved")] NoteSaved { note: Note },
    #[serde(rename = "note.removed")] NoteRemoved { date: IsoDate, name: String },
    #[serde(rename = "journal.changed")] JournalChanged { date: IsoDate },
    /// A conversation was added to, moved to, or removed from a room; `conversation.room_id` is
    /// where it is now.
    #[serde(rename = "conversation.moved", rename_all = "camelCase")] ConversationMoved { conversation: Conversation, from_room_id: Option<RoomId> },
    #[serde(rename = "ask.started")] AskStarted { turn: AskTurn },
    /// The answer so far and what the agent is doing, while a turn runs (at most ~10 a second, only
    /// on change). Not recorded: a client that missed one just shows the next, or `ask.done`.
    #[serde(rename = "ask.progress", rename_all = "camelCase")] AskProgress { id: String, scope: AskScope, answer: String, activity: Option<String> },
    /// Exactly once per started turn, after every `ask.progress` of it; `turn.answer` is the whole answer.
    #[serde(rename = "ask.done")] AskDone { turn: AskTurn },
    #[serde(rename = "resync", rename_all = "camelCase")] Resync { room_id: Option<RoomId> },
}

wire!(pub struct RoomsEvent {
    #[ts(type = "number")]
    pub seq: u64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub kind: EventKind,
});
