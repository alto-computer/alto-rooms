//! Keeping the index in step with disk: rescans of whole rooms or some of their paths, the
//! unavailable flag of a room whose root is gone, and the lookups the watcher uses to decide what
//! to rescan.
//!
//! A scan runs in three phases: list the room (no lock), read the files that changed (no lock,
//! against fingerprints taken under `Inner`), then apply under `Inner`. Scans of one room are
//! serialized by its scan lock, so the last scan to apply is the latest.

use crate::core::{Inner, RoomsCore};
use crate::dangling::DanglingLinks;
use crate::error::CoreError;
use crate::index::{read_entry, Change, Index};
use crate::lock::lock;
use crate::rules::PathClass;
use crate::walk::scan_room_and_dangling;
use rooms_protocol::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A room root is usable only if it is a directory we can list. Scanning anything else would
/// look empty and wipe the room's index rows (losing first-seen createdAt).
fn root_available(root: &Path) -> bool {
    root.is_dir() && std::fs::read_dir(root).is_ok()
}

/// The room in `roots` (as `room_roots` returns them, longest first) owning `abs_path`, and its root.
pub(crate) fn owner_of<'a>(roots: &'a [(RoomId, PathBuf)], abs_path: &Path) -> Option<&'a (RoomId, PathBuf)> {
    roots.iter().find(|(_, root)| abs_path.starts_with(root))
}

/// Test-only seam: called in `apply_scan` between the read phase and the apply phase, with the
/// room id. Compiles to nothing outside `cfg(test)`.
#[cfg(test)]
type ScanHook = Arc<dyn Fn(&str) + Send + Sync>;
#[cfg(test)]
static BEFORE_APPLY_HOOK: Mutex<Option<ScanHook>> = Mutex::new(None);

impl RoomsCore {
    /// Full reconcile after the watcher lost events (overflow / error): rescan everything, then
    /// tell clients to refetch.
    pub fn resync_all(&self) {
        self.rescan_all();
        // Resync is emitted even if the rescan failed, on purpose, so clients refetch.
        let mut inner = lock(&self.inner);
        self.emit(&mut inner, EventKind::Resync { room_id: None });
    }

    /// Reconciles home folders and rescans every room, emitting what changed (no resync): for when
    /// events may have been missed but clients' snapshots plus the change events stay valid.
    pub fn rescan_all(&self) {
        self.sync_home_dirs(); // pick up folders created/renamed/deleted in Finder (takes Inner itself)
        if let Err(e) = self.backfill_all() { eprintln!("rooms-core: rescan of all rooms failed: {e}"); }
    }

    pub fn backfill_all(&self) -> Result<(), CoreError> {
        let roots = { Self::all_roots(&lock(&self.inner)) };
        let mut first_err = None;
        for (id, _, _) in roots {
            if let Err(e) = self.try_rescan_room(&id) { first_err.get_or_insert(e); }
        }
        match first_err { Some(e) => Err(e), None => Ok(()) }
    }

    pub(crate) fn scan_lock(&self, room: &RoomId) -> Arc<Mutex<()>> {
        lock(&self.scan_locks).entry(room.clone()).or_default().clone()
    }

    /// Rescan pipeline. Only the short index steps hold `Inner`; listing and reading files do not.
    fn try_rescan_room(&self, room: &RoomId) -> Result<(), CoreError> {
        let serial = self.scan_lock(room);
        let _serial = lock(&serial); // lock order: room scan lock → Inner
        let Some((root, kind)) = self.room_root(room) else { return Ok(()) };
        if !root_available(&root) { self.mark_unavailable(&mut lock(&self.inner), room); return Ok(()); }
        let (entries, broken) = scan_room_and_dangling(&root, kind == RoomKind::Linked, kind == RoomKind::Journal); // no lock
        let fps = { lock(&self.inner).index.fingerprints(room)? };
        let facts: Vec<_> = entries.iter().filter_map(|e| read_entry(room, e, fps.get(&e.rel_path))).collect(); // no lock
        let present: HashSet<String> = entries.iter().filter(|e| e.class == PathClass::Artifact).map(|e| e.rel_path.clone()).collect();
        // Links without their original: rows that lost it, and links found already broken.
        let lost: HashMap<String, PathBuf> = fps.into_iter().filter(|(rel, _)| !present.contains(rel))
            .map(|(rel, fp)| (rel, PathBuf::from(fp.target))).chain(broken).collect();
        self.apply_scan(room, &root, |index| index.apply(room, &facts, &present), |dangling| {
            let rels: Vec<String> = dangling.rels_of(room).into_iter().chain(lost.keys().cloned()).collect();
            dangling.update(room, &root, rels, lost, |rel| present.contains(rel));
        })
    }

    /// The rescan pipeline for some paths of a room only (each relative to its root): a path that
    /// is an artifact now is upserted, any other path's row is removed. Same locking as
    /// `try_rescan_room`; an unavailable root takes the full rescan, which flags it.
    fn try_rescan_paths(&self, room: &RoomId, rels: &[PathBuf]) -> Result<(), CoreError> {
        let serial = self.scan_lock(room);
        let _serial = lock(&serial); // lock order: room scan lock → Inner
        let Some((root, kind)) = self.room_root(room) else { return Ok(()) };
        if !root_available(&root) { self.mark_unavailable(&mut lock(&self.inner), room); return Ok(()); }
        let (honor_gitignore, in_journal) = (kind == RoomKind::Linked, kind == RoomKind::Journal);
        let mut facts = Vec::new();
        let mut gone = Vec::new();
        let mut present = HashSet::new();
        let mut lost = HashMap::new();
        for rel in rels {
            let rel_path = rel.to_string_lossy().replace('\\', "/");
            let fp = { lock(&self.inner).index.fingerprint(room, &rel_path)? };
            match crate::walk::entry_at(&root, rel, honor_gitignore, in_journal) {
                Some(e) if e.class == PathClass::Artifact => {
                    facts.extend(read_entry(room, &e, fp.as_ref())); // no lock
                    present.insert(rel_path);
                }
                _ => {
                    if let Some(fp) = fp { lost.insert(rel_path.clone(), PathBuf::from(fp.target)); }
                    gone.push(rel_path);
                }
            }
        }
        self.apply_scan(room, &root, |index| index.apply_paths(room, &facts, &gone), |dangling| {
            let rels = present.iter().chain(&gone).cloned().collect::<Vec<_>>();
            dangling.update(room, &root, rels, lost, |rel| present.contains(rel));
        })
    }

    /// Phase 3 of a scan of `room` at `root`, under `Inner`: runs `apply` and emits its changes,
    /// unless the room was removed or moved, or its root vanished, while the scan was reading.
    /// `remember` then updates the dangling links (see `DanglingLinks`) in the same critical section.
    fn apply_scan(&self, room: &RoomId, root: &Path, apply: impl FnOnce(&mut Index) -> Result<Vec<Change>, CoreError>,
                  remember: impl FnOnce(&mut DanglingLinks)) -> Result<(), CoreError> {
        #[cfg(test)]
        {
            // Clone out and release the hook mutex before calling, so the hook never serializes scans.
            let hook = lock(&BEFORE_APPLY_HOOK).clone();
            if let Some(h) = hook { h(room); }
        }
        let mut inner = lock(&self.inner);
        // Removed while we were reading (Finder delete) → write nothing for it. Renamed while we were
        // reading (root moved) → our entries describe the old root; the rename's follow-up rescan
        // does the work.
        if room != JOURNAL_ROOM_ID && inner.state.find(room).map(|r| r.path.as_path()) != Some(root) { return Ok(()); }
        // Root vanished mid-walk: the entries may be partial, so applying could wipe rows. Take the
        // unavailable path instead. A stat under `Inner`, on purpose.
        if !root_available(root) { self.mark_unavailable(&mut inner, room); return Ok(()); }
        let ch = apply(&mut inner.index)?;
        remember(&mut inner.dangling);
        self.emit_changes(&mut inner, ch);
        if inner.unavailable.remove(room) { self.emit_room_updated(&mut inner, room); }
        Ok(())
    }

    /// Keeps the rows; only flags the room, with one room.updated when the flag is new (spec §2:
    /// 방은 유지, status unavailable, 이벤트 발행).
    fn mark_unavailable(&self, inner: &mut Inner, room: &RoomId) {
        if inner.state.find(room).is_some() && inner.unavailable.insert(room.clone()) {
            self.emit_room_updated(inner, room);
        }
    }

    /// Rescans every room currently flagged unavailable (the watcher calls this periodically so a
    /// returning folder is picked up even though nothing watches its path while it is gone).
    pub fn rescan_unavailable(&self) {
        let ids: Vec<RoomId> = { lock(&self.inner).unavailable.iter().cloned().collect() };
        for id in ids { self.rescan_room(&id); }
    }

    pub fn rescan_room(&self, room: &RoomId) {
        if let Err(e) = self.try_rescan_room(room) { eprintln!("rooms-core: rescan of room {room} failed: {e}"); }
    }

    /// Rescans only `rels` (relative to the room's root) of `room`; see `try_rescan_paths`.
    pub fn rescan_paths(&self, room: &RoomId, rels: &[PathBuf]) {
        if let Err(e) = self.try_rescan_paths(room, rels) { eprintln!("rooms-core: rescan of {} paths in room {room} failed: {e}", rels.len()); }
    }

    pub fn apply_fs_change(&self, abs_path: &Path) {
        if let Some(id) = self.room_for_path(abs_path) { self.rescan_room(&id); }
    }

    /// Room owning `abs_path` (longest matching root wins: journal/inbox live under home).
    pub fn room_for_path(&self, abs_path: &Path) -> Option<RoomId> {
        owner_of(&self.room_roots(), abs_path).map(|(id, _)| id.clone())
    }

    /// (room, path relative to its root) of every artifact, or dangling link, whose original is
    /// one of `targets`.
    pub fn artifacts_with_targets<'a>(&self, targets: impl IntoIterator<Item = &'a Path>) -> Vec<(RoomId, PathBuf)> {
        self.links_to(targets, false)
    }

    /// `artifacts_with_targets` for originals anywhere under the folders `dirs` (a folder event
    /// in the original-file watch: created, removed or renamed).
    pub fn artifacts_with_targets_under<'a>(&self, dirs: impl IntoIterator<Item = &'a Path>) -> Vec<(RoomId, PathBuf)> {
        self.links_to(dirs, true)
    }

    fn links_to<'a>(&self, paths: impl IntoIterator<Item = &'a Path>, under: bool) -> Vec<(RoomId, PathBuf)> {
        let inner = lock(&self.inner);
        let mut out = Vec::new();
        for p in paths {
            let key = p.to_string_lossy();
            let rows = if under { inner.index.rows_with_target_under(&key) } else { inner.index.rows_with_target(&key) };
            match rows {
                Ok(rows) => out.extend(rows.into_iter().map(|(room, rel)| (room, PathBuf::from(rel)))),
                Err(e) => eprintln!("rooms-core: looking up artifacts of {} failed: {e}", p.display()),
            }
            out.extend(inner.dangling.at_or_under(p)); // a file path is "under" only itself
        }
        out
    }

    /// Paths (relative to the root) of `room`'s artifacts at or under any of `rels`.
    pub fn artifacts_under(&self, room: &RoomId, rels: &HashSet<PathBuf>) -> Vec<PathBuf> {
        let inner = lock(&self.inner);
        let mut out = Vec::new();
        for rel in rels {
            match inner.index.rel_paths_under(room, &rel.to_string_lossy()) {
                Ok(v) => out.extend(v.into_iter().map(PathBuf::from)),
                Err(e) => eprintln!("rooms-core: looking up artifacts under {} failed: {e}", rel.display()),
            }
        }
        out
    }

    /// Changes whenever the set of dangling links changes (see `DanglingLinks`).
    pub fn dangling_generation(&self) -> u64 { lock(&self.inner).dangling.generation() }

    /// The originals (of artifacts and dangling links) that live outside home and every linked
    /// root, so no room watch sees them.
    pub fn outside_targets(&self) -> Vec<PathBuf> {
        let (targets, linked) = {
            let inner = lock(&self.inner);
            let linked: Vec<PathBuf> = inner.state.rooms.iter().filter(|r| r.kind == RoomKind::Linked).map(|r| r.path.clone()).collect();
            let mut targets: Vec<PathBuf> = inner.index.targets().unwrap_or_default().into_iter().map(PathBuf::from).collect();
            targets.extend(inner.dangling.targets().cloned());
            (targets, linked)
        };
        let watched = |p: &Path| p.starts_with(&self.home) || linked.iter().any(|root| p.starts_with(root));
        targets.into_iter().filter(|t| !watched(t)).collect()
    }
}

/// Helpers for tests that pause a scan between its read and apply phases.
#[cfg(test)]
pub(crate) mod test_hooks {
    use super::*;
    use std::sync::mpsc;

    /// Serializes the tests that install the global hook.
    pub(crate) static HOOK_TESTS: Mutex<()> = Mutex::new(());

    pub(crate) fn set_hook(h: impl Fn(&str) + Send + Sync + 'static) { *lock(&BEFORE_APPLY_HOOK) = Some(Arc::new(h)); }

    pub(crate) fn clear_hook() { *lock(&BEFORE_APPLY_HOOK) = None; }

    /// Installs a hook that blocks the FIRST scan of `room` before its apply phase: it signals
    /// `entered` and waits for `release`. Later scans pass through.
    pub(crate) fn block_first_scan(room: &str) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let room = room.to_string();
        let state = Mutex::new(Some((entered_tx, release_rx)));
        set_hook(move |r: &str| {
            if r != room { return; }
            let Some((entered, release)) = lock(&state).take() else { return };
            entered.send(()).unwrap();
            release.recv().unwrap();
        });
        (entered_rx, release_tx)
    }

    pub(crate) fn rels(core: &RoomsCore, room: &RoomId) -> Vec<String> {
        core.list_artifacts(room).unwrap().into_iter().map(|a| a.rel_path).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::test_hooks::*;
    use super::*;
    use std::time::Duration;

    #[test]
    fn root_vanishing_before_apply_flags_unavailable_and_keeps_rows() {
        let _g = lock(&HOOK_TESTS);
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
        set_hook(move |room: &str| {
            if room == id && std::mem::take(&mut *lock(&once)) { std::fs::rename(&from, &to).unwrap(); }
        });
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

    #[test]
    fn later_scan_waits_for_earlier_scan_so_deleted_file_is_not_resurrected() {
        let _g = lock(&HOOK_TESTS);
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
    fn scan_whose_room_was_renamed_mid_scan_applies_nothing() {
        let _g = lock(&HOOK_TESTS);
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
