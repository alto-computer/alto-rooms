//! Sessions in the Journal and in rooms. What a session is comes from rooms-collect's
//! `collect.db`, opened read-only and only when roomsd was given the collector's folder. Which
//! room holds one is `.rooms/conversations.json`: a map keyed by session, so a session is in at
//! most one room, with a snapshot that keeps it showing after its log is gone.

use crate::core::RoomsCore;
use crate::error::CoreError;
use crate::lock::lock;
use chrono::{Local, NaiveDate, TimeZone, Utc};
use rooms_collect::sessions as collect;
use rooms_protocol::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    title: Option<String>,
    cwd: Option<String>,
    started_at: String,
    ended_at: String,
    messages: u32,
    last_reply: Option<String>,
    #[serde(default)]
    artifacts_written: Vec<String>,
}

impl Snapshot {
    fn of(s: Session) -> Snapshot {
        Snapshot { title: s.title, cwd: s.cwd, started_at: s.started_at, ended_at: s.ended_at, messages: s.messages,
            last_reply: s.last_reply, artifacts_written: s.artifacts_written }
    }

    fn session(self, session_ref: SessionRef, room_id: Option<RoomId>) -> Session {
        let SessionRef { agent, id } = session_ref;
        Session { agent, id, title: self.title, cwd: self.cwd, started_at: self.started_at, ended_at: self.ended_at,
            messages: self.messages, last_reply: self.last_reply, artifacts_written: self.artifacts_written, room_id }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Membership {
    room_id: RoomId,
    added_at: String,
    snapshot: Snapshot,
}

type Memberships = BTreeMap<SessionRef, Membership>;

#[derive(Serialize, Deserialize)]
struct Disk {
    version: u32,
    /// Keyed by `<agent>:<id>`.
    conversations: BTreeMap<String, Membership>,
}

fn store_path(home: &Path) -> PathBuf { home.join(".rooms/conversations.json") }

/// The memberships on disk, without those whose room is gone. A file that does not parse is
/// kept aside as `conversations.json.corrupt` and read as empty.
fn load(home: &Path, rooms: &HashSet<RoomId>) -> Memberships {
    let path = store_path(home);
    let Ok(bytes) = std::fs::read(&path) else { return Memberships::new() };
    let disk: Disk = match serde_json::from_slice(&bytes) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("rooms-core: {}: {e}", path.display());
            let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
            return Memberships::new();
        }
    };
    disk.conversations.into_iter()
        .filter(|(_, m)| rooms.contains(&m.room_id))
        .filter_map(|(k, m)| Some((SessionRef::parse_key(&k)?, m)))
        .collect()
}

fn save(home: &Path, map: &Memberships) -> Result<(), CoreError> {
    let disk = Disk { version: 1, conversations: map.iter().map(|(r, m)| (r.key(), m.clone())).collect() };
    let path = store_path(home);
    let tmp = path.with_extension(format!("{}.tmp", nanoid::nanoid!(8)));
    std::fs::write(&tmp, serde_json::to_vec_pretty(&disk).map_err(|e| CoreError::Internal(e.to_string()))?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// `[start, end)` of a local calendar day, as collect.db's UTC timestamps.
fn utc_bounds(date: &str) -> Option<(String, String)> {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let start = |d: NaiveDate| Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).earliest()
        .map(|t| t.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string());
    Some((start(day)?, start(day.succ_opt()?)?))
}

impl RoomsCore {
    /// Reads sessions from the collector's store in `data` (`ROOMS_COLLECT_DATA`).
    pub fn set_collect_data(&self, data: &Path) {
        lock(&self.inner).collect_db = Some(rooms_collect::store::path_in(data));
    }

    fn collect_db(&self) -> Option<rusqlite::Connection> {
        let path = lock(&self.inner).collect_db.clone()?;
        rooms_collect::store::open_read_only(&path).ok()
    }

    /// The session as collect.db has it now; `None` when it has no such session or there is no
    /// collect.db yet. A store that is there but cannot be read is an error, never "not found".
    fn collect_get(&self, session_ref: &SessionRef) -> Result<Option<Session>, CoreError> {
        let Some(path) = lock(&self.inner).collect_db.clone() else { return Ok(None) };
        if !path.exists() { return Ok(None); }
        let unreadable = |e: rusqlite::Error| CoreError::Internal(format!("collect.db: {e}"));
        let db = rooms_collect::store::open_read_only(&path).map_err(unreadable)?;
        collect::get(&db, session_ref).map_err(unreadable)
    }

    /// The Aside account session `id` is under, as collect.db recorded it.
    pub(crate) fn aside_account(&self, id: &SessionId) -> Option<String> {
        collect::aside_account(&self.collect_db()?, id).ok().flatten()
    }

    fn room_id_set(&self) -> HashSet<RoomId> {
        lock(&self.inner).state.rooms.iter().map(|r| r.id.clone()).collect()
    }

    /// The sessions active on a local day, each at its first message that day.
    pub(crate) fn day_sessions(&self, date: &IsoDate) -> Vec<JournalSession> {
        let (Some(db), Some((from, to))) = (self.collect_db(), utc_bounds(date)) else { return Vec::new() };
        let rows = collect::on_day(&db, &from, &to).unwrap_or_else(|e| {
            eprintln!("rooms-core: sessions on {date}: {e}");
            Vec::new()
        });
        let members = load(&self.home, &self.room_id_set());
        rows.into_iter().map(|(at, mut session)| {
            session.room_id = members.get(&session.session_ref()).map(|m| m.room_id.clone());
            JournalSession { at, session }
        }).collect()
    }

    /// One session with its room: fresh from collect.db when it has it, else as its room last
    /// saw it. `NotFound` when neither knows it; `Internal` when collect.db cannot be read.
    pub fn session(&self, session_ref: &SessionRef) -> Result<Session, CoreError> {
        let member = load(&self.home, &self.room_id_set()).remove(session_ref);
        let room_id = member.as_ref().map(|m| m.room_id.clone());
        match (self.collect_get(session_ref)?, member) {
            (Some(fresh), _) => Ok(Session { room_id, ..fresh }),
            (None, Some(m)) => Ok(m.snapshot.session(session_ref.clone(), room_id)),
            (None, None) => Err(CoreError::NotFound),
        }
    }

    /// The sessions added to `room`, last active first. Their snapshots are refreshed from
    /// collect.db when it still has them.
    pub fn room_sessions(&self, room: &RoomId) -> Result<Vec<Session>, CoreError> {
        if room == JOURNAL_ROOM_ID { return Ok(Vec::new()); }
        let rooms = self.room_id_set();
        if !rooms.contains(room) { return Err(CoreError::RoomNotFound); }
        let mut mine: Vec<(SessionRef, Snapshot)> = load(&self.home, &rooms).into_iter()
            .filter(|(_, m)| &m.room_id == room).map(|(r, m)| (r, m.snapshot)).collect();
        let fresh: Vec<(SessionRef, Snapshot)> = match self.collect_db() {
            Some(db) => mine.iter().filter_map(|(r, old)| {
                let now = Snapshot::of(collect::get(&db, r).ok()??);
                (&now != old).then(|| (r.clone(), now))
            }).collect(),
            None => Vec::new(),
        };
        if !fresh.is_empty() {
            let inner = lock(&self.inner);
            let rooms: HashSet<RoomId> = inner.state.rooms.iter().map(|r| r.id.clone()).collect();
            let mut map = load(&self.home, &rooms);
            for (r, snap) in &fresh {
                if let Some(m) = map.get_mut(r) { m.snapshot = snap.clone(); }
            }
            save(&self.home, &map)?;
            for (r, snap) in fresh {
                if let Some(entry) = mine.iter_mut().find(|(i, _)| *i == r) { entry.1 = snap; }
            }
        }
        let mut out: Vec<Session> = mine.into_iter().map(|(r, s)| s.session(r, Some(room.clone()))).collect();
        out.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
        Ok(out)
    }

    /// Puts a session in `room` (out of any other), or out of every room (`None`). Emits
    /// `session.moved` when that changes where it is.
    pub fn set_session_room(&self, session_ref: &SessionRef, room: Option<RoomId>) -> Result<Session, CoreError> {
        let fresh = self.collect_get(session_ref)?;
        let mut inner = lock(&self.inner);
        let rooms: HashSet<RoomId> = inner.state.rooms.iter().map(|r| r.id.clone()).collect();
        if room.as_ref().is_some_and(|r| !rooms.contains(r)) { return Err(CoreError::RoomNotFound); }
        let mut map = load(&self.home, &rooms);
        let old = map.remove(session_ref);
        let from = old.as_ref().map(|m| m.room_id.clone());
        let snapshot = fresh.map(Snapshot::of).or_else(|| old.as_ref().map(|m| m.snapshot.clone())).ok_or(CoreError::NotFound)?;
        if let Some(r) = &room {
            let added_at = old.filter(|m| &m.room_id == r).map(|m| m.added_at).unwrap_or_else(|| Local::now().to_rfc3339());
            map.insert(session_ref.clone(), Membership { room_id: r.clone(), added_at, snapshot: snapshot.clone() });
        }
        save(&self.home, &map)?;
        let session = snapshot.session(session_ref.clone(), room.clone());
        if from != room {
            self.emit(&mut inner, EventKind::SessionMoved { session: session.clone(), from_room_id: from });
        }
        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    struct Fixture { _d: tempfile::TempDir, core: RoomsCore, data: PathBuf }

    fn fixture() -> Fixture {
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(&d.path().join("rooms")).unwrap();
        let data = d.path().join("collect");
        rooms_collect::store::open(&rooms_collect::store::path_in(&data)).unwrap();
        core.set_collect_data(&data);
        Fixture { _d: d, core, data }
    }

    fn local(day: u32, h: u32, m: u32) -> String {
        Local.with_ymd_and_hms(2026, 10, day, h, m, 0).unwrap().with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }

    fn message(data: &Path, session_id: &str, role: &str, ts: &str, text: &str) {
        let c = rooms_collect::store::open(&rooms_collect::store::path_in(data)).unwrap();
        c.execute(
            "INSERT INTO events(id, kind, agent, session, ts, cwd, role, src_path, file_key, src_offset, src_len, preview)
             VALUES(?1, 'message', 'claude-code', ?2, ?3, '/work', ?4, '/log', 'k', 0, 0, ?5)",
            params![format!("{session_id}-{ts}-{role}"), session_id, ts, role, text]).unwrap();
    }

    fn sref(id: &str) -> SessionRef { SessionRef::parse_key(&format!("claude-code:{id}")).unwrap() }

    #[test]
    fn a_session_over_midnight_is_on_both_days_with_its_room() {
        let f = fixture();
        message(&f.data, "s1", "user", &local(1, 23, 50), "plan the launch");
        message(&f.data, "s1", "assistant", &local(1, 23, 52), "planned");
        message(&f.data, "s1", "user", &local(2, 0, 10), "more");
        let room = f.core.create_room("Launch").unwrap();
        f.core.set_session_room(&sref("s1"), Some(room.id.clone())).unwrap();
        let day1 = f.core.journal_day(&"2026-10-01".into()).unwrap().sessions;
        let day2 = f.core.journal_day(&"2026-10-02".into()).unwrap().sessions;
        assert_eq!(day1.iter().map(|c| (c.at.clone(), c.session.room_id.clone())).collect::<Vec<_>>(), [(local(1, 23, 50), Some(room.id.clone()))]);
        assert_eq!(day2.iter().map(|c| c.at.clone()).collect::<Vec<_>>(), [local(2, 0, 10)]);
        assert_eq!((day2[0].session.title.as_deref(), day2[0].session.messages), (Some("plan the launch"), 3));
        assert!(f.core.journal_day(&"2026-10-03".into()).unwrap().sessions.is_empty());
    }

    #[test]
    fn moving_replaces_the_room_and_emits() {
        let f = fixture();
        message(&f.data, "s1", "user", &local(1, 10, 0), "hi");
        let (a, b) = (f.core.create_room("A").unwrap().id, f.core.create_room("B").unwrap().id);
        let mut rx = f.core.subscribe();
        f.core.set_session_room(&sref("s1"), Some(a.clone())).unwrap();
        f.core.set_session_room(&sref("s1"), Some(b.clone())).unwrap();
        assert!(f.core.room_sessions(&a).unwrap().is_empty());
        assert_eq!(f.core.room_sessions(&b).unwrap().iter().map(Session::session_ref).collect::<Vec<_>>(), [sref("s1")]);
        let moves: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).filter_map(|e| match e.kind {
            EventKind::SessionMoved { session, from_room_id } => Some((from_room_id, session.room_id)),
            _ => None,
        }).collect();
        assert_eq!(moves, [(None, Some(a.clone())), (Some(a), Some(b.clone()))]);
        f.core.set_session_room(&sref("s1"), Some(b.clone())).unwrap();
        assert!(rx.try_recv().is_err(), "no event when nothing moved");
        assert_eq!(f.core.session(&sref("s1")).unwrap().room_id, Some(b.clone()));
        f.core.set_session_room(&sref("s1"), None).unwrap();
        assert_eq!(f.core.session(&sref("s1")).unwrap().room_id, None);
        assert!(f.core.room_sessions(&b).unwrap().is_empty());
        assert!(matches!(f.core.set_session_room(&sref("nope"), Some(b.clone())), Err(CoreError::NotFound)));
        assert!(matches!(f.core.set_session_room(&sref("s1"), Some("gone".into())), Err(CoreError::RoomNotFound)));
    }

    #[test]
    fn a_room_keeps_its_sessions_after_collect_db_empties() {
        let f = fixture();
        message(&f.data, "s1", "user", &local(1, 10, 0), "write the report");
        let room = f.core.create_room("Reports").unwrap().id;
        f.core.set_session_room(&sref("s1"), Some(room.clone())).unwrap();
        message(&f.data, "s1", "assistant", &local(1, 11, 0), "report written");
        let seen = f.core.room_sessions(&room).unwrap();
        assert_eq!((seen[0].messages, seen[0].last_reply.as_deref()), (2, Some("report written")), "refreshed from collect.db");
        assert_eq!(f.core.session(&sref("s1")).unwrap(), seen[0]);
        rooms_collect::store::remove(&rooms_collect::store::path_in(&f.data));
        rooms_collect::store::open(&rooms_collect::store::path_in(&f.data)).unwrap();
        assert_eq!(f.core.room_sessions(&room).unwrap(), seen);
        let reopened = RoomsCore::open(f.core.home()).unwrap();
        assert_eq!(reopened.room_sessions(&room).unwrap(), seen, "no collect.db at all");
        assert_eq!(reopened.session(&sref("s1")).unwrap(), seen[0], "kept by its room");
        assert!(matches!(reopened.session(&sref("s2")), Err(CoreError::NotFound)));
        assert!(reopened.journal_day(&"2026-10-01".into()).unwrap().sessions.is_empty());
    }

    #[test]
    fn an_unreadable_collect_db_is_an_error_not_not_found() {
        let f = fixture();
        let db = rooms_collect::store::path_in(&f.data);
        rooms_collect::store::remove(&db);
        std::fs::write(&db, b"this is not a database at all, not even close............................................").unwrap();
        let err = f.core.session(&sref("s1")).unwrap_err();
        assert_eq!(err.status(), 500, "{err}");
        let room = f.core.create_room("A").unwrap().id;
        assert_eq!(f.core.set_session_room(&sref("s1"), Some(room)).unwrap_err().status(), 500);
        rooms_collect::store::remove(&db);
        assert!(matches!(f.core.session(&sref("s1")), Err(CoreError::NotFound)), "no collect.db yet");
    }

    #[test]
    fn a_day_ask_names_the_days_sessions_newest_first_with_their_rooms() {
        let f = fixture();
        message(&f.data, "s1", "user", &local(1, 9, 0), "plan the launch");
        message(&f.data, "s1", "assistant", &local(1, 9, 30), "planned");
        message(&f.data, "s2", "assistant", &local(1, 11, 0), "a reply with no prompt before it");
        let room = f.core.create_room("Launch").unwrap();
        f.core.set_session_room(&sref("s1"), Some(room.id)).unwrap();
        let (_, sessions) = f.core.day_context(&"2026-10-01".into()).unwrap();
        let got: Vec<_> = sessions.iter().map(|s| (s.title.as_str(), s.span.as_str(), s.room.as_deref(), s.last_reply.as_deref())).collect();
        assert_eq!(got, [
            ("a reply with no prompt before it", "11:00–11:00", None, Some("a reply with no prompt before it")),
            ("plan the launch", "09:00–09:30", Some("Launch"), Some("planned")),
        ]);
    }

    #[test]
    fn memberships_of_a_deleted_room_are_dropped() {
        let f = fixture();
        message(&f.data, "s1", "user", &local(1, 10, 0), "hi");
        let room = f.core.create_room("Temp").unwrap().id;
        f.core.set_session_room(&sref("s1"), Some(room.clone())).unwrap();
        std::fs::remove_dir(f.core.home().join("temp")).unwrap();
        f.core.sync_home_dirs();
        assert!(matches!(f.core.room_sessions(&room), Err(CoreError::RoomNotFound)));
        assert_eq!(f.core.journal_day(&"2026-10-01".into()).unwrap().sessions[0].session.room_id, None);
    }
}
