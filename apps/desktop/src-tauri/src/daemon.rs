use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

const INFO_URL: &str = "http://127.0.0.1:4317/v1/info";
const BASE_URL: &str = "http://127.0.0.1:4317";
const START_ERROR: &str = "Rooms 코어를 시작하지 못했어요";

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

impl Daemon {
    /// Kill the sidecar if (and only if) this app spawned it.
    pub fn kill_spawned(&self) {
        // Called from the main thread on exit, outside the async runtime. If a connect is
        // mid-flight this waits for it (bounded by its 5 s startup deadline).
        let mut inner = self.inner.blocking_lock();
        if let Some(child) = inner.child.take() {
            let _ = child.kill();
        }
        inner.conn = None;
    }
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

fn read_token(home: &str) -> Result<String, String> {
    let path: PathBuf = [home, ".rooms", "token"].iter().collect();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("토큰 파일을 읽지 못했어요 ({:?})", e.kind()))?;
    Ok(raw.trim().to_string())
}

fn connection(home: String) -> Result<Connection, String> {
    let token = read_token(&home)?;
    Ok(Connection { base_url: BASE_URL.to_string(), token, home })
}

#[tauri::command]
pub async fn connect(app: AppHandle, daemon: State<'_, Daemon>) -> Result<Connection, String> {
    // Holding the lock for the whole call serializes concurrent connects.
    let mut inner = daemon.inner.lock().await;

    // Idempotent: our spawned child is alive and still healthy.
    if inner.child.is_some() {
        if let (Some(conn), Some(_)) = (inner.conn.clone(), probe().await) {
            return Ok(conn);
        }
    }

    // Reuse a daemon that is already running (not ours).
    if inner.child.is_none() {
        if let Some(home) = probe().await {
            return connection(home);
        }
    }

    // Stale child (unhealthy): discard before respawning.
    if let Some(old) = inner.child.take() {
        let _ = old.kill();
        inner.conn = None;
    }

    let mut cmd = app.shell().sidecar("roomsd").map_err(|_| START_ERROR.to_string())?;
    if let Ok(home) = std::env::var("ROOMS_HOME") {
        cmd = cmd.env("ROOMS_HOME", home);
    }
    if cfg!(debug_assertions) {
        cmd = cmd.env("ROOMS_DEV_ORIGIN", "http://localhost:1420");
    }
    let (mut rx, child) = cmd.spawn().map_err(|_| START_ERROR.to_string())?;
    inner.child = Some(child);

    let deadline = Instant::now() + Duration::from_secs(5);
    let home = loop {
        // Exit code 2 (or any early exit) means startup failed.
        while let Ok(ev) = rx.try_recv() {
            if let CommandEvent::Terminated(_) = ev {
                inner.child = None;
                return Err(START_ERROR.to_string());
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

    // Keep draining events; clear state if the daemon later dies.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let CommandEvent::Terminated(_) = ev {
                let d = handle.state::<Daemon>();
                let mut inner = d.inner.lock().await;
                inner.child = None;
                inner.conn = None;
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

    #[test]
    fn initial_uppercases_or_falls_back() {
        assert_eq!(initial_from(Some("junseon")), "J");
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
