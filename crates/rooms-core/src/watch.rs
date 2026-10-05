use crate::{CoreError, RoomsCore};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use rooms_protocol::{EventKind, RoomKind};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

type Deb = Debouncer<notify::RecommendedWatcher, RecommendedCache>;

/// Dropping this stops watching.
pub struct WatchHandle {
    _debouncer: Arc<Mutex<Deb>>,
}

fn watch_dir(deb: &Mutex<Deb>, path: &Path) -> Result<(), notify::Error> {
    deb.lock().unwrap().watch(path, RecursiveMode::Recursive)
}

pub fn start_watching(core: RoomsCore) -> Result<WatchHandle, CoreError> {
    let c2 = core.clone();
    let debouncer = new_debouncer(Duration::from_millis(300), None, move |res: DebounceEventResult| {
        match res {
            Ok(events) => {
                let mut seen = std::collections::HashSet::new();
                for ev in events {
                    for p in &ev.paths {
                        if p.components().any(|c| c.as_os_str() == ".rooms") { continue; }
                        if seen.insert(p.clone()) { c2.apply_fs_change(p); }
                    }
                }
            }
            Err(errs) => {
                for e in errs { eprintln!("rooms-core: watcher error: {e}"); }
            }
        }
    }).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    let deb = Arc::new(Mutex::new(debouncer));
    watch_dir(&deb, core.home()).map_err(|e| CoreError::WriteFailed(e.to_string()))?;
    for r in core.list_rooms().into_iter().filter(|r| r.kind == RoomKind::Linked) {
        if let Err(e) = watch_dir(&deb, Path::new(&r.path)) {
            eprintln!("rooms-core: failed to watch linked room {}: {e}", r.path);
        }
    }
    // Pick up rooms linked later. Holds only a Weak so dropping the handle ends the thread.
    let weak = Arc::downgrade(&deb);
    let mut rx = core.subscribe();
    std::thread::spawn(move || loop {
        match rx.blocking_recv() {
            Ok(e) => {
                if let EventKind::RoomAdded { room } = e.kind {
                    if room.kind == RoomKind::Linked {
                        let Some(deb) = weak.upgrade() else { break };
                        if let Err(e) = watch_dir(&deb, Path::new(&room.path)) {
                            eprintln!("rooms-core: failed to watch linked room {}: {e}", room.path);
                        }
                    }
                }
            }
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => break,
        }
        if weak.strong_count() == 0 { break; }
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
