//! Rooms Protocol v1 — the single definition of every wire type.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub use ts_rs::TS;

pub const PROTOCOL_VERSION: &str = "1";
pub const JOURNAL_ROOM_ID: &str = "journal";

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

wire!(pub struct Room {
    pub id: RoomId,
    pub name: String,
    pub kind: RoomKind,
    pub path: String,
    pub status: RoomStatus,
    pub artifact_count: u32,
    pub updated_at: Option<String>,
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

wire!(pub struct ApiError {
    pub error: String,
    pub message: String,
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
    #[serde(rename = "artifact.added")] ArtifactAdded { artifact: Artifact },
    #[serde(rename = "artifact.updated")] ArtifactUpdated { artifact: Artifact },
    #[serde(rename = "artifact.removed", rename_all = "camelCase")] ArtifactRemoved { room_id: RoomId, artifact_id: ArtifactId },
    #[serde(rename = "note.saved")] NoteSaved { note: Note },
    #[serde(rename = "note.removed")] NoteRemoved { date: IsoDate, name: String },
    #[serde(rename = "journal.changed")] JournalChanged { date: IsoDate },
    #[serde(rename = "resync", rename_all = "camelCase")] Resync { room_id: Option<RoomId> },
}

wire!(pub struct RoomsEvent {
    #[ts(type = "number")]
    pub seq: u64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub kind: EventKind,
});
