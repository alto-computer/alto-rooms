pub mod guard;
pub mod routes;
pub mod sse;

use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::routing::{get, patch, post};
use axum::Router;
use rooms_core::RoomsCore;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;

/// Takes an exclusive, non-blocking lock on `<home>/.rooms/lock` (one daemon per home).
/// Keep the returned file alive for the daemon's lifetime; the OS releases the lock on exit.
/// Touches nothing else in `.rooms` (no state.json, no token).
pub fn acquire_home_lock(home: &std::path::Path) -> std::io::Result<std::fs::File> {
    let dir = home.join(".rooms");
    std::fs::create_dir_all(&dir)?;
    let f = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.join("lock"))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "another roomsd holds the lock")),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

/// Writes a fresh 32-char token to `<home>/.rooms/token` (file 0600, dir 0700).
pub fn write_token(home: &std::path::Path) -> std::io::Result<String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let dir = home.join(".rooms");
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let token = nanoid::nanoid!(32);
    let path = dir.join("token");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(token.as_bytes())?;
    Ok(token)
}

/// Listener ports and the optional dev-server origin; the guards and CORS derive their allow-lists from it.
#[derive(Clone, Debug, PartialEq)]
pub struct NetConfig {
    pub api_port: u16,
    pub files_port: u16,
    pub dev_origin: Option<String>,
}

impl Default for NetConfig {
    fn default() -> Self { NetConfig { api_port: 4317, files_port: 4318, dev_origin: None } }
}

/// Accepts only `http(s)://host[:port]` (no path, query, fragment, trailing slash); anything else
/// (`null`, `*`, empty, ...) is `None`. Never lets the sandboxed-iframe origin `null` through.
pub fn parse_dev_origin(raw: &str) -> Option<String> {
    let v = raw.trim();
    let rest = v.strip_prefix("http://").or_else(|| v.strip_prefix("https://"))?;
    let (host, port) = match rest.split_once(':') { Some((h, p)) => (h, Some(p)), None => (rest, None) };
    let host_ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()));
    (host_ok && port_ok).then(|| v.to_string())
}

/// `None` (unset) gives `default`; otherwise a nonzero u16 or an error naming the variable.
pub fn parse_port(var: &str, raw: Option<&str>, default: u16) -> Result<u16, String> {
    match raw {
        None => Ok(default),
        Some(v) => match v.trim().parse::<u16>() {
            Ok(p) if p != 0 => Ok(p),
            _ => Err(format!("{var}={v:?} is not a valid port (1-65535)")),
        },
    }
}

impl NetConfig {
    /// Reads `ROOMS_API_PORT`, `ROOMS_FILES_PORT`, `ROOMS_DEV_ORIGIN`. Invalid ports are an error;
    /// an invalid dev origin is warned about and ignored.
    pub fn from_env() -> Result<Self, String> {
        let d = NetConfig::default();
        let get = |k: &str| std::env::var(k).ok();
        let dev_origin = get("ROOMS_DEV_ORIGIN").and_then(|raw| {
            let o = parse_dev_origin(&raw);
            if o.is_none() { eprintln!("roomsd: ignoring invalid ROOMS_DEV_ORIGIN={raw:?} (want http(s)://host[:port])"); }
            o
        });
        Ok(NetConfig {
            api_port: parse_port("ROOMS_API_PORT", get("ROOMS_API_PORT").as_deref(), d.api_port)?,
            files_port: parse_port("ROOMS_FILES_PORT", get("ROOMS_FILES_PORT").as_deref(), d.files_port)?,
            dev_origin,
        })
    }
}

#[derive(Clone)]
pub struct AppState {
    pub core: RoomsCore,
    pub asks: rooms_core::asks::Asks,
    pub token: String,
    pub read_only: bool,
    pub files_origin: String,
    pub net: NetConfig,
}

pub fn build_api_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate({
            let st = state.clone();
            move |o: &HeaderValue, _| o.to_str().map(|o| guard::origin_allowed(&st, o)).unwrap_or(false)
        }))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .expose_headers([HeaderName::from_static("x-rooms-seq")]);
    Router::new()
        .route("/v1/info", get(routes::info))
        .route("/v1/rooms", get(routes::list_rooms).post(routes::create_room))
        .route("/v1/rooms/link", post(routes::link_room))
        .route("/v1/rooms/{room_id}", patch(routes::rename_room))
        .route("/v1/rooms/{room_id}/move", post(routes::move_room))
        .route("/v1/rooms/{room_id}/artifacts", get(routes::list_artifacts))
        .route("/v1/journal/{date}", get(routes::journal_day))
        .route("/v1/journal/{date}/notes/{name}", get(routes::get_note).put(routes::put_note))
        .route("/v1/journal/{date}/notes/{name}/rename", post(routes::rename_note))
        .route("/v1/artifacts/move", post(routes::move_artifact))
        .route("/v1/artifacts/by-file-key/{key}", get(routes::artifact_by_file_key))
        .route("/v1/asks", get(routes::ask_thread).post(routes::start_ask))
        .route("/v1/asks/{ask_id}", axum::routing::delete(routes::cancel_ask))
        .route("/v1/tools", get(routes::list_tools))
        .route("/v1/tools/call", post(routes::call_tool))
        .route("/v1/plugins", get(routes::list_plugins))
        .route("/v1/plugins/{id}", patch(routes::set_plugin_enabled))
        .route("/v1/plugins/{id}/data", get(routes::list_plugin_data))
        .route(
            "/v1/plugins/{id}/data/{*path}",
            get(routes::get_plugin_data)
                .put(routes::put_plugin_data)
                .delete(routes::delete_plugin_data)
                // One byte over the limit still reaches the handler, which answers 413 `too_large`.
                .layer(axum::extract::DefaultBodyLimit::max(rooms_core::plugins::MAX_DATA_BYTES + 1024)),
        )
        .route("/v1/events", get(sse::events))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::write_guard))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::api_host_guard))
        .layer(cors)
        .with_state(state)
}

pub fn build_files_router(state: AppState) -> Router {
    Router::new()
        .route("/{room_id}/{*rel}", get(routes::file))
        .route("/_plugins/{id}/{*rel}", get(routes::plugin_file))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::files_host_guard))
        // Artifacts (and refusals) get the shared sandbox; plugin assets set their own narrower CSP.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("sandbox allow-scripts allow-popups"),
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::{acquire_home_lock, parse_dev_origin, parse_port, write_token};

    #[test]
    fn dev_origin_parsing() {
        assert_eq!(parse_dev_origin("http://localhost:4173").as_deref(), Some("http://localhost:4173"));
        assert_eq!(parse_dev_origin("https://a.b:8443").as_deref(), Some("https://a.b:8443"));
        assert_eq!(parse_dev_origin(" http://localhost:1420 ").as_deref(), Some("http://localhost:1420"));
        for bad in ["null", "*", "", "http://x/", "http://x/path", "ftp://x", "localhost:1420", "http://", "http://x:", "http://x:abc", "http://x?q", "http://x#f", "http://a b"] {
            assert_eq!(parse_dev_origin(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn port_validation() {
        assert_eq!(parse_port("X", None, 4317), Ok(4317));
        assert_eq!(parse_port("X", Some(" 9000 "), 4317), Ok(9000));
        for bad in ["abc", "0", "", "70000", "-1"] {
            let e = parse_port("ROOMS_API_PORT", Some(bad), 4317).unwrap_err();
            assert!(e.contains("ROOMS_API_PORT"), "{e}");
        }
    }

    #[test]
    fn second_home_lock_fails_until_first_is_dropped() {
        let d = tempfile::tempdir().unwrap();
        let first = acquire_home_lock(d.path()).unwrap();
        assert!(d.path().join(".rooms/lock").is_file());
        assert!(acquire_home_lock(d.path()).is_err(), "second daemon must not get the lock");
        assert!(!d.path().join(".rooms/token").exists() && !d.path().join(".rooms/state.json").exists());
        drop(first);
        assert!(acquire_home_lock(d.path()).is_ok());
    }

    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &std::path::Path) -> u32 { std::fs::metadata(p).unwrap().permissions().mode() & 0o777 }

    #[test]
    fn write_token_sets_modes_and_length() {
        let d = tempfile::tempdir().unwrap();
        let t = write_token(d.path()).unwrap();
        assert_eq!(t.len(), 32);
        let f = d.path().join(".rooms/token");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), t);
        assert_eq!(mode(&f), 0o600);
        assert_eq!(mode(&d.path().join(".rooms")), 0o700);
    }

    #[test]
    fn write_token_tightens_existing_file_and_regenerates() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        let f = d.path().join(".rooms/token");
        std::fs::write(&f, "old-old-old-old-old-old-old-old-old-old").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        let t = write_token(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), t);
        assert_eq!(t.len(), 32);
        assert_eq!(mode(&f), 0o600);
    }
}
