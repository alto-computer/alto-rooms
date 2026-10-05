use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

const INFO_URL: &str = "http://127.0.0.1:4317/v1/info";
const BASE_URL: &str = "http://127.0.0.1:4317";
const START_ERROR: &str = "Rooms 코어를 시작하지 못했어요";
/** Emitted when the roomsd this app spawned exits on its own. */
pub const DAEMON_EXITED: &str = "daemon://exited";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub token: String,
    pub home: String,
}

/// Managed state. `child` is Some only when this app spawned the daemon.
#[derive(Default)]
pub struct Daemon {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    child: Option<CommandChild>,
    conn: Option<Connection>,
}

/// How long the sidecar gets to exit after SIGTERM before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(1);

impl Daemon {
    /// Stop the sidecar if (and only if) this app spawned it: SIGTERM, up to
    /// [`STOP_GRACE`] to exit, then SIGKILL.
    pub fn kill_spawned(&self) {
        // Called from the main thread on exit, outside the async runtime. If a connect is
        // mid-flight this waits for it (bounded by its 5 s startup deadline).
        let mut inner = self.inner.blocking_lock();
        if let Some(child) = inner.child.take() {
            let pid = child.pid();
            // The shell plugin reaps the child as soon as it exits, so "alive" is "the pid exists".
            let alive = |pid: u32| {
                // SAFETY: signal 0 only checks that the process exists and may be signalled.
                unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
            };
            if !stop_gracefully(pid, STOP_GRACE, alive, || {
                let _ = child.kill();
            }) {
                eprintln!("roomsd did not exit within {STOP_GRACE:?} of SIGTERM; killed");
            }
        }
        inner.conn = None;
    }
}

/// Sends SIGTERM to `pid` and waits up to `grace` for `alive(pid)` to turn false;
/// otherwise calls `kill`. Returns whether the process exited on its own.
fn stop_gracefully(pid: u32, grace: Duration, alive: impl Fn(u32) -> bool, kill: impl FnOnce()) -> bool {
    // SAFETY: plain kill(2) on a pid we spawned and still own (not yet reaped by us).
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
        // Already gone (ESRCH): nothing to wait for.
        return true;
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !alive(pid) {
        return true;
    }
    kill();
    false
}

#[derive(Deserialize)]
struct Info {
    version: String,
    home: String,
}

/// Returns the daemon home if the body is a `/v1/info` response with version "1".
pub fn parse_info(body: &str) -> Option<String> {
    let info: Info = serde_json::from_str(body).ok()?;
    (info.version == "1").then_some(info.home)
}

/// Blocking probe; returns the daemon home when a compatible roomsd answers.
fn probe_blocking() -> Option<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(500)))
        .build()
        .into();
    let mut resp = agent.get(INFO_URL).call().ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    let body = resp.body_mut().read_to_string().ok()?;
    parse_info(&body)
}

async fn probe() -> Option<String> {
    tauri::async_runtime::spawn_blocking(probe_blocking)
        .await
        .ok()
        .flatten()
}

/// Facts about the token file, from `fstat` of the opened file (or `symlink_metadata`).
#[derive(Debug, Clone, Copy)]
struct TokenMeta {
    is_symlink: bool,
    is_file: bool,
    uid: u32,
    mode: u32,
    nlink: u64,
    len: u64,
}

impl TokenMeta {
    fn from_metadata(m: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        TokenMeta {
            is_symlink: m.file_type().is_symlink(),
            is_file: m.is_file(),
            uid: m.uid(),
            mode: m.mode(),
            nlink: m.nlink(),
            len: m.len(),
        }
    }
}

/// Pure policy: the token must be ours, private, unlinked elsewhere and small.
fn check_token_meta(m: &TokenMeta, my_uid: u32) -> Result<(), &'static str> {
    if m.is_symlink {
        Err("token is a symlink")
    } else if !m.is_file {
        Err("token is not a regular file")
    } else if m.uid != my_uid {
        Err("token owned by another user")
    } else if m.mode & 0o077 != 0 {
        Err("token is accessible by group/other")
    } else if m.nlink != 1 {
        Err("token has multiple hard links")
    } else if m.len > TOKEN_MAX {
        Err("token file too large")
    } else {
        Ok(())
    }
}

/// Largest token file accepted, in bytes.
const TOKEN_MAX: u64 = 64;

/// Opens the token without following a symlink (and without blocking on a FIFO),
/// checks the opened file itself (`fstat`), and reads at most `TOKEN_MAX + 1` bytes,
/// so nothing can be swapped in between the check and the read.
fn read_token_file(path: &std::path::Path, my_uid: u32) -> Result<String, String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("open: {:?}", e.kind()))?;
    let meta = file.metadata().map_err(|e| format!("fstat: {:?}", e.kind()))?;
    check_token_meta(&TokenMeta::from_metadata(&meta), my_uid).map_err(str::to_string)?;
    let mut raw = Vec::with_capacity(TOKEN_MAX as usize + 1);
    file.take(TOKEN_MAX + 1)
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {:?}", e.kind()))?;
    if raw.len() as u64 > TOKEN_MAX {
        return Err("token file too large".to_string());
    }
    let text = String::from_utf8(raw).map_err(|_| "token is not UTF-8".to_string())?;
    Ok(text.trim().to_string())
}

fn read_token(home: &str) -> Result<String, String> {
    let fail = |reason: &str| {
        eprintln!("roomsd token rejected: {reason}");
        START_ERROR.to_string()
    };
    if !std::path::Path::new(home).is_absolute() {
        return Err(fail("home is not absolute"));
    }
    let path: PathBuf = [home, ".rooms", "token"].iter().collect();
    // SAFETY: getuid has no preconditions and cannot fail.
    let my_uid = unsafe { libc::getuid() };
    read_token_file(&path, my_uid).map_err(|reason| fail(&reason))
}

fn connection(home: String) -> Result<Connection, String> {
    let token = read_token(&home)?;
    Ok(Connection { base_url: BASE_URL.to_string(), token, home })
}

/// Reuse an already-running daemon, refusing one whose home differs from `ROOMS_HOME`.
fn reuse(home: String) -> Result<Connection, String> {
    if let Ok(want) = std::env::var("ROOMS_HOME") {
        let want_c = std::fs::canonicalize(&want).unwrap_or_else(|_| PathBuf::from(&want));
        let got_c = std::fs::canonicalize(&home).unwrap_or_else(|_| PathBuf::from(&home));
        if want_c != got_c {
            return Err(format!(
                "실행 중인 Rooms 코어의 홈({})이 ROOMS_HOME({})과 달라요",
                got_c.display(),
                want_c.display()
            ));
        }
    }
    connection(home)
}

/// A drain task for `drain_pid` may clear state only if that child still owns the slot.
fn should_clear(current_pid: Option<u32>, drain_pid: u32) -> bool {
    current_pid == Some(drain_pid)
}

#[tauri::command]
pub async fn connect(app: AppHandle, daemon: State<'_, Daemon>) -> Result<Connection, String> {
    // Holding the lock for the whole call serializes concurrent connects.
    let mut inner = daemon.inner.lock().await;

    if inner.child.is_some() {
        // Idempotent: our spawned child is alive and still healthy (re-probe once).
        if probe().await.is_some() {
            if let Some(conn) = inner.conn.clone() {
                return Ok(conn);
            }
        }
        // Really stale: kill it and wait up to 2 s for the port to be released.
        if let Some(old) = inner.child.take() {
            let _ = old.kill();
        }
        inner.conn = None;
        let release = Instant::now() + Duration::from_secs(2);
        while probe().await.is_some() && Instant::now() < release {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    } else if let Some(home) = probe().await {
        // Reuse a daemon that is already running (not ours).
        return reuse(home);
    }

    let mut cmd = app.shell().sidecar("roomsd").map_err(|_| START_ERROR.to_string())?;
    if let Ok(home) = std::env::var("ROOMS_HOME") {
        cmd = cmd.env("ROOMS_HOME", home);
    }
    if cfg!(debug_assertions) {
        cmd = cmd.env("ROOMS_DEV_ORIGIN", "http://localhost:1420");
    }
    let (mut rx, child) = cmd.spawn().map_err(|_| START_ERROR.to_string())?;
    let pid = child.pid();
    inner.child = Some(child);

    let deadline = Instant::now() + Duration::from_secs(5);
    let home = loop {
        // Early exit (exit code 2: busy port, lock held, bad config) means startup failed.
        while let Ok(ev) = rx.try_recv() {
            if let CommandEvent::Terminated(_) = ev {
                inner.child = None;
                // Another daemon may have won the race; reuse it if it is healthy.
                return match probe().await {
                    Some(home) => reuse(home),
                    None => Err(START_ERROR.to_string()),
                };
            }
        }
        if let Some(home) = probe().await {
            break home;
        }
        if Instant::now() >= deadline {
            if let Some(child) = inner.child.take() {
                let _ = child.kill();
            }
            return Err(START_ERROR.to_string());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };

    let conn = match connection(home) {
        Ok(c) => c,
        Err(e) => {
            if let Some(child) = inner.child.take() {
                let _ = child.kill();
            }
            return Err(e);
        }
    };
    inner.conn = Some(conn.clone());

    // Keep draining events. If THIS child later dies on its own (not killed by us:
    // kill paths take the child out of the slot first), clear state and tell the
    // webview, which shows the core error and can connect (respawn) again.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let CommandEvent::Terminated(payload) = ev {
                let d = handle.state::<Daemon>();
                let mut inner = d.inner.lock().await;
                if should_clear(inner.child.as_ref().map(|c| c.pid()), pid) {
                    inner.child = None;
                    inner.conn = None;
                    drop(inner);
                    eprintln!("roomsd exited unexpectedly (code {:?}, signal {:?})", payload.code, payload.signal);
                    if let Err(e) = handle.emit(DAEMON_EXITED, ()) {
                        eprintln!("could not emit {DAEMON_EXITED}: {e}");
                    }
                }
                break;
            }
        }
    });
    Ok(conn)
}

/// First char of `$USER`, uppercased; "나" when unavailable.
pub fn initial_from(user: Option<&str>) -> String {
    user.and_then(|u| u.chars().next())
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_else(|| "나".to_string())
}

#[tauri::command]
pub fn viewer_initial() -> String {
    initial_from(std::env::var("USER").ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> TokenMeta {
        TokenMeta { is_symlink: false, is_file: true, uid: 501, mode: 0o100600, nlink: 1, len: 33 }
    }

    #[test]
    fn token_meta_policy() {
        assert_eq!(check_token_meta(&good(), 501), Ok(()));
        assert!(check_token_meta(&TokenMeta { is_symlink: true, ..good() }, 501).is_err());
        assert!(check_token_meta(&TokenMeta { is_file: false, ..good() }, 501).is_err());
        assert!(check_token_meta(&good(), 502).is_err());
        assert!(check_token_meta(&TokenMeta { mode: 0o100644, ..good() }, 501).is_err());
        assert!(check_token_meta(&TokenMeta { nlink: 2, ..good() }, 501).is_err());
        assert!(check_token_meta(&TokenMeta { len: 65, ..good() }, 501).is_err());
    }

    #[test]
    fn token_files_on_disk() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("rooms-tok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let uid = unsafe { libc::getuid() };
        let meta = |p: &std::path::Path| TokenMeta::from_metadata(&std::fs::symlink_metadata(p).unwrap());

        let f = dir.join("t");
        std::fs::write(&f, "secret").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(check_token_meta(&meta(&f), uid), Ok(()));

        let link = dir.join("l");
        symlink(&f, &link).unwrap();
        assert!(check_token_meta(&meta(&link), uid).is_err());

        let hard = dir.join("h");
        std::fs::hard_link(&f, &hard).unwrap();
        assert!(check_token_meta(&meta(&f), uid).is_err());
        std::fs::remove_file(&hard).unwrap();

        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(check_token_meta(&meta(&f), uid).is_err());

        let big = dir.join("b");
        std::fs::write(&big, "x".repeat(65)).unwrap();
        std::fs::set_permissions(&big, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(check_token_meta(&meta(&big), uid).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_read_opens_without_following_links_and_reads_at_most_64_bytes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("rooms-tokread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let uid = unsafe { libc::getuid() };
        let private = |p: &std::path::Path| std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600)).unwrap();

        let ok = dir.join("ok");
        std::fs::write(&ok, "secret-token\n").unwrap();
        private(&ok);
        assert_eq!(read_token_file(&ok, uid), Ok("secret-token".to_string()));

        // Exactly 64 bytes is fine; 65 is not.
        let max = dir.join("max");
        std::fs::write(&max, "x".repeat(64)).unwrap();
        private(&max);
        assert_eq!(read_token_file(&max, uid).map(|t| t.len()), Ok(64));
        let big = dir.join("big");
        std::fs::write(&big, "x".repeat(65)).unwrap();
        private(&big);
        assert!(read_token_file(&big, uid).is_err());

        // A symlink to a good token is refused at open (O_NOFOLLOW), not just by a stat.
        let link = dir.join("link");
        symlink(&ok, &link).unwrap();
        assert!(read_token_file(&link, uid).is_err());

        // A FIFO neither blocks the open nor passes the regular-file check.
        let fifo = dir.join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(read_token_file(&fifo, uid).is_err());

        // The checks run on the opened file: wrong owner, group-readable.
        assert!(read_token_file(&ok, uid + 1).is_err());
        std::fs::set_permissions(&ok, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_token_file(&ok, uid).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stop_gracefully_sends_sigterm_and_skips_the_kill_when_the_child_exits() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        let child = std::sync::Mutex::new(&mut child);
        let alive = |_: u32| matches!(child.lock().unwrap().try_wait(), Ok(None));
        let killed = std::cell::Cell::new(false);
        let started = Instant::now();
        let graceful = stop_gracefully(pid, Duration::from_secs(1), alive, || killed.set(true));
        assert!(graceful);
        assert!(!killed.get());
        assert!(started.elapsed() < Duration::from_millis(900));
    }

    #[test]
    fn stop_gracefully_kills_after_the_grace_period_when_sigterm_is_ignored() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap '' TERM; exec sleep 30"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100)); // let the trap install
        let pid = child.id();
        let child = std::sync::Mutex::new(&mut child);
        let alive = |_: u32| matches!(child.lock().unwrap().try_wait(), Ok(None));
        let started = Instant::now();
        let graceful = stop_gracefully(pid, Duration::from_millis(300), alive, || {
            let _ = child.lock().unwrap().kill();
        });
        assert!(!graceful);
        assert!(started.elapsed() >= Duration::from_millis(300));
        let _ = child.lock().unwrap().wait();
    }

    #[test]
    fn stale_drain_does_not_clear_respawned_child() {
        assert!(should_clear(Some(7), 7));
        assert!(!should_clear(Some(8), 7));
        assert!(!should_clear(None, 7));
    }

    #[test]
    fn initial_uppercases_or_falls_back() {
        assert_eq!(initial_from(Some("jamie")), "J");
        assert_eq!(initial_from(Some("")), "나");
        assert_eq!(initial_from(None), "나");
    }

    #[test]
    fn parse_info_accepts_version_1() {
        let body = r#"{"version":"1","readOnly":false,"home":"/Users/x/rooms","journalRoomId":"j","filesOrigin":"http://127.0.0.1:4318"}"#;
        assert_eq!(parse_info(body), Some("/Users/x/rooms".to_string()));
    }

    #[test]
    fn parse_info_rejects_wrong_version() {
        assert_eq!(parse_info(r#"{"version":"2","home":"/h"}"#), None);
    }

    #[test]
    fn parse_info_rejects_garbage() {
        assert_eq!(parse_info("not json"), None);
        assert_eq!(parse_info(r#"{"version":"1"}"#), None);
    }
}
