//! Links whose original vanished after they were indexed.

use rooms_protocol::RoomId;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Links whose original vanished after they were indexed: (room, rel path) → the original's
/// path. Their rows are gone, so they are remembered here, and when the original comes back
/// (the file recreated, its folder restored) the watcher finds the link by that path and
/// re-adds it. In memory only: after a restart such a link waits for a rescan of its room.
#[derive(Default)]
pub(crate) struct DanglingLinks(HashMap<(RoomId, String), PathBuf>);

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
            if present(&key.1) || !is_symlink(&root.join(&key.1)) {
                self.0.remove(&key);
            } else if let Some(target) = lost.get(&key.1) {
                self.0.insert(key, target.clone());
            }
        }
    }

    pub(crate) fn rels_of(&self, room: &RoomId) -> Vec<String> {
        self.0.keys().filter(|(r, _)| r == room).map(|(_, rel)| rel.clone()).collect()
    }

    /// Remembered links whose original is `target` or lies under the folder `target`.
    pub(crate) fn at_or_under(&self, target: &Path) -> impl Iterator<Item = (RoomId, PathBuf)> + '_ {
        let target = target.to_path_buf();
        self.0.iter().filter(move |(_, t)| t.starts_with(&target)).map(|((room, rel), _)| (room.clone(), PathBuf::from(rel)))
    }

    /// Every remembered original.
    pub(crate) fn targets(&self) -> impl Iterator<Item = &PathBuf> + '_ {
        self.0.values()
    }
}
