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
struct Disk {
    rooms: Vec<RoomRecord>,
}

pub struct StateStore {
    pub path: PathBuf,
    pub rooms: Vec<RoomRecord>,
}

impl StateStore {
    pub fn load(rooms_dir: &Path) -> Result<StateStore, CoreError> {
        std::fs::create_dir_all(rooms_dir)?;
        let path = rooms_dir.join("state.json");
        let disk: Disk = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => Disk::default(),
        };
        Ok(StateStore {
            path,
            rooms: disk.rooms,
        })
    }

    pub fn save(&self) -> Result<(), CoreError> {
        let tmp = self.path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(&Disk {
            rooms: self.rooms.clone(),
        })
        .map_err(|e| CoreError::WriteFailed(e.to_string()))?;
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn find(&self, id: &str) -> Option<&RoomRecord> {
        self.rooms.iter().find(|r| r.id == id)
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut RoomRecord> {
        self.rooms.iter_mut().find(|r| r.id == id)
    }

    pub fn find_by_inode(&self, dev: u64, ino: u64) -> Option<&RoomRecord> {
        self.rooms
            .iter()
            .find(|r| r.dev == Some(dev) && r.ino == Some(ino))
    }
}

pub fn inode_of(path: &Path) -> Option<(u64, u64)> {
    std::fs::metadata(path)
        .ok()
        .map(|m| (m.dev(), m.ino()))
}

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
