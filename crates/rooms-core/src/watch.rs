use crate::{CoreError, RoomsCore};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use rooms_protocol::{EventKind, RoomKind, RoomStatus};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

type Deb = Debouncer<notify::RecommendedWatcher, RecommendedCache>;

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
fn ensure_linked_watched(core: &RoomsCore, deb: &Mutex<Deb>, watched: &Mutex<HashSet<PathBuf>>, failed: &Mutex<HashSet<PathBuf>>) {
    for r in core.list_rooms().into_iter().filter(|r| r.kind == RoomKind::Linked && r.status == RoomStatus::Ok) {
        let p = PathBuf::from(&r.path);
        if watched.lock().unwrap().contains(&p) { continue; }
        match watch_dir(deb, &p) {
            Ok(()) => {
                failed.lock().unwrap().remove(&p);
                watched.lock().unwrap().insert(p);
            }
            Err(e) => {
                if failed.lock().unwrap().insert(p) {
                    eprintln!("rooms-core: failed to watch linked room {}: {e}", r.path);
                }
            }
        }
    }
}

pub fn start_watching(core: RoomsCore) -> Result<WatchHandle, CoreError> {
    let c2 = core.clone();
    let rooms_dir = core.home().join(".rooms");
    let home = core.home().to_path_buf();
    let debouncer = new_debouncer(Duration::from_millis(300), None, move |res: DebounceEventResult| {
        match res {
            // Overflow (events were dropped) or a watcher error: per-room rescans can't be trusted.
            Ok(events) if events.iter().any(|ev| ev.need_rescan()) => c2.resync_all(),
            Err(errs) => {
                for e in errs { eprintln!("rooms-core: watcher error: {e}"); }
                c2.resync_all();
            }
            Ok(events) => {
                let paths: Vec<PathBuf> = events.iter().flat_map(|ev| ev.paths.iter())
                    .filter(|p| !p.starts_with(&rooms_dir)).cloned().collect();
                // A direct child of home (or a path no room owns yet) may be a folder created,
                // renamed or deleted in Finder: reconcile owned rooms first (emits room.* events).
                let mut rooms = HashSet::new();
                if paths.iter().any(|p| p.parent() == Some(home.as_path()) || c2.room_for_path(p).is_none()) {
                    rooms.extend(c2.sync_home_dirs());
                }
                for p in &paths {
                    if let Some(id) = c2.room_for_path(p) { rooms.insert(id); }
                }
                for id in rooms { c2.rescan_room(&id); }
            }
        }
    }).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let deb = Arc::new(Mutex::new(debouncer));
    watch_dir(&deb, core.home()).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let watched = Arc::new(Mutex::new(HashSet::new()));
    let failed = Arc::new(Mutex::new(HashSet::new()));
    ensure_linked_watched(&core, &deb, &watched, &failed);
    // Helper threads hold only weak references, so dropping the handle and every RoomsCore ends them.
    // (The debouncer callback owns a strong core; the debouncer's own thread drops it shortly after
    // the Debouncer is dropped, since Drop only signals stop.)
    let (wcore, wdeb) = (core.downgrade(), Arc::downgrade(&deb));
    let mut rx = core.subscribe();
    let (w3, f3) = (watched.clone(), failed.clone());
    let (wcore3, wdeb3) = (wcore.clone(), wdeb.clone());
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
                    if w3.lock().unwrap().remove(&p) { let _ = deb.lock().unwrap().unwatch(&p); }
                } else {
                    ensure_linked_watched(&core, &deb, &w3, &f3);
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
        ensure_linked_watched(&core, &deb, &watched, &failed);
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
