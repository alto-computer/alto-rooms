//! Artifacts: lookups, moving one between owned rooms, and resolving a room file to serve.

use crate::asks::prompt::ContextEntry;
use crate::core::{Inner, RoomsCore};
use crate::error::CoreError;
use crate::index::Change;
use crate::lock::lock;
use crate::rules::{is_html, local_day};
use rooms_protocol::*;
use std::path::{Path, PathBuf};

/// `base` if nothing (not even a broken symlink) is at `dir/base`, else `stem (2).ext`, `stem (3).ext`, …
fn free_name(dir: &Path, base: &str) -> String {
    let taken = |n: &str| std::fs::symlink_metadata(dir.join(n)).is_ok();
    if !taken(base) { return base.to_string(); }
    let (stem, ext) = match base.rsplit_once('.') { Some((s, e)) if !s.is_empty() => (s, format!(".{e}")), _ => (base, String::new()) };
    (2..).map(|i| format!("{stem} ({i}){ext}")).find(|n| !taken(n)).unwrap() // unbounded range: always finds one
}

// Test-only seam: when set on the calling thread, `move_artifact`'s index step fails after the
// filesystem move, exercising the rollback. Compiles to nothing outside `cfg(test)`.
#[cfg(test)]
thread_local! { static FAIL_REASSIGN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

/// How an entry moves: a plain file or an absolute symlink is renamed. A relative symlink would
/// resolve differently from its new folder (broken, or silently a same-named sibling there), so
/// it is recreated at the destination pointing at its absolute canonical target, and the old link
/// is removed only once the index step succeeded.
enum How { PlainFile, AbsLink, RelLink(PathBuf) }

impl How {
    /// How the entry at `src` moves: a plain file, or a symlink to an html file; anything else is
    /// refused.
    fn detect(src: &Path) -> Result<How, CoreError> {
        let meta = std::fs::symlink_metadata(src).map_err(|_| CoreError::NotFound)?;
        if meta.file_type().is_symlink() {
            let ok = std::fs::metadata(src).is_ok_and(|m| m.is_file()) && std::fs::canonicalize(src).is_ok_and(|t| is_html(&t));
            if !ok { return Err(CoreError::InvalidInput("symlink does not point to an html file".into())); }
            Ok(if std::fs::read_link(src)?.is_relative() { How::RelLink(std::fs::canonicalize(src)?) } else { How::AbsLink })
        } else if meta.is_file() {
            Ok(How::PlainFile)
        } else {
            Err(CoreError::InvalidInput("not a file".into()))
        }
    }

    /// Puts the entry from `src` at `dst`.
    fn place(&self, src: &Path, dst: &Path) -> std::io::Result<()> {
        match self {
            How::RelLink(target) => std::os::unix::fs::symlink(target, dst),
            How::PlainFile | How::AbsLink => std::fs::rename(src, dst),
        }
    }

    /// The target to store once the entry is at `dst`: the canonical path it resolves to. A plain
    /// file's own path changed; a relative link's target is restated (same path); an absolute
    /// link's is kept (`None`).
    fn new_target(&self, dst: &Path) -> Option<String> {
        match self {
            How::PlainFile => std::fs::canonicalize(dst).ok(),
            How::RelLink(target) => Some(target.clone()),
            How::AbsLink => None,
        }.map(|p| p.to_string_lossy().to_string())
    }

    /// After the index step succeeded: drops the old link a relative link left behind.
    fn finish(&self, src: &Path) {
        if matches!(self, How::RelLink(_)) {
            if let Err(e) = std::fs::remove_file(src) {
                eprintln!("rooms-core: removing moved link {} failed: {e}", src.display());
            }
        }
    }

    /// After the index step failed: takes back `place`.
    fn undo(&self, src: &Path, dst: &Path) {
        let undone = match self {
            How::RelLink(_) => std::fs::remove_file(dst),
            How::PlainFile | How::AbsLink => std::fs::rename(dst, src),
        };
        if let Err(e) = undone {
            eprintln!("rooms-core: undoing the move of {} to {} failed: {e}", src.display(), dst.display());
        }
    }
}

impl RoomsCore {
    pub fn list_artifacts(&self, room: &RoomId) -> Result<Vec<Artifact>, CoreError> {
        let inner = lock(&self.inner);
        if room != JOURNAL_ROOM_ID && inner.state.find(room).is_none() { return Err(CoreError::RoomNotFound); }
        inner.index.list(room)
    }

    /// One artifact of `room` by id (an index lookup); an unknown room is `RoomNotFound`, as in
    /// `list_artifacts`.
    pub fn artifact(&self, room: &RoomId, id: &str) -> Result<Option<Artifact>, CoreError> {
        let inner = lock(&self.inner);
        if room != JOURNAL_ROOM_ID && inner.state.find(room).is_none() { return Err(CoreError::RoomNotFound); }
        inner.index.get(room, id)
    }

    /// The artifact holding the original with `file_key`: when several rooms link it, the first in
    /// sidebar order, then the journal. `None` if no artifact has that key.
    pub fn artifact_by_file_key(&self, file_key: &str) -> Option<Artifact> {
        self.artifacts_by_file_key(file_key).into_iter().next()
    }

    /// Every artifact holding the original with `file_key`, in sidebar order, then the journal.
    pub fn artifacts_by_file_key(&self, file_key: &str) -> Vec<Artifact> {
        let inner = lock(&self.inner);
        let mut hits = inner.index.by_file_key(file_key).unwrap_or_default();
        let rank = |room: &str| inner.state.rooms.iter().position(|r| r.id == room).unwrap_or(usize::MAX);
        hits.sort_by_key(|a| rank(&a.room_id));
        hits
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
            if to_room == INBOX_ROOM_ID { return Err(CoreError::InvalidInput("cannot move into inbox".into())); }
            if from_room == to_room { return Err(CoreError::InvalidInput("source and target room are the same".into())); }
            Ok((from_root, to_root))
        };
        check(&lock(&self.inner))?; // fail fast before waiting on scan locks
        let (first, second) = if from_room < to_room { (from_room, to_room) } else { (to_room, from_room) };
        let (l1, l2) = (self.scan_lock(first), self.scan_lock(second));
        let _g1 = lock(&l1); // lock order: room scan locks (by id) → Inner
        let _g2 = lock(&l2);
        // Re-read under the scan locks: the rooms may have been renamed or removed meanwhile.
        let (from_root, to_root, art) = {
            let inner = lock(&self.inner);
            let (f, t) = check(&inner)?;
            let art = inner.index.get(from_room, artifact_id)?.ok_or(CoreError::NotFound)?;
            (f, t, art)
        };
        let src = from_root.join(&art.rel_path);
        let how = How::detect(&src)?;
        let base = Path::new(&art.rel_path).file_name().map(|n| n.to_string_lossy().to_string()).ok_or(CoreError::NotFound)?;
        let to_rel = free_name(&to_root, &base);
        let dst = to_root.join(&to_rel);
        how.place(&src, &dst)?;
        let new_target = how.new_target(&dst);
        let mut inner = lock(&self.inner);
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
                how.finish(&src);
                Ok(moved)
            }
            Err(e) => {
                drop(inner);
                how.undo(&src, &dst);
                Err(e)
            }
        }
    }

    /// What a room ask lists: the room's name and its artifacts, newest first, as realpaths (`rg`
    /// skips symlinks). An artifact whose link no longer resolves is left out.
    pub(crate) fn room_context(&self, room: &RoomId) -> Result<(String, Vec<ContextEntry>), CoreError> {
        if room == JOURNAL_ROOM_ID { return Err(CoreError::InvalidInput("the Journal is asked by day".into())); }
        let name = lock(&self.inner).state.find(room).ok_or(CoreError::RoomNotFound)?.name.clone();
        let entries = self.list_artifacts(room)?.into_iter().rev().filter_map(|a| {
            let path = self.resolve_file(room, &a.rel_path).ok()?;
            Some(ContextEntry { label: name.clone(), day: local_day(&a.created_at).unwrap_or_default(), title: a.title, path })
        }).collect();
        Ok((name, entries))
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
            if !(target.is_file() && is_html(&target)) { return Err(CoreError::PathEscape); }
            return Ok(target);
        }
        if !target.starts_with(&root_real) { return Err(CoreError::PathEscape); }
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::test_hooks::*;
    use std::time::Duration;

    #[test]
    fn move_waits_for_an_in_flight_rescan_and_later_rescans_are_no_ops() {
        let _g = lock(&HOOK_TESTS);
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("r").unwrap();
        let inbox: RoomId = INBOX_ROOM_ID.into();
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
        // Scans the inbox, which a hook test may be blocking (hooks match by room id).
        let _g = lock(&HOOK_TESTS);
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let r = core.create_room("r").unwrap();
        let o = tempfile::tempdir().unwrap();
        let orig = std::fs::canonicalize(o.path()).unwrap().join("x.html");
        std::fs::write(&orig, "<title>x</title>").unwrap();
        let inbox: RoomId = INBOX_ROOM_ID.into();
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
}
