pub mod guard;
pub mod routes;
pub mod sse;

use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::routing::{get, patch, post, put};
use axum::Router;
use rooms_core::RoomsCore;
use tower_http::cors::CorsLayer;

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
        .with_state(state)
}
