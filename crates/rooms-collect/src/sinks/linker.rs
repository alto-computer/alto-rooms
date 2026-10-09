//! The linker (L1–L9): each HTML file an agent writes after the collector first ran gets a
//! symlink in `<home>/<room>` (the owned room named like its repo) or `<home>/inbox`. It never
//! creates rooms, never writes into linked rooms, and never re-adds a link the user removed.
//! The same pass records each written file's conversation in sources.json.
use super::sources::{self, Entry};
use crate::filter::{link_targets, linked_roots, not_a_document, owned_rooms, repo_info};
use crate::pathutil::under;
use crate::store::{event_by_rowid, events_after, set_sink_cursor, sink_cursor, StoredEvent};
use chrono::{DateTime, SecondsFormat, Utc};
use rooms_core::rules::{room_slug, slug_key};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const SINK: &str = "linker";
/// L2: a file not there yet (the log line comes before the tool runs) is looked at again after these.
pub const RETRY_MS: [i64; 3] = [500, 2_000, 10_000];
/// Only writes this recent are waited for; an older missing file is gone.
const FRESH_MS: i64 = 60_000;
/// A loose write counts only when the file changed at (or after) that time.
const MTIME_SLACK_MS: i64 = 2_000;
const BATCH: i64 = 500;

#[derive(Debug, Default)]
pub struct Outcome {
    pub linked: Vec<PathBuf>,
    pub recorded: usize,
    /// When the earliest pending retry is due.
    pub retry_at: Option<i64>,
}

/// `<home>/.rooms/collect/state.json` holds `linkerSince`, written on the first run: files
/// written before it are the onboarding skill's job, not the collector's.
pub fn linker_since(home: &Path, now_ms: i64) -> Option<DateTime<Utc>> {
    let dir = home.join(".rooms/collect");
    let path = dir.join("state.json");
    if let Some(t) = std::fs::read(&path).ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("linkerSince").and_then(|s| s.as_str()).and_then(|s| DateTime::parse_from_rfc3339(s).ok())) {
        return Some(t.with_timezone(&Utc));
    }
    let now = DateTime::<Utc>::from_timestamp_millis(now_ms)?;
    std::fs::create_dir_all(&dir).ok()?;
    let body = serde_json::to_vec_pretty(&json!({"linkerSince": now.to_rfc3339_opts(SecondsFormat::Secs, true)})).ok()?;
    let tmp = dir.join(".state.json.tmp");
    std::fs::write(&tmp, body).ok()?;
    std::fs::rename(&tmp, &path).ok()?;
    Some(now)
}

/// Everything the linker ever linked (`linked.jsonl`): realpaths and (repo, path in repo).
#[derive(Default)]
struct Linked { real: HashSet<String>, in_repo: HashSet<(String, String)> }

fn read_linked(home: &Path) -> Linked {
    let mut l = Linked::default();
    let Ok(s) = std::fs::read_to_string(home.join(".rooms/collect/linked.jsonl")) else { return l };
    for v in s.lines().filter_map(|x| serde_json::from_str::<Value>(x).ok()) {
        let g = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        if let Some(r) = g("real") { l.real.insert(r); }
        if let (Some(k), Some(r)) = (g("repo"), g("rel")) { l.in_repo.insert((k, r)); }
    }
    l
}

fn append_linked(home: &Path, line: &Value) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(home.join(".rooms/collect/linked.jsonl"))?;
    writeln!(f, "{line}")?;
    f.sync_data()
}

struct Run<'a> {
    c: &'a Connection,
    home: &'a Path,
    rooms_real: PathBuf,
    user_home: &'a Path,
    now_ms: i64,
    since: Option<DateTime<Utc>>,
    linked: Linked,
    targets: Option<HashSet<PathBuf>>,
    roots: Vec<PathBuf>,
    sources: BTreeMap<String, Entry>,
    out: Outcome,
}

/// Handles due retries, then every file.written event after the sink's cursor.
pub fn run(c: &Connection, home: &Path, user_home: &Path, now_ms: i64) -> rusqlite::Result<Outcome> {
    if !home.join(".rooms").is_dir() { return Ok(Outcome::default()); } // not a Rooms home (yet)
    let mut r = Run {
        c, home, rooms_real: std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()), user_home, now_ms,
        since: linker_since(home, now_ms), linked: read_linked(home), targets: None, roots: linked_roots(home),
        sources: BTreeMap::new(), out: Outcome::default(),
    };
    let due: Vec<(i64, i64)> = {
        let mut st = c.prepare("SELECT event_rowid, attempts FROM link_retry WHERE next_at_ms<=?1 ORDER BY event_rowid")?;
        let it = st.query_map([now_ms], |row| Ok((row.get(0)?, row.get(1)?)))?;
        it.collect::<rusqlite::Result<_>>()?
    };
    for (rowid, attempts) in due {
        match event_by_rowid(c, rowid)? {
            Some(e) => r.handle(&e, attempts)?,
            None => { c.execute("DELETE FROM link_retry WHERE event_rowid=?1", [rowid])?; }
        }
    }
    let mut cursor = sink_cursor(c, SINK)?;
    loop {
        let batch = events_after(c, "file.written", cursor, BATCH)?;
        for e in &batch { r.handle(e, 0)?; cursor = e.rowid; }
        set_sink_cursor(c, SINK, cursor)?;
        if (batch.len() as i64) < BATCH { break; }
    }
    match sources::merge(home, &r.sources) {
        Ok(n) => r.out.recorded = n,
        Err(e) => eprintln!("rooms-collect: could not update sources.json: {e}"),
    }
    r.out.retry_at = c.query_row("SELECT min(next_at_ms) FROM link_retry", [], |row| row.get::<_, Option<i64>>(0)).optional()?.flatten();
    Ok(r.out)
}

impl Run<'_> {
    fn handle(&mut self, e: &StoredEvent, attempts: i64) -> rusqlite::Result<()> {
        let (Some(raw), Some(ts)) = (e.path.as_deref().map(PathBuf::from), e.ts.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok())) else { return Ok(()) };
        let ts = ts.with_timezone(&Utc);
        if !raw.is_file() {
            // L2: wait a little for a write that was logged before it happened
            let fresh = self.now_ms - ts.timestamp_millis() < FRESH_MS;
            if fresh && (attempts as usize) < RETRY_MS.len() {
                self.c.execute("INSERT INTO link_retry(event_rowid, attempts, next_at_ms) VALUES(?1, ?2, ?3)
                    ON CONFLICT(event_rowid) DO UPDATE SET attempts=excluded.attempts, next_at_ms=excluded.next_at_ms",
                    params![e.rowid, attempts + 1, self.now_ms + RETRY_MS[attempts as usize]])?;
            } else {
                self.c.execute("DELETE FROM link_retry WHERE event_rowid=?1", [e.rowid])?;
            }
            return Ok(());
        }
        self.c.execute("DELETE FROM link_retry WHERE event_rowid=?1", [e.rowid])?;
        let Ok(real) = std::fs::canonicalize(&raw) else { return Ok(()) };
        if not_a_document(&raw, self.user_home, self.home) || not_a_document(&real, self.user_home, &self.rooms_real) { return Ok(()); }
        if !e.explicit {
            // L3: a shell line naming the path may only read or mention it
            let mtime = std::fs::metadata(&real).map(|m| m.mtime() * 1000 + m.mtime_nsec() / 1_000_000).unwrap_or(0);
            if mtime < ts.timestamp_millis() - MTIME_SLACK_MS { return Ok(()); }
        }
        let real_s = real.to_string_lossy().into_owned();
        if let Some(session) = &e.session {
            let entry = Entry {
                agent: e.agent.clone(), session: session.clone(),
                cwd: e.cwd.clone().unwrap_or_else(|| real.parent().unwrap_or(Path::new("/")).to_string_lossy().into_owned()),
                written_at: ts.to_rfc3339_opts(SecondsFormat::Secs, true), explicit: e.explicit,
            };
            let best = sources::better(self.sources.get(&real_s), entry);
            self.sources.insert(real_s.clone(), best);
        }
        self.link(&real, &real_s, ts);
        Ok(())
    }

    fn link(&mut self, real: &Path, real_s: &str, ts: DateTime<Utc>) {
        if self.since.is_none_or(|s| ts < s) { return; } // L1
        if under(real, &self.rooms_real) || self.linked.real.contains(real_s) { return; } // L4, L6
        if self.roots.iter().any(|r| under(real, r)) { return; } // L5: its linked room shows it
        let (repo, root) = repo_info(real);
        let rel = real.strip_prefix(&root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        if self.linked.in_repo.contains(&(repo.clone(), rel.clone())) { return; } // L7: the same file in another worktree
        let targets = self.targets.get_or_insert_with(|| link_targets(self.home));
        if targets.contains(real) { return; } // already linked by hand or by the skill
        // L8: the owned room named like the repo, else inbox
        let want = slug_key(&room_slug(&repo));
        let dir = owned_rooms(self.home).into_iter()
            .find(|(name, _)| name != "inbox" && !want.is_empty() && slug_key(&room_slug(name)) == want)
            .map(|(_, p)| p)
            .unwrap_or_else(|| self.home.join("inbox"));
        if std::fs::create_dir_all(&dir).is_err() { return; }
        let Some(name) = real.file_name().map(|n| n.to_string_lossy().into_owned()) else { return };
        let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i..]), _ => (name.as_str(), "") };
        for n in 1..1000 {
            let link = if n == 1 { dir.join(&name) } else { dir.join(format!("{stem} ({n}){ext}")) };
            if link.symlink_metadata().is_ok() { continue; } // L9: never replace what is there
            match std::os::unix::fs::symlink(real, &link) {
                Ok(()) => {
                    let line = json!({"real": real_s, "link": link.to_string_lossy(), "repo": repo, "rel": rel,
                        "at": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)});
                    if let Err(e) = append_linked(self.home, &line) { eprintln!("rooms-collect: could not note link: {e}"); }
                    self.linked.real.insert(real_s.to_string());
                    self.linked.in_repo.insert((repo, rel));
                    targets.insert(real.to_path_buf());
                    self.out.linked.push(link);
                    return;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => { eprintln!("rooms-collect: could not link {}: {e}", real.display()); return; }
            }
        }
    }
}
