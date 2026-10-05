use crate::error::CoreError;
use crate::meta::{file_mtime, file_times, read_meta, title_or_filename};
use crate::rules::{artifact_id, local_day, PathClass};
use crate::walk::ScanEntry;
use rooms_protocol::{Artifact, Author, Source};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeSet, HashSet};
use std::path::Path;

pub struct Index {
    conn: Connection,
    /// Journal days whose contents changed since the last `take_touched_days` (old and new day on a move).
    touched_days: BTreeSet<String>,
}

/// Journal day of an artifact. Files under `journal/YYYY-MM-DD/` belong to that folder's day
/// (spec §2: journal/YYYY-MM-DD/*.html → that Journal day); everything else uses createdAt's local day.
pub fn journal_folder_day(room_id: &str, rel_path: &str) -> Option<String> {
    if room_id != rooms_protocol::JOURNAL_ROOM_ID { return None; }
    let (first, _) = rel_path.split_once('/')?;
    crate::rules::validate_iso_date(first).ok().map(|_| first.to_string())
}

#[derive(Debug, Clone)]
pub enum Change {
    Added(Artifact),
    Updated(Artifact),
    Removed { room_id: String, artifact_id: String },
}

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_day TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_room ON artifacts(room_id, created_ts);
CREATE INDEX IF NOT EXISTS idx_artifacts_day ON artifacts(created_day, created_ts);
";

fn err(e: rusqlite::Error) -> CoreError { CoreError::WriteFailed(e.to_string()) }

impl Index {
    pub fn open(path: &Path) -> Result<Index, CoreError> {
        let try_open = || -> rusqlite::Result<Connection> {
            let c = Connection::open(path)?;
            c.pragma_update(None, "journal_mode", "WAL")?;
            let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            if v != SCHEMA_VERSION {
                c.execute_batch("DROP TABLE IF EXISTS artifacts;")?;
            }
            c.execute_batch(SCHEMA)?;
            c.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            Ok(c)
        };
        match try_open() {
            Ok(conn) => Ok(Index { conn, touched_days: BTreeSet::new() }),
            Err(_) => {
                let _ = std::fs::remove_file(path);
                for suffix in ["-wal", "-shm"] {
                    let mut p = path.as_os_str().to_owned();
                    p.push(suffix);
                    let _ = std::fs::remove_file(p);
                }
                Ok(Index { conn: try_open().map_err(err)?, touched_days: BTreeSet::new() })
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
        let existing: Option<(String, String, String, String, String)> = self.conn.query_row(
            "SELECT created_at, title, updated_at, created_day, target FROM artifacts WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).optional().map_err(err)?;
        // Cheap path: same target and same mtime → nothing to re-read (unless a journal row's day is stale).
        if let Some((_, _, old_updated, old_day, old_target)) = &existing {
            let day_ok = journal_folder_day(room_id, &e.rel_path).map(|d| &d == old_day).unwrap_or(true);
            if day_ok && *old_target == e.target.to_string_lossy() && file_mtime(&e.target).as_ref() == Some(old_updated) {
                return Ok(None);
            }
        }
        let existing = existing.map(|(c, t, u, d, _)| (c, t, u, d));
        let meta = read_meta(&e.target);
        let (file_created, updated) = file_times(&e.target);
        let created = meta.created.clone()
            .or_else(|| existing.as_ref().map(|x| x.0.clone()))
            .unwrap_or(file_created);
        let title = title_or_filename(&meta, &e.rel_path);
        let day = match (journal_folder_day(room_id, &e.rel_path), &existing) {
            (Some(d), _) => d,
            (None, Some(x)) if x.0 == created => x.3.clone(),
            _ => local_day(&created).unwrap_or_default(),
        };
        let ts = chrono::DateTime::parse_from_rfc3339(&created).map(|d| d.timestamp_millis()).unwrap_or(0);
        let source = serde_json::to_string(&meta.source).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            "INSERT INTO artifacts (id, room_id, rel_path, target, title, created_at, created_day, created_ts, updated_at, source)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET target=excluded.target, title=excluded.title, created_at=excluded.created_at,
               created_day=excluded.created_day, created_ts=excluded.created_ts, updated_at=excluded.updated_at, source=excluded.source",
            params![id, room_id, e.rel_path, e.target.to_string_lossy(), title, created, day, ts, updated, source],
        ).map_err(err)?;
        let a = Artifact { id, room_id: room_id.into(), rel_path: e.rel_path.clone(), title: title.clone(),
            created_at: created, updated_at: updated.clone(), author: Author::Agent, source: meta.source };
        let change = match existing {
            None => Change::Added(a),
            Some((_, old_title, old_updated, old_day)) if old_title == title && old_updated == updated && old_day == day => return Ok(None),
            Some((_, _, _, old_day)) => { self.touch(&old_day); Change::Updated(a) }
        };
        self.touch(&day);
        Ok(Some(change))
    }

    pub fn remove_one(&mut self, room_id: &str, rel_path: &str) -> Result<Option<Change>, CoreError> {
        let id = artifact_id(room_id, rel_path);
        let day: Option<String> = self.conn.query_row("SELECT created_day FROM artifacts WHERE id = ?1", params![id], |r| r.get(0))
            .optional().map_err(err)?;
        if let Some(d) = &day { self.touch(d); }
        let n = self.conn.execute("DELETE FROM artifacts WHERE id = ?1", params![id]).map_err(err)?;
        Ok((n > 0).then(|| Change::Removed { room_id: room_id.into(), artifact_id: id }))
    }

    pub fn backfill(&mut self, room_id: &str, entries: &[ScanEntry]) -> Result<Vec<Change>, CoreError> {
        let mut changes = Vec::new();
        self.conn.execute_batch("BEGIN").map_err(err)?;
        let r = self.backfill_inner(room_id, entries, &mut changes);
        match r {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(err)?; Ok(changes) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    fn backfill_inner(&mut self, room_id: &str, entries: &[ScanEntry], changes: &mut Vec<Change>) -> Result<(), CoreError> {
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
        Ok(())
    }

    pub fn list(&self, room_id: &str) -> Result<Vec<Artifact>, CoreError> {
        let mut st = self.conn.prepare("SELECT * FROM artifacts WHERE room_id = ?1 ORDER BY created_ts ASC, id ASC").map_err(err)?;
        let rows = st.query_map(params![room_id], Self::row_to_artifact).map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn by_day(&self, day: &str) -> Result<Vec<(Artifact, String)>, CoreError> {
        let mut st = self.conn.prepare("SELECT * FROM artifacts WHERE created_day = ?1 ORDER BY created_ts ASC, id ASC").map_err(err)?;
        let rows = st.query_map(params![day], |r| Ok((Self::row_to_artifact(r)?, r.get::<_, String>("target")?))).map_err(err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn touch(&mut self, day: &str) {
        if !day.is_empty() { self.touched_days.insert(day.to_string()); }
    }

    /// Drains the journal days touched by upserts/removals since the last call (sorted).
    pub fn take_touched_days(&mut self) -> Vec<String> {
        std::mem::take(&mut self.touched_days).into_iter().collect()
    }

    pub fn drop_room(&mut self, room_id: &str) -> Result<Vec<Change>, CoreError> {
        let rows: Vec<(String, String)> = {
            let mut st = self.conn.prepare("SELECT id, created_day FROM artifacts WHERE room_id = ?1").map_err(err)?;
            let rows = st.query_map(params![room_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
            rows.filter_map(Result::ok).collect()
        };
        let ids: Vec<String> = rows.iter().map(|(id, _)| id.clone()).collect();
        for (_, d) in &rows { self.touch(d); }
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
    fn list_orders_by_instant_not_string() {
        let (d, room) = setup();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        fs::write(room.join("a.html"), r#"<meta name="rooms:created" content="2026-10-05T01:00:00Z">"#).unwrap();
        fs::write(room.join("b.html"), r#"<meta name="rooms:created" content="2026-10-05T09:30:00+09:00">"#).unwrap();
        ix.backfill("r1", &scan_room(&room, false, false)).unwrap();
        let l = ix.list("r1").unwrap();
        assert_eq!(l[0].rel_path, "b.html");
        assert_eq!(l[1].rel_path, "a.html");
    }

    #[test]
    fn created_day_is_kept_on_reupsert() {
        let (d, room) = setup();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        fs::write(room.join("a.html"), r#"<meta name="rooms:created" content="2026-10-05T01:00:00Z">"#).unwrap();
        let entries = scan_room(&room, false, false);
        ix.backfill("r1", &entries).unwrap();
        ix.conn.execute("UPDATE artifacts SET created_day = '1999-01-01'", []).unwrap();
        ix.backfill("r1", &entries).unwrap();
        assert_eq!(ix.by_day("1999-01-01").unwrap().len(), 1);
    }

    #[test]
    fn unchanged_file_skips_meta_read() {
        use std::os::unix::fs::PermissionsExt;
        let (d, room) = setup();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        fs::write(room.join("a.html"), "<title>Kept</title>").unwrap();
        let entries = scan_room(&room, false, false);
        ix.backfill("r1", &entries).unwrap();
        // chmod does not change mtime; if meta were re-read the title would fall back to "a".
        fs::set_permissions(room.join("a.html"), fs::Permissions::from_mode(0o000)).unwrap();
        let ch = ix.backfill("r1", &entries).unwrap();
        fs::set_permissions(room.join("a.html"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(ch.is_empty(), "{ch:?}");
        assert_eq!(ix.list("r1").unwrap()[0].title, "Kept");
    }

    #[test]
    fn unchanged_journal_file_still_gets_folder_day() {
        let (d, _room) = setup();
        let j = d.path().join("journal");
        fs::create_dir_all(j.join("2026-10-05")).unwrap();
        fs::write(j.join("2026-10-05/a.html"), "").unwrap();
        let mut ix = Index::open(&d.path().join("index.sqlite")).unwrap();
        let entries = scan_room(&j, false, true);
        ix.backfill("journal", &entries).unwrap();
        ix.conn.execute("UPDATE artifacts SET created_day = '1999-01-01'", []).unwrap();
        ix.backfill("journal", &entries).unwrap();
        assert_eq!(ix.by_day("2026-10-05").unwrap().len(), 1);
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
