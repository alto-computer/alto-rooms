//! `<data>/sort.db` (spec §6): every decision with its rule and reason, R2's repo→room memory,
//! R4's votes, and each run's moves for undo.
use crate::rules::{Decision, Memory};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Store {
    pub c: Connection,
}

/// A recorded decision, as `log` and T2 read it.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub file_key: String,
    pub title: String,
    pub at: String,
    pub rule: String,
    pub action: String,
    pub why: String,
    pub to_room: Option<String>,
    pub rooms_hash: String,
}

/// What goes into `decisions` besides the decision itself.
pub struct Record<'a> {
    pub file_key: &'a str,
    pub title: &'a str,
    pub repo: Option<&'a str>,
    pub run_id: &'a str,
    pub at: &'a str,
    pub decision: &'a Decision,
    /// moved | kept | undone
    pub action: &'a str,
    pub to_room: Option<&'a str>,
    pub jev: Option<&'a crate::jev::Reply>,
    pub model: Option<&'a str>,
    pub rooms_hash: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Move {
    pub file_key: String,
    pub to_room: String,
    pub created_room: bool,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        if let Some(d) = path.parent() { let _ = std::fs::create_dir_all(d); }
        let c = Connection::open(path)?;
        Self::init(c)
    }

    pub fn memory() -> rusqlite::Result<Store> { Self::init(Connection::open_in_memory()?) }

    fn init(c: Connection) -> rusqlite::Result<Store> {
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS decisions(file_key TEXT PRIMARY KEY, title TEXT NOT NULL, repo TEXT, run_id TEXT NOT NULL,
               at TEXT NOT NULL, rule TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('moved','kept','undone')), why TEXT NOT NULL,
               to_room_id TEXT, choice TEXT, confidence REAL, top_probs_json TEXT, model TEXT, rooms_hash TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS repo_rooms(repo_key TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_at TEXT NOT NULL,
               forgotten INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS votes(repo_key TEXT NOT NULL, file_key TEXT NOT NULL, PRIMARY KEY(repo_key, file_key));
             CREATE TABLE IF NOT EXISTS moves(run_id TEXT NOT NULL, file_key TEXT NOT NULL, to_room TEXT NOT NULL, created_room INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, considered INTEGER NOT NULL DEFAULT 0,
               moved INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0, rooms_created INTEGER NOT NULL DEFAULT 0,
               input_tokens INTEGER NOT NULL DEFAULT 0, error TEXT);",
        )?;
        Ok(Store { c })
    }

    pub fn decision(&self, file_key: &str) -> rusqlite::Result<Option<Row>> {
        self.c.query_row("SELECT file_key, title, at, rule, action, why, to_room_id, rooms_hash FROM decisions WHERE file_key = ?1", [file_key], row).optional()
    }

    pub fn record(&self, r: &Record) -> rusqlite::Result<()> {
        let top = r.jev.map(|j| serde_json::to_string(&j.top.iter().map(|(k, p)| (k.clone(), *p)).collect::<Vec<_>>()).unwrap_or_default());
        self.c.execute(
            "INSERT OR REPLACE INTO decisions(file_key, title, repo, run_id, at, rule, action, why, to_room_id, choice, confidence, top_probs_json, model, rooms_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![r.file_key, r.title, r.repo, r.run_id, r.at, r.decision.rule.id(), r.action, r.decision.why, r.to_room,
                r.jev.and_then(|j| j.answer.choice.clone()), r.jev.map(|j| j.answer.confidence), top, r.model, r.rooms_hash],
        )?;
        Ok(())
    }

    pub fn set_action(&self, file_key: &str, action: &str) -> rusqlite::Result<()> {
        self.c.execute("UPDATE decisions SET action = ?2 WHERE file_key = ?1", params![file_key, action]).map(|_| ())
    }

    pub fn load_memory(&self) -> rusqlite::Result<Memory> {
        let mut m = Memory::default();
        let mut q = self.c.prepare("SELECT repo_key, room_id, forgotten FROM repo_rooms")?;
        for r in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?)))? {
            let (repo, room, forgotten) = r?;
            if forgotten { m.forgotten.insert(repo); } else { m.repo_rooms.insert(repo, room); }
        }
        let mut q = self.c.prepare("SELECT repo_key, file_key FROM votes")?;
        for r in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (repo, key) = r?;
            m.votes.entry(repo).or_default().insert(key);
        }
        Ok(m)
    }

    pub fn remember_room(&self, repo: &str, room_id: &str, at: &str) -> rusqlite::Result<()> {
        self.c.execute("INSERT OR REPLACE INTO repo_rooms(repo_key, room_id, created_at, forgotten) VALUES (?1, ?2, ?3, 0)", params![repo, room_id, at]).map(|_| ())
    }

    /// N4: the room is gone (or its creation was undone); never create one for this repo again.
    pub fn forget_repo(&self, repo: &str) -> rusqlite::Result<()> {
        self.c.execute("UPDATE repo_rooms SET forgotten = 1 WHERE repo_key = ?1", [repo]).map(|_| ())
    }

    pub fn vote(&self, repo: &str, file_key: &str) -> rusqlite::Result<()> {
        self.c.execute("INSERT OR IGNORE INTO votes(repo_key, file_key) VALUES (?1, ?2)", params![repo, file_key]).map(|_| ())
    }

    /// N3: votes from documents that left the inbox no longer count.
    pub fn drop_votes(&self, file_key: &str) -> rusqlite::Result<()> {
        self.c.execute("DELETE FROM votes WHERE file_key = ?1", [file_key]).map(|_| ())
    }

    pub fn clear_votes(&self, repo: &str) -> rusqlite::Result<()> {
        self.c.execute("DELETE FROM votes WHERE repo_key = ?1", [repo]).map(|_| ())
    }

    pub fn add_move(&self, run_id: &str, m: &Move) -> rusqlite::Result<()> {
        self.c.execute("INSERT INTO moves(run_id, file_key, to_room, created_room) VALUES (?1, ?2, ?3, ?4)", params![run_id, m.file_key, m.to_room, m.created_room]).map(|_| ())
    }

    pub fn moves(&self, run_id: &str) -> rusqlite::Result<Vec<Move>> {
        let mut q = self.c.prepare("SELECT file_key, to_room, created_room FROM moves WHERE run_id = ?1")?;
        let v = q.query_map([run_id], |r| Ok(Move { file_key: r.get(0)?, to_room: r.get(1)?, created_room: r.get(2)? }))?.collect();
        v
    }

    /// The latest run that moved something.
    pub fn last_moving_run(&self) -> rusqlite::Result<Option<String>> {
        self.c.query_row("SELECT run_id FROM moves ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0)).optional()
    }

    pub fn repo_for_room(&self, room_id: &str) -> rusqlite::Result<Option<String>> {
        self.c.query_row("SELECT repo_key FROM repo_rooms WHERE room_id = ?1", [room_id], |r| r.get(0)).optional()
    }

    pub fn run_count(&self) -> rusqlite::Result<i64> { self.c.query_row("SELECT COUNT(*) FROM runs", [], |r| r.get(0)) }

    pub fn start_run(&self, run_id: &str, at: &str) -> rusqlite::Result<()> {
        self.c.execute("INSERT INTO runs(run_id, started_at) VALUES (?1, ?2)", params![run_id, at]).map(|_| ())
    }

    pub fn end_run(&self, run_id: &str, at: &str, s: &crate::run::Summary) -> rusqlite::Result<()> {
        self.c.execute(
            "UPDATE runs SET ended_at = ?2, considered = ?3, moved = ?4, kept = ?5, rooms_created = ?6, input_tokens = ?7, error = ?8 WHERE run_id = ?1",
            params![run_id, at, s.considered, s.moved, s.kept, s.rooms_created, s.input_tokens, s.error],
        ).map(|_| ())
    }

    /// Moved and kept decisions made since `since` (an RFC 3339 prefix such as a local day start).
    pub fn counts_since(&self, since: &str) -> rusqlite::Result<(u32, u32)> {
        self.c.query_row(
            "SELECT COALESCE(SUM(action = 'moved'), 0), COALESCE(SUM(action = 'kept'), 0) FROM decisions WHERE at >= ?1",
            [since], |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    pub fn recent(&self, n: u32) -> rusqlite::Result<Vec<Row>> {
        let mut q = self.c.prepare("SELECT file_key, title, at, rule, action, why, to_room_id, rooms_hash FROM decisions ORDER BY at DESC, rowid DESC LIMIT ?1")?;
        let v = q.query_map([n], row)?.collect();
        v
    }
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row { file_key: r.get(0)?, title: r.get(1)?, at: r.get(2)?, rule: r.get(3)?, action: r.get(4)?, why: r.get(5)?, to_room: r.get(6)?, rooms_hash: r.get(7)? })
}
