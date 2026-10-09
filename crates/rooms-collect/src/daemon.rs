//! The running collector: wakes on log changes (C1: 100 ms after the last change) and every
//! 60 s regardless, reads what is new, links and records, and stops when the app does.
use crate::adapters::{self, Roots};
use crate::config::Config;
use crate::ingest::{self, Settings, Stats};
use crate::sinks::linker::{self, Outcome};
use crate::{archive, store};
use notify::{RecursiveMode, Watcher};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const DEBOUNCE: Duration = Duration::from_millis(100);
/// A pass this often even with no file events (missed events, new roots, retries, config).
pub const RECONCILE: Duration = Duration::from_secs(60);
/// The longest one burst of changes can hold a pass back.
const MAX_DEBOUNCE: Duration = Duration::from_secs(1);
const COMPRESS_EVERY: Duration = Duration::from_secs(60 * 60);
/// How often a waiting collector checks that the app that started it is still there.
const PARENT_CHECK: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct Opts {
    /// The Rooms home (`~/rooms`).
    pub home: PathBuf,
    pub roots: Roots,
    /// Where collect.db and the archive live.
    pub data: PathBuf,
}

impl Opts {
    pub fn db_path(&self) -> PathBuf { store::path_in(&self.data) }
    pub fn archive_dir(&self) -> PathBuf { self.data.join("archive") }
}

pub struct Collector { pub opts: Opts, pub conn: Connection }

#[derive(Debug, Default)]
pub struct Tick { pub enabled: bool, pub ingest: Stats, pub link: Outcome }

pub fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }

impl Collector {
    pub fn open(opts: Opts) -> rusqlite::Result<Self> {
        let conn = store::open(&opts.db_path())?;
        Ok(Collector { opts, conn })
    }

    /// One pass: settings are read fresh, so a changed collect.toml applies on the next pass.
    pub fn tick(&mut self, now_ms: i64) -> rusqlite::Result<Tick> {
        let cfg = Config::load(&self.opts.home);
        if !cfg.enabled { return Ok(Tick::default()); }
        let adapters = adapters::enabled(&self.opts.roots, |a| cfg.agents.on(a));
        let archive_dir = self.opts.archive_dir();
        let s = Settings { history_days: cfg.history_days, archive: cfg.archive, archive_dir: &archive_dir, now_ms };
        let ingest = ingest::pass(&mut self.conn, &adapters, &s)?;
        let link = linker::run(&self.conn, &self.opts.home, &self.opts.roots.user_home, now_ms)?;
        Ok(Tick { enabled: true, ingest, link })
    }

    /// Passes until nothing is left (the first run over a large history takes several).
    pub fn drain(&mut self) -> rusqlite::Result<Tick> {
        let mut total = Tick::default();
        loop {
            let t = self.tick(now_ms())?;
            total.enabled = t.enabled;
            total.ingest.files_read += t.ingest.files_read;
            total.ingest.events += t.ingest.events;
            total.ingest.archived_bytes += t.ingest.archived_bytes;
            total.link.linked.extend(t.link.linked);
            total.link.recorded += t.link.recorded;
            total.link.retry_at = t.link.retry_at;
            if !t.ingest.more { return Ok(total); }
        }
    }

    pub fn compress(&self) {
        if !Config::load(&self.opts.home).archive { return; }
        match archive::compress_idle(&self.conn, now_ms()) {
            Ok(0) => {}
            Ok(n) => eprintln!("rooms-collect: compressed {n} archived logs"),
            Err(e) => eprintln!("rooms-collect: compress: {e}"),
        }
    }
}

/// The folders to watch: each agent's log root (and Codex's archived sessions).
fn watch_roots(r: &Roots) -> Vec<PathBuf> {
    let mut v = vec![r.claude.clone(), r.codex.clone(), r.aside.clone()];
    if let Some(p) = r.codex.parent() { v.push(p.join("archived_sessions")); }
    v
}

/// Runs until the app that started it exits (the parent process changes) or the watcher dies.
pub fn run(opts: Opts) -> Result<(), Box<dyn std::error::Error>> {
    let parent = std::os::unix::process::parent_id();
    let mut c = Collector::open(opts)?;
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok_and(|e| !e.kind.is_access()) { let _ = tx.send(()); }
    })?;
    let mut watched: Vec<PathBuf> = Vec::new();
    let mut last_compress: Option<Instant> = None;
    loop {
        for root in watch_roots(&c.opts.roots) {
            if !watched.contains(&root) && root.is_dir() && watcher.watch(&root, RecursiveMode::Recursive).is_ok() { watched.push(root); }
        }
        let t = c.tick(now_ms())?;
        if t.ingest.files_read > 0 || !t.link.linked.is_empty() {
            eprintln!("rooms-collect: read {} logs, {} new events, {} linked", t.ingest.files_read, t.ingest.events, t.link.linked.len());
        }
        if last_compress.is_none_or(|at| at.elapsed() >= COMPRESS_EVERY) { c.compress(); last_compress = Some(Instant::now()); }
        if t.ingest.more { continue; }
        let mut wait = RECONCILE;
        if let Some(at) = t.link.retry_at { wait = wait.min(Duration::from_millis((at - now_ms()).max(0) as u64)); }
        let deadline = Instant::now() + wait;
        loop {
            if std::os::unix::process::parent_id() != parent { return Ok(()); }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { break; }
            match rx.recv_timeout(left.min(PARENT_CHECK)) {
                Ok(()) => { debounce(&rx); break; }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err("file watcher stopped".into()),
            }
        }
    }
}

/// Waits until changes have been quiet for DEBOUNCE (at most MAX_DEBOUNCE).
fn debounce(rx: &mpsc::Receiver<()>) {
    let start = Instant::now();
    while start.elapsed() < MAX_DEBOUNCE {
        if rx.recv_timeout(DEBOUNCE).is_err() { return; }
    }
}
