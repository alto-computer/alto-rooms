//! The rooms-collect sidecar: started once roomsd answers (it needs the Home roomsd serves),
//! restarted when it dies (at most 5 starts in 10 minutes), stopped when the app exits. It
//! also exits on its own when this app's process goes away, so it only runs while the app does.
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_STARTS: usize = 5;
const START_WINDOW: Duration = Duration::from_secs(10 * 60);
const RESTART_DELAY: Duration = Duration::from_secs(2);

/// Managed state.
#[derive(Default)]
pub struct Collector {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    child: Option<CommandChild>,
    home: Option<String>,
    starts: VecDeque<Instant>,
    /// Set on app exit: nothing may start after this.
    closed: bool,
}

impl Collector {
    /// Starts the collector for `home` unless it already runs for it. Idempotent.
    pub fn ensure(&self, app: &AppHandle, home: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.closed || (inner.child.is_some() && inner.home.as_deref() == Some(home)) {
            return;
        }
        if let Some(old) = inner.child.take() {
            let _ = old.kill();
        }
        inner.home = Some(home.to_string());
        inner.starts.clear();
        spawn(app, &mut inner);
    }

    /// Stops the collector (app exit). It commits each step in a transaction, so a kill loses nothing.
    pub fn kill(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.closed = true;
        if let Some(child) = inner.child.take() {
            let _ = child.kill();
        }
    }
}

/// True when another start fits in the restart budget (and records it).
fn allow_start(starts: &mut VecDeque<Instant>, now: Instant) -> bool {
    while starts.front().is_some_and(|t| now.duration_since(*t) > START_WINDOW) {
        starts.pop_front();
    }
    if starts.len() >= MAX_STARTS {
        return false;
    }
    starts.push_back(now);
    true
}

fn spawn(app: &AppHandle, inner: &mut Inner) {
    let Some(home) = inner.home.clone() else { return };
    if !allow_start(&mut inner.starts, Instant::now()) {
        eprintln!("rooms-collect: exited {MAX_STARTS} times in {START_WINDOW:?}; not restarting until the app restarts");
        return;
    }
    let mut cmd = match app.shell().sidecar("rooms-collect") {
        Ok(c) => c.env("ROOMS_HOME", &home),
        Err(e) => {
            eprintln!("rooms-collect: not bundled: {e}");
            return;
        }
    };
    if let Ok(dir) = app.path().app_data_dir() {
        cmd = cmd.env("ROOMS_COLLECT_DATA", dir);
    }
    let (mut rx, child) = match cmd.spawn() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("rooms-collect: could not start: {e}");
            return;
        }
    };
    let pid = child.pid();
    inner.child = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stderr(line) | CommandEvent::Stdout(line) => {
                    eprintln!("{}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(p) => {
                    eprintln!("rooms-collect exited (code {:?}, signal {:?})", p.code, p.signal);
                    tokio::time::sleep(RESTART_DELAY).await;
                    let state = handle.state::<Collector>();
                    let mut inner = state.inner.lock().unwrap_or_else(|p| p.into_inner());
                    // Only the child this task watches is restarted (not one replaced or killed on purpose).
                    if inner.child.as_ref().map(|c| c.pid()) == Some(pid) {
                        inner.child = None;
                        if !inner.closed {
                            spawn(&handle, &mut inner);
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_are_capped_per_window() {
        let mut s = VecDeque::new();
        let t0 = Instant::now();
        for i in 0..MAX_STARTS {
            assert!(allow_start(&mut s, t0 + Duration::from_secs(i as u64)));
        }
        assert!(!allow_start(&mut s, t0 + Duration::from_secs(60)));
        assert!(allow_start(&mut s, t0 + START_WINDOW + Duration::from_secs(1)), "the oldest start left the window");
    }
}
