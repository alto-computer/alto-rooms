//! The two listeners' routers: the JSON API and the sandboxed files origin.
use crate::{guard, routes, sse, AppState};
use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::routing::{get, patch, post};
use axum::Router;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;

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
        .route("/v1/asks/target", get(routes::ask_target))
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
