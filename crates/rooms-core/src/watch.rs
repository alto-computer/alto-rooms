use crate::rules::DEFAULT_IGNORED_DIRS;
use crate::{CoreError, RoomsCore};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use rooms_protocol::{EventKind, RoomKind, RoomStatus};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::RecvError;

/// No file-id cache: it walks and stats every watched tree (node_modules, .git included) on each
/// watch(), and rescans never rely on rename stitching.
type Deb = Debouncer<notify::RecommendedWatcher, NoCache>;

/// Dropping this stops watching.
pub struct WatchHandle {
    _debouncer: Arc<Mutex<Deb>>,
}

/// How often rooms flagged unavailable are re-checked (their paths are not watchable while gone).
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

fn watch_dir(deb: &Mutex<Deb>, path: &Path) -> Result<(), notify::Error> {
    deb.lock().unwrap().watch(path, RecursiveMode::Recursive)
}

/// Linked roots live outside home, so each needs its own watch. Simple retry model:
/// `watched` holds the roots with a live watch; any linked room that is `ok` but not in the set
/// is (re)watched here. Callers: startup, room.added, room.updated→ok, and the retry tick.
/// A root that goes unavailable is dropped from the set (and unwatched) so its return re-watches.
/// A root whose watch() fails is logged once per path (`failed` holds the already-logged paths);
/// a later success clears the entry so a future failure logs again.
/// Returns whether a watch was added.
fn ensure_linked_watched(core: &RoomsCore, deb: &Mutex<Deb>, watched: &Mutex<HashSet<PathBuf>>, failed: &Mutex<HashSet<PathBuf>>) -> bool {
    let mut added = false;
    for p in core.linked_roots() {
        if watched.lock().unwrap().contains(&p) { continue; }
        match watch_dir(deb, &p) {
            Ok(()) => {
                failed.lock().unwrap().remove(&p);
                watched.lock().unwrap().insert(p);
                added = true;
            }
            Err(e) => {
                if failed.lock().unwrap().insert(p.clone()) {
                    eprintln!("rooms-core: failed to watch linked room {}: {e}", p.display());
                }
            }
        }
    }
    added
}

/// Minimum gap between watcher-triggered resyncs, so a persistent watcher error can't cause a
/// refetch storm.
const RESYNC_MIN_GAP: Duration = Duration::from_secs(2);

/// Runs `run` on its own worker thread, coalescing requests (sent on the returned channel): at most
/// one run at a time; every request that arrives during a run or its min-gap wait collapses into
/// exactly one more run; runs start at least `min_gap` after the previous one ended. The only
/// state is the channel and the last-run `Instant` (no core lock is involved). The worker ends
/// when every sender is dropped or `run` returns false.
fn spawn_coalescer(min_gap: Duration, mut run: impl FnMut() -> bool + Send + 'static) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut last: Option<Instant> = None;
        while rx.recv().is_ok() {
            if let Some(t) = last { std::thread::sleep(min_gap.saturating_sub(t.elapsed())); }
            while rx.try_recv().is_ok() {} // everything queued so far is served by this run
            if !run() { break; }
            last = Some(Instant::now());
        }
    });
    tx
}

/// Whether a change at `abs` (`rel` to its room root) can change what a rescan finds: an
/// artifact, a journal note, an ignore file, or a folder (created, renamed or deleted). Anything
/// inside a dot-folder or a default-ignored folder (`node_modules`, `dist`, …) and every other
/// file is noise, so a build writing thousands of files never rescans the room.
fn can_affect_index(rel: &Path, abs: &Path) -> bool {
    let names: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    let Some((name, dirs)) = names.split_last() else { return true }; // the root itself
    let ignored = |n: &str| n.starts_with('.') || DEFAULT_IGNORED_DIRS.contains(&n);
    if dirs.iter().any(|d| ignored(d)) { return false; }
    if name == ".gitignore" || name == ".roomsignore" { return true; }
    if ignored(name) { return false; }
    let ext = Path::new(name.as_ref()).extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    match ext.as_deref() {
        Some("html" | "htm" | "md") => true,
        Some(_) => abs.is_dir(),
        // Gone without a trace: it may have been a folder.
        None => abs.is_dir() || std::fs::symlink_metadata(abs).is_err(),
    }
}

#[cfg(test)]
#[test]
fn only_paths_that_can_change_a_scan_are_relevant() {
    let d = tempfile::tempdir().unwrap();
    let at = |rel: &str| can_affect_index(Path::new(rel), &d.path().join(rel));
    std::fs::create_dir_all(d.path().join("v1.2")).unwrap();
    std::fs::write(d.path().join("Makefile"), "").unwrap();
    assert!(at(""));
    assert!(at("a.html") && at("sub/b.HTM") && at("2026-10-05/n.md"));
    assert!(at(".gitignore") && at("sub/.roomsignore"));
    assert!(at("v1.2"), "an existing folder");
    assert!(at("gone"), "a missing path without extension may have been a folder");
    assert!(!at("Makefile"), "an existing file without extension");
    assert!(!at("x.png") && !at("src/main.rs"));
    assert!(!at("node_modules/x/a.html") && !at(".git/a.html") && !at("a/.cache/b.html"));
    assert!(!at(".a.html.tmp") && !at("node_modules") && !at("dist"));
}

/// A path under `<plugins>/<id>/` that is not inside that plugin's `data/` (or `<plugins>/<id>` itself).
fn is_plugin_code_path(plugins_dir: &Path, p: &Path) -> bool {
    let Ok(rest) = p.strip_prefix(plugins_dir) else { return false };
    let mut parts = rest.components();
    parts.next().is_some() && parts.next().is_none_or(|c| c.as_os_str() != "data")
}

#[cfg(test)]
#[test]
fn plugin_code_paths_exclude_data() {
    let d = Path::new("/h/.rooms/plugins");
    assert!(is_plugin_code_path(d, Path::new("/h/.rooms/plugins/echo")));
    assert!(is_plugin_code_path(d, Path::new("/h/.rooms/plugins/echo/manifest.json")));
    assert!(is_plugin_code_path(d, Path::new("/h/.rooms/plugins/echo/assets/x.js")));
    assert!(!is_plugin_code_path(d, Path::new("/h/.rooms/plugins/echo/data/notes/a.txt")));
    assert!(!is_plugin_code_path(d, Path::new("/h/.rooms/plugins/echo/data")));
    assert!(!is_plugin_code_path(d, Path::new("/h/.rooms/state.json")));
    assert!(!is_plugin_code_path(d, Path::new("/h/.rooms/plugins")));
}

pub fn start_watching(core: RoomsCore) -> Result<WatchHandle, CoreError> {
    let c2 = core.clone();
    let rooms_dir = core.home().join(".rooms");
    let home = core.home().to_path_buf();
    let plugins_dir = crate::plugins::plugins_dir(core.home());
    // Watcher-triggered full resyncs run coalesced on a worker that holds only a weak core; it ends
    // when the debouncer (owner of `resync`) is dropped or the core is gone.
    let wresync = core.downgrade();
    let resync = spawn_coalescer(RESYNC_MIN_GAP, move || match wresync.upgrade() {
        Some(core) => { core.resync_all(); true }
        None => false,
    });
    let on_events = move |res: DebounceEventResult| {
        match res {
            // Overflow (events were dropped) or a watcher error: per-room rescans can't be trusted.
            Ok(events) if events.iter().any(|ev| ev.need_rescan()) => {
                eprintln!("rooms-core: watch_overflow: the watcher dropped events; resyncing everything");
                let _ = resync.send(());
            }
            Err(errs) => {
                for e in errs { eprintln!("rooms-core: watcher error: {e}"); }
                let _ = resync.send(());
            }
            Ok(events) => {
                // A plugin's code or manifest changed (its own data/ writes don't count): clients list again.
                if events.iter().flat_map(|ev| ev.paths.iter()).any(|p| is_plugin_code_path(&plugins_dir, p)) {
                    c2.plugins_changed();
                }
                let paths = events.iter().flat_map(|ev| ev.paths.iter()).filter(|p| !p.starts_with(&rooms_dir));
                // A direct child of home (or a path no room owns yet) may be a folder created,
                // renamed or deleted in Finder: reconcile owned rooms first (emits room.* events).
                let mut rooms = HashSet::new();
                let mut sync_home = false;
                for p in paths {
                    let owner = c2.room_and_root_for_path(p);
                    let root = owner.as_ref().map_or(home.as_path(), |(_, root)| root.as_path());
                    let Ok(rel) = p.strip_prefix(root) else { continue };
                    // Any direct child of home may be a room folder, whatever its name.
                    let top_level = p.parent() == Some(home.as_path());
                    if !top_level && !can_affect_index(rel, p) { continue; }
                    sync_home |= top_level || owner.is_none();
                    if let Some((id, _)) = owner { rooms.insert(id); }
                }
                if sync_home { rooms.extend(c2.sync_home_dirs()); }
                for id in rooms { c2.rescan_room(&id); }
            }
        }
    };
    // Adding or removing a watch restarts the FSEvents stream, and events in that gap are lost:
    // each change is followed by a coalesced rescan of everything (it emits only what changed).
    let wrescan = core.downgrade();
    let rescan = spawn_coalescer(RESYNC_MIN_GAP, move || match wrescan.upgrade() {
        Some(core) => { core.rescan_all(); true }
        None => false,
    });
    let debouncer = new_debouncer_opt::<_, notify::RecommendedWatcher, _>(Duration::from_millis(300), None, on_events, NoCache, notify::Config::default())
        .map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let deb = Arc::new(Mutex::new(debouncer));
    watch_dir(&deb, core.home()).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let watched = Arc::new(Mutex::new(HashSet::new()));
    let failed = Arc::new(Mutex::new(HashSet::new()));
    ensure_linked_watched(&core, &deb, &watched, &failed); // the startup backfill covers the gap
    // Helper threads hold only weak references, so dropping the handle and every RoomsCore ends them.
    // (The debouncer callback owns a strong core; the debouncer's own thread drops it shortly after
    // the Debouncer is dropped, since Drop only signals stop.)
    let (wcore, wdeb) = (core.downgrade(), Arc::downgrade(&deb));
    let mut rx = core.subscribe();
    let (w3, f3) = (watched.clone(), failed.clone());
    let (wcore3, wdeb3) = (wcore.clone(), wdeb.clone());
    let rescan3 = rescan.clone();
    std::thread::spawn(move || loop {
        match rx.blocking_recv() {
            Ok(e) => {
                let room = match e.kind {
                    EventKind::RoomAdded { room } | EventKind::RoomUpdated { room } if room.kind == RoomKind::Linked => room,
                    _ => continue,
                };
                let (Some(core), Some(deb)) = (wcore3.upgrade(), wdeb3.upgrade()) else { break };
                if room.status == RoomStatus::Unavailable {
                    let p = PathBuf::from(&room.path);
                    f3.lock().unwrap().remove(&p);
                    if w3.lock().unwrap().remove(&p) {
                        let _ = deb.lock().unwrap().unwatch(&p);
                        let _ = rescan3.send(());
                    }
                } else if ensure_linked_watched(&core, &deb, &w3, &f3) {
                    let _ = rescan3.send(());
                }
            }
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => break,
        }
    });
    // Retry tick: re-check unavailable rooms (a returning root emits room.updated→ok, which re-watches above).
    std::thread::spawn(move || loop {
        std::thread::sleep(RETRY_INTERVAL);
        let (Some(core), Some(deb)) = (wcore.upgrade(), wdeb.upgrade()) else { break };
        core.rescan_unavailable();
        if ensure_linked_watched(&core, &deb, &watched, &failed) { let _ = rescan.send(()); }
    });
    Ok(WatchHandle { _debouncer: deb })
}

pub fn open_and_watch(home: &Path) -> Result<(RoomsCore, WatchHandle), CoreError> {
    let core = RoomsCore::open(home)?;
    let handle = start_watching(core.clone())?;
    let c = core.clone();
    std::thread::spawn(move || {
        if let Err(e) = c.backfill_all() { eprintln!("rooms-core: background backfill failed: {e}"); }
    });
    Ok((core, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    const T: Duration = Duration::from_secs(5);

    #[test]
    fn requests_during_a_run_coalesce_into_exactly_one_more_run() {
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel::<()>();
        let (done_tx, done) = mpsc::channel();
        let mut n = 0;
        let req = spawn_coalescer(Duration::ZERO, move || {
            n += 1;
            if n == 1 { entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); }
            done_tx.send(n).unwrap();
            true
        });
        req.send(()).unwrap();
        entered.recv_timeout(T).unwrap(); // run 1 is in progress
        for _ in 0..5 { req.send(()).unwrap(); }
        release.send(()).unwrap();
        assert_eq!(done.recv_timeout(T).unwrap(), 1);
        assert_eq!(done.recv_timeout(T).unwrap(), 2);
        assert!(done.recv_timeout(Duration::from_millis(300)).is_err(), "more than one extra run");
    }

    #[test]
    fn runs_keep_the_minimum_gap() {
        let (done_tx, done) = mpsc::channel();
        let req = spawn_coalescer(Duration::from_millis(300), move || { done_tx.send(Instant::now()).unwrap(); true });
        req.send(()).unwrap();
        let first = done.recv_timeout(T).unwrap();
        req.send(()).unwrap();
        let second = done.recv_timeout(T).unwrap();
        assert!(second - first >= Duration::from_millis(300), "{:?}", second - first);
    }

    #[test]
    fn worker_ends_when_requests_are_dropped() {
        let (alive_tx, alive) = mpsc::channel::<()>();
        let req = spawn_coalescer(Duration::ZERO, move || { let _ = &alive_tx; true });
        drop(req);
        assert_eq!(alive.recv_timeout(T), Err(mpsc::RecvTimeoutError::Disconnected));
    }
}
