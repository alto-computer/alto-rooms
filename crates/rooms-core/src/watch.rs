use crate::lock::lock;
use crate::rules::{is_html, DEFAULT_IGNORED_DIRS};
use crate::scan::owner_of;
use crate::{CoreError, RoomsCore};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use rooms_protocol::{EventKind, RoomId, RoomKind, RoomStatus};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::RecvError;

/// No file-id cache: it walks and stats every watched tree (node_modules, .git included) on each
/// watch(), and rescans never rely on rename stitching.
type Deb = Debouncer<RecommendedWatcher, NoCache>;

/// Dropping this stops watching.
pub struct WatchHandle {
    _debouncer: Arc<Mutex<Deb>>,
    _targets: Arc<Mutex<TargetWatch>>,
}

/// How often rooms flagged unavailable are re-checked (their paths are not watchable while gone).
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

fn watch_dir(deb: &Mutex<Deb>, path: &Path) -> Result<(), notify::Error> {
    lock(deb).watch(path, RecursiveMode::Recursive)
}

/// Linked roots live outside home, so each needs its own watch. Simple retry model:
/// `watched` holds the roots with a live watch; any linked room that is `ok` but not in the set
/// is (re)watched here. Callers: startup, room.added, room.updated→ok, and the retry tick.
/// A root that goes unavailable is dropped from the set (and unwatched) so its return re-watches.
/// A root whose watch() fails is logged once per path (`failed` holds the already-logged paths);
/// a later success clears the entry so a future failure logs again.
/// Returns whether it touched the watcher at all: a failed watch() restarts the stream too.
fn ensure_linked_watched(core: &RoomsCore, deb: &Mutex<Deb>, watched: &Mutex<HashSet<PathBuf>>, failed: &Mutex<HashSet<PathBuf>>) -> bool {
    let mut touched = false;
    for p in core.linked_roots() {
        if lock(watched).contains(&p) { continue; }
        touched = true;
        match watch_dir(deb, &p) {
            Ok(()) => {
                lock(failed).remove(&p);
                lock(watched).insert(p);
            }
            Err(e) => {
                if lock(failed).insert(p.clone()) {
                    eprintln!("rooms-core: failed to watch linked room {}: {e}", p.display());
                }
            }
        }
    }
    touched
}

/// Minimum gap between watcher-triggered resyncs, so a persistent watcher error can't cause a
/// refetch storm.
const RESYNC_MIN_GAP: Duration = Duration::from_secs(2);

/// Minimum gap between the rescans that follow watch changes.
const WATCH_GAP_RESCAN_MIN_GAP: Duration = Duration::from_secs(30);

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

/// What a change at `abs` (`rel` to its room root) asks of the index.
#[derive(Debug, PartialEq, Eq)]
enum Effect {
    /// Nothing a scan would see: inside a dot-folder or a default-ignored folder (`node_modules`,
    /// `dist`, …), or a file that is not a document, so a build writing thousands of files never
    /// rescans the room.
    None,
    /// A document (artifact or note), there or gone: rescan just that path.
    Path,
    /// A folder, an ignore file or the root itself: rescan the room.
    Room,
    /// Something gone that is not a document (a folder moved out, trashed, or renamed to an
    /// ignored name, whatever its name looks like): rescan the rows indexed under it.
    Gone,
}

fn effect_of(rel: &Path, abs: &Path) -> Effect {
    let names: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    let Some((name, dirs)) = names.split_last() else { return Effect::Room };
    let ignored = |n: &str| n.starts_with('.') || DEFAULT_IGNORED_DIRS.contains(&n);
    if dirs.iter().any(|d| ignored(d)) { return Effect::None; }
    if name == ".gitignore" || name == ".roomsignore" { return Effect::Room; }
    if ignored(name) { return Effect::None; }
    match std::fs::symlink_metadata(abs) {
        Ok(m) if m.is_dir() => Effect::Room,
        _ if has_doc_ext(abs) => Effect::Path,
        Ok(_) => Effect::None,
        Err(_) => Effect::Gone,
    }
}

#[cfg(test)]
#[test]
fn effects_of_changed_paths() {
    let d = tempfile::tempdir().unwrap();
    let at = |rel: &str| effect_of(Path::new(rel), &d.path().join(rel));
    std::fs::create_dir_all(d.path().join("v1.2")).unwrap();
    std::fs::create_dir_all(d.path().join("folder.html")).unwrap();
    std::fs::write(d.path().join("Makefile"), "").unwrap();
    std::fs::write(d.path().join("x.png"), "").unwrap();
    assert_eq!(at(""), Effect::Room);
    for p in ["a.html", "sub/b.HTM", "2026-10-05/n.md"] { assert_eq!(at(p), Effect::Path, "{p}"); }
    for p in [".gitignore", "sub/.roomsignore", "v1.2", "folder.html"] { assert_eq!(at(p), Effect::Room, "{p}"); }
    for p in ["gone", "v9.9", "gone.png"] { assert_eq!(at(p), Effect::Gone, "{p}"); }
    for p in ["Makefile", "x.png", "node_modules/x/a.html", ".git/a.html", "a/.cache/b.html", ".a.html.tmp", "node_modules", "dist", ".old"] {
        assert_eq!(at(p), Effect::None, "{p}");
    }
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

/// Work the watchers found, merged until the rescan worker takes it.
#[derive(Default)]
struct Pending {
    /// Reconcile home's folders: a room folder may have been created, renamed or deleted.
    sync_home: bool,
    /// Rooms to rescan whole: a folder, an ignore file or the root itself changed.
    rooms: HashSet<RoomId>,
    /// Paths (relative to their room's root) to rescan one by one.
    paths: HashMap<RoomId, HashSet<PathBuf>>,
    /// Vanished paths (relative to their room's root) whose indexed rows must be rechecked.
    gone: HashMap<RoomId, HashSet<PathBuf>>,
    /// Changed files that may be the original of linked artifacts, in any room.
    targets: HashSet<PathBuf>,
    /// Folders the original-file watch saw change: every original under them is rechecked.
    target_dirs: HashSet<PathBuf>,
}

fn has_doc_ext(p: &Path) -> bool {
    is_html(p) || p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Records what a change at `p` (seen by the home or a linked-root watch) asks for. `roots` are
/// `RoomsCore::room_roots`.
fn note_change(pending: &mut Pending, roots: &[(RoomId, PathBuf)], home: &Path, p: &Path) {
    // Any document may be the original of a link somewhere, even in a folder scans ignore.
    if has_doc_ext(p) { pending.targets.insert(p.to_path_buf()); }
    let owner = owner_of(roots, p);
    let Ok(rel) = p.strip_prefix(owner.map_or(home, |(_, root)| root.as_path())) else { return };
    // Any direct child of home may be a room folder, whatever its name.
    let top_level = p.parent() == Some(home);
    let effect = effect_of(rel, p);
    pending.sync_home |= top_level || (owner.is_none() && effect != Effect::None);
    let Some((room, _)) = owner else { return };
    let room = room.clone();
    match effect {
        Effect::None => {}
        Effect::Path => { pending.paths.entry(room).or_default().insert(rel.to_path_buf()); }
        Effect::Room => { pending.rooms.insert(room); }
        Effect::Gone => { pending.gone.entry(room).or_default().insert(rel.to_path_buf()); }
    }
}

/// Does the work in `pending`: home folders first (new or renamed rooms are rescanned whole),
/// then whole rooms, then single paths, including every artifact whose original changed.
fn run_pending(core: &RoomsCore, pending: Pending) {
    let Pending { sync_home, mut rooms, mut paths, gone, targets, target_dirs } = pending;
    if sync_home { rooms.extend(core.sync_home_dirs()); }
    for (room, rels) in gone {
        let under = core.artifacts_under(&room, &rels);
        paths.entry(room).or_default().extend(under);
    }
    let linked = core.artifacts_with_targets(targets.iter().map(PathBuf::as_path)).into_iter()
        .chain(core.artifacts_with_targets_under(target_dirs.iter().map(PathBuf::as_path)));
    for (room, rel) in linked { paths.entry(room).or_default().insert(rel); }
    for room in &rooms { core.rescan_room(room); }
    for (room, rels) in paths.into_iter().filter(|(room, _)| !rooms.contains(room)) {
        core.rescan_paths(&room, &rels.into_iter().collect::<Vec<_>>());
    }
}

/// Originals outside every watched root (home, linked roots) are seen by a non-recursive watch
/// of their folder, or of its nearest existing ancestor while the folder is gone (so its return
/// is seen). Folders that could not be watched are in `failed`, retried after a while.
struct TargetWatch {
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
    failed: HashSet<PathBuf>,
    failed_at: Option<Instant>,
}

/// Minimum time before folders the original-file watch could not watch are tried again.
const TARGET_RETRY_GAP: Duration = Duration::from_secs(30);

/// Brings the target watch in line with the index. Returns whether the watch set changed.
fn sync_target_watch(core: &RoomsCore, tw: &Mutex<TargetWatch>) -> bool {
    let want: HashSet<PathBuf> = core.outside_targets().iter()
        .filter_map(|t| t.parent()?.ancestors().find(|a| a.is_dir()).map(Path::to_path_buf))
        .collect();
    let mut tw = lock(tw);
    let TargetWatch { watcher, watched, failed, failed_at } = &mut *tw;
    if want == *watched { failed.clear(); return false; }
    let only_retries = want.difference(watched).all(|d| failed.contains(d)) && watched.is_subset(&want);
    if only_retries && failed_at.is_some_and(|t| t.elapsed() < TARGET_RETRY_GAP) { return false; }
    // One batch: FSEvents restarts its stream once, not once per folder.
    let mut batch = watcher.paths_mut();
    for d in watched.difference(&want) { let _ = batch.remove(d); }
    let mut now = HashSet::new();
    failed.clear();
    for d in &want {
        if watched.contains(d) || batch.add(d, RecursiveMode::NonRecursive).is_ok() { now.insert(d.clone()); } else { failed.insert(d.clone()); }
    }
    if let Err(e) = batch.commit() { eprintln!("rooms-core: updating the original-file watch failed: {e}"); }
    *failed_at = (!failed.is_empty()).then(Instant::now);
    *watched = now;
    true
}

/// How long the debouncer waits for a path to go quiet, and how often it checks. Rescans are
/// per path now, so this is most of a new file's latency.
const DEBOUNCE: Duration = Duration::from_millis(80);
const DEBOUNCE_TICK: Duration = Duration::from_millis(20);

/// Minimum gap between syncs of the original-file watch (each change restarts its stream).
const TARGET_SYNC_MIN_GAP: Duration = Duration::from_millis(250);

pub fn start_watching(core: RoomsCore) -> Result<WatchHandle, CoreError> {
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
    // Rescans run on their own worker, not on the watchers' threads: the callbacks only record
    // what changed, and everything recorded while a rescan runs is served by the next one.
    let pending = Arc::new(Mutex::new(Pending::default()));
    let (wwork, pending_w) = (core.downgrade(), pending.clone());
    let work = spawn_coalescer(Duration::ZERO, move || match wwork.upgrade() {
        Some(core) => {
            let work = std::mem::take(&mut *lock(&pending_w)); // released before the rescans
            run_pending(&core, work);
            true
        }
        None => false,
    });
    let (wcore_cb, pending_cb, work_cb, resync_cb) = (core.downgrade(), pending.clone(), work.clone(), resync.clone());
    let on_events = move |res: DebounceEventResult| {
        let Some(c2) = wcore_cb.upgrade() else { return };
        match res {
            // Overflow (events were dropped) or a watcher error: per-room rescans can't be trusted.
            Ok(events) if events.iter().any(|ev| ev.need_rescan()) => {
                eprintln!("rooms-core: watch_overflow: the watcher dropped events; resyncing everything");
                let _ = resync_cb.send(());
            }
            Err(errs) => {
                for e in errs { eprintln!("rooms-core: watcher error: {e}"); }
                let _ = resync_cb.send(());
            }
            Ok(events) => {
                // A plugin's code or manifest changed (its own data/ writes don't count): clients list again.
                if events.iter().flat_map(|ev| ev.paths.iter()).any(|p| is_plugin_code_path(&plugins_dir, p)) {
                    c2.plugins_changed();
                }
                let roots = c2.room_roots();
                let mut pending = lock(&pending_cb);
                for p in events.iter().flat_map(|ev| ev.paths.iter()) {
                    if !p.starts_with(&rooms_dir) {
                        note_change(&mut pending, &roots, &home, p);
                    } else if has_doc_ext(p) {
                        pending.targets.insert(p.clone()); // `.rooms` holds no room, but may hold an original
                    }
                }
                let _ = work_cb.send(());
            }
        }
    };
    // Adding or removing a watch restarts the FSEvents stream, and events in that gap are lost:
    // each change is followed by a coalesced rescan of everything (it emits only what changed).
    // The long gap bounds the cost when a linked root flaps or keeps failing to be watched.
    let wrescan = core.downgrade();
    let rescan = spawn_coalescer(WATCH_GAP_RESCAN_MIN_GAP, move || match wrescan.upgrade() {
        Some(core) => { core.rescan_all(); true }
        None => false,
    });
    let debouncer = new_debouncer_opt::<_, RecommendedWatcher, _>(DEBOUNCE, Some(DEBOUNCE_TICK), on_events, NoCache, notify::Config::default())
        .map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let deb = Arc::new(Mutex::new(debouncer));
    watch_dir(&deb, core.home()).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let watched = Arc::new(Mutex::new(HashSet::new()));
    let failed = Arc::new(Mutex::new(HashSet::new()));
    ensure_linked_watched(&core, &deb, &watched, &failed); // the startup backfill covers the gap

    // An edit to an original (or an editor's tmp + rename over it) refreshes its artifacts.
    // A folder event (created, removed, renamed) also re-syncs the watch, so the folders of
    // dangling links' originals are followed as they come back.
    let target_sync_cell: Arc<OnceLock<mpsc::Sender<()>>> = Arc::default();
    let (pending_t, work_t, resync_t, sync_t) = (pending.clone(), work.clone(), resync.clone(), target_sync_cell.clone());
    let target_watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
        Ok(ev) if ev.need_rescan() => { let _ = resync_t.send(()); }
        Ok(ev) => {
            let mut folder_changed = false;
            {
                let mut pending = lock(&pending_t);
                for p in ev.paths {
                    if has_doc_ext(&p) && !p.is_dir() {
                        pending.targets.insert(p);
                    } else {
                        pending.target_dirs.insert(p);
                        folder_changed = true;
                    }
                }
            }
            let _ = work_t.send(());
            if let (true, Some(sync)) = (folder_changed, sync_t.get()) { let _ = sync.send(()); }
        }
        Err(e) => eprintln!("rooms-core: original-file watcher error: {e}"),
    }).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let targets = Arc::new(Mutex::new(TargetWatch { watcher: target_watcher, watched: HashSet::new(), failed: HashSet::new(), failed_at: None }));
    let (wcore_ts, wtargets, pending_ts, work_ts) = (core.downgrade(), Arc::downgrade(&targets), pending.clone(), work.clone());
    let target_sync = spawn_coalescer(TARGET_SYNC_MIN_GAP, move || {
        let (Some(core), Some(tw)) = (wcore_ts.upgrade(), wtargets.upgrade()) else { return false };
        // Edits made while the stream restarted are lost: re-check every outside original.
        if sync_target_watch(&core, &tw) {
            lock(&pending_ts).targets.extend(core.outside_targets());
            let _ = work_ts.send(());
        }
        true
    });
    let _ = target_sync_cell.set(target_sync.clone());
    let _ = target_sync.send(()); // the index may already hold artifacts from the last run
    drop((pending, work));

    // Helper threads hold only weak references, so dropping the handle and every RoomsCore ends them.
    // (The debouncer callback holds a weak core too; its thread ends shortly after the Debouncer
    // is dropped, since Drop only signals stop.)
    let (wcore, wdeb) = (core.downgrade(), Arc::downgrade(&deb));
    let mut rx = core.subscribe();
    let (w3, f3) = (watched.clone(), failed.clone());
    let (wcore3, wdeb3) = (wcore.clone(), wdeb.clone());
    let rescan3 = rescan.clone();
    let (target_sync_tick, wtargets_tick) = (target_sync.clone(), Arc::downgrade(&targets));
    std::thread::spawn(move || loop {
        match rx.blocking_recv() {
            Ok(e) => {
                let room = match e.kind {
                    EventKind::RoomAdded { room } | EventKind::RoomUpdated { room } if room.kind == RoomKind::Linked => room,
                    // Artifacts (and so their originals) changed: the original-file watch may need to follow.
                    EventKind::ArtifactAdded { .. } | EventKind::ArtifactUpdated { .. } | EventKind::ArtifactRemoved { .. }
                    | EventKind::Resync { .. } => { let _ = target_sync.send(()); continue }
                    _ => continue,
                };
                let (Some(core), Some(deb)) = (wcore3.upgrade(), wdeb3.upgrade()) else { break };
                if room.status == RoomStatus::Unavailable {
                    let p = PathBuf::from(&room.path);
                    lock(&f3).remove(&p);
                    if lock(&w3).remove(&p) {
                        let _ = lock(&deb).unwatch(&p);
                        let _ = rescan3.send(());
                    }
                } else if ensure_linked_watched(&core, &deb, &w3, &f3) {
                    let _ = rescan3.send(());
                }
                // A linked root came or went: originals under it move in or out of the target watch.
                let _ = target_sync.send(());
            }
            Err(RecvError::Lagged(_)) => { let _ = target_sync.send(()); }
            Err(RecvError::Closed) => break,
        }
    });
    // Retry tick: re-check unavailable rooms (a returning root emits room.updated→ok, which re-watches above).
    std::thread::spawn(move || loop {
        std::thread::sleep(RETRY_INTERVAL);
        let (Some(core), Some(deb)) = (wcore.upgrade(), wdeb.upgrade()) else { break };
        core.rescan_unavailable();
        if ensure_linked_watched(&core, &deb, &watched, &failed) { let _ = rescan.send(()); }
        // Retries original folders that could not be watched (the sync itself waits out the backoff).
        if wtargets_tick.upgrade().is_some_and(|tw| !lock(&tw).failed.is_empty()) { let _ = target_sync_tick.send(()); }
    });
    Ok(WatchHandle { _debouncer: deb, _targets: targets })
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
