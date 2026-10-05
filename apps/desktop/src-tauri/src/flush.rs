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
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Intent {
    CloseWindow,
    /// Our own exit (menu Quit, or an exit request we held).
    Exit,
    /// AppKit asked `applicationShouldTerminate:` (Dock, Apple Event, logout) and is
    /// waiting for `replyToApplicationShouldTerminate:`.
    Terminate,
}

impl Intent {
    /// The stronger intent wins: Terminate > Exit > CloseWindow. Quitting while a
    /// close is pending still quits, and a pending AppKit terminate always gets its reply.
    fn merge(self, other: Intent) -> Intent {
        self.max(other)
    }
}

/// The answer to `applicationShouldTerminate:`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminateReply {
    /// NSTerminateNow: a flush round has completed; let AppKit quit.
    Now,
    /// NSTerminateLater: flush first, then reply.
    Later,
}

/// Pure decision for `applicationShouldTerminate:`.
pub fn terminate_reply(gate: &FlushGate) -> TerminateReply {
    if gate.completed {
        TerminateReply::Now
    } else {
        TerminateReply::Later
    }
}

/// At most one flush round is pending; each round has a token so a stale timeout can't fire.
#[derive(Debug, Default)]
pub struct FlushGate {
    pending: Option<(u64, Intent)>,
    next: u64,
    /// A round has ended (answered or timed out): the app is on its way out.
    completed: bool,
}

/// Whether an exit request must be held and routed through a flush round.
/// `code` is `None` for a quit the user or the system asked for; `Some` is our
/// own `app.exit(n)`, which always goes through. Once a round has completed, the
/// exit that follows (window destroyed, or `app.exit`) goes through too.
pub fn should_intercept_exit(code: Option<i32>, gate: &FlushGate) -> bool {
    code.is_none() && !gate.completed
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
        let intent = self.pending.take().map(|(_, intent)| intent);
        self.completed |= intent.is_some();
        intent
    }

    /// The timeout of round `token` fired: ends it only if it is still the pending round.
    pub fn timeout(&mut self, token: u64) -> Option<Intent> {
        match self.pending {
            Some((t, intent)) if t == token => {
                self.pending = None;
                self.completed = true;
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
        Intent::Terminate => {
            #[cfg(target_os = "macos")]
            crate::terminate::reply(app);
            #[cfg(not(target_os = "macos"))]
            app.exit(0);
        }
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
    eprintln!("flush: round {token} ({intent:?}): emitting {FLUSH_EVENT}");
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
        eprintln!("flush: flush_done received; {intent:?}");
        perform(&app, intent);
    }
}

/// `applicationShouldTerminate:` (macOS): answers now after a completed round,
/// otherwise starts (or joins) a Terminate round and answers later.
pub fn on_should_terminate(app: &AppHandle) -> TerminateReply {
    let reply = {
        let state = app.state::<Flush>();
        let gate = state.0.lock().unwrap_or_else(|p| p.into_inner());
        terminate_reply(&gate)
    };
    if reply == TerminateReply::Later {
        eprintln!("flush: applicationShouldTerminate; flushing first");
        request(app, Intent::Terminate);
    }
    reply
}

/// `RunEvent::ExitRequested`: holds a user/system quit until a flush round has run.
/// Returns true when the exit was intercepted (the caller must prevent it).
pub fn intercept_exit(app: &AppHandle, code: Option<i32>) -> bool {
    let intercept = {
        let state = app.state::<Flush>();
        let gate = state.0.lock().unwrap_or_else(|p| p.into_inner());
        should_intercept_exit(code, &gate)
    };
    if intercept {
        eprintln!("flush: exit requested (code {code:?}); flushing first");
        request(app, Intent::Exit);
    }
    intercept
}

/// Verification hook for the quit flush (cargo feature `flush-probe`), inert unless `ALTO_ROOMS_FLUSH_PROBE` is set
/// (`<YYYY-MM-DD>/<note file>`): the webview then makes that note dirty with a saver
/// that never saves on its own, so its text can only reach disk through a quit flush.
#[cfg(feature = "flush-probe")]
pub const FLUSH_PROBE_ENV: &str = "ALTO_ROOMS_FLUSH_PROBE";

#[cfg(feature = "flush-probe")]
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct FlushProbe {
    pub date: String,
    pub name: String,
}

#[cfg(feature = "flush-probe")]
/// Parses `<YYYY-MM-DD>/<name>.md`; anything else disables the probe.
pub fn parse_flush_probe(raw: &str) -> Option<FlushProbe> {
    let (date, name) = raw.trim().split_once('/')?;
    let date_ok = date.len() == 10 && date.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    let name_ok = name.ends_with(".md") && name.len() > 3 && !name.contains('/');
    (date_ok && name_ok).then(|| FlushProbe { date: date.to_string(), name: name.to_string() })
}

#[cfg(feature = "flush-probe")]
#[tauri::command]
pub fn flush_probe() -> Option<FlushProbe> {
    parse_flush_probe(&std::env::var(FLUSH_PROBE_ENV).ok()?)
}

#[cfg(feature = "flush-probe")]
#[tauri::command]
pub fn flush_probe_armed() {
    eprintln!("flush probe: note is dirty; only a quit flush can save it");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "flush-probe")]
    #[test]
    fn flush_probe_accepts_only_date_slash_note() {
        assert_eq!(
            parse_flush_probe("2026-10-05/probe.md"),
            Some(FlushProbe { date: "2026-10-05".into(), name: "probe.md".into() })
        );
        assert_eq!(parse_flush_probe(""), None);
        assert_eq!(parse_flush_probe("2026-10-05/probe"), None);
        assert_eq!(parse_flush_probe("2026-1-05/probe.md"), None);
        assert_eq!(parse_flush_probe("2026-10-05/a/b.md"), None);
        assert_eq!(parse_flush_probe("2026-10-05/.md"), None);
    }

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
    fn exit_requests_are_held_until_a_flush_round_completes() {
        let mut g = FlushGate::default();
        // A user/system quit request (no code) before any flush: hold it.
        assert!(should_intercept_exit(None, &g));
        // Our own app.exit(n) always goes through.
        assert!(!should_intercept_exit(Some(0), &g));
        // Still held while a round is pending (the request joins it).
        let t = g.request(Intent::CloseWindow).unwrap();
        assert!(should_intercept_exit(None, &g));
        // Once the round has completed (answer or timeout), the exit that follows passes.
        assert_eq!(g.done(), Some(Intent::CloseWindow));
        assert!(!should_intercept_exit(None, &g));
        assert_eq!(g.timeout(t), None);
        assert!(!should_intercept_exit(None, &g));
    }

    #[test]
    fn a_timed_out_round_also_lets_the_exit_through() {
        let mut g = FlushGate::default();
        let t = g.request(Intent::Exit).unwrap();
        assert_eq!(g.timeout(t), Some(Intent::Exit));
        assert!(!should_intercept_exit(None, &g));
    }

    #[test]
    fn terminate_is_answered_later_until_a_round_completes() {
        let mut g = FlushGate::default();
        // Dock / Apple Event / logout quit: answer NSTerminateLater and flush first.
        assert_eq!(terminate_reply(&g), TerminateReply::Later);
        let t = g.request(Intent::Terminate).unwrap();
        assert_eq!(terminate_reply(&g), TerminateReply::Later);
        assert_eq!(g.timeout(t), Some(Intent::Terminate));
        // After a completed round (e.g. our own exit calling terminate:), quit now.
        assert_eq!(terminate_reply(&g), TerminateReply::Now);
    }

    #[test]
    fn terminate_wins_every_merge_so_appkit_always_gets_its_reply() {
        let mut g = FlushGate::default();
        g.request(Intent::CloseWindow).unwrap();
        assert_eq!(g.request(Intent::Terminate), None);
        assert_eq!(g.request(Intent::Exit), None);
        assert_eq!(g.request(Intent::CloseWindow), None);
        assert_eq!(g.done(), Some(Intent::Terminate));

        let mut g = FlushGate::default();
        g.request(Intent::Exit).unwrap();
        assert_eq!(g.request(Intent::Terminate), None);
        assert_eq!(g.done(), Some(Intent::Terminate));
    }

    #[test]
    fn timeout_is_longer_than_the_webview_cap() {
        // The webview gives notes 2 s; Rust must wait longer than that before giving up.
        assert!(FLUSH_TIMEOUT > Duration::from_secs(2));
        assert_eq!(FLUSH_TIMEOUT, Duration::from_millis(2500));
    }
}
