# Alto Rooms — Plan 1: Core + roomsd + Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless Rust daemon `roomsd` that turns room folders of HTML artifacts into a versioned HTTP+SSE API (`/v1`), so any client (curl, the future Tauri app, third-party UIs) can list rooms, artifacts, Journal days, and receive live changes.

**Architecture:** Functional core + imperative shell. `rooms-protocol` holds the only definition of wire types (serde; TS via ts-rs, JSON Schema via schemars). `rooms-core` turns the file system (source of truth) into values, keeps a rebuildable SQLite index (`~/rooms/.rooms/index.sqlite`) plus human-readable `state.json`, and broadcasts `RoomsEvent`s. `roomsd` (axum) only translates `RoomsCore` to HTTP/SSE and serves artifact bytes from a separate sandboxed origin.

**Tech Stack:** Rust 1.82+ (edition 2021), tokio, axum 0.8, notify 8 + notify-debouncer-full 0.5, ignore 0.4, lol_html 2, rusqlite 0.32 (bundled), chrono, serde/serde_json, ts-rs 10, schemars 0.8, sha1 + hex, nanoid, unicode-normalization, thiserror, tempfile + insta (tests).

**Spec:** `docs/superpowers/specs/2026-10-05-alto-rooms-v1-spec.html`. Read §2 (rules), §5 (seams S1–S3), §6 (contracts) before starting any task.

**Later plans (not in this plan):** Plan 2 desktop app (Tauri + React + shadcn), Plan 3 onboarding (`ONBOARD.md` + rooms skill), Plan 4 remote web (Tailscale read-only listener on 4319).

## Global Constraints

- Home defaults to `~/rooms/`; Rooms' own state lives only in `~/rooms/.rooms/` (`state.json`, `index.sqlite`, `token`).
- Files are the source of truth. When index and files disagree, files win. Deleting `index.sqlite` must be safe (full backfill rebuilds it; only first-seen times fall back to file times).
- Artifacts = `.html` / `.htm` only. Notes = `.md` directly inside `journal/YYYY-MM-DD/` only.
- Default ignore: hidden entries (leading `.`), `node_modules`, `dist`, `build`, `.next`, `coverage`; linked rooms also honor `.gitignore`; every room honors a user-written `.roomsignore` (gitignore syntax). Rooms never writes `.roomsignore`.
- Rooms never writes anything inside a linked folder.
- Reserved room names (case-insensitive): `journal`, `inbox`. Journal room id is the constant `"journal"`.
- Room name: trimmed, 1–80 chars, no `/ \ :` and no `..`. Folder name = slug = NFC-normalized, spaces → `-`. Collision = slug compared NFC + case-insensitive.
- Note name: 1–60 chars, no path chars, `.md` appended. Note body ≤ 1 MB UTF-8.
- `RoomId` = nanoid(12), immutable. `ArtifactId` = first 16 hex chars of sha1(`roomId + ":" + relPath`).
- Artifact `createdAt` = `rooms:created` meta → persisted first-seen → (first sight only) target birthtime → mtime. For symlinks, times come from the target (stat, follow). Journal day = local date of `createdAt`; never changes afterward.
- Symlinks inside rooms: follow only when the target is an `.html`/`.htm` *file*; never follow directory symlinks inside rooms.
- `listArtifacts` sorted by `createdAt` ascending. `JournalDay.artifacts` deduped by target realpath, sorted by `createdAt` ascending.
- Linked path: absolute realpath, existing readable directory, not Home / ancestor of Home / inside Home, not ancestor or descendant of another linked room (else `overlapping_room` 409).
- Every `RoomsEvent` carries a monotonically increasing `seq`; snapshot GETs return header `X-Rooms-Seq`.
- Writes (POST/PATCH/PUT) require: loopback peer AND `Host` ∈ {`127.0.0.1:4317`, `localhost:4317`} AND `Origin` absent or in allow-list AND `Authorization: Bearer <token>` matching `~/rooms/.rooms/token` (0600, regenerated each start). Otherwise 403 `read_only`.
- API listener `127.0.0.1:4317`; artifact file listener `127.0.0.1:4318` with header `Content-Security-Policy: sandbox allow-scripts allow-popups` (no `allow-same-origin`).
- File event → protocol event ≤ 2 s (300 ms debounce).
- Error codes (exact strings): `invalid_room_name` 400, `room_exists` 409, `invalid_link_path` 400, `overlapping_room` 409, `room_not_found` 404, `invalid_input` 400, `path_escape` 400, `read_only` 403, `write_failed` 500, `unsupported_version` 400.
- No AI, prompts, models or API keys anywhere in this codebase.

## Review Focus

1. **Huge linked folders (e.g. 50k files under a team drive)** — startup must not block the API; backfill runs per room and `/v1/rooms` answers immediately with whatever is indexed. Pinned in Task 8 (`open_returns_before_backfill_completes_for_big_room`).
2. **An agent writes via temp file + rename (`a.html.tmp` → `a.html`)** — must appear once as `artifact.added`, never as remove+add of different ids, and keep its first-seen time. Pinned in Task 8 (`atomic_rename_write_yields_single_add`).
3. **Broken or cyclic symlinks inside a room** — must be skipped silently, never crash or loop. Pinned in Task 3 (`skips_broken_and_directory_symlinks`).
4. **Non-UTF-8 / huge / binary file named `.html`** — title falls back to file name, no panic, reads ≤ 64 KB. Pinned in Task 4 (`binary_and_huge_files_fall_back_to_filename`).
5. **Unicode room names (Korean NFD from Finder vs NFC from the app)** — "연구 도구" typed in the app and a Finder-created NFD folder must collide, not create two rooms. Pinned in Task 2 (`nfd_and_nfc_names_collide`).

---

## File Structure

```
alto-rooms/
  Cargo.toml                         # workspace
  rust-toolchain.toml
  crates/
    rooms-protocol/
      Cargo.toml
      src/lib.rs                     # all wire types (Room, Artifact, Note, JournalDay, Info, RoomsEvent, ApiError)
      tests/shape.rs                 # JSON shape snapshots + TS export
    rooms-core/
      Cargo.toml
      src/lib.rs                     # pub use; module list
      src/error.rs                   # CoreError + code()/status()
      src/rules.rs                   # pure: classify_path, slug, validate names, artifact_id, local_day
      src/walk.rs                    # scan_room (ignore crate)
      src/meta.rs                    # extract_meta (lol_html), FileTimes
      src/state.rs                   # StateStore (state.json): room registry
      src/index.rs                   # Index (rusqlite): artifacts table + first-seen + backfill
      src/core.rs                    # RoomsCore facade
      src/watch.rs                   # notify debouncer -> core.apply_fs_change
      tests/core_flows.rs            # integration tests on temp homes
    roomsd/
      Cargo.toml
      src/main.rs                    # bin: open core, write token, bind 4317 + 4318
      src/lib.rs                     # build_api_router, build_files_router (testable)
      src/guard.rs                   # write guard (loopback/Host/Origin/Bearer)
      src/routes.rs                  # handlers + error mapping + X-Rooms-Seq
      src/sse.rs                     # /v1/events
      tests/api.rs                   # oneshot tests
  packages/protocol-ts/
    package.json
    src/generated/                   # ts-rs output (committed)
    src/client.ts                    # createRoomsClient (thin)
```

---

### Task 0: Toolchain and workspace scaffold

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `.gitignore`
- Create: `crates/rooms-protocol/Cargo.toml`, `crates/rooms-protocol/src/lib.rs`
- Create: `crates/rooms-core/Cargo.toml`, `crates/rooms-core/src/lib.rs`
- Create: `crates/roomsd/Cargo.toml`, `crates/roomsd/src/main.rs`, `crates/roomsd/src/lib.rs`

**Interfaces:**
- Consumes: nothing
- Produces: a compiling Cargo workspace with three crates named `rooms-protocol`, `rooms-core`, `roomsd`

- [ ] **Step 1: Install Rust (needs the user's approval — external installer)**

Ask the user to run:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cargo --version
```
Expected: `cargo 1.8x.x`

- [ ] **Step 2: Write the workspace files**

`Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = ["crates/rooms-protocol", "crates/rooms-core", "crates/roomsd"]

[workspace.package]
edition = "2021"
version = "0.1.0"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
chrono = { version = "0.4", features = ["serde"] }
ts-rs = "10"
schemars = "0.8"
tokio = { version = "1", features = ["full"] }
```

`rust-toolchain.toml`:
```toml
[toolchain]
channel = "stable"
```

`.gitignore`:
```
/target
node_modules
```

`crates/rooms-protocol/Cargo.toml`:
```toml
[package]
name = "rooms-protocol"
edition.workspace = true
version.workspace = true

[dependencies]
serde.workspace = true
ts-rs.workspace = true
schemars.workspace = true

[dev-dependencies]
serde_json.workspace = true
insta = { version = "1", features = ["json"] }
```

`crates/rooms-core/Cargo.toml`:
```toml
[package]
name = "rooms-core"
edition.workspace = true
version.workspace = true

[dependencies]
rooms-protocol = { path = "../rooms-protocol" }
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
chrono.workspace = true
tokio.workspace = true
ignore = "0.4"
lol_html = "2"
rusqlite = { version = "0.32", features = ["bundled"] }
notify = "8"
notify-debouncer-full = "0.5"
sha1 = "0.10"
hex = "0.4"
nanoid = "0.4"
unicode-normalization = "0.1"

[dev-dependencies]
tempfile = "3"
```

`crates/roomsd/Cargo.toml`:
```toml
[package]
name = "roomsd"
edition.workspace = true
version.workspace = true

[dependencies]
rooms-protocol = { path = "../rooms-protocol" }
rooms-core = { path = "../rooms-core" }
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
axum = "0.8"
tower-http = { version = "0.6", features = ["set-header"] }
tokio-stream = { version = "0.1", features = ["sync"] }
futures = "0.3"
nanoid = "0.4"
dirs = "5"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
tempfile = "3"
http-body-util = "0.1"
```

`crates/rooms-protocol/src/lib.rs`, `crates/rooms-core/src/lib.rs`, `crates/roomsd/src/lib.rs`:
```rust
// placeholder module; real content arrives in later tasks
```

`crates/roomsd/src/main.rs`:
```rust
fn main() {}
```

- [ ] **Step 3: Verify it builds**

Run: `cargo test --workspace`
Expected: compiles, `test result: ok. 0 passed`

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml rust-toolchain.toml .gitignore crates
git commit -m "chore: scaffold Rust workspace for rooms-protocol, rooms-core, roomsd"
```

---

### Task 1: Protocol types (`rooms-protocol`)

**Files:**
- Modify: `crates/rooms-protocol/src/lib.rs`
- Test: `crates/rooms-protocol/tests/shape.rs`
- Create: `packages/protocol-ts/package.json`, `packages/protocol-ts/src/generated/` (generated)

**Interfaces:**
- Consumes: nothing
- Produces (exact names, used by every later task):
  - `type RoomId = String; type ArtifactId = String; type IsoDate = String;`
  - `enum RoomKind { Owned, Linked, Journal }` (JSON `"owned"|"linked"|"journal"`)
  - `enum RoomStatus { Ok, Unavailable }` (JSON `"ok"|"unavailable"`)
  - `enum Author { Agent, Me }` (JSON `"agent"|"me"`)
  - `struct Room { id, name, kind, path: String, status, artifact_count: u32, updated_at: Option<String> }`
  - `struct Source { agent, session, cwd, machine: Option<String> }`
  - `struct Artifact { id, room_id, rel_path, title, created_at: String, updated_at: String, author: Author, source: Source }`
  - `struct Note { date, name, rel_path, updated_at: String, author: Author }`
  - `struct JournalDay { date, artifacts: Vec<Artifact>, notes: Vec<Note> }`
  - `struct Info { version: String, read_only: bool, home: String, journal_room_id: String, files_origin: String }`
  - `enum EventKind` (serde tag `type`): `RoomAdded{room}`=`"room.added"`, `RoomUpdated{room}`=`"room.updated"`, `RoomRemoved{room_id}`=`"room.removed"`, `ArtifactAdded{artifact}`, `ArtifactUpdated{artifact}`, `ArtifactRemoved{room_id, artifact_id}`, `NoteSaved{note}`, `NoteRemoved{date, name}`, `JournalChanged{date}`, `Resync{room_id: Option<RoomId>}`
  - `struct RoomsEvent { seq: u64, #[serde(flatten)] kind: EventKind }`
  - `struct ApiError { error: String, message: String }`
  - All JSON keys camelCase.

- [ ] **Step 1: Write the failing test**

`crates/rooms-protocol/tests/shape.rs`:
```rust
use rooms_protocol::*;

#[test]
fn room_serializes_camel_case() {
    let r = Room {
        id: "abc123def456".into(),
        name: "연구 도구".into(),
        kind: RoomKind::Owned,
        path: "/Users/x/rooms/연구-도구".into(),
        status: RoomStatus::Ok,
        artifact_count: 2,
        updated_at: None,
    };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["kind"], "owned");
    assert_eq!(v["artifactCount"], 2);
    assert!(v["updatedAt"].is_null());
}

#[test]
fn event_flattens_seq_and_type() {
    let e = RoomsEvent { seq: 7, kind: EventKind::JournalChanged { date: "2026-10-05".into() } };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["seq"], 7);
    assert_eq!(v["type"], "journal.changed");
    assert_eq!(v["date"], "2026-10-05");
}

#[test]
fn artifact_removed_uses_camel_ids() {
    let e = RoomsEvent { seq: 1, kind: EventKind::ArtifactRemoved { room_id: "r".into(), artifact_id: "a".into() } };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "artifact.removed");
    assert_eq!(v["roomId"], "r");
    assert_eq!(v["artifactId"], "a");
}

#[test]
fn export_typescript_bindings() {
    // ts-rs writes files when `export` is called; the files are committed.
    Room::export_all().unwrap();
    Artifact::export_all().unwrap();
    JournalDay::export_all().unwrap();
    Info::export_all().unwrap();
    RoomsEvent::export_all().unwrap();
    ApiError::export_all().unwrap();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p rooms-protocol`
Expected: FAIL — `cannot find type Room`

- [ ] **Step 3: Write the implementation**

`crates/rooms-protocol/src/lib.rs`:
```rust
//! Rooms Protocol v1 — the single definition of every wire type.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
    #[serde(rename = "artifact.added")] ArtifactAdded { artifact: Artifact },
    #[serde(rename = "artifact.updated")] ArtifactUpdated { artifact: Artifact },
    #[serde(rename = "artifact.removed", rename_all = "camelCase")] ArtifactRemoved { room_id: RoomId, artifact_id: ArtifactId },
    #[serde(rename = "note.saved")] NoteSaved { note: Note },
    #[serde(rename = "note.removed")] NoteRemoved { date: IsoDate, name: String },
    #[serde(rename = "journal.changed")] JournalChanged { date: IsoDate },
    #[serde(rename = "resync", rename_all = "camelCase")] Resync { room_id: Option<RoomId> },
}

wire!(pub struct RoomsEvent {
    pub seq: u64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub kind: EventKind,
});
```

`packages/protocol-ts/package.json`:
```json
{
  "name": "@alto-rooms/protocol-ts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/client.ts"
}
```

Note for the implementer: if the resolved `ts-rs` version rejects `#[ts(flatten)]` on a field whose type is an internally tagged enum, replace the two `ts` attributes on `RoomsEvent` with `#[ts(type = "{ seq: number } & EventKind")]` on the struct (keep the serde `flatten`); the JSON shape tested below must not change.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p rooms-protocol`
Expected: 4 passed; `packages/protocol-ts/src/generated/Room.ts` (and others) exist.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-protocol packages/protocol-ts
git commit -m "feat(protocol): define Rooms Protocol v1 wire types with TS export"
```

---

### Task 2: Pure rules (`rules.rs`, `error.rs`)

**Files:**
- Create: `crates/rooms-core/src/error.rs`, `crates/rooms-core/src/rules.rs`
- Modify: `crates/rooms-core/src/lib.rs`
- Test: inline `#[cfg(test)] mod tests` in `rules.rs`

**Interfaces:**
- Consumes: `rooms_protocol::RoomId`
- Produces:
  - `enum CoreError { InvalidRoomName, RoomExists, InvalidLinkPath(String), OverlappingRoom, RoomNotFound, InvalidInput(String), PathEscape, WriteFailed(String) }` with `fn code(&self) -> &'static str` and `fn status(&self) -> u16`
  - `enum PathClass { Artifact, Note { date: String }, Ignored }`
  - `fn classify_path(rel: &Path, in_journal: bool) -> PathClass`
  - `fn validate_room_name(name: &str) -> Result<String, CoreError>` (returns trimmed name)
  - `fn room_slug(name: &str) -> String`
  - `fn slug_key(slug: &str) -> String` (NFC + lowercase; equality = collision)
  - `fn validate_note_name(name: &str) -> Result<String, CoreError>` (returns name with `.md`)
  - `fn validate_iso_date(d: &str) -> Result<(), CoreError>`
  - `fn artifact_id(room_id: &str, rel_path: &str) -> String`
  - `fn local_day(rfc3339: &str) -> Option<String>` (YYYY-MM-DD in local tz)
  - `const DEFAULT_IGNORED_DIRS: [&str; 5] = ["node_modules","dist","build",".next","coverage"]`

- [ ] **Step 1: Write the failing tests**

Append to `crates/rooms-core/src/rules.rs` (create file with only the test module first):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn html_is_artifact_md_is_note_only_in_journal() {
        assert_eq!(classify_path(Path::new("a/b.html"), false), PathClass::Artifact);
        assert_eq!(classify_path(Path::new("B.HTM"), false), PathClass::Artifact);
        assert_eq!(classify_path(Path::new("notes.md"), false), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("2026-10-05/회고.md"), true), PathClass::Note { date: "2026-10-05".into() });
        assert_eq!(classify_path(Path::new("2026-10-05/sub/x.md"), true), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("img.png"), false), PathClass::Ignored);
    }

    #[test]
    fn hidden_and_build_dirs_are_ignored() {
        assert_eq!(classify_path(Path::new(".git/x.html"), false), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("node_modules/p/index.html"), false), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("site/dist/index.html"), false), PathClass::Ignored);
    }

    #[test]
    fn room_name_rules() {
        assert_eq!(validate_room_name("  연구 도구 ").unwrap(), "연구 도구");
        assert!(validate_room_name("").is_err());
        assert!(validate_room_name("a/b").is_err());
        assert!(validate_room_name("..").is_err());
        assert!(validate_room_name("Journal").is_err());
        assert!(validate_room_name("INBOX").is_err());
        assert!(validate_room_name(&"x".repeat(81)).is_err());
    }

    #[test]
    fn nfd_and_nfc_names_collide() {
        let nfc = "연구 도구";
        let nfd: String = unicode_normalization::UnicodeNormalization::nfd(nfc).collect();
        assert_ne!(nfc, nfd);
        assert_eq!(slug_key(&room_slug(nfc)), slug_key(&room_slug(&nfd)));
        assert_eq!(slug_key(&room_slug("연구 도구")), slug_key(&room_slug("연구-도구")));
        assert_eq!(slug_key("Research"), slug_key("research"));
    }

    #[test]
    fn artifact_id_is_stable_16_hex() {
        let a = artifact_id("r1", "x/a.html");
        assert_eq!(a.len(), 16);
        assert_eq!(a, artifact_id("r1", "x/a.html"));
        assert_ne!(a, artifact_id("r2", "x/a.html"));
    }

    #[test]
    fn note_and_date_rules() {
        assert_eq!(validate_note_name("회고").unwrap(), "회고.md");
        assert!(validate_note_name("a/b").is_err());
        assert!(validate_iso_date("2026-10-05").is_ok());
        assert!(validate_iso_date("2026-02-30").is_err());
        assert!(validate_iso_date("2026-10-5").is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core rules`
Expected: FAIL — `cannot find function classify_path`

- [ ] **Step 3: Write the implementation**

`crates/rooms-core/src/error.rs`:
```rust
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CoreError {
    #[error("invalid room name")] InvalidRoomName,
    #[error("room exists")] RoomExists,
    #[error("invalid link path: {0}")] InvalidLinkPath(String),
    #[error("overlapping room")] OverlappingRoom,
    #[error("room not found")] RoomNotFound,
    #[error("invalid input: {0}")] InvalidInput(String),
    #[error("path escape")] PathEscape,
    #[error("write failed: {0}")] WriteFailed(String),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::InvalidRoomName => "invalid_room_name",
            CoreError::RoomExists => "room_exists",
            CoreError::InvalidLinkPath(_) => "invalid_link_path",
            CoreError::OverlappingRoom => "overlapping_room",
            CoreError::RoomNotFound => "room_not_found",
            CoreError::InvalidInput(_) => "invalid_input",
            CoreError::PathEscape => "path_escape",
            CoreError::WriteFailed(_) => "write_failed",
        }
    }
    pub fn status(&self) -> u16 {
        match self {
            CoreError::RoomExists | CoreError::OverlappingRoom => 409,
            CoreError::RoomNotFound => 404,
            CoreError::WriteFailed(_) => 500,
            _ => 400,
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self { CoreError::WriteFailed(e.to_string()) }
}
```

`crates/rooms-core/src/rules.rs` (above the test module):
```rust
use crate::error::CoreError;
use sha1::{Digest, Sha1};
use std::path::{Component, Path};
use unicode_normalization::UnicodeNormalization;

pub const DEFAULT_IGNORED_DIRS: [&str; 5] = ["node_modules", "dist", "build", ".next", "coverage"];
pub const RESERVED_NAMES: [&str; 2] = ["journal", "inbox"];

#[derive(Debug, PartialEq, Eq)]
pub enum PathClass { Artifact, Note { date: String }, Ignored }

fn is_html(p: &Path) -> bool {
    matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("html" | "htm"))
}

pub fn classify_path(rel: &Path, in_journal: bool) -> PathClass {
    let parts: Vec<&str> = rel.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    }).collect();
    if parts.is_empty() { return PathClass::Ignored; }
    for dir in &parts[..parts.len() - 1] {
        if dir.starts_with('.') || DEFAULT_IGNORED_DIRS.contains(dir) { return PathClass::Ignored; }
    }
    if parts[parts.len() - 1].starts_with('.') { return PathClass::Ignored; }
    if is_html(rel) { return PathClass::Artifact; }
    let is_md = rel.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false);
    if in_journal && is_md && parts.len() == 2 && validate_iso_date(parts[0]).is_ok() {
        return PathClass::Note { date: parts[0].to_string() };
    }
    PathClass::Ignored
}

pub fn validate_room_name(name: &str) -> Result<String, CoreError> {
    let t = name.trim();
    let n = t.chars().count();
    if n == 0 || n > 80 || t.contains(['/', '\\', ':']) || t.contains("..") { return Err(CoreError::InvalidRoomName); }
    let key = slug_key(&room_slug(t));
    if RESERVED_NAMES.contains(&key.as_str()) { return Err(CoreError::InvalidRoomName); }
    Ok(t.to_string())
}

pub fn room_slug(name: &str) -> String {
    name.trim().nfc().map(|c| if c.is_whitespace() { '-' } else { c }).collect()
}

pub fn slug_key(slug: &str) -> String {
    slug.nfc().collect::<String>().to_lowercase()
}

pub fn validate_note_name(name: &str) -> Result<String, CoreError> {
    let base = name.trim().trim_end_matches(".md");
    let n = base.chars().count();
    if n == 0 || n > 60 || base.contains(['/', '\\', ':']) || base.contains("..") || base.starts_with('.') {
        return Err(CoreError::InvalidInput("note name".into()));
    }
    Ok(format!("{base}.md"))
}

pub fn validate_iso_date(d: &str) -> Result<(), CoreError> {
    if d.len() != 10 { return Err(CoreError::InvalidInput("date".into())); }
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map(|_| ()).map_err(|_| CoreError::InvalidInput("date".into()))
}

pub fn artifact_id(room_id: &str, rel_path: &str) -> String {
    let mut h = Sha1::new();
    h.update(room_id.as_bytes());
    h.update(b":");
    h.update(rel_path.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

pub fn local_day(rfc3339: &str) -> Option<String> {
    let t = chrono::DateTime::parse_from_rfc3339(rfc3339).ok()?;
    Some(t.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}
```

`crates/rooms-core/src/lib.rs`:
```rust
pub mod error;
pub mod rules;

pub use error::CoreError;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core rules`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "feat(core): pure path, name, id and date rules"
```

---

### Task 3: Room scanning with ignore rules and file symlinks (`walk.rs`)

**Files:**
- Create: `crates/rooms-core/src/walk.rs`
- Modify: `crates/rooms-core/src/lib.rs` (add `pub mod walk;`)
- Test: inline tests in `walk.rs`

**Interfaces:**
- Consumes: `rules::{classify_path, PathClass, DEFAULT_IGNORED_DIRS}`
- Produces:
  - `struct ScanEntry { rel_path: String, abs_path: PathBuf, target: PathBuf, class: PathClass }` — `target` = realpath of the file (symlink resolved)
  - `fn scan_room(root: &Path, honor_gitignore: bool, in_journal: bool) -> Vec<ScanEntry>` — only `Artifact`/`Note` entries, sorted by `rel_path`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn rels(v: &[ScanEntry]) -> Vec<String> { v.iter().map(|e| e.rel_path.clone()).collect() }

    #[test]
    fn finds_nested_html_and_skips_noise() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join("harness")).unwrap();
        fs::create_dir_all(r.join("node_modules/x")).unwrap();
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::write(r.join("a.html"), "<title>A</title>").unwrap();
        fs::write(r.join("harness/b.htm"), "").unwrap();
        fs::write(r.join("node_modules/x/c.html"), "").unwrap();
        fs::write(r.join(".git/d.html"), "").unwrap();
        fs::write(r.join("e.md"), "").unwrap();
        assert_eq!(rels(&scan_room(r, false, false)), vec!["a.html", "harness/b.htm"]);
    }

    #[test]
    fn honors_roomsignore_always_and_gitignore_only_when_asked() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::write(r.join("keep.html"), "").unwrap();
        fs::write(r.join("drop.html"), "").unwrap();
        fs::write(r.join("git.html"), "").unwrap();
        fs::write(r.join(".roomsignore"), "drop.html\n").unwrap();
        fs::write(r.join(".gitignore"), "git.html\n").unwrap();
        assert_eq!(rels(&scan_room(r, false, false)), vec!["git.html", "keep.html"]);
        assert_eq!(rels(&scan_room(r, true, false)), vec!["keep.html"]);
    }

    #[test]
    fn follows_file_symlink_to_html_and_records_target() {
        let d = tempfile::tempdir().unwrap();
        let orig = d.path().join("elsewhere");
        fs::create_dir_all(&orig).unwrap();
        fs::write(orig.join("spec.html"), "").unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        symlink(orig.join("spec.html"), room.join("spec.html")).unwrap();
        let v = scan_room(&room, false, false);
        assert_eq!(rels(&v), vec!["spec.html"]);
        assert_eq!(v[0].target, fs::canonicalize(orig.join("spec.html")).unwrap());
    }

    #[test]
    fn skips_broken_and_directory_symlinks() {
        let d = tempfile::tempdir().unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        symlink(d.path().join("missing.html"), room.join("broken.html")).unwrap();
        symlink(&room, room.join("loop")).unwrap();
        fs::write(room.join("ok.html"), "").unwrap();
        assert_eq!(rels(&scan_room(&room, false, false)), vec!["ok.html"]);
    }

    #[test]
    fn journal_scan_returns_notes_and_artifacts() {
        let d = tempfile::tempdir().unwrap();
        let j = d.path();
        fs::create_dir_all(j.join("2026-10-05")).unwrap();
        fs::write(j.join("2026-10-05/dream.html"), "").unwrap();
        fs::write(j.join("2026-10-05/회고.md"), "").unwrap();
        let v = scan_room(j, false, true);
        assert_eq!(rels(&v), vec!["2026-10-05/dream.html", "2026-10-05/회고.md"]);
        assert!(matches!(v[1].class, PathClass::Note { .. }));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core walk`
Expected: FAIL — `cannot find function scan_room`

- [ ] **Step 3: Write the implementation**

```rust
use crate::rules::{classify_path, PathClass, DEFAULT_IGNORED_DIRS};
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct ScanEntry {
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub target: PathBuf,
    pub class: PathClass,
}

pub fn scan_room(root: &Path, honor_gitignore: bool, in_journal: bool) -> Vec<ScanEntry> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .follow_links(false)
        .git_ignore(honor_gitignore)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .add_custom_ignore_filename(".roomsignore")
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().map(|t| t.is_dir()).unwrap_or(false) && DEFAULT_IGNORED_DIRS.contains(&name.as_ref()))
        })
        .build();
    for entry in walker.flatten() {
        let abs = entry.path().to_path_buf();
        let Ok(rel) = abs.strip_prefix(root) else { continue };
        if rel.as_os_str().is_empty() { continue; }
        let ft = match entry.file_type() { Some(t) => t, None => continue };
        // Directory symlinks inside rooms are never followed; file symlinks must point to a regular file.
        let target = if ft.is_symlink() {
            match std::fs::metadata(&abs) {
                Ok(m) if m.is_file() => match std::fs::canonicalize(&abs) { Ok(t) => t, Err(_) => continue },
                _ => continue,
            }
        } else if ft.is_file() {
            match std::fs::canonicalize(&abs) { Ok(t) => t, Err(_) => continue }
        } else {
            continue;
        };
        let class = classify_path(rel, in_journal);
        if class == PathClass::Ignored { continue; }
        if ft.is_symlink() && class != PathClass::Artifact { continue; }
        out.push(ScanEntry { rel_path: rel.to_string_lossy().replace('\\', "/"), abs_path: abs, target, class });
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core walk`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "feat(core): scan rooms with ignore rules and html file symlinks"
```

---

### Task 4: HTML meta extraction (`meta.rs`)

**Files:**
- Create: `crates/rooms-core/src/meta.rs`
- Modify: `crates/rooms-core/src/lib.rs` (add `pub mod meta;`)
- Test: inline tests in `meta.rs`

**Interfaces:**
- Consumes: `rooms_protocol::Source`
- Produces:
  - `struct Meta { title: Option<String>, created: Option<String>, source: Source }`
  - `fn extract_meta(head: &[u8]) -> Meta`
  - `fn read_meta(path: &Path) -> Meta` — reads ≤ 64 KB, never panics
  - `fn file_times(path: &Path) -> (String, String)` — `(created_rfc3339, updated_rfc3339)` following symlinks; created = birthtime or mtime
  - `fn title_or_filename(meta: &Meta, rel_path: &str) -> String`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooms_title_beats_title_tag() {
        let m = extract_meta(br#"<html><head><meta name="rooms:title" content="Meta T"><title>Tag T</title></head>"#);
        assert_eq!(m.title.as_deref(), Some("Meta T"));
    }

    #[test]
    fn reads_title_and_source_meta() {
        let html = br#"<head><title> 벤치마크 현황 </title>
          <meta name="rooms:created" content="2026-10-05T10:02:00+09:00">
          <meta name="rooms:agent" content="codex"><meta name="rooms:session" content="s1">
          <meta name="rooms:cwd" content="/w"><meta name="rooms:machine" content="mac-mini"></head>"#;
        let m = extract_meta(html);
        assert_eq!(m.title.as_deref(), Some("벤치마크 현황"));
        assert_eq!(m.created.as_deref(), Some("2026-10-05T10:02:00+09:00"));
        assert_eq!(m.source.agent.as_deref(), Some("codex"));
        assert_eq!(m.source.session.as_deref(), Some("s1"));
        assert_eq!(m.source.cwd.as_deref(), Some("/w"));
        assert_eq!(m.source.machine.as_deref(), Some("mac-mini"));
    }

    #[test]
    fn invalid_created_is_dropped() {
        let m = extract_meta(br#"<meta name="rooms:created" content="yesterday">"#);
        assert!(m.created.is_none());
    }

    #[test]
    fn binary_and_huge_files_fall_back_to_filename() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("blob.html");
        let mut bytes = vec![0xffu8, 0xfe, 0x00];
        bytes.extend(std::iter::repeat(b'x').take(5 * 1024 * 1024));
        std::fs::write(&p, &bytes).unwrap();
        let m = read_meta(&p);
        assert_eq!(title_or_filename(&m, "sub/blob.html"), "blob");
    }

    #[test]
    fn empty_title_falls_back() {
        let m = extract_meta(b"<title>   </title>");
        assert_eq!(title_or_filename(&m, "a/report.htm"), "report");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core meta`
Expected: FAIL — `cannot find function extract_meta`

- [ ] **Step 3: Write the implementation**

```rust
use lol_html::{element, text, HtmlRewriter, Settings};
use rooms_protocol::Source;
use std::cell::RefCell;
use std::io::Read;
use std::path::Path;

const HEAD_LIMIT: usize = 64 * 1024;

#[derive(Debug, Default, Clone)]
pub struct Meta {
    pub title: Option<String>,
    pub created: Option<String>,
    pub source: Source,
}

pub fn extract_meta(head: &[u8]) -> Meta {
    let tag_title = RefCell::new(String::new());
    let meta = RefCell::new(Meta::default());
    let mut rw = HtmlRewriter::new(
        Settings {
            element_content_handlers: vec![
                text!("title", |t| { tag_title.borrow_mut().push_str(t.as_str()); Ok(()) }),
                element!("meta[name]", |el| {
                    let name = el.get_attribute("name").unwrap_or_default();
                    let content = el.get_attribute("content").map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
                    let mut m = meta.borrow_mut();
                    match name.as_str() {
                        "rooms:title" => m.title = content,
                        "rooms:created" => m.created = content.filter(|c| chrono::DateTime::parse_from_rfc3339(c).is_ok()),
                        "rooms:agent" => m.source.agent = content,
                        "rooms:session" => m.source.session = content,
                        "rooms:cwd" => m.source.cwd = content,
                        "rooms:machine" => m.source.machine = content,
                        _ => {}
                    }
                    Ok(())
                }),
            ],
            ..Settings::new()
        },
        |_: &[u8]| {},
    );
    let _ = rw.write(&head[..head.len().min(HEAD_LIMIT)]);
    let _ = rw.end();
    let mut m = meta.into_inner();
    if m.title.is_none() {
        let t = tag_title.into_inner().trim().to_string();
        if !t.is_empty() { m.title = Some(t); }
    }
    m
}

pub fn read_meta(path: &Path) -> Meta {
    let mut buf = Vec::with_capacity(HEAD_LIMIT);
    match std::fs::File::open(path) {
        Ok(f) => { let _ = f.take(HEAD_LIMIT as u64).read_to_end(&mut buf); }
        Err(_) => return Meta::default(),
    }
    extract_meta(&buf)
}

pub fn file_times(path: &Path) -> (String, String) {
    let to_rfc = |t: std::time::SystemTime| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339();
    match std::fs::metadata(path) {
        Ok(m) => {
            let modified = m.modified().map(to_rfc).unwrap_or_default();
            let created = m.created().map(to_rfc).unwrap_or_else(|_| modified.clone());
            (created, modified)
        }
        Err(_) => { let now = chrono::Local::now().to_rfc3339(); (now.clone(), now) }
    }
}

pub fn title_or_filename(meta: &Meta, rel_path: &str) -> String {
    if let Some(t) = meta.title.as_ref().map(|t| t.trim()).filter(|t| !t.is_empty()) { return t.to_string(); }
    Path::new(rel_path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| rel_path.to_string())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core meta`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "feat(core): extract rooms:* meta and titles from html heads"
```

---

### Task 5: Room registry (`state.rs`)

**Files:**
- Create: `crates/rooms-core/src/state.rs`
- Modify: `crates/rooms-core/src/lib.rs` (add `pub mod state;`)
- Test: inline tests

**Interfaces:**
- Consumes: `rooms_protocol::{RoomId, RoomKind}`, `CoreError`
- Produces:
  - `struct RoomRecord { id: RoomId, name: String, kind: RoomKind, path: PathBuf, dev: Option<u64>, ino: Option<u64> }` (serde)
  - `struct StateStore { path: PathBuf, rooms: Vec<RoomRecord> }`
  - `fn StateStore::load(rooms_dir: &Path) -> Result<StateStore, CoreError>` (`rooms_dir` = `<home>/.rooms`; missing file → empty)
  - `fn StateStore::save(&self) -> Result<(), CoreError>` (temp file + rename)
  - `fn StateStore::find(&self, id: &str) -> Option<&RoomRecord>` and `find_mut`
  - `fn StateStore::find_by_inode(&self, dev: u64, ino: u64) -> Option<&RoomRecord>`
  - `fn inode_of(path: &Path) -> Option<(u64, u64)>`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_and_preserves_order() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(".rooms");
        let mut s = StateStore::load(&dir).unwrap();
        assert!(s.rooms.is_empty());
        s.rooms.push(RoomRecord { id: "b".into(), name: "B".into(), kind: RoomKind::Owned, path: "/x/b".into(), dev: Some(1), ino: Some(2) });
        s.rooms.push(RoomRecord { id: "a".into(), name: "연구 도구".into(), kind: RoomKind::Linked, path: "/t".into(), dev: None, ino: None });
        s.save().unwrap();
        let s2 = StateStore::load(&dir).unwrap();
        assert_eq!(s2.rooms.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
        assert_eq!(s2.find("a").unwrap().name, "연구 도구");
        assert_eq!(s2.find_by_inode(1, 2).unwrap().id, "b");
    }

    #[test]
    fn inode_survives_rename() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        std::fs::create_dir(&a).unwrap();
        let before = inode_of(&a).unwrap();
        let b = d.path().join("b");
        std::fs::rename(&a, &b).unwrap();
        assert_eq!(inode_of(&b).unwrap(), before);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core state`
Expected: FAIL — `cannot find type StateStore`

- [ ] **Step 3: Write the implementation**

```rust
use crate::error::CoreError;
use rooms_protocol::{RoomId, RoomKind};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomRecord {
    pub id: RoomId,
    pub name: String,
    pub kind: RoomKind,
    pub path: PathBuf,
    pub dev: Option<u64>,
    pub ino: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct Disk { rooms: Vec<RoomRecord> }

pub struct StateStore { pub path: PathBuf, pub rooms: Vec<RoomRecord> }

impl StateStore {
    pub fn load(rooms_dir: &Path) -> Result<StateStore, CoreError> {
        std::fs::create_dir_all(rooms_dir)?;
        let path = rooms_dir.join("state.json");
        let disk: Disk = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => Disk::default(),
        };
        Ok(StateStore { path, rooms: disk.rooms })
    }
    pub fn save(&self) -> Result<(), CoreError> {
        let tmp = self.path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(&Disk { rooms: self.rooms.clone() }).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
    pub fn find(&self, id: &str) -> Option<&RoomRecord> { self.rooms.iter().find(|r| r.id == id) }
    pub fn find_mut(&mut self, id: &str) -> Option<&mut RoomRecord> { self.rooms.iter_mut().find(|r| r.id == id) }
    pub fn find_by_inode(&self, dev: u64, ino: u64) -> Option<&RoomRecord> {
        self.rooms.iter().find(|r| r.dev == Some(dev) && r.ino == Some(ino))
    }
}

pub fn inode_of(path: &Path) -> Option<(u64, u64)> {
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core state`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "feat(core): human-readable room registry with inode tracking"
```

---

### Task 6: SQLite index with first-seen times and backfill (`index.rs`)

**Files:**
- Create: `crates/rooms-core/src/index.rs`
- Modify: `crates/rooms-core/src/lib.rs` (add `pub mod index;`)
- Test: inline tests

**Interfaces:**
- Consumes: `walk::{scan_room, ScanEntry}`, `meta::{read_meta, file_times, title_or_filename}`, `rules::{artifact_id, PathClass}`, `rooms_protocol::{Artifact, Author, Source}`
- Produces:
  - `struct Index { conn: rusqlite::Connection }`
  - `fn Index::open(path: &Path) -> Result<Index, CoreError>` — creates schema; a corrupt file is deleted and recreated
  - `enum Change { Added(Artifact), Updated(Artifact), Removed { room_id: String, artifact_id: String } }`
  - `fn Index::backfill(&mut self, room_id: &str, entries: &[ScanEntry]) -> Result<Vec<Change>, CoreError>` — upserts every artifact entry, removes rows not in `entries`, preserves `created_at` of existing ids, returns changes
  - `fn Index::upsert_one(&mut self, room_id: &str, e: &ScanEntry) -> Result<Option<Change>, CoreError>`
  - `fn Index::remove_one(&mut self, room_id: &str, rel_path: &str) -> Result<Option<Change>, CoreError>`
  - `fn Index::list(&self, room_id: &str) -> Result<Vec<Artifact>, CoreError>` — ordered `created_at ASC, id ASC`
  - `fn Index::by_day(&self, day: &str) -> Result<Vec<(Artifact, String)>, CoreError>` — `(artifact, target_realpath)` with `created_day = day`, ordered `created_at ASC`
  - `fn Index::rename_room(&mut self, room_id: &str) -> ()` is NOT needed (ids are room-id based; folder rename does not change rows)
  - `fn Index::drop_room(&mut self, room_id: &str) -> Result<Vec<Change>, CoreError>`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::walk::scan_room;
    use std::fs;

    fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        (d, room)
    }

    #[test]
    fn backfill_adds_then_removes() {
        let (d, room) = setup();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        fs::write(room.join("a.html"), "<title>A</title>").unwrap();
        let ch = ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert!(matches!(&ch[0], Change::Added(a) if a.title == "A"));
        fs::remove_file(room.join("a.html")).unwrap();
        let ch = ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert!(matches!(&ch[0], Change::Removed { .. }));
        assert!(ix.list("r1").unwrap().is_empty());
    }

    #[test]
    fn first_seen_is_kept_across_reopen_and_rewrite() {
        let (d, room) = setup();
        let db = d.path().join("index.sqlite");
        fs::write(room.join("a.html"), "").unwrap();
        let created = {
            let mut ix = Index::open(&db).unwrap();
            ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
            ix.list("r1").unwrap()[0].created_at.clone()
        };
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // temp-file + rename rewrite changes birthtime
        fs::write(room.join("a.html.tmp"), "<title>new</title>").unwrap();
        fs::rename(room.join("a.html.tmp"), room.join("a.html")).unwrap();
        let mut ix = Index::open(&db).unwrap();
        let ch = ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert!(matches!(&ch[0], Change::Updated(a) if a.title == "new"));
        assert_eq!(ix.list("r1").unwrap()[0].created_at, created);
    }

    #[test]
    fn rooms_created_meta_wins() {
        let (d, room) = setup();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        fs::write(room.join("a.html"), r#"<meta name="rooms:created" content="2026-01-02T03:04:05+09:00">"#).unwrap();
        ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert_eq!(ix.list("r1").unwrap()[0].created_at, "2026-01-02T03:04:05+09:00");
    }

    #[test]
    fn deleting_db_rebuilds() {
        let (d, room) = setup();
        let db = d.path().join("index.sqlite");
        fs::write(room.join("a.html"), "").unwrap();
        { let mut ix = Index::open(&db).unwrap(); ix.backfill("r1", &scan_room(&room, false, false)).unwrap(); }
        fs::remove_file(&db).unwrap();
        let mut ix = Index::open(&db).unwrap();
        ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert_eq!(ix.list("r1").unwrap().len(), 1);
    }

    #[test]
    fn corrupt_db_is_recreated() {
        let (d, _room) = setup();
        let db = d.path().join("index.sqlite");
        fs::write(&db, b"not a database").unwrap();
        assert!(Index::open(&db).is_ok());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core index`
Expected: FAIL — `cannot find type Index`

- [ ] **Step 3: Write the implementation**

```rust
use crate::error::CoreError;
use crate::meta::{file_times, read_meta, title_or_filename};
use crate::rules::{artifact_id, local_day, PathClass};
use crate::walk::ScanEntry;
use rooms_protocol::{Artifact, Author, Source};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;

pub struct Index { conn: Connection }

#[derive(Debug, Clone)]
pub enum Change {
    Added(Artifact),
    Updated(Artifact),
    Removed { room_id: String, artifact_id: String },
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_day TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_room ON artifacts(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_day ON artifacts(created_day, created_at);
";

fn err(e: rusqlite::Error) -> CoreError { CoreError::WriteFailed(e.to_string()) }

impl Index {
    pub fn open(path: &Path) -> Result<Index, CoreError> {
        let try_open = || -> rusqlite::Result<Connection> {
            let c = Connection::open(path)?;
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.execute_batch(SCHEMA)?;
            Ok(c)
        };
        match try_open() {
            Ok(conn) => Ok(Index { conn }),
            Err(_) => {
                let _ = std::fs::remove_file(path);
                Ok(Index { conn: try_open().map_err(err)? })
            }
        }
    }

    fn row_to_artifact(r: &rusqlite::Row) -> rusqlite::Result<Artifact> {
        let source: String = r.get("source")?;
        Ok(Artifact {
            id: r.get("id")?,
            room_id: r.get("room_id")?,
            rel_path: r.get("rel_path")?,
            title: r.get("title")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
            author: Author::Agent,
            source: serde_json::from_str::<Source>(&source).unwrap_or_default(),
        })
    }

    pub fn upsert_one(&mut self, room_id: &str, e: &ScanEntry) -> Result<Option<Change>, CoreError> {
        if e.class != PathClass::Artifact { return Ok(None); }
        let id = artifact_id(room_id, &e.rel_path);
        let meta = read_meta(&e.target);
        let (file_created, updated) = file_times(&e.target);
        let existing: Option<(String, String, String)> = self.conn.query_row(
            "SELECT created_at, title, updated_at FROM artifacts WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(err)?;
        let created = meta.created.clone()
            .or_else(|| existing.as_ref().map(|x| x.0.clone()))
            .unwrap_or(file_created);
        let title = title_or_filename(&meta, &e.rel_path);
        let day = local_day(&created).unwrap_or_default();
        let source = serde_json::to_string(&meta.source).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            "INSERT INTO artifacts (id, room_id, rel_path, target, title, created_at, created_day, updated_at, source)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET target=excluded.target, title=excluded.title, created_at=excluded.created_at,
               created_day=excluded.created_day, updated_at=excluded.updated_at, source=excluded.source",
            params![id, room_id, e.rel_path, e.target.to_string_lossy(), title, created, day, updated, source],
        ).map_err(err)?;
        let a = Artifact { id, room_id: room_id.into(), rel_path: e.rel_path.clone(), title: title.clone(),
            created_at: created, updated_at: updated.clone(), author: Author::Agent, source: meta.source };
        Ok(Some(match existing {
            None => Change::Added(a),
            Some((_, old_title, old_updated)) if old_title == title && old_updated == updated => return Ok(None),
            Some(_) => Change::Updated(a),
        }))
    }

    pub fn remove_one(&mut self, room_id: &str, rel_path: &str) -> Result<Option<Change>, CoreError> {
        let id = artifact_id(room_id, rel_path);
        let n = self.conn.execute("DELETE FROM artifacts WHERE id = ?1", params![id]).map_err(err)?;
        Ok((n > 0).then(|| Change::Removed { room_id: room_id.into(), artifact_id: id }))
    }

    pub fn backfill(&mut self, room_id: &str, entries: &[ScanEntry]) -> Result<Vec<Change>, CoreError> {
        let mut changes = Vec::new();
        let mut seen = HashSet::new();
        for e in entries.iter().filter(|e| e.class == PathClass::Artifact) {
            seen.insert(e.rel_path.clone());
            if let Some(c) = self.upsert_one(room_id, e)? { changes.push(c); }
        }
        let existing: Vec<String> = {
            let mut st = self.conn.prepare("SELECT rel_path FROM artifacts WHERE room_id = ?1").map_err(err)?;
            let rows = st.query_map(params![room_id], |r| r.get(0)).map_err(err)?;
            rows.filter_map(Result::ok).collect()
        };
        for rel in existing.into_iter().filter(|r| !seen.contains(r)) {
            if let Some(c) = self.remove_one(room_id, &rel)? { changes.push(c); }
        }
        Ok(changes)
    }

    pub fn list(&self, room_id: &str) -> Result<Vec<Artifact>, CoreError> {
        let mut st = self.conn.prepare("SELECT * FROM artifacts WHERE room_id = ?1 ORDER BY created_at ASC, id ASC").map_err(err)?;
        let rows = st.query_map(params![room_id], Self::row_to_artifact).map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn by_day(&self, day: &str) -> Result<Vec<(Artifact, String)>, CoreError> {
        let mut st = self.conn.prepare("SELECT * FROM artifacts WHERE created_day = ?1 ORDER BY created_at ASC, id ASC").map_err(err)?;
        let rows = st.query_map(params![day], |r| Ok((Self::row_to_artifact(r)?, r.get::<_, String>("target")?))).map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn drop_room(&mut self, room_id: &str) -> Result<Vec<Change>, CoreError> {
        let ids: Vec<String> = {
            let mut st = self.conn.prepare("SELECT id FROM artifacts WHERE room_id = ?1").map_err(err)?;
            let rows = st.query_map(params![room_id], |r| r.get(0)).map_err(err)?;
            rows.filter_map(Result::ok).collect()
        };
        self.conn.execute("DELETE FROM artifacts WHERE room_id = ?1", params![room_id]).map_err(err)?;
        Ok(ids.into_iter().map(|id| Change::Removed { room_id: room_id.into(), artifact_id: id }).collect())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core index`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "feat(core): sqlite artifact index with first-seen times and backfill"
```

---

### Task 7: `RoomsCore` facade — rooms, Journal, notes, files

**Files:**
- Create: `crates/rooms-core/src/core.rs`
- Modify: `crates/rooms-core/src/lib.rs` (add `pub mod core; pub use crate::core::RoomsCore;`)
- Test: `crates/rooms-core/tests/core_flows.rs`

**Interfaces:**
- Consumes: everything from Tasks 2–6
- Produces (frozen, from spec §5 S2 — do not rename):
```rust
impl RoomsCore {
    pub fn open(home: &Path) -> Result<Self, CoreError>;                       // synchronous: loads state, opens index, ensures journal/ and inbox/
    pub fn backfill_all(&self) -> Result<(), CoreError>;                       // scans every room, emits events
    pub fn list_rooms(&self) -> Vec<Room>;                                     // excludes journal
    pub fn list_artifacts(&self, room: &RoomId) -> Result<Vec<Artifact>, CoreError>;
    pub fn journal_day(&self, date: &IsoDate) -> Result<JournalDay, CoreError>;
    pub fn create_room(&self, name: &str) -> Result<Room, CoreError>;
    pub fn link_folder(&self, path: &Path, name: Option<&str>) -> Result<Room, CoreError>;
    pub fn rename_room(&self, room: &RoomId, name: &str) -> Result<Room, CoreError>;
    pub fn save_note(&self, date: &IsoDate, name: &str, body: &str) -> Result<Note, CoreError>;
    pub fn resolve_file(&self, room: &RoomId, rel: &str) -> Result<PathBuf, CoreError>;
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<RoomsEvent>;
    pub fn current_seq(&self) -> u64;
    pub fn home(&self) -> &Path;
    pub fn room_root(&self, room: &RoomId) -> Option<(PathBuf, RoomKind)>;    // used by watch.rs
    pub fn apply_fs_change(&self, abs_path: &Path);                           // used by watch.rs
    pub fn rescan_room(&self, room: &RoomId);                                  // used by watch.rs
}
```
  `RoomsCore` is `Clone` (inner `Arc<Mutex<Inner>>`), so roomsd and the watcher share it.

- [ ] **Step 1: Write the failing tests**

`crates/rooms-core/tests/core_flows.rs`:
```rust
use rooms_core::{CoreError, RoomsCore};
use rooms_protocol::*;
use std::fs;
use std::os::unix::fs::symlink;

fn home() -> (tempfile::TempDir, RoomsCore) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    core.backfill_all().unwrap();
    (d, core)
}

#[test]
fn create_room_makes_slug_folder_and_keeps_display_name() {
    let (d, core) = home();
    let r = core.create_room("연구 도구").unwrap();
    assert_eq!(r.name, "연구 도구");
    assert!(d.path().join("연구-도구").is_dir());
    assert_eq!(core.create_room("연구-도구").unwrap_err(), CoreError::RoomExists);
    assert_eq!(core.create_room("journal").unwrap_err(), CoreError::InvalidRoomName);
    let reopened = RoomsCore::open(d.path()).unwrap();
    assert_eq!(reopened.list_rooms().iter().find(|x| x.id == r.id).unwrap().name, "연구 도구");
}

#[test]
fn inbox_is_listed_journal_is_not() {
    let (_d, core) = home();
    let names: Vec<String> = core.list_rooms().into_iter().map(|r| r.name).collect();
    assert!(names.contains(&"inbox".to_string()));
    assert!(!names.contains(&"journal".to_string()));
}

#[test]
fn rename_owned_renames_folder_keeps_id_and_artifact_ids() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    fs::write(d.path().join("a/x.html"), "").unwrap();
    core.rescan_room(&r.id);
    let before = core.list_artifacts(&r.id).unwrap()[0].id.clone();
    let mut rx = core.subscribe();
    let r2 = core.rename_room(&r.id, "b c").unwrap();
    assert_eq!(r2.id, r.id);
    assert!(d.path().join("b-c").is_dir());
    assert_eq!(core.list_artifacts(&r.id).unwrap()[0].id, before);
    let ev = rx.try_recv().unwrap();
    assert!(matches!(ev.kind, EventKind::RoomUpdated { .. }));
    assert!(rx.try_recv().is_err(), "exactly one event");
}

#[test]
fn link_folder_rules_and_rename_is_display_only() {
    let (d, core) = home();
    let team = tempfile::tempdir().unwrap();
    fs::create_dir_all(team.path().join("research/sub")).unwrap();
    let r = core.link_folder(&team.path().join("research"), Some("팀 리서치")).unwrap();
    assert_eq!(r.kind, RoomKind::Linked);
    assert_eq!(core.link_folder(&team.path().join("research/sub"), None).unwrap_err(), CoreError::OverlappingRoom);
    assert_eq!(core.link_folder(team.path(), None).unwrap_err(), CoreError::OverlappingRoom);
    assert!(matches!(core.link_folder(d.path(), None).unwrap_err(), CoreError::InvalidLinkPath(_)));
    core.rename_room(&r.id, "리서치").unwrap();
    assert!(team.path().join("research").is_dir(), "linked folder name untouched");
    assert_eq!(fs::read_dir(team.path().join("research")).unwrap().count(), 1, "nothing written into linked folder");
}

#[test]
fn journal_day_merges_journal_files_rooms_and_dedupes_symlinks() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap();
    let b = core.create_room("b").unwrap();
    let orig = tempfile::tempdir().unwrap();
    fs::write(orig.path().join("spec.html"), r#"<meta name="rooms:created" content="2026-10-05T10:00:00+09:00">"#).unwrap();
    symlink(orig.path().join("spec.html"), d.path().join("a/spec.html")).unwrap();
    symlink(orig.path().join("spec.html"), d.path().join("b/spec.html")).unwrap();
    fs::create_dir_all(d.path().join("journal/2026-10-05")).unwrap();
    fs::write(d.path().join("journal/2026-10-05/dream.html"), r#"<meta name="rooms:created" content="2026-10-05T23:00:00+09:00">"#).unwrap();
    core.backfill_all().unwrap();
    let day = core.journal_day(&"2026-10-05".to_string()).unwrap();
    let titles: Vec<&str> = day.artifacts.iter().map(|x| x.title.as_str()).collect();
    assert_eq!(titles, vec!["spec", "dream"], "deduped by target, sorted by createdAt");
    let _ = (a, b);
}

#[test]
fn save_note_is_atomic_and_listed() {
    let (d, core) = home();
    let n = core.save_note(&"2026-10-05".to_string(), "회고", "# 오늘").unwrap();
    assert_eq!(n.name, "회고.md");
    assert_eq!(fs::read_to_string(d.path().join("journal/2026-10-05/회고.md")).unwrap(), "# 오늘");
    let day = core.journal_day(&"2026-10-05".to_string()).unwrap();
    assert_eq!(day.notes.len(), 1);
    assert!(core.save_note(&"2026-13-01".to_string(), "x", "").is_err());
    assert!(core.save_note(&"2026-10-05".to_string(), "x", &"a".repeat(1_048_577)).is_err());
}

#[test]
fn resolve_file_blocks_escape_but_allows_html_file_links() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("o.html"), "").unwrap();
    symlink(outside.path().join("o.html"), d.path().join("a/o.html")).unwrap();
    fs::write(d.path().join("a/in.html"), "").unwrap();
    assert!(core.resolve_file(&r.id, "in.html").is_ok());
    assert_eq!(core.resolve_file(&r.id, "o.html").unwrap(), fs::canonicalize(outside.path().join("o.html")).unwrap());
    assert_eq!(core.resolve_file(&r.id, "../journal").unwrap_err(), CoreError::PathEscape);
    symlink(outside.path(), d.path().join("a/dir")).unwrap();
    assert_eq!(core.resolve_file(&r.id, "dir/o.html").unwrap_err(), CoreError::PathEscape);
}

#[test]
fn seq_increases_monotonically() {
    let (_d, core) = home();
    let s0 = core.current_seq();
    core.create_room("x").unwrap();
    core.create_room("y").unwrap();
    assert_eq!(core.current_seq(), s0 + 2);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core --test core_flows`
Expected: FAIL — `unresolved import rooms_core::RoomsCore`

- [ ] **Step 3: Write the implementation**

`crates/rooms-core/src/core.rs`:
```rust
use crate::error::CoreError;
use crate::index::{Change, Index};
use crate::rules::{room_slug, slug_key, validate_iso_date, validate_note_name, validate_room_name, PathClass};
use crate::state::{inode_of, RoomRecord, StateStore};
use crate::walk::scan_room;
use rooms_protocol::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

struct Inner {
    home: PathBuf,
    state: StateStore,
    index: Index,
    seq: u64,
}

#[derive(Clone)]
pub struct RoomsCore {
    inner: Arc<Mutex<Inner>>,
    tx: broadcast::Sender<RoomsEvent>,
    home: PathBuf,
}

const MAX_NOTE_BYTES: usize = 1_048_576;

impl RoomsCore {
    pub fn open(home: &Path) -> Result<Self, CoreError> {
        std::fs::create_dir_all(home)?;
        let home = std::fs::canonicalize(home)?;
        let dot = home.join(".rooms");
        std::fs::create_dir_all(home.join("journal"))?;
        std::fs::create_dir_all(home.join("inbox"))?;
        let mut state = StateStore::load(&dot)?;
        // ensure inbox record; journal is implicit (constant id)
        if !state.rooms.iter().any(|r| r.kind == RoomKind::Owned && r.path == home.join("inbox")) {
            let (dev, ino) = inode_of(&home.join("inbox")).unzip();
            state.rooms.insert(0, RoomRecord { id: "inbox".into(), name: "inbox".into(), kind: RoomKind::Owned,
                path: home.join("inbox"), dev, ino });
            state.save()?;
        }
        // adopt owned folders created in Finder
        for e in std::fs::read_dir(&home)?.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if !p.is_dir() || name.starts_with('.') || name == "journal" { continue; }
            if state.rooms.iter().any(|r| r.path == p) { continue; }
            let (dev, ino) = inode_of(&p).unzip();
            if let (Some(dv), Some(io)) = (dev, ino) {
                if let Some(id) = state.find_by_inode(dv, io).map(|r| r.id.clone()) {
                    let rec = state.find_mut(&id).unwrap();
                    rec.path = p.clone();
                    rec.name = name.clone();
                    continue;
                }
            }
            state.rooms.push(RoomRecord { id: nanoid::nanoid!(12), name, kind: RoomKind::Owned, path: p, dev, ino });
        }
        state.save()?;
        let index = Index::open(&dot.join("index.sqlite"))?;
        let (tx, _) = broadcast::channel(1024);
        Ok(RoomsCore { inner: Arc::new(Mutex::new(Inner { home: home.clone(), state, index, seq: 0 })), tx, home })
    }

    pub fn home(&self) -> &Path { &self.home }

    pub fn subscribe(&self) -> broadcast::Receiver<RoomsEvent> { self.tx.subscribe() }

    pub fn current_seq(&self) -> u64 { self.inner.lock().unwrap().seq }

    fn emit(&self, inner: &mut Inner, kind: EventKind) {
        inner.seq += 1;
        let _ = self.tx.send(RoomsEvent { seq: inner.seq, kind });
    }

    fn emit_changes(&self, inner: &mut Inner, changes: Vec<Change>) {
        let mut days = HashSet::new();
        for c in changes {
            let kind = match c {
                Change::Added(a) => { if let Some(d) = crate::rules::local_day(&a.created_at) { days.insert(d); } EventKind::ArtifactAdded { artifact: a } }
                Change::Updated(a) => { if let Some(d) = crate::rules::local_day(&a.created_at) { days.insert(d); } EventKind::ArtifactUpdated { artifact: a } }
                Change::Removed { room_id, artifact_id } => EventKind::ArtifactRemoved { room_id, artifact_id },
            };
            self.emit(inner, kind);
        }
        for date in days { self.emit(inner, EventKind::JournalChanged { date }); }
    }

    fn to_room(inner: &Inner, r: &RoomRecord) -> Room {
        let list = inner.index.list(&r.id).unwrap_or_default();
        Room {
            id: r.id.clone(),
            name: r.name.clone(),
            kind: r.kind,
            path: r.path.to_string_lossy().to_string(),
            status: if r.path.is_dir() { RoomStatus::Ok } else { RoomStatus::Unavailable },
            artifact_count: list.len() as u32,
            updated_at: list.iter().map(|a| a.updated_at.clone()).max(),
        }
    }

    pub fn room_root(&self, room: &RoomId) -> Option<(PathBuf, RoomKind)> {
        let inner = self.inner.lock().unwrap();
        if room == JOURNAL_ROOM_ID { return Some((inner.home.join("journal"), RoomKind::Journal)); }
        inner.state.find(room).map(|r| (r.path.clone(), r.kind))
    }

    fn all_roots(inner: &Inner) -> Vec<(RoomId, PathBuf, RoomKind)> {
        let mut v: Vec<_> = inner.state.rooms.iter().map(|r| (r.id.clone(), r.path.clone(), r.kind)).collect();
        v.push((JOURNAL_ROOM_ID.into(), inner.home.join("journal"), RoomKind::Journal));
        v
    }

    pub fn backfill_all(&self) -> Result<(), CoreError> {
        let roots = { Self::all_roots(&self.inner.lock().unwrap()) };
        for (id, _, _) in roots { self.rescan_room(&id); }
        Ok(())
    }

    pub fn rescan_room(&self, room: &RoomId) {
        let Some((root, kind)) = self.room_root(room) else { return };
        let entries = scan_room(&root, kind == RoomKind::Linked, kind == RoomKind::Journal);
        let mut inner = self.inner.lock().unwrap();
        if let Ok(ch) = inner.index.backfill(room, &entries) { self.emit_changes(&mut inner, ch); }
    }

    pub fn apply_fs_change(&self, abs_path: &Path) {
        let roots = { Self::all_roots(&self.inner.lock().unwrap()) };
        // longest matching root wins (journal/inbox live under home)
        let hit = roots.into_iter().filter(|(_, root, _)| abs_path.starts_with(root)).max_by_key(|(_, root, _)| root.as_os_str().len());
        if let Some((id, _, _)) = hit { self.rescan_room(&id); }
    }

    pub fn list_rooms(&self) -> Vec<Room> {
        let inner = self.inner.lock().unwrap();
        inner.state.rooms.iter().map(|r| Self::to_room(&inner, r)).collect()
    }

    pub fn list_artifacts(&self, room: &RoomId) -> Result<Vec<Artifact>, CoreError> {
        let inner = self.inner.lock().unwrap();
        if room != JOURNAL_ROOM_ID && inner.state.find(room).is_none() { return Err(CoreError::RoomNotFound); }
        inner.index.list(room)
    }

    pub fn journal_day(&self, date: &IsoDate) -> Result<JournalDay, CoreError> {
        validate_iso_date(date)?;
        let inner = self.inner.lock().unwrap();
        let mut seen = HashSet::new();
        let mut artifacts = Vec::new();
        for (a, target) in inner.index.by_day(date)? {
            if seen.insert(target) { artifacts.push(a); }
        }
        let dir = inner.home.join("journal").join(date);
        let mut notes = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let rel = format!("{}/{}", date, e.file_name().to_string_lossy());
                if let PathClass::Note { .. } = crate::rules::classify_path(Path::new(&rel), true) {
                    let (_, updated) = crate::meta::file_times(&e.path());
                    notes.push(Note { date: date.clone(), name: e.file_name().to_string_lossy().to_string(), rel_path: rel, updated_at: updated, author: Author::Me });
                }
            }
        }
        notes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(JournalDay { date: date.clone(), artifacts, notes })
    }

    fn slug_taken(inner: &Inner, slug: &str) -> bool {
        let key = slug_key(slug);
        inner.state.rooms.iter().any(|r| slug_key(&r.name) == key || r.path.file_name().map(|f| slug_key(&f.to_string_lossy()) == key).unwrap_or(false))
    }

    pub fn create_room(&self, name: &str) -> Result<Room, CoreError> {
        let name = validate_room_name(name)?;
        let slug = room_slug(&name);
        let mut inner = self.inner.lock().unwrap();
        if Self::slug_taken(&inner, &slug) { return Err(CoreError::RoomExists); }
        let path = inner.home.join(&slug);
        std::fs::create_dir(&path)?;
        let (dev, ino) = inode_of(&path).unzip();
        let rec = RoomRecord { id: nanoid::nanoid!(12), name, kind: RoomKind::Owned, path, dev, ino };
        inner.state.rooms.push(rec.clone());
        inner.state.save()?;
        let room = Self::to_room(&inner, &rec);
        self.emit(&mut inner, EventKind::RoomAdded { room: room.clone() });
        Ok(room)
    }

    pub fn link_folder(&self, path: &Path, name: Option<&str>) -> Result<Room, CoreError> {
        let real = std::fs::canonicalize(path).map_err(|_| CoreError::InvalidLinkPath("not found".into()))?;
        if !real.is_dir() || std::fs::read_dir(&real).is_err() { return Err(CoreError::InvalidLinkPath("not a readable directory".into())); }
        let display = match name { Some(n) => validate_room_name(n)?, None => validate_room_name(&real.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default())? };
        let mut inner = self.inner.lock().unwrap();
        if real == inner.home || inner.home.starts_with(&real) || real.starts_with(&inner.home) {
            return Err(CoreError::InvalidLinkPath("home".into()));
        }
        for r in inner.state.rooms.iter().filter(|r| r.kind == RoomKind::Linked) {
            if real.starts_with(&r.path) || r.path.starts_with(&real) { return Err(CoreError::OverlappingRoom); }
        }
        if Self::slug_taken(&inner, &room_slug(&display)) { return Err(CoreError::RoomExists); }
        let rec = RoomRecord { id: nanoid::nanoid!(12), name: display, kind: RoomKind::Linked, path: real, dev: None, ino: None };
        inner.state.rooms.push(rec.clone());
        inner.state.save()?;
        let room = Self::to_room(&inner, &rec);
        self.emit(&mut inner, EventKind::RoomAdded { room: room.clone() });
        drop(inner);
        self.rescan_room(&rec.id);
        Ok(room)
    }

    pub fn rename_room(&self, room: &RoomId, name: &str) -> Result<Room, CoreError> {
        let name = validate_room_name(name)?;
        let mut inner = self.inner.lock().unwrap();
        let rec = inner.state.find(room).cloned().ok_or(CoreError::RoomNotFound)?;
        if rec.id == "inbox" { return Err(CoreError::InvalidRoomName); }
        let others_taken = inner.state.rooms.iter().filter(|r| r.id != rec.id)
            .any(|r| slug_key(&r.name) == slug_key(&room_slug(&name)));
        if others_taken { return Err(CoreError::RoomExists); }
        let new_path = if rec.kind == RoomKind::Owned {
            let p = inner.home.join(room_slug(&name));
            if p != rec.path { std::fs::rename(&rec.path, &p)?; }
            p
        } else { rec.path.clone() };
        {
            let r = inner.state.find_mut(room).unwrap();
            r.name = name;
            r.path = new_path;
        }
        inner.state.save()?;
        let updated = inner.state.find(room).cloned().unwrap();
        let room_v = Self::to_room(&inner, &updated);
        self.emit(&mut inner, EventKind::RoomUpdated { room: room_v.clone() });
        Ok(room_v)
    }

    pub fn save_note(&self, date: &IsoDate, name: &str, body: &str) -> Result<Note, CoreError> {
        validate_iso_date(date)?;
        let name = validate_note_name(name)?;
        if body.len() > MAX_NOTE_BYTES { return Err(CoreError::InvalidInput("note too large".into())); }
        let mut inner = self.inner.lock().unwrap();
        let dir = inner.home.join("journal").join(date);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(&name);
        let tmp = dir.join(format!(".{name}.tmp"));
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &path)?;
        let (_, updated) = crate::meta::file_times(&path);
        let note = Note { date: date.clone(), name: name.clone(), rel_path: format!("{date}/{name}"), updated_at: updated, author: Author::Me };
        self.emit(&mut inner, EventKind::NoteSaved { note: note.clone() });
        Ok(note)
    }

    pub fn resolve_file(&self, room: &RoomId, rel: &str) -> Result<PathBuf, CoreError> {
        let (root, _) = self.room_root(room).ok_or(CoreError::RoomNotFound)?;
        let rel_p = Path::new(rel);
        if rel_p.is_absolute() || rel_p.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err(CoreError::PathEscape); }
        let root_real = std::fs::canonicalize(&root)?;
        let joined = root.join(rel_p);
        // every parent directory must resolve inside the room (no directory-link escape)
        let parent = joined.parent().unwrap_or(&root);
        let parent_real = std::fs::canonicalize(parent).map_err(|_| CoreError::PathEscape)?;
        if !parent_real.starts_with(&root_real) { return Err(CoreError::PathEscape); }
        let meta = std::fs::symlink_metadata(&joined).map_err(|_| CoreError::RoomNotFound)?;
        let target = std::fs::canonicalize(&joined).map_err(|_| CoreError::PathEscape)?;
        if meta.file_type().is_symlink() {
            let is_html = target.extension().and_then(|e| e.to_str()).map(|e| matches!(e.to_ascii_lowercase().as_str(), "html" | "htm")).unwrap_or(false);
            if !(target.is_file() && is_html) { return Err(CoreError::PathEscape); }
            return Ok(target);
        }
        if !target.starts_with(&root_real) { return Err(CoreError::PathEscape); }
        Ok(target)
    }
}
```

`crates/rooms-core/src/lib.rs`:
```rust
pub mod core;
pub mod error;
pub mod index;
pub mod meta;
pub mod rules;
pub mod state;
pub mod walk;

pub use crate::core::RoomsCore;
pub use error::CoreError;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core`
Expected: all unit tests + 8 `core_flows` tests pass

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "feat(core): RoomsCore facade for rooms, journal days, notes and file resolution"
```

---

### Task 8: File watching (`watch.rs`)

**Files:**
- Create: `crates/rooms-core/src/watch.rs`
- Modify: `crates/rooms-core/src/lib.rs` (add `pub mod watch; pub use watch::start_watching;`)
- Test: append to `crates/rooms-core/tests/core_flows.rs`

**Interfaces:**
- Consumes: `RoomsCore::{home, list_rooms, room_root, apply_fs_change}`
- Produces:
  - `pub struct WatchHandle` (dropping it stops watching)
  - `pub fn start_watching(core: RoomsCore) -> Result<WatchHandle, CoreError>` — watches Home recursively plus every linked room path; 300 ms debounce; each changed path → `core.apply_fs_change(path)`; newly linked rooms are picked up when `room.added` events arrive
  - `pub fn open_and_watch(home: &Path) -> Result<(RoomsCore, WatchHandle), CoreError>` — open, start watching, then backfill on a background thread (so callers never wait for big rooms)

- [ ] **Step 1: Write the failing tests**

Append to `crates/rooms-core/tests/core_flows.rs`:
```rust
use std::time::{Duration, Instant};

fn wait_for(rx: &mut tokio::sync::broadcast::Receiver<RoomsEvent>, pred: impl Fn(&EventKind) -> bool, max: Duration) -> Vec<RoomsEvent> {
    let start = Instant::now();
    let mut got = Vec::new();
    while start.elapsed() < max {
        match rx.try_recv() {
            Ok(e) => { let hit = pred(&e.kind); got.push(e); if hit { return got; } }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    panic!("timed out; got {got:?}");
}

#[test]
fn new_file_emits_added_within_two_seconds() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::write(d.path().join("a/new.html"), "<title>N</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.room_id == r.id), Duration::from_secs(2));
}

#[test]
fn atomic_rename_write_yields_single_add() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::write(d.path().join("a/x.html.tmp"), "<title>X</title>").unwrap();
    fs::rename(d.path().join("a/x.html.tmp"), d.path().join("a/x.html")).unwrap();
    let evs = wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { .. }), Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(600));
    let mut all = evs;
    while let Ok(e) = rx.try_recv() { all.push(e); }
    let adds = all.iter().filter(|e| matches!(e.kind, EventKind::ArtifactAdded { .. })).count();
    let removes = all.iter().filter(|e| matches!(e.kind, EventKind::ArtifactRemoved { .. })).count();
    assert_eq!((adds, removes), (1, 0), "{all:?}");
}

#[test]
fn open_returns_before_backfill_completes_for_big_room() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), "").unwrap(); }
    let t = Instant::now();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    assert!(t.elapsed() < Duration::from_millis(500), "open must not wait for backfill");
    assert!(!core.list_rooms().is_empty());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rooms-core --test core_flows watch -- --test-threads=1`
Expected: FAIL — `could not find watch in rooms_core`

- [ ] **Step 3: Write the implementation**

```rust
use crate::{CoreError, RoomsCore};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use rooms_protocol::{EventKind, RoomKind};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct WatchHandle {
    _debouncer: Arc<Mutex<notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::RecommendedCache>>>,
}

pub fn start_watching(core: RoomsCore) -> Result<WatchHandle, CoreError> {
    let c2 = core.clone();
    let debouncer = new_debouncer(Duration::from_millis(300), None, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let mut seen = std::collections::HashSet::new();
            for ev in events {
                for p in &ev.paths {
                    if p.components().any(|c| c.as_os_str() == ".rooms") { continue; }
                    if seen.insert(p.clone()) { c2.apply_fs_change(p); }
                }
            }
        }
    }).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let deb = Arc::new(Mutex::new(debouncer));
    deb.lock().unwrap().watch(core.home(), RecursiveMode::Recursive).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    for r in core.list_rooms().into_iter().filter(|r| r.kind == RoomKind::Linked) {
        let _ = deb.lock().unwrap().watch(Path::new(&r.path), RecursiveMode::Recursive);
    }
    // pick up rooms linked later
    let deb2 = deb.clone();
    let mut rx = core.subscribe();
    std::thread::spawn(move || {
        while let Ok(e) = rx.blocking_recv() {
            if let EventKind::RoomAdded { room } = e.kind {
                if room.kind == RoomKind::Linked {
                    let _ = deb2.lock().unwrap().watch(Path::new(&room.path), RecursiveMode::Recursive);
                }
            }
        }
    });
    Ok(WatchHandle { _debouncer: deb })
}

pub fn open_and_watch(home: &Path) -> Result<(RoomsCore, WatchHandle), CoreError> {
    let core = RoomsCore::open(home)?;
    let handle = start_watching(core.clone())?;
    let c = core.clone();
    std::thread::spawn(move || { let _ = c.backfill_all(); });
    Ok((core, handle))
}
```

Note for the implementer: `notify-debouncer-full` 0.5 exposes `Debouncer::watch(path, mode)` directly; if the resolved version only has `debouncer.watcher().watch(...)`, use that — the behavior is identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p rooms-core --test core_flows -- --test-threads=1`
Expected: all pass (watch tests may take ~3 s)

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "feat(core): debounced file watching with background backfill"
```

---

### Task 9: roomsd HTTP API, write guard and sandboxed file origin

**Files:**
- Create: `crates/roomsd/src/guard.rs`, `crates/roomsd/src/routes.rs`
- Modify: `crates/roomsd/src/lib.rs`
- Test: `crates/roomsd/tests/api.rs`

**Interfaces:**
- Consumes: `RoomsCore` (Task 7 signatures), `rooms_protocol::*`
- Produces:
  - `pub struct AppState { pub core: RoomsCore, pub token: String, pub read_only: bool, pub files_origin: String }` (Clone)
  - `pub fn build_api_router(state: AppState) -> axum::Router` — all `/v1` routes from spec §5 S3
  - `pub fn build_files_router(state: AppState) -> axum::Router` — `GET /{room_id}/{*rel}` with CSP sandbox header
  - Error body: `ApiError { error: <code>, message }` with the status from `CoreError::status()`
  - Snapshot GETs set header `X-Rooms-Seq: <core.current_seq()>`

- [ ] **Step 1: Write the failing tests**

`crates/roomsd/tests/api.rs`:
```rust
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use rooms_core::RoomsCore;
use roomsd::{build_api_router, build_files_router, AppState};
use std::net::SocketAddr;
use tower::ServiceExt;

fn app(read_only: bool, peer: &str) -> (tempfile::TempDir, axum::Router, AppState) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    core.backfill_all().unwrap();
    let st = AppState { core, token: "t0k".into(), read_only, files_origin: "http://127.0.0.1:4318".into() };
    let addr: SocketAddr = peer.parse().unwrap();
    (d, build_api_router(st.clone()).layer(MockConnectInfo(addr)), st)
}

async fn body_json(r: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn post(uri: &str, json: &str, token: Option<&str>, host: &str) -> Request<Body> {
    let mut b = Request::post(uri).header("content-type", "application/json").header("host", host);
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::from(json.to_string())).unwrap()
}

#[tokio::test]
async fn info_and_rooms_with_seq_header() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let r = app.clone().oneshot(Request::get("/v1/info").body(Body::empty()).unwrap()).await.unwrap();
    let v = body_json(r).await;
    assert_eq!(v["version"], "1");
    assert_eq!(v["journalRoomId"], "journal");
    let r = app.oneshot(Request::get("/v1/rooms").body(Body::empty()).unwrap()).await.unwrap();
    assert!(r.headers().get("x-rooms-seq").is_some());
    assert_eq!(r.status(), StatusCode::OK);
}

#[tokio::test]
async fn create_room_requires_token_host_and_loopback() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let ok = app.clone().oneshot(post("/v1/rooms", r#"{"name":"연구 도구"}"#, Some("t0k"), "127.0.0.1:4317")).await.unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let no_token = app.clone().oneshot(post("/v1/rooms", r#"{"name":"b"}"#, None, "127.0.0.1:4317")).await.unwrap();
    assert_eq!(no_token.status(), StatusCode::FORBIDDEN);
    let rebinding = app.clone().oneshot(post("/v1/rooms", r#"{"name":"c"}"#, Some("t0k"), "evil.example:4317")).await.unwrap();
    assert_eq!(rebinding.status(), StatusCode::FORBIDDEN);
    let dup = app.oneshot(post("/v1/rooms", r#"{"name":"연구-도구"}"#, Some("t0k"), "localhost:4317")).await.unwrap();
    assert_eq!(dup.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(dup).await["error"], "room_exists");
}

#[tokio::test]
async fn remote_peer_cannot_write_even_with_token() {
    let (_d, app, _) = app(false, "100.64.1.2:5000");
    let r = app.oneshot(post("/v1/rooms", r#"{"name":"x"}"#, Some("t0k"), "127.0.0.1:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(r).await["error"], "read_only");
}

#[tokio::test]
async fn foreign_origin_is_rejected() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let mut req = post("/v1/rooms", r#"{"name":"x"}"#, Some("t0k"), "127.0.0.1:4317");
    req.headers_mut().insert("origin", "https://evil.example".parse().unwrap());
    assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn note_put_and_journal_get() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let req = Request::put("/v1/journal/2026-10-05/notes/%ED%9A%8C%EA%B3%A0") // "회고" percent-encoded
        .header("host", "127.0.0.1:4317").header("authorization", "Bearer t0k")
        .header("content-type", "text/markdown").body(Body::from("# 오늘")).unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);
    let r = app.oneshot(Request::get("/v1/journal/2026-10-05").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(body_json(r).await["notes"][0]["name"], "회고.md");
}

#[tokio::test]
async fn unknown_room_is_404_and_bad_date_400() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let r = app.clone().oneshot(Request::get("/v1/rooms/nope/artifacts").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = app.oneshot(Request::get("/v1/journal/2026-13-40").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn files_router_sets_sandbox_csp_and_blocks_escape() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), "<p>hi</p>").unwrap();
    let files = build_files_router(st);
    let r = files.clone().oneshot(Request::get(format!("/{}/x.html", room.id)).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-security-policy"], "sandbox allow-scripts allow-popups");
    let r = files.oneshot(Request::get(format!("/{}/..%2Fjournal", room.id)).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p roomsd`
Expected: FAIL — `unresolved import roomsd::build_api_router`

- [ ] **Step 3: Write the implementation**

`crates/roomsd/src/guard.rs`:
```rust
use crate::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rooms_protocol::ApiError;
use std::net::SocketAddr;

const ALLOWED_HOSTS: [&str; 2] = ["127.0.0.1:4317", "localhost:4317"];
const ALLOWED_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:4317"];

pub fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, axum::Json(ApiError { error: "read_only".into(), message: "read only".into() })).into_response()
}

pub async fn write_guard(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let is_write = matches!(*req.method(), Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    if !is_write { return next.run(req).await; }
    let h = req.headers();
    let host_ok = h.get(header::HOST).and_then(|v| v.to_str().ok()).map(|v| ALLOWED_HOSTS.contains(&v)).unwrap_or(false);
    let origin_ok = match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) { None => true, Some(o) => ALLOWED_ORIGINS.contains(&o) };
    let token_ok = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some(format!("Bearer {}", st.token).as_str());
    if st.read_only || !peer.ip().is_loopback() || !host_ok || !origin_ok || !token_ok { return forbidden(); }
    next.run(req).await
}
```

`crates/roomsd/src/routes.rs`:
```rust
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rooms_core::CoreError;
use rooms_protocol::*;
use serde::Deserialize;

pub struct ApiErr(pub CoreError);
impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(ApiError { error: self.0.code().into(), message: self.0.to_string() })).into_response()
    }
}
impl From<CoreError> for ApiErr { fn from(e: CoreError) -> Self { ApiErr(e) } }

fn with_seq<T: serde::Serialize>(st: &AppState, v: T) -> Response {
    let mut h = HeaderMap::new();
    h.insert("x-rooms-seq", HeaderValue::from_str(&st.core.current_seq().to_string()).unwrap());
    (h, Json(v)).into_response()
}

pub async fn info(State(st): State<AppState>) -> Json<Info> {
    Json(Info { version: PROTOCOL_VERSION.into(), read_only: st.read_only, home: st.core.home().to_string_lossy().into(),
        journal_room_id: JOURNAL_ROOM_ID.into(), files_origin: st.files_origin.clone() })
}

pub async fn list_rooms(State(st): State<AppState>) -> Response { with_seq(&st, st.core.list_rooms()) }

pub async fn list_artifacts(State(st): State<AppState>, Path(room_id): Path<String>) -> Result<Response, ApiErr> {
    Ok(with_seq(&st, st.core.list_artifacts(&room_id)?))
}

pub async fn journal_day(State(st): State<AppState>, Path(date): Path<String>) -> Result<Response, ApiErr> {
    Ok(with_seq(&st, st.core.journal_day(&date)?))
}

#[derive(Deserialize)] pub struct CreateBody { name: String }
pub async fn create_room(State(st): State<AppState>, Json(b): Json<CreateBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(st.core.create_room(&b.name)?))
}

#[derive(Deserialize)] pub struct LinkBody { path: String, name: Option<String> }
pub async fn link_room(State(st): State<AppState>, Json(b): Json<LinkBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(st.core.link_folder(std::path::Path::new(&b.path), b.name.as_deref())?))
}

#[derive(Deserialize)] pub struct RenameBody { name: String }
pub async fn rename_room(State(st): State<AppState>, Path(room_id): Path<String>, Json(b): Json<RenameBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(st.core.rename_room(&room_id, &b.name)?))
}

pub async fn put_note(State(st): State<AppState>, Path((date, name)): Path<(String, String)>, body: String) -> Result<Json<Note>, ApiErr> {
    Ok(Json(st.core.save_note(&date, &name, &body)?))
}

pub async fn file(State(st): State<AppState>, Path((room_id, rel)): Path<(String, String)>) -> Result<Response, ApiErr> {
    let path = st.core.resolve_file(&room_id, &rel)?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| ApiErr(CoreError::WriteFailed(e.to_string())))?;
    let ct = if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) { "text/markdown; charset=utf-8" } else { "text/html; charset=utf-8" };
    Ok(([("content-type", ct), ("content-security-policy", "sandbox allow-scripts allow-popups")], bytes).into_response())
}
```

`crates/roomsd/src/lib.rs`:
```rust
pub mod guard;
pub mod routes;
pub mod sse;

use axum::routing::{get, patch, post, put};
use axum::Router;
use rooms_core::RoomsCore;

#[derive(Clone)]
pub struct AppState {
    pub core: RoomsCore,
    pub token: String,
    pub read_only: bool,
    pub files_origin: String,
}

pub fn build_api_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/info", get(routes::info))
        .route("/v1/rooms", get(routes::list_rooms).post(routes::create_room))
        .route("/v1/rooms/link", post(routes::link_room))
        .route("/v1/rooms/{room_id}", patch(routes::rename_room))
        .route("/v1/rooms/{room_id}/artifacts", get(routes::list_artifacts))
        .route("/v1/journal/{date}", get(routes::journal_day))
        .route("/v1/journal/{date}/notes/{name}", put(routes::put_note))
        .route("/v1/events", get(sse::events))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::write_guard))
        .with_state(state)
}

pub fn build_files_router(state: AppState) -> Router {
    Router::new().route("/{room_id}/{*rel}", get(routes::file)).with_state(state)
}
```

Create `crates/roomsd/src/sse.rs` now with a stub so the crate compiles (Task 10 fills it):
```rust
use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;

pub async fn events(State(_st): State<AppState>) -> StatusCode { StatusCode::NOT_IMPLEMENTED }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p roomsd`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add crates/roomsd
git commit -m "feat(roomsd): /v1 HTTP API with write guard and sandboxed file origin"
```

---

### Task 10: SSE events, the `roomsd` binary, and the TS client

**Files:**
- Modify: `crates/roomsd/src/sse.rs`, `crates/roomsd/src/main.rs`
- Create: `packages/protocol-ts/src/client.ts`
- Test: append to `crates/roomsd/tests/api.rs`

**Interfaces:**
- Consumes: `AppState`, `RoomsCore::subscribe`, `rooms_core::watch::open_and_watch`
- Produces:
  - `GET /v1/events` → `text/event-stream`; each SSE `data:` is one JSON `RoomsEvent`; SSE `id:` = `seq`; keep-alive every 15 s
  - Binary `roomsd`: opens `~/rooms` (or `$ROOMS_HOME`), writes a fresh token to `<home>/.rooms/token` (mode 0600), serves API on `127.0.0.1:4317` and files on `127.0.0.1:4318`
  - TS: `createRoomsClient(baseUrl: string, token?: string)` with `info()`, `listRooms()`, `listArtifacts(roomId)`, `journalDay(date)`, `createRoom(name)`, `renameRoom(id, name)`, `linkFolder(path, name?)`, `saveNote(date, name, body)`, `fileUrl(info, artifact)`, `subscribe(onEvent)` — applying the snapshot/seq rule from spec §5 S3 is the caller's job (Plan 2)

- [ ] **Step 1: Write the failing test**

Append to `crates/roomsd/tests/api.rs`:
```rust
#[tokio::test]
async fn events_stream_delivers_room_added_with_seq() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let r = app.oneshot(Request::get("/v1/events").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.headers()["content-type"], "text/event-stream");
    let mut body = r.into_body();
    st.core.create_room("x").unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Some(Ok(f)) = body.frame().await {
                if let Ok(d) = f.into_data() { let s = String::from_utf8_lossy(&d).to_string(); if s.contains("room.added") { return s; } }
            }
        }
    }).await.unwrap();
    assert!(frame.contains("\"seq\":"));
    assert!(frame.contains("id:"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p roomsd events_stream`
Expected: FAIL — status 501 / content-type mismatch

- [ ] **Step 3: Write the implementation**

`crates/roomsd/src/sse.rs`:
```rust
use crate::AppState;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub async fn events(State(st): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(st.core.subscribe()).filter_map(|r| match r {
        Ok(ev) => Some(Ok(Event::default().id(ev.seq.to_string()).data(serde_json::to_string(&ev).unwrap_or_default()))),
        // lagged receiver: tell the client to resync (spec §3)
        Err(_) => Some(Ok(Event::default().data(r#"{"seq":0,"type":"resync","roomId":null}"#))),
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
```

`crates/roomsd/src/main.rs`:
```rust
use roomsd::{build_api_router, build_files_router, AppState};
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;

#[tokio::main]
async fn main() {
    let home = std::env::var("ROOMS_HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("home dir").join("rooms"));
    let (core, _watch) = rooms_core::watch::open_and_watch(&home).expect("open rooms home");
    let token = nanoid::nanoid!(32);
    let token_path = core.home().join(".rooms/token");
    std::fs::write(&token_path, &token).expect("write token");
    std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).expect("chmod token");
    let st = AppState { core, token, read_only: false, files_origin: "http://127.0.0.1:4318".into() };
    let api = build_api_router(st.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let files = build_files_router(st).into_make_service();
    let api_l = tokio::net::TcpListener::bind("127.0.0.1:4317").await.unwrap_or_else(|e| { eprintln!("port 4317: {e}"); std::process::exit(2) });
    let files_l = tokio::net::TcpListener::bind("127.0.0.1:4318").await.unwrap_or_else(|e| { eprintln!("port 4318: {e}"); std::process::exit(2) });
    eprintln!("roomsd: home={} api=http://127.0.0.1:4317 files=http://127.0.0.1:4318", home.display());
    let a = tokio::spawn(async move { axum::serve(api_l, api).await });
    let f = tokio::spawn(async move { axum::serve(files_l, files).await });
    let _ = tokio::join!(a, f);
}
```

`packages/protocol-ts/src/client.ts`:
```ts
import type { Artifact } from "./generated/Artifact";
import type { Info } from "./generated/Info";
import type { JournalDay } from "./generated/JournalDay";
import type { Note } from "./generated/Note";
import type { Room } from "./generated/Room";
import type { RoomsEvent } from "./generated/RoomsEvent";

export type Snapshot<T> = { data: T; seq: number };

export function createRoomsClient(baseUrl: string, token?: string) {
  const get = async <T>(path: string): Promise<Snapshot<T>> => {
    const r = await fetch(baseUrl + path);
    if (!r.ok) throw await r.json();
    return { data: (await r.json()) as T, seq: Number(r.headers.get("x-rooms-seq") ?? 0) };
  };
  const write = async <T>(method: string, path: string, body: string, type = "application/json"): Promise<T> => {
    const r = await fetch(baseUrl + path, {
      method,
      headers: { "content-type": type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    });
    if (!r.ok) throw await r.json();
    return (await r.json()) as T;
  };
  return {
    info: async () => (await get<Info>("/v1/info")).data,
    listRooms: () => get<Room[]>("/v1/rooms"),
    listArtifacts: (roomId: string) => get<Artifact[]>(`/v1/rooms/${encodeURIComponent(roomId)}/artifacts`),
    journalDay: (date: string) => get<JournalDay>(`/v1/journal/${date}`),
    createRoom: (name: string) => write<Room>("POST", "/v1/rooms", JSON.stringify({ name })),
    linkFolder: (path: string, name?: string) => write<Room>("POST", "/v1/rooms/link", JSON.stringify({ path, name })),
    renameRoom: (id: string, name: string) => write<Room>("PATCH", `/v1/rooms/${encodeURIComponent(id)}`, JSON.stringify({ name })),
    saveNote: (date: string, name: string, body: string) =>
      write<Note>("PUT", `/v1/journal/${date}/notes/${encodeURIComponent(name)}`, body, "text/markdown"),
    fileUrl: (info: Info, a: Artifact) =>
      `${info.filesOrigin}/${encodeURIComponent(a.roomId)}/${a.relPath.split("/").map(encodeURIComponent).join("/")}`,
    subscribe: (onEvent: (e: RoomsEvent) => void) => {
      const es = new EventSource(baseUrl + "/v1/events");
      es.onmessage = (m) => onEvent(JSON.parse(m.data) as RoomsEvent);
      return () => es.close();
    },
  };
}
```

- [ ] **Step 4: Run tests, then a manual curl check**

Run: `cargo test --workspace`
Expected: all pass

Run (manual):
```bash
export ROOMS_HOME=$(mktemp -d)
cargo run -p roomsd &
sleep 3
curl -s http://127.0.0.1:4317/v1/info
curl -s http://127.0.0.1:4317/v1/rooms
TOKEN=$(cat "$ROOMS_HOME/.rooms/token")
curl -s -X POST -H "host: 127.0.0.1:4317" -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"연구 도구"}' http://127.0.0.1:4317/v1/rooms
kill %1
```
Expected: `{"version":"1","readOnly":false,...,"journalRoomId":"journal","filesOrigin":"http://127.0.0.1:4318"}`, a JSON array containing the `inbox` room, then the new room JSON.

- [ ] **Step 5: Commit**

```bash
git add crates/roomsd packages/protocol-ts
git commit -m "feat(roomsd): SSE events, daemon binary with token, and thin TS client"
```

---

## Self-Review (done while writing)

- **Spec coverage:** S1 folder contract (Tasks 2–4, 6), S2 `RoomsCore` (Task 7, names match spec except Rust casing `journal_day`/`list_artifacts` as frozen in spec §5), S3 endpoints + write guard + seq header + files origin + SSE (Tasks 9–10), §2 rules (Tasks 2, 3, 6, 7), §3 errors (Task 2 codes, Task 9 mapping), AC-1/2/3/4/5/6/7/8/11/13 (Tasks 7–10), AC-12 remote (deferred to Plan 4 — listener 4319), AC-9/10/14/15–18 UI & onboarding (Plans 2–3). Spec S4 handoff is v2 — intentionally absent.
- **Placeholder scan:** Only the stub `sse.rs` in Task 9, which Task 10 replaces with full code in the same plan.
- **Type consistency:** `RoomsCore` methods used in Tasks 8–10 match Task 7. `Change` (Task 6) is consumed only in Task 7. `AppState` fields identical in Tasks 9–10 and tests. Event names (`room.added` …) match Task 1.
- **Review Focus:** all five lines have pinned tests (Tasks 2, 3, 4, 8 ×2).
- **Time zone:** Journal-day assertions in Task 7 assume the test machine runs in KST (+09:00), like the user's Mac; on CI set `TZ=Asia/Seoul`.
