use crate::error::CoreError;
use crate::index::{read_entry, Change, Index};
use crate::rules::{room_slug, slug_key, validate_iso_date, validate_note_name, validate_room_name, PathClass};
use crate::state::{inode_of, RoomRecord, StateStore};
use crate::walk::scan_room;
use rooms_protocol::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
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

/// The room in `roots` (as `room_roots` returns them, longest first) owning `abs_path`, and its root.
pub fn owner_of<'a>(roots: &'a [(RoomId, PathBuf)], abs_path: &Path) -> Option<&'a (RoomId, PathBuf)> {
    roots.iter().find(|(_, root)| abs_path.starts_with(root))
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
    /// Serializes `save_note` (tmp write → rename → emit) so NoteSaved order equals file order.
    /// Lock order: notes_lock → `Inner`.
    notes_lock: Arc<Mutex<()>>,
    tx: broadcast::Sender<RoomsEvent>,
    home: PathBuf,
}

/// Non-owning handle to a `RoomsCore`: lets helper threads observe the core without keeping it
/// (or the event channel) alive.
#[derive(Clone)]
pub struct WeakRoomsCore {
    inner: Weak<Mutex<Inner>>,
    seq: Arc<AtomicU64>,
    scan_locks: Arc<Mutex<HashMap<RoomId, Arc<Mutex<()>>>>>,
    notes_lock: Arc<Mutex<()>>,
    tx: broadcast::WeakSender<RoomsEvent>,
    home: PathBuf,
}

impl WeakRoomsCore {
    /// `None` once the core (its `Inner` or its event sender) has been dropped.
    pub fn upgrade(&self) -> Option<RoomsCore> {
        let inner = self.inner.upgrade()?;
        let tx = self.tx.upgrade()?;
        Some(RoomsCore {
            inner,
            seq: self.seq.clone(),
            scan_locks: self.scan_locks.clone(),
            notes_lock: self.notes_lock.clone(),
            tx,
            home: self.home.clone(),
        })
    }
}

const MAX_NOTE_BYTES: usize = 1_048_576;

/// Capacity of the event channel: a subscriber further behind than this lags and must resync.
const EVENT_BUFFER: usize = 1024;

/// Above this many changes in one batch, `emit_changes` sends per-room resyncs instead of one
/// event per change, keeping well inside `EVENT_BUFFER`.
const MAX_CHANGE_EVENTS: usize = 256;

/// Test-only seam: called in `try_rescan_room` between the read phase and the apply phase, with
/// the room id. Compiles to nothing outside `cfg(test)`.
#[cfg(test)]
type ScanHook = Arc<dyn Fn(&str) + Send + Sync>;
#[cfg(test)]
static BEFORE_APPLY_HOOK: Mutex<Option<ScanHook>> = Mutex::new(None);

/// `base` if nothing (not even a broken symlink) is at `dir/base`, else `stem (2).ext`, `stem (3).ext`, …
fn free_name(dir: &Path, base: &str) -> String {
    let taken = |n: &str| std::fs::symlink_metadata(dir.join(n)).is_ok();
    if !taken(base) { return base.to_string(); }
    let (stem, ext) = match base.rsplit_once('.') { Some((s, e)) if !s.is_empty() => (s, format!(".{e}")), _ => (base, String::new()) };
    (2..).map(|i| format!("{stem} ({i}){ext}")).find(|n| !taken(n)).unwrap()
}

// Test-only seam: when set on the calling thread, `move_artifact`'s index step fails after the
// filesystem move, exercising the rollback. Compiles to nothing outside `cfg(test)`.
#[cfg(test)]
thread_local! { static FAIL_REASSIGN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

enum HomeChange { Added(RoomId), Renamed(RoomId), Removed(RoomId) }

/// One real (non-symlink) directory directly under home.
struct HomeDir { path: PathBuf, name: String, dev: Option<u64>, ino: Option<u64> }

/// Lists the candidate room folders directly under home (`read_dir` + `inode_of`). Called with
/// `Inner` held (see `sync_home_dirs_with`).
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
/// Defense in depth against a stale listing: an owned room whose (dev, ino) is still listed at a
/// path no other room record holds is never removed as "gone" (a later sync follows it as a rename).
/// If home could not be listed (`None`) nothing is changed.
fn reconcile_home_dirs(home: &Path, listing: Option<Vec<HomeDir>>, state: &mut StateStore) -> Vec<HomeChange> {
    let mut out = Vec::new();
    let Some(listing) = listing else { return out };
    let listed_inodes: HashMap<(u64, u64), PathBuf> = listing.iter().filter_map(|h| Some(((h.dev?, h.ino?), h.path.clone()))).collect();
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
        // Protected only if its inode is listed at a path no OTHER room record holds: when another
        // room owns that path (`rm -rf b && mv a b`), room a's folder really is gone.
        .filter(|r| {
            let listed_at = match (r.dev, r.ino) { (Some(dv), Some(io)) => listed_inodes.get(&(dv, io)), _ => None };
            !listed_at.is_some_and(|p| !state.rooms.iter().any(|o| o.id != r.id && &o.path == p))
        })
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
        if let Err(e) = crate::onboarding::ensure(&home) { eprintln!("rooms-core: onboarding files not written: {e}"); }
        let (tx, _) = broadcast::channel(EVENT_BUFFER);
        Ok(RoomsCore {
            inner: Arc::new(Mutex::new(Inner { home: home.clone(), state, index, unavailable: HashSet::new() })),
            seq: Arc::new(AtomicU64::new(0)),
            scan_locks: Arc::new(Mutex::new(HashMap::new())),
            notes_lock: Arc::new(Mutex::new(())),
            tx,
            home,
        })
    }

    pub fn home(&self) -> &Path { &self.home }

    pub fn downgrade(&self) -> WeakRoomsCore {
        WeakRoomsCore {
            inner: Arc::downgrade(&self.inner),
            seq: self.seq.clone(),
            scan_locks: self.scan_locks.clone(),
            notes_lock: self.notes_lock.clone(),
            tx: self.tx.downgrade(),
            home: self.home.clone(),
        }
    }

    /// Full reconcile after the watcher lost events (overflow / error): rescan everything, then
    /// tell clients to refetch.
    pub fn resync_all(&self) {
        self.rescan_all();
        // Resync is emitted even if the rescan failed, on purpose, so clients refetch.
        let mut inner = self.inner.lock().unwrap();
        self.emit(&mut inner, EventKind::Resync { room_id: None });
    }

    /// Reconciles home folders and rescans every room, emitting what changed (no resync): for when
    /// events may have been missed but clients' snapshots plus the change events stay valid.
    pub fn rescan_all(&self) {
        self.sync_home_dirs(); // pick up folders created/renamed/deleted in Finder (takes Inner itself)
        if let Err(e) = self.backfill_all() { eprintln!("rooms-core: rescan of all rooms failed: {e}"); }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RoomsEvent> { self.tx.subscribe() }

    pub fn current_seq(&self) -> u64 { self.seq.load(Ordering::SeqCst) }

    /// `ask.started` / `ask.done` from `asks::Asks`: same seq and broadcast as every other event.
    pub fn emit_ask(&self, kind: EventKind) {
        debug_assert!(matches!(kind, EventKind::AskStarted { .. } | EventKind::AskDone { .. }));
        let mut inner = self.inner.lock().unwrap();
        self.emit(&mut inner, kind);
    }

    /// Must be called with `Inner` held (the `&mut Inner` proves it): that keeps the increment and
    /// the send of concurrent emitters ordered, so receivers see strictly increasing seqs.
    fn emit(&self, _inner: &mut Inner, kind: EventKind) {
        let s = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send(RoomsEvent { seq: s, kind });
    }

    fn emit_changes(&self, inner: &mut Inner, changes: Vec<Change>) {
        if changes.len() > MAX_CHANGE_EVENTS {
            self.emit_room_resyncs(inner, &changes);
        } else {
            self.emit_each_change(inner, changes);
        }
        // Stored created_day (old and new on a move, plus removed rows' days), not a recomputation.
        for date in inner.index.take_touched_days() { self.emit(inner, EventKind::JournalChanged { date }); }
    }

    /// A big batch as `resync {room}` (refetch that room) plus `room.updated` (its new count) per
    /// room: one event per change would overflow subscribers' buffers, and every lagging client
    /// would then refetch everything.
    fn emit_room_resyncs(&self, inner: &mut Inner, changes: &[Change]) {
        let rooms: std::collections::BTreeSet<RoomId> = changes.iter().map(|c| match c {
            Change::Added(a) | Change::Updated(a) => a.room_id.clone(),
            Change::Removed { room_id, .. } => room_id.clone(),
        }).collect();
        for room in rooms {
            self.emit(inner, EventKind::Resync { room_id: Some(room.clone()) });
            self.emit_room_updated(inner, &room);
        }
    }

    fn emit_each_change(&self, inner: &mut Inner, changes: Vec<Change>) {
        for c in changes {
            let kind = match c {
                Change::Added(a) => EventKind::ArtifactAdded { artifact: a },
                Change::Updated(a) => EventKind::ArtifactUpdated { artifact: a },
                Change::Removed { room_id, artifact_id } => EventKind::ArtifactRemoved { room_id, artifact_id },
            };
            self.emit(inner, kind);
        }
    }

    fn to_room(inner: &Inner, r: &RoomRecord) -> Room {
        let (count, updated_at) = inner.index.room_summary(&r.id).unwrap_or((0, None));
        Room {
            id: r.id.clone(),
            name: r.name.clone(),
            kind: r.kind,
            path: r.path.to_string_lossy().to_string(),
            // No stat under `Inner`: rescans (watcher, retry tick, rescan_unavailable) keep `unavailable` current.
            status: if inner.unavailable.contains(&r.id) { RoomStatus::Unavailable } else { RoomStatus::Ok },
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
        if !root_available(&root) { self.flag_unavailable(room); return Ok(()); }
        let entries = scan_room(&root, kind == RoomKind::Linked, kind == RoomKind::Journal); // no lock
        let fps = { self.inner.lock().unwrap().index.fingerprints(room)? };
        let facts: Vec<_> = entries.iter().filter_map(|e| read_entry(room, e, fps.get(&e.rel_path))).collect(); // no lock
        let present: HashSet<String> = entries.iter().filter(|e| e.class == PathClass::Artifact).map(|e| e.rel_path.clone()).collect();
        self.apply_scan(room, &root, |index| index.apply(room, &facts, &present))
    }

    /// The rescan pipeline for some paths of a room only (each relative to its root): a path that
    /// is an artifact now is upserted, any other path's row is removed. Same locking as
    /// `try_rescan_room`; an unavailable root takes the full rescan, which flags it.
    fn try_rescan_paths(&self, room: &RoomId, rels: &[PathBuf]) -> Result<(), CoreError> {
        let lock = self.scan_lock(room);
        let _serial = lock.lock().unwrap(); // lock order: room scan lock → Inner
        let Some((root, kind)) = self.room_root(room) else { return Ok(()) };
        if !root_available(&root) { self.flag_unavailable(room); return Ok(()); }
        let (honor_gitignore, in_journal) = (kind == RoomKind::Linked, kind == RoomKind::Journal);
        let mut facts = Vec::new();
        let mut gone = Vec::new();
        for rel in rels {
            let rel_path = rel.to_string_lossy().replace('\\', "/");
            match crate::walk::entry_at(&root, rel, honor_gitignore, in_journal) {
                Some(e) if e.class == PathClass::Artifact => {
                    let fp = { self.inner.lock().unwrap().index.fingerprint(room, &rel_path)? };
                    facts.extend(read_entry(room, &e, fp.as_ref())); // no lock
                }
                _ => gone.push(rel_path),
            }
        }
        self.apply_scan(room, &root, |index| index.apply_paths(room, &facts, &gone))
    }

    /// Phase 3 of a scan of `room` at `root`, under `Inner`: runs `apply` and emits its changes,
    /// unless the room was removed or moved, or its root vanished, while the scan was reading.
    fn apply_scan(&self, room: &RoomId, root: &Path, apply: impl FnOnce(&mut Index) -> Result<Vec<Change>, CoreError>) -> Result<(), CoreError> {
        #[cfg(test)]
        {
            // Clone out and release the hook mutex before calling, so the hook never serializes scans.
            let hook = BEFORE_APPLY_HOOK.lock().unwrap().clone();
            if let Some(h) = hook { h(room); }
        }
        let mut inner = self.inner.lock().unwrap();
        // Removed while we were reading (Finder delete) → write nothing for it. Renamed while we were
        // reading (root moved) → our entries describe the old root; the rename's follow-up rescan
        // does the work.
        if room != JOURNAL_ROOM_ID && inner.state.find(room).map(|r| r.path.as_path()) != Some(root) { return Ok(()); }
        // Root vanished mid-walk: the entries may be partial, so applying could wipe rows. Take the
        // unavailable path instead (flag + one room.updated). A stat under `Inner`, on purpose.
        if !root_available(root) {
            if inner.state.find(room).is_some() && inner.unavailable.insert(room.clone()) {
                self.emit_room_updated(&mut inner, room);
            }
            return Ok(());
        }
        let ch = apply(&mut inner.index)?;
        self.emit_changes(&mut inner, ch);
        if inner.unavailable.remove(room) { self.emit_room_updated(&mut inner, room); }
        Ok(())
    }

    /// Keeps the rows; only flags the room (spec §2: 방은 유지, status unavailable, 이벤트 발행).
    fn flag_unavailable(&self, room: &RoomId) {
        let mut inner = self.inner.lock().unwrap();
        if inner.state.find(room).is_some() && inner.unavailable.insert(room.clone()) {
            self.emit_room_updated(&mut inner, room);
        }
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

    /// Rescans only `rels` (relative to the room's root) of `room`; see `try_rescan_paths`.
    pub fn rescan_paths(&self, room: &RoomId, rels: &[PathBuf]) {
        if let Err(e) = self.try_rescan_paths(room, rels) { eprintln!("rooms-core: rescan of {} paths in room {room} failed: {e}", rels.len()); }
    }

    /// (room, path relative to its root) of every artifact whose original is one of `targets`.
    pub fn artifacts_with_targets<'a>(&self, targets: impl IntoIterator<Item = &'a Path>) -> Vec<(RoomId, PathBuf)> {
        let inner = self.inner.lock().unwrap();
        let mut out = Vec::new();
        for t in targets {
            match inner.index.rows_with_target(&t.to_string_lossy()) {
                Ok(rows) => out.extend(rows.into_iter().map(|(room, rel)| (room, PathBuf::from(rel)))),
                Err(e) => eprintln!("rooms-core: looking up artifacts of {} failed: {e}", t.display()),
            }
        }
        out
    }

    /// Paths (relative to the root) of `room`'s artifacts at or under any of `rels`.
    pub fn artifacts_under(&self, room: &RoomId, rels: &HashSet<PathBuf>) -> Vec<PathBuf> {
        let inner = self.inner.lock().unwrap();
        let mut out = Vec::new();
        for rel in rels {
            match inner.index.rel_paths_under(room, &rel.to_string_lossy()) {
                Ok(v) => out.extend(v.into_iter().map(PathBuf::from)),
                Err(e) => eprintln!("rooms-core: looking up artifacts under {} failed: {e}", rel.display()),
            }
        }
        out
    }

    /// The originals that live outside home and every linked root, so no room watch sees them.
    pub fn outside_targets(&self) -> Vec<PathBuf> {
        let (targets, linked) = {
            let inner = self.inner.lock().unwrap();
            let linked: Vec<PathBuf> = inner.state.rooms.iter().filter(|r| r.kind == RoomKind::Linked).map(|r| r.path.clone()).collect();
            (inner.index.targets().unwrap_or_default(), linked)
        };
        let watched = |p: &Path| p.starts_with(&self.home) || linked.iter().any(|root| p.starts_with(root));
        targets.into_iter().map(PathBuf::from).filter(|t| !watched(t)).collect()
    }

    /// Every room root (journal included), longest first, for mapping many paths to rooms with one
    /// lock (see `owner_of`).
    pub fn room_roots(&self) -> Vec<(RoomId, PathBuf)> {
        let mut roots: Vec<_> = Self::all_roots(&self.inner.lock().unwrap()).into_iter().map(|(id, root, _)| (id, root)).collect();
        roots.sort_by_key(|(_, root)| std::cmp::Reverse(root.as_os_str().len()));
        roots
    }

    /// Room owning `abs_path` (longest matching root wins: journal/inbox live under home).
    pub fn room_for_path(&self, abs_path: &Path) -> Option<RoomId> {
        owner_of(&self.room_roots(), abs_path).map(|(id, _)| id.clone())
    }

    /// Re-reads the direct children of home (called by the watcher when a batch touches one):
    /// emits room.added / room.updated (Finder rename, same id) / room.removed. Returns the ids
    /// of added or renamed rooms, plus "inbox" when its folder had to be recreated, so the caller
    /// can scan them.
    pub fn sync_home_dirs(&self) -> Vec<RoomId> {
        self.sync_home_dirs_with(list_home_dirs)
    }

    /// `sync_home_dirs` with the home listing injectable (tests feed a stale listing to reproduce
    /// a rename landing between listing and reconcile). `list` is called with `Inner` held.
    fn sync_home_dirs_with(&self, list: impl FnOnce(&Path) -> Option<Vec<HomeDir>>) -> Vec<RoomId> {
        let mut touched = Vec::new();
        let mut removed = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            let home = inner.home.clone();
            // Listed under `Inner` on purpose (an exception to "no IO under the lock"): it is a few
            // direntries, and a listing taken before the lock can predate a rename_room / Finder
            // rename, inode-match the room back to its old path and then drop it as gone.
            let listing = list(&home);
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

    /// Roots of the linked rooms not flagged unavailable. Unlike `list_rooms` it computes no
    /// per-room counts, so the watcher's periodic checks barely hold the lock.
    pub fn linked_roots(&self) -> Vec<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner.state.rooms.iter()
            .filter(|r| r.kind == RoomKind::Linked && !inner.unavailable.contains(&r.id))
            .map(|r| r.path.clone()).collect()
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

    // ---- plugins ----

    fn plugin_info(state: &crate::state::PluginState, folder: String, r: Result<(crate::plugins::Manifest, String), String>) -> PluginInfo {
        match r {
            Ok((m, rev)) => {
                let enabled = state.enabled.contains(&m.id);
                let granted = state.grants.get(&m.id).cloned();
                let needs_approval = granted.as_ref().is_none_or(|g| !m.permissions.iter().all(|p| g.contains(p)));
                PluginInfo {
                    id: m.id, name: m.name, version: m.version, min_app_version: m.min_app_version, description: m.description,
                    entry: m.entry, permissions: m.permissions, slots: m.slots, status: PluginStatus::Ok, reason: None,
                    enabled, granted, needs_approval, rev,
                }
            }
            Err(reason) => PluginInfo {
                id: folder.clone(), name: folder, version: String::new(), min_app_version: String::new(), description: None,
                entry: String::new(), permissions: Vec::new(), slots: PluginSlots::default(), status: PluginStatus::Invalid,
                reason: Some(reason), enabled: false, granted: None, needs_approval: false, rev: String::new(),
            },
        }
    }

    /// Every plugin folder, sorted by id, with its enable state.
    pub fn plugins(&self) -> Vec<PluginInfo> {
        let state = self.inner.lock().unwrap().state.plugins.clone();
        crate::plugins::scan(&self.home).into_iter().map(|(f, r)| Self::plugin_info(&state, f, r)).collect()
    }

    fn plugin(&self, id: &str) -> Option<PluginInfo> {
        self.plugins().into_iter().find(|p| p.id == id)
    }

    /// Turns a valid plugin on or off. Turning on grants `shown` (the permissions the user saw)
    /// limited to what the manifest declares now; `None` grants what it declares now. Turning off
    /// keeps the approval.
    pub fn set_plugin_enabled(&self, id: &str, enabled: bool, shown: Option<Vec<String>>) -> Result<PluginInfo, CoreError> {
        let p = self.plugin(id).ok_or(CoreError::NotFound)?;
        if p.status != PluginStatus::Ok { return Err(CoreError::InvalidInput(p.reason.unwrap_or_else(|| "invalid plugin".into()))); }
        {
            let mut inner = self.inner.lock().unwrap();
            let st = &mut inner.state.plugins;
            st.enabled.retain(|x| x != id);
            if enabled {
                st.enabled.push(id.to_string());
                st.enabled.sort();
                let granted: Vec<String> = match shown {
                    Some(seen) => p.permissions.iter().filter(|x| seen.contains(x)).cloned().collect(),
                    None => p.permissions.clone(),
                };
                st.grants.insert(id.to_string(), granted);
            }
            inner.state.save()?;
            self.emit(&mut inner, EventKind::PluginsChanged {});
        }
        self.plugin(id).ok_or(CoreError::NotFound)
    }

    /// The folder of a valid plugin the user turned on; else `NotFound`. Storage comes with turning
    /// it on, so a plugin waiting to approve *new* permissions can still save (e.g. while closing).
    fn usable_plugin_dir(&self, id: &str) -> Result<std::path::PathBuf, CoreError> {
        match self.plugin(id) {
            Some(p) if p.status == PluginStatus::Ok && p.enabled => Ok(crate::plugins::plugins_dir(&self.home).join(id)),
            _ => Err(CoreError::NotFound),
        }
    }

    /// The tools of valid, enabled plugins, in plugin-id then tool-name (alphabetical) order; the
    /// manifest's `tools` is a map, so its own order is not kept.
    ///
    /// Plugins should treat `appendTo` files as append-only: the bridge may rewrite them, which
    /// races with tool appends.
    pub fn list_tools(&self) -> Vec<ToolInfo> {
        let enabled = self.inner.lock().unwrap().state.plugins.enabled.clone();
        let mut out = Vec::new();
        for (_, r) in crate::plugins::scan(&self.home) {
            let Ok((m, _)) = r else { continue };
            if !enabled.contains(&m.id) { continue; }
            for t in &m.tools {
                out.push(ToolInfo { plugin_id: m.id.clone(), name: t.name.clone(), description: t.description.clone(), input: t.input.clone() });
            }
        }
        out
    }

    /// Appends the call's input, as one envelope line, to the plugin's data file the tool declares
    /// for the resolved document, then emits `plugin.data.changed`. See `crate::tools`.
    pub fn call_tool(&self, call: &ToolCall) -> Result<ToolResult, CoreError> {
        let dir = self.usable_plugin_dir(&call.plugin_id)?;
        let tool = crate::plugins::scan(&self.home).into_iter()
            .filter_map(|(_, r)| r.ok()).map(|(m, _)| m)
            .find(|m| m.id == call.plugin_id)
            .and_then(|m| m.tools.into_iter().find(|t| t.name == call.name))
            .ok_or(CoreError::NotFound)?;
        let doc = crate::tools::doc_of(&call.input)?;
        let file_key = crate::tools::resolve_doc(self, doc)?;
        let path = tool.append_to.replace("{doc}", &file_key);
        let line = crate::tools::envelope_line(&chrono::Local::now().to_rfc3339(), &call.name, &call.input);
        crate::plugins::append_data(&dir, &path, &line)?;
        let mut inner = self.inner.lock().unwrap();
        self.emit(&mut inner, EventKind::PluginDataChanged { plugin_id: call.plugin_id.clone(), path: path.clone() });
        Ok(ToolResult { path })
    }

    pub fn read_plugin_data(&self, id: &str, rel: &str) -> Result<Option<String>, CoreError> {
        crate::plugins::read_data(&self.usable_plugin_dir(id)?, rel)
    }

    pub fn write_plugin_data(&self, id: &str, rel: &str, text: &str) -> Result<(), CoreError> {
        crate::plugins::write_data(&self.usable_plugin_dir(id)?, rel, text)
    }

    pub fn list_plugin_data(&self, id: &str, prefix: &str) -> Result<Vec<String>, CoreError> {
        crate::plugins::list_data(&self.usable_plugin_dir(id)?, prefix)
    }

    pub fn delete_plugin_data(&self, id: &str, rel: &str) -> Result<(), CoreError> {
        crate::plugins::delete_data(&self.usable_plugin_dir(id)?, rel)
    }

    /// A file of a valid plugin to serve (never under data/). Enabled or not: the app only opens
    /// frames for enabled plugins, and serving lets the enable card show nothing but the manifest.
    pub fn resolve_plugin_file(&self, id: &str, rel: &str) -> Result<std::path::PathBuf, CoreError> {
        match self.plugin(id) {
            Some(p) if p.status == PluginStatus::Ok => crate::plugins::resolve_asset(&crate::plugins::plugins_dir(&self.home).join(id), rel),
            _ => Err(CoreError::NotFound),
        }
    }

    /// Installs the plugins the app ships (`src/<id>/`). A plugin seen for the first time is turned
    /// on; every bundled version gets its declared permissions, since it comes with the app. A user's
    /// "off" stays off. Returns the ids it copied.
    pub fn install_bundled_plugins(&self, src: &std::path::Path) -> Result<Vec<String>, CoreError> {
        let Ok(rd) = std::fs::read_dir(src) else { return Ok(Vec::new()) };
        let mut dirs: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        let mut copied = Vec::new();
        for dir in dirs {
            let Some(m) = crate::plugins::install_bundled(&self.home, &dir)? else { continue };
            let mut inner = self.inner.lock().unwrap();
            let st = &mut inner.state.plugins;
            if !st.bundled.contains(&m.id) {
                st.bundled.push(m.id.clone());
                st.bundled.sort();
                if !st.enabled.contains(&m.id) {
                    st.enabled.push(m.id.clone());
                    st.enabled.sort();
                }
            }
            st.grants.insert(m.id.clone(), m.permissions.clone());
            inner.state.save()?;
            copied.push(m.id);
        }
        if !copied.is_empty() {
            self.plugins_changed();
        }
        Ok(copied)
    }

    /// Tells clients the plugin list may have changed (the watcher calls this).
    pub fn plugins_changed(&self) {
        let mut inner = self.inner.lock().unwrap();
        self.emit(&mut inner, EventKind::PluginsChanged {});
    }

    /// The artifact holding the original with `file_key`: when several rooms link it, the first in
    /// sidebar order, then the journal. `None` if no artifact has that key.
    pub fn artifact_by_file_key(&self, file_key: &str) -> Option<Artifact> {
        let inner = self.inner.lock().unwrap();
        let mut hits = inner.index.by_file_key(file_key).ok()?;
        let rank = |room: &str| inner.state.rooms.iter().position(|r| r.id == room).unwrap_or(usize::MAX);
        hits.sort_by_key(|a| rank(&a.room_id));
        hits.into_iter().next()
    }

    /// Moves `room` to position `to` among the rooms other than the inbox, which keeps its place
    /// (`to` past the end = last). Saves state.json and emits `rooms.reordered` with the full order.
    pub fn move_room(&self, room: &RoomId, to: usize) -> Result<Vec<RoomId>, CoreError> {
        if room == "inbox" { return Err(CoreError::InvalidInput("the inbox can't be moved".into())); }
        let mut inner = self.inner.lock().unwrap();
        let from = inner.state.rooms.iter().position(|r| &r.id == room).ok_or(CoreError::RoomNotFound)?;
        let rec = inner.state.rooms.remove(from);
        let rooms = &inner.state.rooms;
        let at = rooms.iter().enumerate().filter(|(_, r)| r.id != "inbox").nth(to).map(|(i, _)| i).unwrap_or(rooms.len());
        inner.state.rooms.insert(at, rec);
        inner.state.save()?;
        let room_ids: Vec<RoomId> = inner.state.rooms.iter().map(|r| r.id.clone()).collect();
        self.emit(&mut inner, EventKind::RoomsReordered { room_ids: room_ids.clone() });
        Ok(room_ids)
    }

    pub fn save_note(&self, date: &IsoDate, name: &str, body: &str) -> Result<Note, CoreError> {
        validate_iso_date(date)?;
        let name = validate_note_name(name)?;
        if body.len() > MAX_NOTE_BYTES { return Err(CoreError::InvalidInput("note too large".into())); }
        // File IO without `Inner`; it is taken only to emit. `notes_lock` is held across the write,
        // the rename and the emit so NoteSaved order equals file order (lock order: notes_lock → Inner).
        let _notes = self.notes_lock.lock().unwrap();
        let dir = self.home.join("journal").join(date);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(&name);
        let tmp = dir.join(format!(".{name}.{}.tmp", nanoid::nanoid!(8)));
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &path)?;
        let (_, updated) = crate::meta::file_times(&path);
        let note = Note { date: date.clone(), name: name.clone(), rel_path: format!("{date}/{name}"), updated_at: updated, author: Author::Me };
        let mut inner = self.inner.lock().unwrap();
        self.emit(&mut inner, EventKind::NoteSaved { note: note.clone() });
        Ok(note)
    }

    /// Renames `journal/<date>/<from>` to `<to>` (both validated like `save_note`). Never
    /// overwrites: a target that exists — compared case-insensitively, since the default macOS
    /// volume is — is `NoteExists`, except the source itself (a case-only rename `a.md` → `A.md`).
    /// Same locking as `save_note`: `notes_lock` across the checks, the rename and the emits;
    /// `Inner` only to emit (lock order: notes_lock → Inner).
    pub fn rename_note(&self, date: &IsoDate, from: &str, to: &str) -> Result<Note, CoreError> {
        validate_iso_date(date)?;
        let from = validate_note_name(from)?;
        let to = validate_note_name(to)?;
        let _notes = self.notes_lock.lock().unwrap();
        let dir = self.home.join("journal").join(date);
        let src = dir.join(&from);
        if !std::fs::symlink_metadata(&src).map(|m| m.is_file()).unwrap_or(false) { return Err(CoreError::NotFound); }
        let dst = dir.join(&to);
        if from != to {
            let fold = |s: &str| slug_key(s);
            let to_key = fold(&to);
            // Another entry folding to the target name (case-sensitive volumes), or the target
            // path itself resolving to something other than the source (case-insensitive ones).
            let clash = std::fs::read_dir(&dir)?.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n != from && fold(&n) == to_key
            });
            if clash || (fold(&from) != to_key && std::fs::symlink_metadata(&dst).is_ok()) { return Err(CoreError::NoteExists); }
            std::fs::rename(&src, &dst)?;
        }
        let (_, updated) = crate::meta::file_times(&dst);
        let note = Note { date: date.clone(), name: to.clone(), rel_path: format!("{date}/{to}"), updated_at: updated, author: Author::Me };
        if from != to {
            let mut inner = self.inner.lock().unwrap();
            self.emit(&mut inner, EventKind::NoteRemoved { date: date.clone(), name: from });
            self.emit(&mut inner, EventKind::NoteSaved { note: note.clone() });
        }
        Ok(note)
    }

    /// Reads `journal/<date>/<name>.md`. Holds only `notes_lock` (never `Inner`) so it cannot see a
    /// half-written file; saves are tmp + rename, so this is consistency rather than necessity.
    pub fn read_note(&self, date: &IsoDate, name: &str) -> Result<String, CoreError> {
        validate_iso_date(date)?;
        let name = validate_note_name(name)?;
        let _notes = self.notes_lock.lock().unwrap();
        let path = self.home.join("journal").join(date).join(&name);
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(CoreError::NotFound),
            Err(e) => Err(CoreError::Internal(e.to_string())),
        }
    }

    /// Owned, existing room → its root. Journal and linked rooms are `InvalidInput` (never written
    /// to by a move); an unknown id is `RoomNotFound`. Checked before any filesystem op.
    fn owned_root(inner: &Inner, room: &RoomId) -> Result<PathBuf, CoreError> {
        if room == JOURNAL_ROOM_ID { return Err(CoreError::InvalidInput("journal is not a move room".into())); }
        let rec = inner.state.find(room).ok_or(CoreError::RoomNotFound)?;
        if rec.kind != RoomKind::Owned { return Err(CoreError::InvalidInput("linked rooms are read only".into())); }
        Ok(rec.path.clone())
    }

    /// Moves an artifact (a symlink to an original, or a plain html file) out of owned room `from`
    /// (inbox allowed) to the top level of owned room `to` (not inbox), keeping its first-seen
    /// `createdAt` and Journal day. Only the entry inside the room moves; a symlink's original is
    /// never touched. A taken name gets ` (2)`, ` (3)`, … before the extension.
    ///
    /// Locking: both rooms' scan locks (taken in room-id order, so two opposite moves cannot
    /// deadlock) are held across the rename and the index reassign, so a watcher rescan of either
    /// room runs entirely before or entirely after and then finds matching fingerprints (no-op).
    /// `Inner` is taken only for the short lookups and the reassign + emit; the rename runs without it.
    pub fn move_artifact(&self, from_room: &RoomId, artifact_id: &str, to_room: &RoomId) -> Result<Artifact, CoreError> {
        let check = |inner: &Inner| -> Result<(PathBuf, PathBuf), CoreError> {
            let from_root = Self::owned_root(inner, from_room)?;
            let to_root = Self::owned_root(inner, to_room)?;
            if to_room == "inbox" { return Err(CoreError::InvalidInput("cannot move into inbox".into())); }
            if from_room == to_room { return Err(CoreError::InvalidInput("source and target room are the same".into())); }
            Ok((from_root, to_root))
        };
        check(&self.inner.lock().unwrap())?; // fail fast before waiting on scan locks
        let (first, second) = if from_room < to_room { (from_room, to_room) } else { (to_room, from_room) };
        let (l1, l2) = (self.scan_lock(first), self.scan_lock(second));
        let _g1 = l1.lock().unwrap(); // lock order: room scan locks (by id) → Inner
        let _g2 = l2.lock().unwrap();
        // Re-read under the scan locks: the rooms may have been renamed or removed meanwhile.
        let (from_root, to_root, art) = {
            let inner = self.inner.lock().unwrap();
            let (f, t) = check(&inner)?;
            let art = inner.index.get(from_room, artifact_id)?.ok_or(CoreError::NotFound)?;
            (f, t, art)
        };
        let src = from_root.join(&art.rel_path);
        let meta = std::fs::symlink_metadata(&src).map_err(|_| CoreError::NotFound)?;
        let is_html = |p: &Path| p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
        // How the entry moves: a plain file or an absolute symlink is renamed. A relative symlink
        // would resolve differently from its new folder (broken, or silently a same-named
        // sibling there), so it is recreated at the destination pointing at its absolute canonical
        // target, and the old link is removed only once the index step succeeded.
        enum How { PlainFile, AbsLink, RelLink(PathBuf) }
        let how = if meta.file_type().is_symlink() {
            let ok = std::fs::metadata(&src).is_ok_and(|m| m.is_file()) && std::fs::canonicalize(&src).is_ok_and(|t| is_html(&t));
            if !ok { return Err(CoreError::InvalidInput("symlink does not point to an html file".into())); }
            if std::fs::read_link(&src)?.is_relative() { How::RelLink(std::fs::canonicalize(&src)?) } else { How::AbsLink }
        } else if meta.is_file() {
            How::PlainFile
        } else {
            return Err(CoreError::InvalidInput("not a file".into()));
        };
        let base = Path::new(&art.rel_path).file_name().map(|n| n.to_string_lossy().to_string()).ok_or(CoreError::NotFound)?;
        let to_rel = free_name(&to_root, &base);
        let dst = to_root.join(&to_rel);
        match &how {
            How::RelLink(target) => std::os::unix::fs::symlink(target, &dst)?,
            How::PlainFile | How::AbsLink => std::fs::rename(&src, &dst)?,
        }
        // The stored target is the canonical path the entry resolves to: a plain file's own path
        // changed; a relative link's target is restated (same path); an absolute link's is kept.
        let new_target = match &how {
            How::PlainFile => std::fs::canonicalize(&dst).ok(),
            How::RelLink(target) => Some(target.clone()),
            How::AbsLink => None,
        }.map(|p| p.to_string_lossy().to_string());
        let mut inner = self.inner.lock().unwrap();
        #[cfg(test)]
        let fail = FAIL_REASSIGN.with(|c| c.get());
        #[cfg(not(test))]
        let fail = false;
        let res = if fail { Err(CoreError::WriteFailed("injected".into())) }
            else { inner.index.reassign(from_room, &art.rel_path, to_room, &to_rel, new_target.as_deref()) };
        match res {
            Ok((removed, added)) => {
                let Change::Added(moved) = &added else { unreachable!("reassign returns Added second") };
                let moved = moved.clone();
                self.emit_changes(&mut inner, vec![removed, added]);
                drop(inner);
                if matches!(how, How::RelLink(_)) {
                    if let Err(e) = std::fs::remove_file(&src) {
                        eprintln!("rooms-core: removing moved link {} failed: {e}", src.display());
                    }
                }
                Ok(moved)
            }
            Err(e) => {
                drop(inner);
                let undo = match how {
                    How::RelLink(_) => std::fs::remove_file(&dst),
                    How::PlainFile | How::AbsLink => std::fs::rename(&dst, &src),
                };
                if let Err(back) = undo {
                    eprintln!("rooms-core: undoing the move of {} to {} failed: {back}", src.display(), dst.display());
                }
                Err(e)
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Serializes the tests that install the global hook.
    static HOOK_TESTS: Mutex<()> = Mutex::new(());

    /// Installs a hook that blocks the FIRST scan of `room` before its apply phase: it signals
    /// `entered` and waits for `release`. Later scans pass through.
    fn block_first_scan(room: &str) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let room = room.to_string();
        let state = Mutex::new(Some((entered_tx, release_rx)));
        *BEFORE_APPLY_HOOK.lock().unwrap() = Some(Arc::new(move |r: &str| {
            if r != room { return; }
            let Some((entered, release)) = state.lock().unwrap().take() else { return };
            entered.send(()).unwrap();
            release.recv().unwrap();
        }));
        (entered_rx, release_tx)
    }

    fn clear_hook() { *BEFORE_APPLY_HOOK.lock().unwrap() = None; }

    fn rels(core: &RoomsCore, room: &RoomId) -> Vec<String> {
        core.list_artifacts(room).unwrap().into_iter().map(|a| a.rel_path).collect()
    }

    #[test]
    fn root_vanishing_before_apply_flags_unavailable_and_keeps_rows() {
        let _g = HOOK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let team = tempfile::tempdir().unwrap();
        let root = team.path().join("research");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.html"), "<title>a</title>").unwrap();
        let r = core.link_folder(&root, None).unwrap(); // scans: one row
        assert_eq!(rels(&core, &r.id), vec!["a.html".to_string()]);
        let (id, from, to) = (r.id.clone(), root.clone(), team.path().join("moved"));
        let once = Mutex::new(true);
        *BEFORE_APPLY_HOOK.lock().unwrap() = Some(Arc::new(move |room: &str| {
            if room == id && std::mem::take(&mut *once.lock().unwrap()) { std::fs::rename(&from, &to).unwrap(); }
        }));
        let mut rx = core.subscribe();
        core.rescan_room(&r.id);
        clear_hook();
        assert_eq!(rels(&core, &r.id), vec!["a.html".to_string()], "rows must be kept");
        let st = core.list_rooms().into_iter().find(|x| x.id == r.id).unwrap().status;
        assert_eq!(st, RoomStatus::Unavailable);
        let updates = std::iter::from_fn(|| rx.try_recv().ok())
            .filter(|e| matches!(&e.kind, EventKind::RoomUpdated { room } if room.id == r.id)).count();
        assert_eq!(updates, 1, "exactly one room.updated");
    }

    fn room_ids(core: &RoomsCore) -> Vec<RoomId> { core.list_rooms().into_iter().map(|r| r.id).collect() }

    #[test]
    fn api_rename_between_listing_and_reconcile_keeps_room_and_rows() {
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("a").unwrap();
        std::fs::write(d.path().join("a/x.html"), "<title>x</title>").unwrap();
        core.rescan_room(&r.id);
        let created = core.list_artifacts(&r.id).unwrap()[0].created_at.clone();
        let stale = list_home_dirs(core.home()); // listing taken…
        core.rename_room(&r.id, "b").unwrap(); // …then the API rename lands…
        core.sync_home_dirs_with(|_| stale); // …then reconcile runs on the stale listing
        core.sync_home_dirs();
        assert!(room_ids(&core).contains(&r.id), "room removed");
        assert_eq!(room_ids(&core).len(), 2, "b adopted as a new room: {:?}", core.list_rooms());
        let arts = core.list_artifacts(&r.id).unwrap();
        assert_eq!((arts.len(), arts[0].created_at.clone()), (1, created));
    }

    #[test]
    fn finder_rename_between_listing_and_reconcile_keeps_room_and_rows() {
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("a").unwrap();
        std::fs::write(d.path().join("a/x.html"), "<title>x</title>").unwrap();
        core.rescan_room(&r.id);
        let created = core.list_artifacts(&r.id).unwrap()[0].created_at.clone();
        let stale = list_home_dirs(core.home());
        std::fs::rename(d.path().join("a"), d.path().join("b")).unwrap();
        core.sync_home_dirs_with(|_| stale);
        core.sync_home_dirs();
        assert!(room_ids(&core).contains(&r.id), "room removed");
        assert_eq!(room_ids(&core).len(), 2, "b adopted as a new room: {:?}", core.list_rooms());
        let arts = core.list_artifacts(&r.id).unwrap();
        assert_eq!((arts.len(), arts[0].created_at.clone()), (1, created));
    }

    #[test]
    fn later_scan_waits_for_earlier_scan_so_deleted_file_is_not_resurrected() {
        let _g = HOOK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("r").unwrap();
        // Not indexed yet: scan A reads a.html as new and will upsert it at apply time.
        std::fs::write(d.path().join("r/a.html"), "<title>a</title>").unwrap();
        let (entered, release) = block_first_scan(&r.id);
        let (ca, ida) = (core.clone(), r.id.clone());
        let a = std::thread::spawn(move || ca.rescan_room(&ida));
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        std::fs::remove_file(d.path().join("r/a.html")).unwrap();
        let (cb, idb) = (core.clone(), r.id.clone());
        let b = std::thread::spawn(move || cb.rescan_room(&idb));
        std::thread::sleep(Duration::from_millis(200));
        release.send(()).unwrap();
        a.join().unwrap();
        b.join().unwrap();
        clear_hook();
        assert!(!rels(&core, &r.id).contains(&"a.html".to_string()), "deleted a.html resurrected");
    }

    #[test]
    fn move_waits_for_an_in_flight_rescan_and_later_rescans_are_no_ops() {
        let _g = HOOK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("r").unwrap();
        let inbox: RoomId = "inbox".into();
        std::fs::write(core.home().join("inbox/a.html"), "<title>a</title>").unwrap();
        core.rescan_room(&inbox);
        let a = core.list_artifacts(&inbox).unwrap().remove(0);
        let mut rx = core.subscribe();
        let (entered, release) = block_first_scan(&inbox);
        let (cs, ids) = (core.clone(), inbox.clone());
        let scan = std::thread::spawn(move || cs.rescan_room(&ids));
        entered.recv_timeout(Duration::from_secs(5)).unwrap(); // rescan holds inbox's scan lock
        let (cm, from, to, id) = (core.clone(), inbox.clone(), r.id.clone(), a.id.clone());
        let mv = std::thread::spawn(move || cm.move_artifact(&from, &id, &to));
        std::thread::sleep(Duration::from_millis(200));
        assert!(core.home().join("inbox/a.html").exists(), "move ran while a rescan of its room was in flight");
        release.send(()).unwrap();
        scan.join().unwrap();
        let moved = mv.join().unwrap().unwrap();
        clear_hook();
        core.rescan_room(&inbox);
        core.rescan_room(&r.id);
        let evs: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).map(|e| e.kind).collect();
        assert!(matches!(&evs[..], [
            EventKind::ArtifactRemoved { artifact_id, .. }, EventKind::ArtifactAdded { artifact }, EventKind::JournalChanged { .. },
        ] if artifact_id == &a.id && artifact == &moved), "{evs:?}");
        assert_eq!(rels(&core, &r.id), vec!["a.html".to_string()]);
    }

    /// Makes the index step of `move_artifact` fail on this thread (after the filesystem move).
    fn with_failing_reassign<T>(f: impl FnOnce() -> T) -> T {
        FAIL_REASSIGN.with(|c| c.set(true));
        let out = f();
        FAIL_REASSIGN.with(|c| c.set(false));
        out
    }

    #[test]
    fn failed_index_step_puts_the_entry_back_and_changes_nothing() {
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("r").unwrap();
        let o = tempfile::tempdir().unwrap();
        let orig = std::fs::canonicalize(o.path()).unwrap().join("x.html");
        std::fs::write(&orig, "<title>x</title>").unwrap();
        let inbox: RoomId = "inbox".into();
        std::os::unix::fs::symlink(&orig, core.home().join("inbox/abs.html")).unwrap();
        std::fs::create_dir_all(core.home().join("inbox/sub")).unwrap();
        std::os::unix::fs::symlink("../abs.html", core.home().join("inbox/sub/rel.html")).unwrap();
        std::fs::write(core.home().join("inbox/plain.html"), "<title>p</title>").unwrap();
        core.rescan_room(&inbox);
        let before = core.list_artifacts(&inbox).unwrap();
        assert_eq!(before.len(), 3);
        let mut rx = core.subscribe();
        for a in &before {
            let e = with_failing_reassign(|| core.move_artifact(&inbox, &a.id, &r.id)).unwrap_err();
            assert!(matches!(e, CoreError::WriteFailed(_)), "{e:?}");
        }
        assert_eq!(std::fs::read_link(core.home().join("inbox/abs.html")).unwrap(), orig);
        assert_eq!(std::fs::read_link(core.home().join("inbox/sub/rel.html")).unwrap(), Path::new("../abs.html"));
        assert_eq!(std::fs::read_to_string(core.home().join("inbox/plain.html")).unwrap(), "<title>p</title>");
        assert!(std::fs::read_dir(core.home().join("r")).unwrap().next().is_none());
        assert_eq!(core.list_artifacts(&inbox).unwrap(), before);
        assert!(core.list_artifacts(&r.id).unwrap().is_empty());
        assert!(rx.try_recv().is_err(), "no events");
        core.rescan_room(&inbox);
        core.rescan_room(&r.id);
        assert!(rx.try_recv().is_err(), "rescans find nothing to change");
    }

    #[test]
    fn scan_whose_room_was_renamed_mid_scan_applies_nothing() {
        let _g = HOOK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("r").unwrap();
        std::fs::write(d.path().join("r/a.html"), "<title>a</title>").unwrap();
        let (entered, release) = block_first_scan(&r.id);
        let (ca, ida) = (core.clone(), r.id.clone());
        let a = std::thread::spawn(move || ca.rescan_room(&ida));
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        core.rename_room(&r.id, "s").unwrap();
        std::fs::remove_file(d.path().join("s/a.html")).unwrap();
        release.send(()).unwrap();
        a.join().unwrap();
        clear_hook();
        // The stale scan (old root) must not write; no follow-up rescan runs here.
        assert!(rels(&core, &r.id).is_empty(), "{:?}", rels(&core, &r.id));
    }
}
