//! Owned rooms follow their folders directly under home: a folder made in Finder becomes a room,
//! a renamed one keeps its room (matched by inode), a deleted one takes its room with it.

use crate::core::RoomsCore;
use crate::lock::lock;
use crate::state::{inode_of, RoomRecord, StateStore};
use rooms_protocol::{EventKind, RoomId, RoomKind, INBOX_ROOM_ID};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(crate) enum HomeChange { Added(RoomId), Renamed(RoomId), Removed(RoomId) }

/// One real (non-symlink) directory directly under home.
pub(crate) struct HomeDir { path: PathBuf, name: String, dev: Option<u64>, ino: Option<u64> }

/// Lists the candidate room folders directly under home (`read_dir` + `inode_of`). Called with
/// `Inner` held (see `sync_home_dirs_with`).
/// `.`-folders, `journal` and `inbox` are fixed roots and never listed. `None` = home unlistable.
pub(crate) fn list_home_dirs(home: &Path) -> Option<Vec<HomeDir>> {
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
pub(crate) fn reconcile_home_dirs(home: &Path, listing: Option<Vec<HomeDir>>, state: &mut StateStore) -> Vec<HomeChange> {
    let mut out = Vec::new();
    let Some(listing) = listing else { return out };
    let listed_inodes: HashMap<(u64, u64), PathBuf> = listing.iter().filter_map(|h| Some(((h.dev?, h.ino?), h.path.clone()))).collect();
    for HomeDir { path: p, name, dev, ino } in listing {
        if state.rooms.iter().any(|r| r.path == p) { continue; }
        if let (Some(dv), Some(io)) = (dev, ino) {
            if let Some(rec) = state.find_by_inode_mut(dv, io) {
                rec.path = p;
                rec.name = name;
                out.push(HomeChange::Renamed(rec.id.clone()));
                continue;
            }
        }
        let id: RoomId = nanoid::nanoid!(12);
        state.rooms.push(RoomRecord { id: id.clone(), name, kind: RoomKind::Owned, path: p, dev, ino, color: None });
        out.push(HomeChange::Added(id));
    }
    // Per-room `symlink_metadata` under the lock is intentional: a cheap stat over the handful of
    // owned rooms, and it must see the same state the listing above was reconciled against.
    let gone: Vec<RoomId> = state.rooms.iter()
        .filter(|r| r.kind == RoomKind::Owned && r.id != INBOX_ROOM_ID && r.path.starts_with(home) && std::fs::symlink_metadata(&r.path).is_err())
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
    /// Re-reads the direct children of home (called by the watcher when a batch touches one):
    /// emits room.added / room.updated (Finder rename, same id) / room.removed. Returns the ids
    /// of added or renamed rooms, plus the inbox when its folder had to be recreated, so the caller
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
            let mut inner = lock(&self.inner);
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
            let mut locks = lock(&self.scan_locks);
            for id in &removed { locks.remove(id); }
        }
        // The inbox record never follows its folder: if `inbox` was renamed away (adopted above as a
        // normal room), recreate an empty one and let the caller rescan it to drop the moved rows.
        let inbox = self.home.join("inbox");
        if !inbox.is_dir() {
            match std::fs::create_dir_all(&inbox) {
                Ok(()) => touched.push(INBOX_ROOM_ID.into()),
                Err(e) => eprintln!("rooms-core: recreating inbox failed: {e}"),
            }
        }
        touched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
