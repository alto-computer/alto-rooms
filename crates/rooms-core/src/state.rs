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

/// Which plugins the user turned on, and the permissions they saw when they did.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginState {
    #[serde(default)]
    pub enabled: Vec<String>,
    #[serde(default)]
    pub grants: std::collections::BTreeMap<String, Vec<String>>,
    /// Plugins that came with the app and were turned on once; a later "off" is the user's to keep.
    #[serde(default)]
    pub bundled: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Disk {
    rooms: Vec<RoomRecord>,
    #[serde(default)]
    plugins: PluginState,
}

pub struct StateStore {
    pub path: PathBuf,
    pub rooms: Vec<RoomRecord>,
    pub plugins: PluginState,
}

impl StateStore {
    pub fn load(rooms_dir: &Path) -> Result<StateStore, CoreError> {
        std::fs::create_dir_all(rooms_dir)?;
        let path = rooms_dir.join("state.json");
        let disk: Disk = match std::fs::read(&path) {
            Ok(b) => match serde_json::from_slice(&b) {
                Ok(d) => d,
                Err(_e) => {
                    // JSON parsing failed: atomically rename the corrupted file with timestamp
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let corrupt_path = rooms_dir.join(format!("state.json.corrupt-{}", now));
                    std::fs::rename(&path, &corrupt_path).map_err(|e| {
                        CoreError::WriteFailed(format!("failed to preserve corrupted state.json: {}", e))
                    })?;
                    return Ok(StateStore {
                        path,
                        rooms: Vec::new(),
                        plugins: PluginState::default(),
                    });
                }
            },
            Err(e) => {
                // File read error: check if it's NotFound (file doesn't exist yet)
                if e.kind() == std::io::ErrorKind::NotFound {
                    Disk::default()
                } else {
                    // Other errors (permission denied, etc.) should be reported
                    return Err(CoreError::WriteFailed(format!(
                        "failed to read state.json: {}",
                        e
                    )));
                }
            }
        };
        Ok(StateStore {
            path,
            rooms: disk.rooms,
            plugins: disk.plugins,
        })
    }

    pub fn save(&self) -> Result<(), CoreError> {
        let tmp = self.path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(&Disk {
            rooms: self.rooms.clone(),
            plugins: self.plugins.clone(),
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

    #[test]
    fn corrupted_json_preserved_and_store_empty() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(".rooms");
        std::fs::create_dir_all(&dir).unwrap();
        let state_json = dir.join("state.json");

        // Write garbage JSON
        let garbage = b"{ invalid json }]";
        std::fs::write(&state_json, garbage).unwrap();

        // Load should succeed but with empty rooms
        let s = StateStore::load(&dir).unwrap();
        assert!(s.rooms.is_empty());

        // Original state.json should be moved, not copied
        assert!(!state_json.exists());

        // Corrupted file should be preserved with timestamp
        let corrupt_files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| {
                let entry = e.ok()?;
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("state.json.corrupt-") {
                    Some(name_str.into_owned())
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(corrupt_files.len(), 1);
        let corrupt_content = std::fs::read(&dir.join(&corrupt_files[0])).unwrap();
        assert_eq!(corrupt_content, garbage);
    }

}
