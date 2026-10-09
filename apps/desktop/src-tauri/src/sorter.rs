//! The rooms-sort sidecar (spec rooms-sort §8): once roomsd answers, `rooms-sort run` every
//! minute (and right after a key is saved), one run at a time. The TypeSafe key comes from
//! `TYPESAFE_API_KEY` in this app's environment, else the Keychain, and reaches the sidecar as
//! that same variable; rooms-sort itself never touches the Keychain. Without a key the runs
//! still apply R1 and R2. After TypeSafe refuses a key (exit 3), runs go on without it until
//! the key changes.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Notify;

pub const KEY_ENV: &str = "TYPESAFE_API_KEY";
const INTERVAL: Duration = Duration::from_secs(60);
/// rooms-sort's exit code when TypeSafe refuses the key.
const KEY_REJECTED: i32 = 3;

#[derive(Default)]
pub struct Sorter {
    inner: Mutex<Inner>,
    kick: Arc<Notify>,
}

#[derive(Default)]
struct Inner {
    /// (Rooms home, roomsd API port) once roomsd answers.
    target: Option<(String, u16)>,
    started: bool,
    closed: bool,
    running: bool,
    /// The key TypeSafe last refused; not sent again until it changes.
    rejected: Option<String>,
}

fn lock(s: &Sorter) -> std::sync::MutexGuard<'_, Inner> { s.inner.lock().unwrap_or_else(|p| p.into_inner()) }

impl Sorter {
    /// Starts the minute loop for `home` (idempotent; a new home replaces the old one).
    pub fn ensure(&self, app: &AppHandle, home: &str, base_url: &str) {
        let port = base_url.rsplit(':').next().and_then(|p| p.trim_end_matches('/').parse().ok()).unwrap_or(4317);
        let mut inner = lock(self);
        if inner.closed { return; }
        inner.target = Some((home.to_string(), port));
        if inner.started { return; }
        inner.started = true;
        let (app, kick) = (app.clone(), self.kick.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                if lock(&app.state::<Sorter>()).closed { break; }
                run_once(&app).await;
                let _ = tokio::time::timeout(INTERVAL, kick.notified()).await;
            }
        });
    }

    /// Run again now (after a key is saved).
    pub fn kick(&self) { self.kick.notify_one(); }

    pub fn close(&self) { lock(self).closed = true; }
}

/// Where the key comes from: `env` wins over `keychain` (as in Zed).
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum KeySource { None, Env, Keychain }

fn env_key() -> Option<String> { std::env::var(KEY_ENV).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) }

pub fn current_key() -> (KeySource, Option<String>) {
    if let Some(k) = env_key() { return (KeySource::Env, Some(k)); }
    match keychain::read() { Some(k) => (KeySource::Keychain, Some(k)), None => (KeySource::None, None) }
}

fn sidecar(app: &AppHandle, home: &str, port: u16, key: Option<&str>) -> Result<tauri_plugin_shell::process::Command, String> {
    let mut cmd = app.shell().sidecar("rooms-sort").map_err(|e| format!("rooms-sort is not bundled: {e}"))?
        .env("ROOMS_HOME", home).env("ROOMS_API_PORT", port.to_string())
        // Always set, so a refused key in this app's own environment is not inherited (empty = no key).
        .env(KEY_ENV, key.unwrap_or(""));
    if let Ok(dir) = app.path().app_data_dir() { cmd = cmd.env("ROOMS_SORT_DATA", dir); }
    Ok(cmd)
}

async fn run_once(app: &AppHandle) {
    let state = app.state::<Sorter>();
    let (home, port, key) = {
        let mut inner = lock(&state);
        let Some((home, port)) = inner.target.clone() else { return };
        if inner.running { return; }
        inner.running = true;
        let key = current_key().1.filter(|k| inner.rejected.as_ref() != Some(k));
        (home, port, key)
    };
    let out = match sidecar(app, &home, port, key.as_deref()) {
        Ok(cmd) => cmd.args(["run"]).output().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    let mut inner = lock(&state);
    inner.running = false;
    match out {
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            if !err.trim().is_empty() { eprintln!("{}", err.trim_end()); }
            if o.status.code() == Some(KEY_REJECTED) { inner.rejected = key; }
        }
        Err(e) => eprintln!("rooms-sort: {e}"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortState {
    key_source: KeySource,
    /// TypeSafe refused the key in use; runs go on without it.
    key_rejected: bool,
    /// `<data>/sort-status.json` as rooms-sort last wrote it.
    status: Option<serde_json::Value>,
}

#[tauri::command]
pub fn sort_state(app: AppHandle, sorter: State<'_, Sorter>) -> SortState {
    let (source, key) = current_key();
    let rejected = key.is_some() && lock(&sorter).rejected == key;
    let status = app.path().app_data_dir().ok()
        .and_then(|d| std::fs::read(d.join("sort-status.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    SortState { key_source: source, key_rejected: rejected, status }
}

/// Checks the key with TypeSafe (through `rooms-sort check-key`), then keeps it in the Keychain
/// and runs right away. A refused key is not saved.
#[tauri::command]
pub async fn sort_set_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() { return Err("Paste a key first.".into()); }
    let (home, port) = lock(&app.state::<Sorter>()).target.clone().ok_or("Rooms is still starting. Try again in a moment.")?;
    let o = sidecar(&app, &home, port, Some(&key))?.args(["check-key"]).output().await.map_err(|e| e.to_string())?;
    match o.status.code() {
        Some(0) => {}
        Some(KEY_REJECTED) => return Err("TypeSafe didn't accept this key. Copy it again from the console.".into()),
        _ => return Err(format!("Couldn't reach TypeSafe: {}", String::from_utf8_lossy(&o.stderr).trim().trim_start_matches("rooms-sort: "))),
    }
    keychain::write(&key)?;
    let sorter = app.state::<Sorter>();
    lock(&sorter).rejected = None;
    sorter.kick();
    Ok(())
}

#[tauri::command]
pub fn sort_clear_key() -> Result<(), String> { keychain::delete() }

/// `rooms-sort undo`: the last run's documents go back to the inbox. Returns its report lines.
#[tauri::command]
pub async fn sort_undo_last(app: AppHandle) -> Result<Vec<String>, String> {
    let (home, port) = lock(&app.state::<Sorter>()).target.clone().ok_or("Rooms is still starting.")?;
    let o = sidecar(&app, &home, port, None)?.args(["undo"]).output().await.map_err(|e| e.to_string())?;
    if !o.status.success() { return Err(String::from_utf8_lossy(&o.stderr).trim().trim_start_matches("rooms-sort: ").to_string()); }
    Ok(String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect())
}

/// The key in the macOS Keychain (service `computer.alto.rooms`, account `typesafe-api-key`).
#[cfg(target_os = "macos")]
mod keychain {
    const SERVICE: &str = "computer.alto.rooms";
    const ACCOUNT: &str = "typesafe-api-key";

    fn entry() -> Result<keyring::Entry, String> { keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string()) }

    pub fn read() -> Option<String> { entry().ok()?.get_password().ok().filter(|k| !k.trim().is_empty()) }

    pub fn write(key: &str) -> Result<(), String> { entry()?.set_password(key).map_err(|e| format!("Couldn't save the key in the Keychain: {e}")) }

    pub fn delete() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Elsewhere there is no Keychain: only `TYPESAFE_API_KEY` works.
#[cfg(not(target_os = "macos"))]
mod keychain {
    pub fn read() -> Option<String> { None }
    pub fn write(_: &str) -> Result<(), String> { Err("Saving a key needs macOS. Set TYPESAFE_API_KEY instead.".into()) }
    pub fn delete() -> Result<(), String> { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_key_wins_and_blank_is_none() {
        std::env::set_var(KEY_ENV, "  ");
        assert_eq!(current_key().0, KeySource::None);
        std::env::set_var(KEY_ENV, " k1 ");
        assert_eq!(current_key(), (KeySource::Env, Some("k1".into())));
        std::env::remove_var(KEY_ENV);
    }
}
