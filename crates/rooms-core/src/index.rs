use crate::error::CoreError;
use crate::meta::{file_times, read_meta, title_or_filename};
use crate::rules::{artifact_id, local_day, PathClass};
use crate::walk::ScanEntry;
use rooms_protocol::{Artifact, Author, Source};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;

pub struct Index { conn: Connection }

#[derive(Debug, Clone)]
pub enum Change {
    Added(Artifact),
    Updated(Artifact),
    Removed { room_id: String, artifact_id: String },
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_day TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_room ON artifacts(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_day ON artifacts(created_day, created_at);
";

fn err(e: rusqlite::Error) -> CoreError { CoreError::WriteFailed(e.to_string()) }

impl Index {
    pub fn open(path: &Path) -> Result<Index, CoreError> {
        let try_open = || -> rusqlite::Result<Connection> {
            let c = Connection::open(path)?;
            c.pragma_update(None, "journal_mode", "WAL")?;
            c.execute_batch(SCHEMA)?;
            Ok(c)
        };
        match try_open() {
            Ok(conn) => Ok(Index { conn }),
            Err(_) => {
                let _ = std::fs::remove_file(path);
                Ok(Index { conn: try_open().map_err(err)? })
            }
        }
    }

    fn row_to_artifact(r: &rusqlite::Row) -> rusqlite::Result<Artifact> {
        let source: String = r.get("source")?;
        Ok(Artifact {
            id: r.get("id")?,
            room_id: r.get("room_id")?,
            rel_path: r.get("rel_path")?,
            title: r.get("title")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
            author: Author::Agent,
            source: serde_json::from_str::<Source>(&source).unwrap_or_default(),
        })
    }

    pub fn upsert_one(&mut self, room_id: &str, e: &ScanEntry) -> Result<Option<Change>, CoreError> {
        if e.class != PathClass::Artifact { return Ok(None); }
        let id = artifact_id(room_id, &e.rel_path);
        let meta = read_meta(&e.target);
        let (file_created, updated) = file_times(&e.target);
        let existing: Option<(String, String, String)> = self.conn.query_row(
            "SELECT created_at, title, updated_at FROM artifacts WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(err)?;
        let created = meta.created.clone()
            .or_else(|| existing.as_ref().map(|x| x.0.clone()))
            .unwrap_or(file_created);
        let title = title_or_filename(&meta, &e.rel_path);
        let day = local_day(&created).unwrap_or_default();
        let source = serde_json::to_string(&meta.source).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            "INSERT INTO artifacts (id, room_id, rel_path, target, title, created_at, created_day, updated_at, source)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET target=excluded.target, title=excluded.title, created_at=excluded.created_at,
               created_day=excluded.created_day, updated_at=excluded.updated_at, source=excluded.source",
            params![id, room_id, e.rel_path, e.target.to_string_lossy(), title, created, day, updated, source],
        ).map_err(err)?;
        let a = Artifact { id, room_id: room_id.into(), rel_path: e.rel_path.clone(), title: title.clone(),
            created_at: created, updated_at: updated.clone(), author: Author::Agent, source: meta.source };
        Ok(Some(match existing {
            None => Change::Added(a),
            Some((_, old_title, old_updated)) if old_title == title && old_updated == updated => return Ok(None),
            Some(_) => Change::Updated(a),
        }))
    }

    pub fn remove_one(&mut self, room_id: &str, rel_path: &str) -> Result<Option<Change>, CoreError> {
        let id = artifact_id(room_id, rel_path);
        let n = self.conn.execute("DELETE FROM artifacts WHERE id = ?1", params![id]).map_err(err)?;
        Ok((n > 0).then(|| Change::Removed { room_id: room_id.into(), artifact_id: id }))
    }

    pub fn backfill(&mut self, room_id: &str, entries: &[ScanEntry]) -> Result<Vec<Change>, CoreError> {
        let mut changes = Vec::new();
        let mut seen = HashSet::new();
        for e in entries.iter().filter(|e| e.class == PathClass::Artifact) {
            seen.insert(e.rel_path.clone());
            if let Some(c) = self.upsert_one(room_id, e)? { changes.push(c); }
        }
        let existing: Vec<String> = {
            let mut st = self.conn.prepare("SELECT rel_path FROM artifacts WHERE room_id = ?1").map_err(err)?;
            let rows = st.query_map(params![room_id], |r| r.get(0)).map_err(err)?;
            rows.filter_map(Result::ok).collect()
        };
        for rel in existing.into_iter().filter(|r| !seen.contains(r)) {
            if let Some(c) = self.remove_one(room_id, &rel)? { changes.push(c); }
        }
        Ok(changes)
    }

    pub fn list(&self, room_id: &str) -> Result<Vec<Artifact>, CoreError> {
        let mut st = self.conn.prepare("SELECT * FROM artifacts WHERE room_id = ?1 ORDER BY created_at ASC, id ASC").map_err(err)?;
        let rows = st.query_map(params![room_id], Self::row_to_artifact).map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn by_day(&self, day: &str) -> Result<Vec<(Artifact, String)>, CoreError> {
        let mut st = self.conn.prepare("SELECT * FROM artifacts WHERE created_day = ?1 ORDER BY created_at ASC, id ASC").map_err(err)?;
        let rows = st.query_map(params![day], |r| Ok((Self::row_to_artifact(r)?, r.get::<_, String>("target")?))).map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn drop_room(&mut self, room_id: &str) -> Result<Vec<Change>, CoreError> {
        let ids: Vec<String> = {
            let mut st = self.conn.prepare("SELECT id FROM artifacts WHERE room_id = ?1").map_err(err)?;
            let rows = st.query_map(params![room_id], |r| r.get(0)).map_err(err)?;
            rows.filter_map(Result::ok).collect()
        };
        self.conn.execute("DELETE FROM artifacts WHERE room_id = ?1", params![room_id]).map_err(err)?;
        Ok(ids.into_iter().map(|id| Change::Removed { room_id: room_id.into(), artifact_id: id }).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walk::scan_room;
    use std::fs;

    fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        (d, room)
    }

    #[test]
    fn backfill_adds_then_removes() {
        let (d, room) = setup();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        fs::write(room.join("a.html"), "<title>A</title>").unwrap();
        let ch = ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert!(matches!(&ch[0], Change::Added(a) if a.title == "A"));
        fs::remove_file(room.join("a.html")).unwrap();
        let ch = ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert!(matches!(&ch[0], Change::Removed { .. }));
        assert!(ix.list("r1").unwrap().is_empty());
    }

    #[test]
    fn first_seen_is_kept_across_reopen_and_rewrite() {
        let (d, room) = setup();
        let db = d.path().join("index.sqlite");
        fs::write(room.join("a.html"), "").unwrap();
        let created = {
            let mut ix = Index::open(&db).unwrap();
            ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
            ix.list("r1").unwrap()[0].created_at.clone()
        };
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // temp-file + rename rewrite changes birthtime
        fs::write(room.join("a.html.tmp"), "<title>new</title>").unwrap();
        fs::rename(room.join("a.html.tmp"), room.join("a.html")).unwrap();
        let mut ix = Index::open(&db).unwrap();
        let ch = ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert!(matches!(&ch[0], Change::Updated(a) if a.title == "new"));
        assert_eq!(ix.list("r1").unwrap()[0].created_at, created);
    }

    #[test]
    fn rooms_created_meta_wins() {
        let (d, room) = setup();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        fs::write(room.join("a.html"), r#"<meta name="rooms:created" content="2026-01-02T03:04:05+09:00">"#).unwrap();
        ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert_eq!(ix.list("r1").unwrap()[0].created_at, "2026-01-02T03:04:05+09:00");
    }

    #[test]
    fn deleting_db_rebuilds() {
        let (d, room) = setup();
        let db = d.path().join("index.sqlite");
        fs::write(room.join("a.html"), "").unwrap();
        { let mut ix = Index::open(&db).unwrap(); ix.backfill("r1", &scan_room(&room, false, false)).unwrap(); }
        fs::remove_file(&db).unwrap();
        let mut ix = Index::open(&db).unwrap();
        ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        assert_eq!(ix.list("r1").unwrap().len(), 1);
    }

    #[test]
    fn corrupt_db_is_recreated() {
        let (d, _room) = setup();
        let db = d.path().join("index.sqlite");
        fs::write(&db, b"not a database").unwrap();
        assert!(Index::open(&db).is_ok());
    }
}
