use crate::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rooms_protocol::ApiError;
use std::net::SocketAddr;

pub const API_HOSTS: [&str; 2] = ["127.0.0.1:4317", "localhost:4317"];
pub const FILES_HOSTS: [&str; 2] = ["127.0.0.1:4318", "localhost:4318"];
pub const ALLOWED_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:4317"];

fn forbid(code: &str, message: &str) -> Response {
    (StatusCode::FORBIDDEN, axum::Json(ApiError { error: code.into(), message: message.into() })).into_response()
}

pub fn forbidden() -> Response { forbid("read_only", "read only") }

fn host_ok(req: &Request, allowed: &[&str]) -> bool {
    req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).map(|v| allowed.contains(&v)).unwrap_or(false)
}

/// Host allow-list for every request on a local (non read-only) listener; blocks DNS rebinding.
pub async fn host_guard(allowed: &'static [&'static str], read_only: bool, req: Request, next: Next) -> Response {
    if !read_only && !host_ok(&req, allowed) {
        return forbid("forbidden_host", "host not allowed");
    }
    next.run(req).await
}

pub async fn api_host_guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    host_guard(&API_HOSTS, st.read_only, req, next).await
}

pub async fn files_host_guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    host_guard(&FILES_HOSTS, st.read_only, req, next).await
}

pub async fn write_guard(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let is_write = matches!(*req.method(), Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    if !is_write { return next.run(req).await; }
    let h = req.headers();
    let origin_ok = match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) { None => true, Some(o) => ALLOWED_ORIGINS.contains(&o) };
    let token_ok = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some(format!("Bearer {}", st.token).as_str());
    if st.read_only || !peer.ip().is_loopback() || !host_ok(&req, &API_HOSTS) || !origin_ok || !token_ok { return forbidden(); }
    next.run(req).await
}
