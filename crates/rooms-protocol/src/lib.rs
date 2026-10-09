//! Rooms Protocol v1 — the single definition of every wire type.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub use ts_rs::TS;

pub mod layout;

pub const PROTOCOL_VERSION: &str = "1";
pub const JOURNAL_ROOM_ID: &str = "journal";
/// Every permission a plugin manifest may declare. The app's enable card has copy for each.
pub const PERMISSIONS: [&str; 4] = ["rooms.read", "clipboard", "downloads", "artifact.content"];
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
    /// Changes when the manifest, the entry file or a content script changes.
    pub rev: String,
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
pub enum AskMode { Resume, New }

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

/// What a conversation is about, and the one thread it keeps: a doc (by the file key its rooms
/// share), a room, or a Journal day.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum AskScope {
    #[serde(rename_all = "camelCase")] Doc { file_key: String },
    #[serde(rename_all = "camelCase")] Room { room_id: RoomId },
    Day { date: IsoDate },
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
