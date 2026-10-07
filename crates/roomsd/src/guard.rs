use crate::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rooms_protocol::ApiError;
use std::net::SocketAddr;

/// Browser origins allowed to write. The last entry is the API's own origin on
/// `layout::DEFAULT_API_PORT` (pinned by a test below); it does not follow `ROOMS_API_PORT`.
pub const ALLOWED_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:4317"];

fn forbid(code: &str, message: &str) -> Response {
    (StatusCode::FORBIDDEN, axum::Json(ApiError { error: code.into(), message: message.into() })).into_response()
}

/// The answer to any write (or private read) the write guard refuses: read-only daemon, non-loopback
/// peer, foreign host, foreign origin, or a missing/wrong token. The wire code is `read_only` for all of
/// them on purpose: to a client every case means "you may only read here", and one code tells a
/// prober nothing about which check failed. Clients match on this code, so it must not change.
fn write_denied() -> Response { forbid("read_only", "read only") }

pub fn hosts(port: u16) -> [String; 2] { [format!("127.0.0.1:{port}"), format!("localhost:{port}")] }

pub fn origin_allowed(st: &AppState, o: &str) -> bool {
    ALLOWED_ORIGINS.contains(&o) || st.net.dev_origin.as_deref() == Some(o)
}

fn host_ok(req: &Request, allowed: &[String]) -> bool {
    req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).map(|v| allowed.iter().any(|a| a == v)).unwrap_or(false)
}

/// Host allow-list for every request on a local (non read-only) listener; blocks DNS rebinding.
pub async fn host_guard(allowed: &[String], read_only: bool, req: Request, next: Next) -> Response {
    if !read_only && !host_ok(&req, allowed) {
        return forbid("forbidden_host", "host not allowed");
    }
    next.run(req).await
}

pub async fn api_host_guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    host_guard(&hosts(st.net.api_port), st.read_only, req, next).await
}

pub async fn files_host_guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    host_guard(&hosts(st.net.files_port), st.read_only, req, next).await
}

pub async fn write_guard(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let is_write = matches!(*req.method(), Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    // Plugin data and the tool list are private (data goes to the app, tools to local agents): reads need the token too.
    let p = req.uri().path();
    let private = p.starts_with("/v1/plugins/") && (p.ends_with("/data") || p.contains("/data/")) || p == "/v1/tools";
    if !is_write && !private { return next.run(req).await; }
    let h = req.headers();
    let origin_ok = match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) { None => true, Some(o) => origin_allowed(&st, o) };
    let token_ok = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some(format!("Bearer {}", st.token).as_str());
    if st.read_only || !peer.ip().is_loopback() || !host_ok(&req, &hosts(st.net.api_port)) || !origin_ok || !token_ok { return write_denied(); }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn own_origin_matches_default_api_port() {
        let own = format!("http://127.0.0.1:{}", rooms_protocol::layout::DEFAULT_API_PORT);
        assert!(super::ALLOWED_ORIGINS.contains(&own.as_str()));
    }
}
