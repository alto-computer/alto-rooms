pub mod guard;
pub mod routes;
pub mod sse;

use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::routing::{get, patch, post, put};
use axum::Router;
use rooms_core::RoomsCore;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

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

#[derive(Clone)]
pub struct AppState {
    pub core: RoomsCore,
    pub token: String,
    pub read_only: bool,
    pub files_origin: String,
}

pub fn build_api_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(guard::ALLOWED_ORIGINS.iter().map(|o| HeaderValue::from_static(o)).collect::<Vec<_>>())
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .expose_headers([HeaderName::from_static("x-rooms-seq")]);
    Router::new()
        .route("/v1/info", get(routes::info))
        .route("/v1/rooms", get(routes::list_rooms).post(routes::create_room))
        .route("/v1/rooms/link", post(routes::link_room))
        .route("/v1/rooms/{room_id}", patch(routes::rename_room))
        .route("/v1/rooms/{room_id}/artifacts", get(routes::list_artifacts))
        .route("/v1/journal/{date}", get(routes::journal_day))
        .route("/v1/journal/{date}/notes/{name}", put(routes::put_note))
        .route("/v1/events", get(sse::events))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::write_guard))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::api_host_guard))
        .layer(cors)
        .with_state(state)
}

pub fn build_files_router(state: AppState) -> Router {
    Router::new()
        .route("/{room_id}/{*rel}", get(routes::file))
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard::files_host_guard))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("sandbox allow-scripts allow-popups"),
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::write_token;
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
