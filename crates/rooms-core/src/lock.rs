//! One lock-poisoning policy for every mutex in the crate.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks `m`, carrying on if a thread panicked while holding it. roomsd answers a panicked
/// handler with a 500 and keeps serving; with `unwrap` here, one panic under a lock would make
/// every later call that takes it panic too. What the locks guard stays usable after an
/// interrupted update: the index and state.json are written transactionally / by rename, and the
/// next rescan reconciles the in-memory rest with disk.
pub(crate) fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}
