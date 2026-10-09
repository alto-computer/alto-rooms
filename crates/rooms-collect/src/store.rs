//! `collect.db`: events, per-log cursors, sink cursors and the search index. A cache over the
//! agents' logs: a different schema version or a broken file is deleted and rebuilt.
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub const SCHEMA_VERSION: &str = "1";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY, agent TEXT NOT NULL, key TEXT NOT NULL,
  dev INTEGER, ino INTEGER, size INTEGER, mtime_ms INTEGER,
  offset INTEGER NOT NULL DEFAULT 0,
  ctx TEXT,
  archive_id INTEGER, archived_to INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'current',
  fail_count INTEGER NOT NULL DEFAULT 0, failed_mtime_ms INTEGER);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime_ms);
CREATE TABLE IF NOT EXISTS archives(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL, key TEXT NOT NULL, src_path TEXT NOT NULL,
  base INTEGER NOT NULL, len INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL, compressed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS archives_key ON archives(agent, key);
CREATE TABLE IF NOT EXISTS events(
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, agent TEXT NOT NULL, session TEXT,
  ts TEXT, cwd TEXT, path TEXT, explicit INTEGER NOT NULL DEFAULT 0, role TEXT,
  src_path TEXT NOT NULL, file_key TEXT NOT NULL, src_offset INTEGER NOT NULL, src_len INTEGER NOT NULL,
  preview TEXT);
CREATE INDEX IF NOT EXISTS events_kind_rowid ON events(kind, rowid);
CREATE INDEX IF NOT EXISTS events_session ON events(agent, session);
CREATE INDEX IF NOT EXISTS events_src ON events(src_path);
CREATE TABLE IF NOT EXISTS sink_cursors(sink TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link_retry(event_rowid INTEGER PRIMARY KEY, attempts INTEGER NOT NULL, next_at_ms INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_text, assistant_text, tool_text, identifiers,
  content='', contentless_delete=1,
  tokenize="unicode61 tokenchars '_.-/+'");
"#;

/// Opens (creating, or rebuilding when stale or broken) the store at `path`.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(d) = path.parent() { let _ = std::fs::create_dir_all(d); }
    match try_open(path) {
        Ok(c) => Ok(c),
        Err(e) => {
            eprintln!("rooms-collect: rebuilding {} ({e})", path.display());
            remove(path);
            try_open(path)
        }
    }
}

fn try_open(path: &Path) -> rusqlite::Result<Connection> {
    let mut c = Connection::open(path)?;
    let stale: Option<String> = c.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0)).optional()
        .unwrap_or(None);
    let has_meta: bool = c.query_row("SELECT count(*) FROM sqlite_master WHERE name='meta'", [], |r| r.get::<_, i64>(0))? > 0;
    if has_meta && stale.as_deref() != Some(SCHEMA_VERSION) {
        drop(c);
        remove(path);
        c = Connection::open(path)?;
    }
    c.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    c.pragma_update(None, "busy_timeout", 5000)?;
    c.pragma_update(None, "cache_size", -4000)?; // ~4 MB page cache
    c.execute_batch(SCHEMA)?;
    c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?1)", [SCHEMA_VERSION])?;
    Ok(c)
}

/// Opens an existing store read-only (search). WAL gives a consistent snapshot during writes.
pub fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
}

pub fn remove(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

/// What the store holds for one log file.
#[derive(Debug, Clone, Default)]
pub struct FileRow {
    pub dev: Option<u64>,
    pub ino: Option<u64>,
    pub size: Option<u64>,
    pub mtime_ms: Option<i64>,
    pub offset: u64,
    pub ctx: Option<String>,
    pub archive_id: Option<i64>,
    pub archived_to: u64,
    pub state: String,
    pub fail_count: u32,
    pub failed_mtime_ms: Option<i64>,
}

pub fn file_row(c: &Connection, path: &str) -> rusqlite::Result<Option<FileRow>> {
    c.query_row(
        "SELECT dev, ino, size, mtime_ms, offset, ctx, archive_id, archived_to, state, fail_count, failed_mtime_ms FROM files WHERE path=?1",
        [path],
        |r| Ok(FileRow {
            dev: r.get::<_, Option<i64>>(0)?.map(|v| v as u64),
            ino: r.get::<_, Option<i64>>(1)?.map(|v| v as u64),
            size: r.get::<_, Option<i64>>(2)?.map(|v| v as u64),
            mtime_ms: r.get(3)?,
            offset: r.get::<_, i64>(4)? as u64,
            ctx: r.get(5)?,
            archive_id: r.get(6)?,
            archived_to: r.get::<_, i64>(7)? as u64,
            state: r.get(8)?,
            fail_count: r.get::<_, i64>(9)? as u32,
            failed_mtime_ms: r.get(10)?,
        }),
    ).optional()
}

pub fn sink_cursor(c: &Connection, sink: &str) -> rusqlite::Result<i64> {
    Ok(c.query_row("SELECT last_rowid FROM sink_cursors WHERE sink=?1", [sink], |r| r.get(0)).optional()?.unwrap_or(0))
}

pub fn set_sink_cursor(c: &Connection, sink: &str, rowid: i64) -> rusqlite::Result<()> {
    c.execute("INSERT INTO sink_cursors(sink, last_rowid) VALUES(?1, ?2) ON CONFLICT(sink) DO UPDATE SET last_rowid=excluded.last_rowid", params![sink, rowid])?;
    Ok(())
}

/// A stored event, as the sinks see it.
#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub rowid: i64,
    pub kind: String,
    pub agent: String,
    pub session: Option<String>,
    pub ts: Option<String>,
    pub cwd: Option<String>,
    pub path: Option<String>,
    pub explicit: bool,
}

/// Events of `kind` after `after`, oldest first, at most `limit`.
pub fn events_after(c: &Connection, kind: &str, after: i64, limit: i64) -> rusqlite::Result<Vec<StoredEvent>> {
    let mut st = c.prepare_cached("SELECT rowid, kind, agent, session, ts, cwd, path, explicit FROM events WHERE kind=?1 AND rowid>?2 ORDER BY rowid LIMIT ?3")?;
    let rows = st.query_map(params![kind, after, limit], row_event)?;
    rows.collect()
}

pub fn event_by_rowid(c: &Connection, rowid: i64) -> rusqlite::Result<Option<StoredEvent>> {
    c.query_row("SELECT rowid, kind, agent, session, ts, cwd, path, explicit FROM events WHERE rowid=?1", [rowid], row_event).optional()
}

fn row_event(r: &rusqlite::Row) -> rusqlite::Result<StoredEvent> {
    Ok(StoredEvent {
        rowid: r.get(0)?, kind: r.get(1)?, agent: r.get(2)?, session: r.get(3)?, ts: r.get(4)?,
        cwd: r.get(5)?, path: r.get(6)?, explicit: r.get::<_, i64>(7)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_or_broken_store_is_rebuilt() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("c.db");
        {
            let c = open(&p).unwrap();
            c.execute("INSERT INTO sink_cursors VALUES('linker', 5)", []).unwrap();
            assert_eq!(sink_cursor(&c, "linker").unwrap(), 5);
        }
        assert_eq!(sink_cursor(&open(&p).unwrap(), "linker").unwrap(), 5, "same version keeps data");
        open(&p).unwrap().execute("UPDATE meta SET value='0' WHERE key='schema_version'", []).unwrap();
        assert_eq!(sink_cursor(&open(&p).unwrap(), "linker").unwrap(), 0, "old version is rebuilt");
        remove(&p);
        std::fs::write(&p, b"this is not a database at all, not even close............................................").unwrap();
        assert_eq!(sink_cursor(&open(&p).unwrap(), "linker").unwrap(), 0, "garbage is rebuilt");
    }

    #[test]
    fn fts5_contentless_delete_is_available() {
        let d = tempfile::tempdir().unwrap();
        let c = open(&d.path().join("c.db")).unwrap();
        c.execute("INSERT INTO messages_fts(rowid, user_text) VALUES(7, 'pricing plan src/app.tsx')", []).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH '\"src/app.tsx\"'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        c.execute("DELETE FROM messages_fts WHERE rowid=7", []).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'pricing'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
