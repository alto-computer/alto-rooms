use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rooms_core::{CoreError, RoomsCore};
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

/// Runs a core call on the blocking pool: core does filesystem/SQLite IO under a std Mutex,
/// which must not stall the async workers. A panicked/cancelled task maps to 500 `internal`.
pub async fn blocking<T, F>(st: &AppState, f: F) -> Result<T, ApiErr>
where
    T: Send + 'static,
    F: FnOnce(&RoomsCore) -> Result<T, CoreError> + Send + 'static,
{
    let core = st.core.clone();
    tokio::task::spawn_blocking(move || f(&core))
        .await
        .map_err(|e| ApiErr(CoreError::Internal(e.to_string())))?
        .map_err(ApiErr)
}

/// Snapshot GET with `X-Rooms-Seq`. Spec §5 S3 rule ③: the client discards buffered events with
/// seq ≤ the snapshot seq, so the seq MUST be read BEFORE the data is computed. Reading it after
/// could cover an event the data does not contain yet (lost update); reading it before at worst
/// re-applies an event, which is idempotent (rule ④).
pub async fn snapshot<T, F>(st: &AppState, f: F) -> Result<Response, ApiErr>
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(&RoomsCore) -> Result<T, CoreError> + Send + 'static,
{
    let (seq, v) = blocking(st, move |core| {
        let seq = core.current_seq(); // ① seq first
        let v = f(core)?; // ② then data
        Ok((seq, v))
    })
    .await?;
    let mut h = HeaderMap::new();
    h.insert("x-rooms-seq", HeaderValue::from_str(&seq.to_string()).unwrap());
    Ok((h, Json(v)).into_response())
}

pub async fn info(State(st): State<AppState>) -> Json<Info> {
    Json(Info { version: PROTOCOL_VERSION.into(), read_only: st.read_only, home: st.core.home().to_string_lossy().into(),
        journal_room_id: JOURNAL_ROOM_ID.into(), files_origin: st.files_origin.clone() })
}

pub async fn list_rooms(State(st): State<AppState>) -> Response {
    snapshot(&st, |c| Ok(c.list_rooms())).await.into_response()
}

pub async fn list_artifacts(State(st): State<AppState>, Path(room_id): Path<String>) -> Result<Response, ApiErr> {
    snapshot(&st, move |c| c.list_artifacts(&room_id)).await
}

pub async fn journal_day(State(st): State<AppState>, Path(date): Path<String>) -> Result<Response, ApiErr> {
    snapshot(&st, move |c| c.journal_day(&date)).await
}

#[derive(Deserialize)] pub struct CreateBody { name: String }
pub async fn create_room(State(st): State<AppState>, Json(b): Json<CreateBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.create_room(&b.name)).await?))
}

#[derive(Deserialize)] pub struct LinkBody { path: String, name: Option<String> }
pub async fn link_room(State(st): State<AppState>, Json(b): Json<LinkBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.link_folder(std::path::Path::new(&b.path), b.name.as_deref())).await?))
}

#[derive(Deserialize)] pub struct RenameBody { name: String }
pub async fn rename_room(State(st): State<AppState>, Path(room_id): Path<String>, Json(b): Json<RenameBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.rename_room(&room_id, &b.name)).await?))
}

#[derive(Deserialize)] pub struct MoveRoomBody { to: usize }
/// Moves a room to position `to` among the rooms other than the inbox; returns the full new order.
pub async fn move_room(State(st): State<AppState>, Path(room_id): Path<String>, Json(b): Json<MoveRoomBody>) -> Result<Json<Vec<String>>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.move_room(&room_id, b.to)).await?))
}

pub async fn put_note(State(st): State<AppState>, Path((date, name)): Path<(String, String)>, body: String) -> Result<Json<Note>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.save_note(&date, &name, &body)).await?))
}

#[derive(Deserialize)] pub struct RenameNoteBody { to: String }
pub async fn rename_note(State(st): State<AppState>, Path((date, name)): Path<(String, String)>, Json(b): Json<RenameNoteBody>) -> Result<Json<Note>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.rename_note(&date, &name, &b.to)).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveArtifactBody { room_id: String, artifact_id: String, to_room_id: String }
pub async fn move_artifact(State(st): State<AppState>, Json(b): Json<MoveArtifactBody>) -> Result<Json<Artifact>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.move_artifact(&b.room_id, &b.artifact_id, &b.to_room_id)).await?))
}

pub async fn get_note(State(st): State<AppState>, Path((date, name)): Path<(String, String)>) -> Result<Response, ApiErr> {
    let body = blocking(&st, move |c| c.read_note(&date, &name)).await?;
    Ok(([("content-type", "text/markdown; charset=utf-8"), ("x-content-type-options", "nosniff")], body).into_response())
}

pub async fn file(State(st): State<AppState>, Path((room_id, rel)): Path<(String, String)>) -> Result<Response, ApiErr> {
    let path = blocking(&st, move |c| c.resolve_file(&room_id, &rel)).await?;
    // CoreError has no read/not-found variant besides RoomNotFound (misleading here); WriteFailed (500) is the closest fit.
    let bytes = tokio::fs::read(&path).await.map_err(|e| ApiErr(CoreError::WriteFailed(e.to_string())))?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let ct = content_type(&ext);
    Ok(([("content-type", ct), ("x-content-type-options", "nosniff")], bytes).into_response())
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rooms_core::RoomsCore;

    fn state() -> (tempfile::TempDir, AppState) {
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        (d, AppState { core, token: "t".into(), read_only: false, files_origin: String::new(), net: crate::NetConfig::default() })
    }

    /// Spec §5 S3 rule ③: the client drops buffered events with seq ≤ snapshot seq, so the header
    /// must be read before the data. An event emitted while computing the data must NOT be covered.
    #[tokio::test]
    async fn snapshot_reads_seq_before_data() {
        let (_d, st) = state();
        let s0 = st.core.current_seq();
        let r = snapshot(&st, |core: &RoomsCore| core.create_room("during")).await.unwrap_or_else(|_| panic!("snapshot failed"));
        assert_eq!(st.core.current_seq(), s0 + 1);
        assert_eq!(r.headers()["x-rooms-seq"], s0.to_string().as_str());
    }

    #[tokio::test]
    async fn blocking_maps_panic_to_internal_error() {
        let (_d, st) = state();
        let Err(e) = blocking(&st, |_core: &RoomsCore| -> Result<(), CoreError> { panic!("boom") }).await else { panic!("must fail") };
        assert_eq!(e.0.code(), "internal");
        assert_eq!(e.0.status(), 500);
    }
}
