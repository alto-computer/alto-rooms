//! One pass over the agents' logs: decide what each file still owes (C2–C6), read only that,
//! copy it into the archive, turn it into events, and commit events + cursors together.
use crate::adapters::{Adapter, FileCtx, LogFile};
use crate::archive;
use crate::event::{fmt_ts, Event, Kind, Role};
use crate::reader::{lines, read_chunk};
use crate::store::{file_row, FileRow};
use regex::Regex;
use rusqlite::{params, Connection};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::OnceLock;

/// Most bytes read from one file in one go (C6).
pub const CHUNK: u64 = 8 << 20;
/// Most bytes read in one pass; the rest waits for the next pass so new logs are not starved.
pub const PASS_BUDGET: u64 = 32 << 20;
/// Failed reads at one unchanged mtime before a file is left alone (C4).
pub const MAX_FAILS: u32 = 3;
const DAY_MS: i64 = 86_400_000;

pub struct Settings<'a> {
    pub history_days: u32,
    pub archive: bool,
    pub archive_dir: &'a Path,
    pub now_ms: i64,
}

#[derive(Debug, Default)]
pub struct Stats { pub files_read: usize, pub events: usize, pub archived_bytes: u64, pub more: bool }

struct Candidate<'a> { adapter: &'a dyn Adapter, file: LogFile, dev: u64, ino: u64, size: u64, mtime_ms: i64 }

pub fn pass(c: &mut Connection, adapters: &[Box<dyn Adapter>], s: &Settings) -> rusqlite::Result<Stats> {
    let mut cands: Vec<Candidate> = Vec::new();
    for a in adapters {
        for file in a.discover() {
            let Ok(m) = std::fs::metadata(&file.path) else { continue };
            let mtime_ms = m.mtime() * 1000 + m.mtime_nsec() / 1_000_000;
            cands.push(Candidate { adapter: a.as_ref(), file, dev: m.dev(), ino: m.ino(), size: m.len(), mtime_ms });
        }
    }
    cands.sort_by_key(|c| std::cmp::Reverse(c.mtime_ms)); // newest first (C6)
    let cutoff = (s.history_days > 0).then(|| s.now_ms - s.history_days as i64 * DAY_MS);
    let mut stats = Stats::default();
    let mut budget = PASS_BUDGET;
    for cand in &cands {
        if budget == 0 { stats.more = true; break; }
        match one_file(c, cand, s, cutoff, budget, &mut stats) {
            Ok(read) => budget = budget.saturating_sub(read),
            Err(e) => {
                eprintln!("rooms-collect: {}: {e}", cand.file.path.display());
                note_failure(c, cand)?;
            }
        }
    }
    Ok(stats)
}

/// Reads what `cand` owes; returns the bytes read.
fn one_file(c: &mut Connection, cand: &Candidate, s: &Settings, cutoff: Option<i64>, budget: u64, stats: &mut Stats) -> Result<u64, Box<dyn std::error::Error>> {
    let path = cand.file.path.to_string_lossy().into_owned();
    let stored = file_row(c, &path)?;
    let mut row = stored.clone().unwrap_or_else(|| FileRow { state: "current".into(), ..Default::default() });
    if row.state == "failed" && row.failed_mtime_ms == Some(cand.mtime_ms) && row.fail_count >= MAX_FAILS { return Ok(0); }
    // C2: a different file under the same name (new inode, or shorter than what was read) starts over
    let reread = stored.is_some() && (row.ino != Some(cand.ino) || row.dev != Some(cand.dev)
        || (!cand.file.compressed && cand.size < row.offset.max(row.archived_to)) || row.state == "due");
    if reread {
        row.offset = 0;
        row.ctx = None;
        row.archive_id = None;
        row.archived_to = 0;
    }
    let in_window = cutoff.is_some_and(|cut| cand.mtime_ms >= cut);
    if !in_window && row.offset > 0 { expire(c, &path)?; row.offset = 0; row.ctx = None; }

    let unchanged = stored.is_some() && !reread && row.size == Some(cand.size) && row.mtime_ms == Some(cand.mtime_ms);
    let (need_index, need_archive) = if cand.file.compressed {
        // compressed logs are read whole; an unchanged one owes nothing it was not already given
        let fresh = !unchanged || row.state == "partial";
        (in_window && (fresh || row.offset == 0), s.archive && (fresh || (row.archived_to == 0 && row.archive_id.is_none())))
    } else {
        (in_window && row.offset < cand.size, s.archive && row.archived_to < cand.size)
    };
    if !need_index && !need_archive {
        if stored.is_none() || !unchanged { save_stat(c, &path, cand, &row)?; }
        return Ok(0);
    }
    let from = match (need_index, need_archive) {
        (true, true) => row.offset.min(row.archived_to),
        (true, false) => row.offset,
        _ => row.archived_to,
    };
    let chunk = read_chunk(&cand.file.path, cand.file.compressed, from, CHUNK.min(budget.max(1)))?;
    stats.files_read += 1;

    // A4: Codex compressed a log whose plain copy is already archived; keep what matches
    if need_archive && cand.file.compressed && row.archived_to == 0 && row.archive_id.is_none() && chunk.from == 0 {
        if let Some(seg) = archive::latest(c, cand.adapter.agent(), &cand.file.key)? {
            if seg.base == 0 && seg.len <= chunk.end {
                if let Ok(prev) = archive::read_all(&seg) {
                    if chunk.bytes.starts_with(&prev) {
                        row.archived_to = seg.len;
                        row.archive_id = (!seg.compressed).then_some(seg.id);
                    }
                }
            }
        }
    }

    let mut seg_update: Option<(i64, u64)> = None;
    if need_archive && chunk.end > row.archived_to && row.archived_to >= chunk.from {
        let mut seg = match row.archive_id { Some(id) => archive::get(c, id)?, None => None };
        if !seg.as_ref().is_some_and(|g| !g.compressed && g.base + g.len == row.archived_to) {
            seg = Some(archive::create(c, s.archive_dir, cand.adapter.agent(), &cand.file.key, &cand.file.path, row.archived_to)?);
        }
        let seg = seg.unwrap();
        let start = (row.archived_to - chunk.from) as usize;
        let new_len = archive::append(&seg, &chunk.bytes[start..])?;
        stats.archived_bytes += (chunk.bytes.len() - start) as u64;
        row.archive_id = Some(seg.id);
        row.archived_to = chunk.end;
        seg_update = Some((seg.id, new_len));
    }

    let mut events: Vec<Event> = Vec::new();
    if need_index && chunk.end > row.offset && row.offset >= chunk.from {
        let mut ctx: FileCtx = row.ctx.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
        let start = (row.offset - chunk.from) as usize;
        for (at, line) in lines(&chunk.bytes[start..], row.offset) {
            cand.adapter.parse_line(line, at, &cand.file, &mut ctx, &mut events);
        }
        row.offset = chunk.end;
        row.ctx = serde_json::to_string(&ctx).ok();
    }

    let tx = c.transaction()?;
    for e in &events {
        if insert_event(&tx, cand.adapter.agent(), &cand.file, &path, e)? { stats.events += 1; }
    }
    if let Some((id, len)) = seg_update { tx.execute("UPDATE archives SET len=?2 WHERE id=?1", params![id, len as i64])?; }
    row.state = if chunk.capped { "partial".into() } else { "current".into() };
    row.fail_count = 0;
    row.failed_mtime_ms = None;
    save_stat(&tx, &path, cand, &row)?;
    tx.commit()?;
    if chunk.capped { stats.more = true; }
    Ok(chunk.bytes.len() as u64)
}

fn save_stat(c: &Connection, path: &str, cand: &Candidate, row: &FileRow) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO files(path, agent, key, dev, ino, size, mtime_ms, offset, ctx, archive_id, archived_to, state, fail_count, failed_mtime_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(path) DO UPDATE SET dev=excluded.dev, ino=excluded.ino, size=excluded.size, mtime_ms=excluded.mtime_ms,
           offset=excluded.offset, ctx=excluded.ctx, archive_id=excluded.archive_id, archived_to=excluded.archived_to,
           state=excluded.state, fail_count=excluded.fail_count, failed_mtime_ms=excluded.failed_mtime_ms",
        params![path, cand.adapter.agent(), cand.file.key, cand.dev as i64, cand.ino as i64, cand.size as i64, cand.mtime_ms,
            row.offset as i64, row.ctx, row.archive_id, row.archived_to as i64,
            if row.state == "partial" { "partial" } else { "current" }, row.fail_count, row.failed_mtime_ms],
    )?;
    Ok(())
}

fn note_failure(c: &Connection, cand: &Candidate) -> rusqlite::Result<()> {
    let path = cand.file.path.to_string_lossy();
    c.execute(
        "INSERT INTO files(path, agent, key, state, fail_count, failed_mtime_ms) VALUES(?1, ?2, ?3, 'failed', 1, ?4)
         ON CONFLICT(path) DO UPDATE SET state='failed',
           fail_count=CASE WHEN failed_mtime_ms=excluded.failed_mtime_ms THEN fail_count+1 ELSE 1 END,
           failed_mtime_ms=excluded.failed_mtime_ms",
        params![path, cand.adapter.agent(), cand.file.key, cand.mtime_ms],
    )?;
    Ok(())
}

/// C5: a log that left the search window loses its index rows (file writes stay for the sinks).
fn expire(c: &Connection, path: &str) -> rusqlite::Result<()> {
    c.execute("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM events WHERE src_path=?1)", [path])?;
    c.execute("DELETE FROM events WHERE src_path=?1 AND kind IN ('message', 'tool.call', 'session.seen')", [path])?;
    Ok(())
}

/// Inserts one event (ignored when its id is already stored) and, when new, its index row.
fn insert_event(c: &Connection, agent: &str, file: &LogFile, path: &str, e: &Event) -> rusqlite::Result<bool> {
    let n = c.execute(
        "INSERT OR IGNORE INTO events(id, kind, agent, session, ts, cwd, path, explicit, role, src_path, file_key, src_offset, src_len, preview)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![e.id(agent, &file.key), e.kind.as_str(), agent, e.session, e.ts.as_ref().map(fmt_ts), e.cwd,
            e.path.as_ref().map(|p| p.to_string_lossy().into_owned()), e.explicit as i64,
            e.role.map(|r| if r == Role::User { "user" } else { "assistant" }), path, file.key,
            e.line_offset as i64, e.line_len as i64, e.preview()],
    )?;
    if n == 0 { return Ok(false); }
    let rowid = c.last_insert_rowid();
    let (user, assistant, tool) = match (e.kind, e.role) {
        (Kind::Message, Some(Role::User)) => (e.text.as_deref(), None, None),
        (Kind::Message, _) => (None, e.text.as_deref(), None),
        (Kind::ToolCall, _) => (None, None, e.text.as_deref()),
        _ => (None, None, None),
    };
    let mut ids = String::new();
    if let Some(t) = e.text.as_deref() { identifiers(t, &mut ids); }
    if let Some(p) = e.path.as_ref() { identifiers(&p.to_string_lossy(), &mut ids); }
    if user.is_some() || assistant.is_some() || tool.is_some() || !ids.is_empty() {
        c.execute("INSERT INTO messages_fts(rowid, user_text, assistant_text, tool_text, identifiers) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![rowid, user, assistant, tool, ids])?;
    }
    Ok(true)
}

fn ident_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[A-Za-z0-9_]+(?:[./\-][A-Za-z0-9_]+)+|[a-z0-9]+(?:[A-Z][a-z0-9]+)+").unwrap())
}

/// Paths and identifiers split into words (`src/appShell.tsx` → `src app Shell tsx`), so a
/// search for one part finds them. At most ~2 KiB per event.
fn identifiers(text: &str, out: &mut String) {
    for m in ident_re().find_iter(text) {
        if out.len() > 2048 { return; }
        let mut word = String::new();
        let mut prev_lower = false;
        for ch in m.as_str().chars() {
            if matches!(ch, '/' | '.' | '-' | '_') {
                if !word.is_empty() { out.push_str(&word); out.push(' '); word.clear(); }
                prev_lower = false;
                continue;
            }
            if ch.is_ascii_uppercase() && prev_lower && !word.is_empty() { out.push_str(&word); out.push(' '); word.clear(); }
            prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
            word.push(ch);
        }
        if !word.is_empty() { out.push_str(&word); out.push(' '); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_split_paths_and_camel_case() {
        let mut s = String::new();
        identifiers("see src/appShell.tsx and rooms-core", &mut s);
        assert_eq!(s.trim(), "src app Shell tsx rooms core");
    }
}
