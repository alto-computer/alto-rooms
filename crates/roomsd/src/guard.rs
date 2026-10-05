use crate::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rooms_protocol::ApiError;
use std::net::SocketAddr;

pub const ALLOWED_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:4317"];

fn forbid(code: &str, message: &str) -> Response {
    (StatusCode::FORBIDDEN, axum::Json(ApiError { error: code.into(), message: message.into() })).into_response()
}

pub fn forbidden() -> Response { forbid("read_only", "read only") }

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
    if !is_write { return next.run(req).await; }
    let h = req.headers();
    let origin_ok = match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) { None => true, Some(o) => origin_allowed(&st, o) };
    let token_ok = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some(format!("Bearer {}", st.token).as_str());
    if st.read_only || !peer.ip().is_loopback() || !host_ok(&req, &hosts(st.net.api_port)) || !origin_ok || !token_ok { return forbidden(); }
    next.run(req).await
}
