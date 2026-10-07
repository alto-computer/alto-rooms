//! `RoomsCore`: the shared state behind one Rooms home, and the event stream.
//!
//! The operations live in sibling modules, each an `impl RoomsCore` block: `rooms` (the room
//! list), `home_sync` (folders changed in Finder), `scan` (keeping the index in step with disk),
//! `artifacts`, `journal` and `plugins`.

use crate::dangling::DanglingLinks;
use crate::error::CoreError;
use crate::home_sync::{list_home_dirs, reconcile_home_dirs, HomeChange};
use crate::index::{Change, Index};
use crate::lock::lock;
use crate::state::{inode_of, RoomRecord, StateStore};
use rooms_protocol::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::broadcast;

pub(crate) struct Inner {
    pub(crate) home: PathBuf,
    pub(crate) state: StateStore,
    pub(crate) index: Index,
    /// Rooms whose root was missing/unreadable at the last rescan (drives one room.updated per transition).
    pub(crate) unavailable: HashSet<RoomId>,
    pub(crate) dangling: DanglingLinks,
}

#[derive(Clone)]
pub struct RoomsCore {
    pub(crate) inner: Arc<Mutex<Inner>>,
    /// Last emitted event seq. Incremented only inside `emit` (which runs under `Inner`), so send
    /// order matches seq order; read lock-free by `current_seq`.
    pub(crate) seq: Arc<AtomicU64>,
    /// One mutex per room serializing its rescans. Lock order: room scan lock → `Inner`
    /// (never take a scan lock while holding `Inner`). The map lock itself is only held briefly.
    pub(crate) scan_locks: Arc<Mutex<HashMap<RoomId, Arc<Mutex<()>>>>>,
    /// Serializes `save_note` (tmp write → rename → emit) so NoteSaved order equals file order.
    /// Lock order: notes_lock → `Inner`.
    pub(crate) notes_lock: Arc<Mutex<()>>,
    pub(crate) tx: broadcast::Sender<RoomsEvent>,
    pub(crate) home: PathBuf,
}

/// Non-owning handle to a `RoomsCore`: lets helper threads observe the core without keeping it
/// (or the event channel) alive.
#[derive(Clone)]
pub struct WeakRoomsCore {
    inner: Weak<Mutex<Inner>>,
    seq: Arc<AtomicU64>,
    scan_locks: Arc<Mutex<HashMap<RoomId, Arc<Mutex<()>>>>>,
    notes_lock: Arc<Mutex<()>>,
    tx: broadcast::WeakSender<RoomsEvent>,
    home: PathBuf,
}

impl WeakRoomsCore {
    /// `None` once the core (its `Inner` or its event sender) has been dropped.
    pub fn upgrade(&self) -> Option<RoomsCore> {
        let inner = self.inner.upgrade()?;
        let tx = self.tx.upgrade()?;
        Some(RoomsCore {
            inner,
            seq: self.seq.clone(),
            scan_locks: self.scan_locks.clone(),
            notes_lock: self.notes_lock.clone(),
            tx,
            home: self.home.clone(),
        })
    }
}

/// Capacity of the event channel: a subscriber further behind than this lags and must resync.
const EVENT_BUFFER: usize = 1024;

/// Above this many changes in one batch, `emit_changes` sends per-room resyncs instead of one
/// event per change, keeping well inside `EVENT_BUFFER`.
const MAX_CHANGE_EVENTS: usize = 256;

impl RoomsCore {
    pub fn open(home: &Path) -> Result<Self, CoreError> {
        std::fs::create_dir_all(home)?;
        let home = std::fs::canonicalize(home)?;
        let dot = home.join(".rooms");
        let inbox = home.join("inbox");
        std::fs::create_dir_all(home.join("journal"))?;
        std::fs::create_dir_all(&inbox)?;
        let mut state = StateStore::load(&dot)?;
        // ensure inbox record; journal is implicit (constant id)
        if !state.rooms.iter().any(|r| r.kind == RoomKind::Owned && r.path == inbox) {
            let (dev, ino) = inode_of(&inbox).unzip();
            state.rooms.insert(0, RoomRecord { id: INBOX_ROOM_ID.into(), name: "inbox".into(), kind: RoomKind::Owned, path: inbox, dev, ino });
            state.save()?;
        }
        // adopt / follow / drop owned folders changed in Finder while we were not running
        let home_changes = reconcile_home_dirs(&home, list_home_dirs(&home), &mut state);
        state.save()?;
        let mut index = Index::open(&dot.join("index.sqlite"))?;
        for c in &home_changes {
            if let HomeChange::Removed(id) = c { index.drop_room(id)?; }
        }
        let _ = index.take_touched_days();
        if let Err(e) = crate::onboarding::ensure(&home) { eprintln!("rooms-core: onboarding files not written: {e}"); }
        let (tx, _) = broadcast::channel(EVENT_BUFFER);
        Ok(RoomsCore {
            inner: Arc::new(Mutex::new(Inner { home: home.clone(), state, index, unavailable: HashSet::new(), dangling: DanglingLinks::default() })),
            seq: Arc::new(AtomicU64::new(0)),
            scan_locks: Arc::new(Mutex::new(HashMap::new())),
            notes_lock: Arc::new(Mutex::new(())),
            tx,
            home,
        })
    }

    pub fn home(&self) -> &Path { &self.home }

    pub fn downgrade(&self) -> WeakRoomsCore {
        WeakRoomsCore {
            inner: Arc::downgrade(&self.inner),
            seq: self.seq.clone(),
            scan_locks: self.scan_locks.clone(),
            notes_lock: self.notes_lock.clone(),
            tx: self.tx.downgrade(),
            home: self.home.clone(),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RoomsEvent> { self.tx.subscribe() }

    pub fn current_seq(&self) -> u64 { self.seq.load(Ordering::SeqCst) }

    /// `ask.started` / `ask.done` from `asks::Asks`: same seq and broadcast as every other event.
    pub fn emit_ask(&self, kind: EventKind) {
        debug_assert!(matches!(kind, EventKind::AskStarted { .. } | EventKind::AskDone { .. }));
        let mut inner = lock(&self.inner);
        self.emit(&mut inner, kind);
    }

    /// Must be called with `Inner` held (the `&mut Inner` proves it): that keeps the increment and
    /// the send of concurrent emitters ordered, so receivers see strictly increasing seqs.
    pub(crate) fn emit(&self, _inner: &mut Inner, kind: EventKind) {
        let s = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send(RoomsEvent { seq: s, kind });
    }

    pub(crate) fn emit_changes(&self, inner: &mut Inner, changes: Vec<Change>) {
        if changes.len() > MAX_CHANGE_EVENTS {
            self.emit_room_resyncs(inner, &changes);
        } else {
            self.emit_each_change(inner, changes);
        }
        // Stored created_day (old and new on a move, plus removed rows' days), not a recomputation.
        for date in inner.index.take_touched_days() { self.emit(inner, EventKind::JournalChanged { date }); }
    }

    /// A big batch as `resync {room}` (refetch that room) plus `room.updated` (its new count) per
    /// room: one event per change would overflow subscribers' buffers, and every lagging client
    /// would then refetch everything.
    fn emit_room_resyncs(&self, inner: &mut Inner, changes: &[Change]) {
        let rooms: std::collections::BTreeSet<RoomId> = changes.iter().map(|c| match c {
            Change::Added(a) | Change::Updated(a) => a.room_id.clone(),
            Change::Removed { room_id, .. } => room_id.clone(),
        }).collect();
        for room in rooms {
            self.emit(inner, EventKind::Resync { room_id: Some(room.clone()) });
            self.emit_room_updated(inner, &room);
        }
    }

    fn emit_each_change(&self, inner: &mut Inner, changes: Vec<Change>) {
        for c in changes {
            let kind = match c {
                Change::Added(a) => EventKind::ArtifactAdded { artifact: a },
                Change::Updated(a) => EventKind::ArtifactUpdated { artifact: a },
                Change::Removed { room_id, artifact_id } => EventKind::ArtifactRemoved { room_id, artifact_id },
            };
            self.emit(inner, kind);
        }
    }

    pub(crate) fn emit_room_updated(&self, inner: &mut Inner, room: &RoomId) {
        if let Some(rec) = inner.state.find(room).cloned() {
            let room_v = Self::to_room(inner, &rec);
            self.emit(inner, EventKind::RoomUpdated { room: room_v });
        }
    }

    pub(crate) fn to_room(inner: &Inner, r: &RoomRecord) -> Room {
        let (count, updated_at) = inner.index.room_summary(&r.id).unwrap_or((0, None));
        Room {
            id: r.id.clone(),
            name: r.name.clone(),
            kind: r.kind,
            path: r.path.to_string_lossy().to_string(),
            // No stat under `Inner`: rescans (watcher, retry tick, rescan_unavailable) keep `unavailable` current.
            status: if inner.unavailable.contains(&r.id) { RoomStatus::Unavailable } else { RoomStatus::Ok },
            artifact_count: count,
            updated_at,
        }
    }
}
