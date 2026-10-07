//! Html links whose original is missing, remembered so they are added when it returns.

use rooms_protocol::RoomId;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Html links whose original is missing: (room, rel path) → the original's path. Both links
/// whose original vanished after they were indexed and links a full scan finds already broken
/// (at startup, say) are here, so when the original comes back (the file recreated, its folder
/// restored) the watcher finds the link by that path and adds it.
#[derive(Default)]
pub(crate) struct DanglingLinks {
    links: HashMap<(RoomId, String), PathBuf>,
    /// Bumped on every change, so the watcher can tell when the originals to follow changed.
    generation: u64,
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

impl DanglingLinks {
    /// After a scan of `rels` in `room` at `root`: a link that lost its row (`lost`: rel → its
    /// original) is remembered; a remembered rel that is an artifact again, or no longer a link,
    /// is forgotten.
    pub(crate) fn update(&mut self, room: &RoomId, root: &Path, rels: impl IntoIterator<Item = String>, lost: HashMap<String, PathBuf>, present: impl Fn(&str) -> bool) {
        for rel in rels {
            let key = (room.clone(), rel);
            let changed = if present(&key.1) || !is_symlink(&root.join(&key.1)) {
                self.links.remove(&key).is_some()
            } else if let Some(target) = lost.get(&key.1) {
                self.links.insert(key, target.clone()).as_ref() != Some(target)
            } else {
                false
            };
            if changed { self.generation += 1; }
        }
    }

    pub(crate) fn rels_of(&self, room: &RoomId) -> Vec<String> {
        self.links.keys().filter(|(r, _)| r == room).map(|(_, rel)| rel.clone()).collect()
    }

    /// Remembered links whose original is `target` or lies under the folder `target`.
    pub(crate) fn at_or_under(&self, target: &Path) -> impl Iterator<Item = (RoomId, PathBuf)> + '_ {
        let target = target.to_path_buf();
        self.links.iter().filter(move |(_, t)| t.starts_with(&target)).map(|((room, rel), _)| (room.clone(), PathBuf::from(rel)))
    }

    /// Every remembered original.
    pub(crate) fn targets(&self) -> impl Iterator<Item = &PathBuf> + '_ {
        self.links.values()
    }

    pub(crate) fn generation(&self) -> u64 { self.generation }
}
