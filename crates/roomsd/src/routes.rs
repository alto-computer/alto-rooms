use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rooms_core::CoreError;
use rooms_protocol::*;
use serde::Deserialize;

pub struct ApiErr(pub CoreError);
impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(ApiError { error: self.0.code().into(), message: self.0.to_string() })).into_response()
    }
}
impl From<CoreError> for ApiErr { fn from(e: CoreError) -> Self { ApiErr(e) } }

fn with_seq<T: serde::Serialize>(st: &AppState, v: T) -> Response {
    let mut h = HeaderMap::new();
    h.insert("x-rooms-seq", HeaderValue::from_str(&st.core.current_seq().to_string()).unwrap());
    (h, Json(v)).into_response()
}

pub async fn info(State(st): State<AppState>) -> Json<Info> {
    Json(Info { version: PROTOCOL_VERSION.into(), read_only: st.read_only, home: st.core.home().to_string_lossy().into(),
        journal_room_id: JOURNAL_ROOM_ID.into(), files_origin: st.files_origin.clone() })
}

pub async fn list_rooms(State(st): State<AppState>) -> Response { with_seq(&st, st.core.list_rooms()) }

pub async fn list_artifacts(State(st): State<AppState>, Path(room_id): Path<String>) -> Result<Response, ApiErr> {
    Ok(with_seq(&st, st.core.list_artifacts(&room_id)?))
}

pub async fn journal_day(State(st): State<AppState>, Path(date): Path<String>) -> Result<Response, ApiErr> {
    Ok(with_seq(&st, st.core.journal_day(&date)?))
}

#[derive(Deserialize)] pub struct CreateBody { name: String }
pub async fn create_room(State(st): State<AppState>, Json(b): Json<CreateBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(st.core.create_room(&b.name)?))
}

#[derive(Deserialize)] pub struct LinkBody { path: String, name: Option<String> }
pub async fn link_room(State(st): State<AppState>, Json(b): Json<LinkBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(st.core.link_folder(std::path::Path::new(&b.path), b.name.as_deref())?))
}

#[derive(Deserialize)] pub struct RenameBody { name: String }
pub async fn rename_room(State(st): State<AppState>, Path(room_id): Path<String>, Json(b): Json<RenameBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(st.core.rename_room(&room_id, &b.name)?))
}

pub async fn put_note(State(st): State<AppState>, Path((date, name)): Path<(String, String)>, body: String) -> Result<Json<Note>, ApiErr> {
    Ok(Json(st.core.save_note(&date, &name, &body)?))
}

pub async fn file(State(st): State<AppState>, Path((room_id, rel)): Path<(String, String)>) -> Result<Response, ApiErr> {
    let path = st.core.resolve_file(&room_id, &rel)?;
    // CoreError has no read/not-found variant besides RoomNotFound (misleading here); WriteFailed (500) is the closest fit.
    let bytes = tokio::fs::read(&path).await.map_err(|e| ApiErr(CoreError::WriteFailed(e.to_string())))?;
    let ct = if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) { "text/markdown; charset=utf-8" } else { "text/html; charset=utf-8" };
    Ok(([("content-type", ct), ("content-security-policy", "sandbox allow-scripts allow-popups")], bytes).into_response())
}
