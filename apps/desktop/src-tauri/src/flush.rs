//! Close/quit handshake with the webview.
//!
//! Closing the window (red button, ⇧⌘W) or quitting from the menu (⌘Q) is
//! held while the webview flushes unsaved notes:
//!
//! 1. Rust prevents the close and emits `app://flush`.
//! 2. The webview flushes (capped at 2 s) and invokes `flush_done`.
//! 3. Rust then closes the window or exits.
//!
//! If the webview does not answer within [`FLUSH_TIMEOUT`], Rust goes ahead
//! anyway. [`FlushGate`] is the pure state of that handshake.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// How long Rust waits for `flush_done` before closing anyway.
pub const FLUSH_TIMEOUT: Duration = Duration::from_millis(2500);
pub const FLUSH_EVENT: &str = "app://flush";
pub const MAIN_WINDOW: &str = "main";

/// What to do once the webview has flushed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    CloseWindow,
    Exit,
}

impl Intent {
    /// Exit wins: quitting while a close is pending must still quit.
    fn merge(self, other: Intent) -> Intent {
        if self == Intent::Exit || other == Intent::Exit {
            Intent::Exit
        } else {
            Intent::CloseWindow
        }
    }
}

/// At most one flush round is pending; each round has a token so a stale timeout can't fire.
#[derive(Debug, Default)]
pub struct FlushGate {
    pending: Option<(u64, Intent)>,
    next: u64,
}

impl FlushGate {
    /// Asks to close or exit. Returns the new round's token when a round must start
    /// (emit the event and arm the timeout); `None` when one is already pending, in
    /// which case the intent is merged into it.
    pub fn request(&mut self, intent: Intent) -> Option<u64> {
        if let Some((token, pending)) = self.pending {
            self.pending = Some((token, pending.merge(intent)));
            return None;
        }
        self.next += 1;
        self.pending = Some((self.next, intent));
        Some(self.next)
    }

    /// The webview answered: ends the pending round, if any.
    pub fn done(&mut self) -> Option<Intent> {
        self.pending.take().map(|(_, intent)| intent)
    }

    /// The timeout of round `token` fired: ends it only if it is still the pending round.
    pub fn timeout(&mut self, token: u64) -> Option<Intent> {
        match self.pending {
            Some((t, intent)) if t == token => {
                self.pending = None;
                Some(intent)
            }
            _ => None,
        }
    }
}

/// Managed state wrapper.
#[derive(Default)]
pub struct Flush(Mutex<FlushGate>);

fn perform(app: &AppHandle, intent: Intent) {
    match intent {
        Intent::CloseWindow => match app.get_webview_window(MAIN_WINDOW) {
            // destroy() skips CloseRequested, so this doesn't loop back into the gate.
            Some(w) => {
                if let Err(e) = w.destroy() {
                    eprintln!("could not close the window: {e}");
                    app.exit(0);
                }
            }
            None => app.exit(0),
        },
        Intent::Exit => app.exit(0),
    }
}

/// Starts (or joins) a flush round for `intent`.
pub fn request(app: &AppHandle, intent: Intent) {
    let token = {
        let state = app.state::<Flush>();
        let mut gate = state.0.lock().unwrap_or_else(|p| p.into_inner());
        gate.request(intent)
    };
    let Some(token) = token else { return };
    if let Err(e) = app.emit(FLUSH_EVENT, ()) {
        eprintln!("could not ask the webview to flush: {e}");
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FLUSH_TIMEOUT).await;
        let intent = {
            let state = handle.state::<Flush>();
            let mut gate = state.0.lock().unwrap_or_else(|p| p.into_inner());
            gate.timeout(token)
        };
        if let Some(intent) = intent {
            eprintln!("webview did not finish flushing in time; closing anyway");
            perform(&handle, intent);
        }
    });
}

/// The webview has flushed its notes.
#[tauri::command]
pub fn flush_done(app: AppHandle) {
    let intent = {
        let state = app.state::<Flush>();
        let mut gate = state.0.lock().unwrap_or_else(|p| p.into_inner());
        gate.done()
    };
    if let Some(intent) = intent {
        perform(&app, intent);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_starts_a_round_and_done_ends_it() {
        let mut g = FlushGate::default();
        let t = g.request(Intent::CloseWindow);
        assert!(t.is_some());
        assert_eq!(g.done(), Some(Intent::CloseWindow));
        // Nothing pending any more: a late timeout or a second answer does nothing.
        assert_eq!(g.timeout(t.unwrap()), None);
        assert_eq!(g.done(), None);
    }

    #[test]
    fn requests_while_pending_join_the_round_and_exit_wins() {
        let mut g = FlushGate::default();
        let t = g.request(Intent::CloseWindow).unwrap();
        assert_eq!(g.request(Intent::CloseWindow), None);
        assert_eq!(g.request(Intent::Exit), None);
        assert_eq!(g.request(Intent::CloseWindow), None); // never downgraded
        assert_eq!(g.timeout(t), Some(Intent::Exit));
    }

    #[test]
    fn timeout_closes_when_the_webview_never_answers() {
        let mut g = FlushGate::default();
        let t = g.request(Intent::Exit).unwrap();
        assert_eq!(g.timeout(t), Some(Intent::Exit));
        assert_eq!(g.done(), None);
    }

    #[test]
    fn a_stale_timeout_does_not_end_a_newer_round() {
        let mut g = FlushGate::default();
        let first = g.request(Intent::CloseWindow).unwrap();
        assert_eq!(g.done(), Some(Intent::CloseWindow));
        let second = g.request(Intent::Exit).unwrap();
        assert_ne!(first, second);
        assert_eq!(g.timeout(first), None);
        assert_eq!(g.timeout(second), Some(Intent::Exit));
    }

    #[test]
    fn timeout_is_longer_than_the_webview_cap() {
        // The webview gives notes 2 s; Rust must wait longer than that before giving up.
        assert!(FLUSH_TIMEOUT > Duration::from_secs(2));
        assert_eq!(FLUSH_TIMEOUT, Duration::from_millis(2500));
    }
}
