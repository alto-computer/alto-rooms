use crate::error::CoreError;
use crate::index::{read_entry, Change, Index};
use crate::rules::{room_slug, slug_key, validate_iso_date, validate_note_name, validate_room_name, PathClass};
use crate::state::{inode_of, RoomRecord, StateStore};
use crate::walk::scan_room;
use rooms_protocol::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

struct Inner {
    home: PathBuf,
    state: StateStore,
    index: Index,
    /// Rooms whose root was missing/unreadable at the last rescan (drives one room.updated per transition).
    unavailable: HashSet<RoomId>,
}

/// A room root is usable only if it is a directory we can list. Scanning anything else would
/// look empty and wipe the room's index rows (losing first-seen createdAt).
fn root_available(root: &Path) -> bool {
    root.is_dir() && std::fs::read_dir(root).is_ok()
}

#[derive(Clone)]
pub struct RoomsCore {
    inner: Arc<Mutex<Inner>>,
    /// Last emitted event seq. Incremented only inside `emit` (which runs under `Inner`), so send
    /// order matches seq order; read lock-free by `current_seq`.
    seq: Arc<AtomicU64>,
    /// One mutex per room serializing its rescans. Lock order: room scan lock → `Inner`
    /// (never take a scan lock while holding `Inner`). The map lock itself is only held briefly.
    scan_locks: Arc<Mutex<HashMap<RoomId, Arc<Mutex<()>>>>>,
    tx: broadcast::Sender<RoomsEvent>,
    home: PathBuf,
}

const MAX_NOTE_BYTES: usize = 1_048_576;

enum HomeChange { Added(RoomId), Renamed(RoomId), Removed(RoomId) }

/// One real (non-symlink) directory directly under home, as listed without any lock.
struct HomeDir { path: PathBuf, name: String, dev: Option<u64>, ino: Option<u64> }

/// Lists the candidate room folders directly under home (no lock: `read_dir` + `inode_of`).
/// `.`-folders, `journal` and `inbox` are fixed roots and never listed. `None` = home unlistable.
fn list_home_dirs(home: &Path) -> Option<Vec<HomeDir>> {
    let rd = std::fs::read_dir(home).ok()?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_real_dir = e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false);
        if !is_real_dir || name.starts_with('.') || name == "journal" || name == "inbox" { continue; }
        let path = e.path();
        let (dev, ino) = inode_of(&path).unzip();
        out.push(HomeDir { path, name, dev, ino });
    }
    Some(out)
}

/// Reconciles a `list_home_dirs` listing with the owned rooms in `state` (spec §2 / Q3), under the
/// core lock: a new real folder is adopted, a folder whose inode matches a known room is that room
/// renamed (path + display name follow, id kept), and an owned room whose folder is gone with no
/// inode match is removed. The inbox is excluded from inode matching: a Finder rename of `inbox`
/// is adopted as a normal room and the caller recreates an empty `home/inbox`.
/// If home could not be listed (`None`) nothing is changed.
fn reconcile_home_dirs(home: &Path, listing: Option<Vec<HomeDir>>, state: &mut StateStore) -> Vec<HomeChange> {
    let mut out = Vec::new();
    let Some(listing) = listing else { return out };
    for HomeDir { path: p, name, dev, ino } in listing {
        if state.rooms.iter().any(|r| r.path == p) { continue; }
        if let (Some(dv), Some(io)) = (dev, ino) {
            let renamed = state.rooms.iter()
                .find(|r| r.id != "inbox" && r.dev == Some(dv) && r.ino == Some(io))
                .map(|r| r.id.clone());
            if let Some(id) = renamed {
                let rec = state.find_mut(&id).unwrap();
                rec.path = p.clone();
                rec.name = name.clone();
                out.push(HomeChange::Renamed(id));
                continue;
            }
        }
        let id: RoomId = nanoid::nanoid!(12);
        state.rooms.push(RoomRecord { id: id.clone(), name, kind: RoomKind::Owned, path: p, dev, ino });
        out.push(HomeChange::Added(id));
    }
    // Per-room `symlink_metadata` under the lock is intentional: a cheap stat over the handful of
    // owned rooms, and it must see the same state the listing above was reconciled against.
    let gone: Vec<RoomId> = state.rooms.iter()
        .filter(|r| r.kind == RoomKind::Owned && r.id != "inbox" && r.path.starts_with(home) && std::fs::symlink_metadata(&r.path).is_err())
        .map(|r| r.id.clone()).collect();
    state.rooms.retain(|r| !gone.contains(&r.id));
    out.extend(gone.into_iter().map(HomeChange::Removed));
    out
}

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
        // adopt / follow / drop owned folders changed in Finder while we were not running
        let home_changes = reconcile_home_dirs(&home, list_home_dirs(&home), &mut state);
        state.save()?;
        let mut index = Index::open(&dot.join("index.sqlite"))?;
        for c in &home_changes {
            if let HomeChange::Removed(id) = c { index.drop_room(id)?; }
        }
        let _ = index.take_touched_days();
        let (tx, _) = broadcast::channel(1024);
        Ok(RoomsCore {
            inner: Arc::new(Mutex::new(Inner { home: home.clone(), state, index, unavailable: HashSet::new() })),
            seq: Arc::new(AtomicU64::new(0)),
            scan_locks: Arc::new(Mutex::new(HashMap::new())),
            tx,
            home,
        })
    }

    pub fn home(&self) -> &Path { &self.home }

    pub fn subscribe(&self) -> broadcast::Receiver<RoomsEvent> { self.tx.subscribe() }

    pub fn current_seq(&self) -> u64 { self.seq.load(Ordering::SeqCst) }

    /// Must be called with `Inner` held (the `&mut Inner` proves it): that keeps the increment and
    /// the send of concurrent emitters ordered, so receivers see strictly increasing seqs.
    fn emit(&self, _inner: &mut Inner, kind: EventKind) {
        let s = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send(RoomsEvent { seq: s, kind });
    }

    fn emit_changes(&self, inner: &mut Inner, changes: Vec<Change>) {
        for c in changes {
            let kind = match c {
                Change::Added(a) => EventKind::ArtifactAdded { artifact: a },
                Change::Updated(a) => EventKind::ArtifactUpdated { artifact: a },
                Change::Removed { room_id, artifact_id } => EventKind::ArtifactRemoved { room_id, artifact_id },
            };
            self.emit(inner, kind);
        }
        // Stored created_day (old and new on a move, plus removed rows' days), not a recomputation.
        for date in inner.index.take_touched_days() { self.emit(inner, EventKind::JournalChanged { date }); }
    }

    fn to_room(inner: &Inner, r: &RoomRecord) -> Room {
        let (count, updated_at) = inner.index.room_summary(&r.id).unwrap_or((0, None));
        Room {
            id: r.id.clone(),
            name: r.name.clone(),
            kind: r.kind,
            path: r.path.to_string_lossy().to_string(),
            status: if inner.unavailable.contains(&r.id) || !r.path.is_dir() { RoomStatus::Unavailable } else { RoomStatus::Ok },
            artifact_count: count,
            updated_at,
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
        let mut first_err = None;
        for (id, _, _) in roots {
            if let Err(e) = self.try_rescan_room(&id) { first_err.get_or_insert(e); }
        }
        match first_err { Some(e) => Err(e), None => Ok(()) }
    }

    fn scan_lock(&self, room: &RoomId) -> Arc<Mutex<()>> {
        self.scan_locks.lock().unwrap().entry(room.clone()).or_default().clone()
    }

    /// Rescan pipeline. Only the short index steps hold `Inner`; listing and reading files do not.
    /// Scans of one room are serialized by its scan lock, so the last scan to apply is the latest.
    fn try_rescan_room(&self, room: &RoomId) -> Result<(), CoreError> {
        let lock = self.scan_lock(room);
        let _serial = lock.lock().unwrap(); // lock order: room scan lock → Inner
        let Some((root, kind)) = self.room_root(room) else { return Ok(()) };
        if !root_available(&root) {
            // Keep the rows; only flag the room (spec §2: 방은 유지, status unavailable, 이벤트 발행).
            let mut inner = self.inner.lock().unwrap();
            if inner.state.find(room).is_some() && inner.unavailable.insert(room.clone()) {
                self.emit_room_updated(&mut inner, room);
            }
            return Ok(());
        }
        let entries = scan_room(&root, kind == RoomKind::Linked, kind == RoomKind::Journal); // no lock
        let fps = { self.inner.lock().unwrap().index.fingerprints(room)? };
        let facts: Vec<_> = entries.iter().filter_map(|e| read_entry(room, e, fps.get(&e.rel_path))).collect(); // no lock
        let present: HashSet<String> = entries.iter().filter(|e| e.class == PathClass::Artifact).map(|e| e.rel_path.clone()).collect();
        let mut inner = self.inner.lock().unwrap();
        // Removed while we were reading (Finder delete): write nothing for it.
        if room != JOURNAL_ROOM_ID && inner.state.find(room).is_none() { return Ok(()); }
        let ch = inner.index.apply(room, &facts, &present)?;
        self.emit_changes(&mut inner, ch);
        if inner.unavailable.remove(room) { self.emit_room_updated(&mut inner, room); }
        Ok(())
    }

    fn emit_room_updated(&self, inner: &mut Inner, room: &RoomId) {
        if let Some(rec) = inner.state.find(room).cloned() {
            let room_v = Self::to_room(inner, &rec);
            self.emit(inner, EventKind::RoomUpdated { room: room_v });
        }
    }

    /// Rescans every room currently flagged unavailable (the watcher calls this periodically so a
    /// returning folder is picked up even though nothing watches its path while it is gone).
    pub fn rescan_unavailable(&self) {
        let ids: Vec<RoomId> = { self.inner.lock().unwrap().unavailable.iter().cloned().collect() };
        for id in ids { self.rescan_room(&id); }
    }

    pub fn rescan_room(&self, room: &RoomId) {
        if let Err(e) = self.try_rescan_room(room) { eprintln!("rooms-core: rescan of room {room} failed: {e}"); }
    }

    /// Room owning `abs_path` (longest matching root wins: journal/inbox live under home).
    pub fn room_for_path(&self, abs_path: &Path) -> Option<RoomId> {
        let roots = { Self::all_roots(&self.inner.lock().unwrap()) };
        roots.into_iter()
            .filter(|(_, root, _)| abs_path.starts_with(root))
            .max_by_key(|(_, root, _)| root.as_os_str().len())
            .map(|(id, _, _)| id)
    }

    /// Re-reads the direct children of home (called by the watcher when a batch touches one):
    /// emits room.added / room.updated (Finder rename, same id) / room.removed. Returns the ids
    /// of added or renamed rooms so the caller can scan them.
    pub fn sync_home_dirs(&self) -> Vec<RoomId> {
        let listing = list_home_dirs(&self.home); // no lock
        let mut touched = Vec::new();
        let mut removed = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            let home = inner.home.clone();
            let changes = reconcile_home_dirs(&home, listing, &mut inner.state);
            if !changes.is_empty() {
                if let Err(e) = inner.state.save() { eprintln!("rooms-core: saving state after home sync failed: {e}"); }
            }
            for c in changes {
                match &c {
                    HomeChange::Added(id) | HomeChange::Renamed(id) => {
                        let id = id.clone();
                        let added = matches!(c, HomeChange::Added(_));
                        let Some(rec) = inner.state.find(&id).cloned() else { continue };
                        let room = Self::to_room(&inner, &rec);
                        let kind = if added { EventKind::RoomAdded { room } } else { EventKind::RoomUpdated { room } };
                        self.emit(&mut inner, kind);
                        touched.push(id);
                    }
                    HomeChange::Removed(id) => {
                        let id = id.clone();
                        inner.unavailable.remove(&id);
                        self.emit(&mut inner, EventKind::RoomRemoved { room_id: id.clone() });
                        match inner.index.drop_room(&id) {
                            Ok(ch) => self.emit_changes(&mut inner, ch),
                            Err(e) => eprintln!("rooms-core: dropping index rows of room {id} failed: {e}"),
                        }
                        removed.push(id);
                    }
                }
            }
        }
        // Map lock only (no room scan lock, no Inner). An in-flight scan keeps its own Arc and its
        // apply step sees the room gone.
        if !removed.is_empty() {
            let mut locks = self.scan_locks.lock().unwrap();
            for id in &removed { locks.remove(id); }
        }
        // The inbox record never follows its folder: if `inbox` was renamed away (adopted above as a
        // normal room), recreate an empty one and let the caller rescan it to drop the moved rows.
        let inbox = self.home.join("inbox");
        if !inbox.is_dir() {
            match std::fs::create_dir_all(&inbox) {
                Ok(()) => touched.push("inbox".into()),
                Err(e) => eprintln!("rooms-core: recreating inbox failed: {e}"),
            }
        }
        touched
    }

    pub fn apply_fs_change(&self, abs_path: &Path) {
        if let Some(id) = self.room_for_path(abs_path) { self.rescan_room(&id); }
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
        let rows = { self.inner.lock().unwrap().index.by_day(date)? };
        let mut seen = HashSet::new();
        let mut artifacts = Vec::new();
        for (a, target) in rows {
            if seen.insert(target) { artifacts.push(a); }
        }
        // Notes are listed from disk without the lock.
        let dir = self.home.join("journal").join(date);
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

    fn slug_taken(inner: &Inner, slug: &str) -> bool { Self::slug_taken_except(inner, slug, None) }

    fn slug_taken_except(inner: &Inner, slug: &str, except: Option<&str>) -> bool {
        let key = slug_key(slug);
        inner.state.rooms.iter().filter(|r| Some(r.id.as_str()) != except).any(|r| slug_key(&r.name) == key || r.path.file_name().map(|f| slug_key(&f.to_string_lossy()) == key).unwrap_or(false))
    }

    pub fn create_room(&self, name: &str) -> Result<Room, CoreError> {
        let name = validate_room_name(name)?;
        let slug = room_slug(&name);
        let mut inner = self.inner.lock().unwrap();
        // The stat + mkdir below stay under the lock on purpose: the slug check and the folder
        // creation must be atomic with respect to other create/rename calls.
        if Self::slug_taken(&inner, &slug) { return Err(CoreError::RoomExists); }
        let path = inner.home.join(&slug);
        // A plain folder of that name (not yet adopted) or any other entry: the name is taken.
        if std::fs::symlink_metadata(&path).is_ok() { return Err(CoreError::RoomExists); }
        std::fs::create_dir(&path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { CoreError::RoomExists } else { e.into() })?;
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
        let mut inner = self.inner.lock().unwrap();
        if real == inner.home || inner.home.starts_with(&real) || real.starts_with(&inner.home) {
            return Err(CoreError::InvalidLinkPath("home".into()));
        }
        for r in inner.state.rooms.iter().filter(|r| r.kind == RoomKind::Linked) {
            if real.starts_with(&r.path) || r.path.starts_with(&real) { return Err(CoreError::OverlappingRoom); }
        }
        let display = match name { Some(n) => validate_room_name(n)?, None => validate_room_name(&real.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default())? };
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
        if Self::slug_taken_except(&inner, &room_slug(&name), Some(&rec.id)) { return Err(CoreError::RoomExists); }
        // The stat + rename below stay under the lock on purpose: the slug check and the folder
        // rename must be atomic with respect to other create/rename calls.
        let new_path = if rec.kind == RoomKind::Owned {
            let p = inner.home.join(room_slug(&name));
            if p != rec.path {
                let same_dir = std::fs::canonicalize(&p).ok() == std::fs::canonicalize(&rec.path).ok();
                if !same_dir && std::fs::symlink_metadata(&p).is_ok() { return Err(CoreError::RoomExists); }
                std::fs::rename(&rec.path, &p)?;
            }
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
        // File IO without the lock; the lock is taken only to emit.
        let dir = self.home.join("journal").join(date);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(&name);
        let tmp = dir.join(format!(".{name}.tmp"));
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &path)?;
        let (_, updated) = crate::meta::file_times(&path);
        let note = Note { date: date.clone(), name: name.clone(), rel_path: format!("{date}/{name}"), updated_at: updated, author: Author::Me };
        let mut inner = self.inner.lock().unwrap();
        self.emit(&mut inner, EventKind::NoteSaved { note: note.clone() });
        Ok(note)
    }

    pub fn resolve_file(&self, room: &RoomId, rel: &str) -> Result<PathBuf, CoreError> {
        let (root, _) = self.room_root(room).ok_or(CoreError::RoomNotFound)?;
        let rel_p = Path::new(rel);
        if rel_p.is_absolute() || rel_p.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err(CoreError::PathEscape); }
        if rel_p.components().any(|c| matches!(c, std::path::Component::Normal(n) if n.to_string_lossy().starts_with('.'))) { return Err(CoreError::PathEscape); }
        let root_real = std::fs::canonicalize(&root)?;
        let joined = root.join(rel_p);
        // every parent directory must resolve inside the room (no directory-link escape)
        let parent = joined.parent().unwrap_or(&root);
        let parent_real = std::fs::canonicalize(parent).map_err(|_| CoreError::PathEscape)?;
        if !parent_real.starts_with(&root_real) { return Err(CoreError::PathEscape); }
        let meta = std::fs::symlink_metadata(&joined).map_err(|_| CoreError::RoomNotFound)?;
        let target = std::fs::canonicalize(&joined).map_err(|_| CoreError::PathEscape)?;
        if !target.is_file() { return Err(CoreError::PathEscape); }
        if meta.file_type().is_symlink() {
            let is_html = target.extension().and_then(|e| e.to_str()).map(|e| matches!(e.to_ascii_lowercase().as_str(), "html" | "htm")).unwrap_or(false);
            if !(target.is_file() && is_html) { return Err(CoreError::PathEscape); }
            return Ok(target);
        }
        if !target.starts_with(&root_real) { return Err(CoreError::PathEscape); }
        Ok(target)
    }
}
