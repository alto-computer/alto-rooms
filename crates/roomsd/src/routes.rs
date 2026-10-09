use crate::AppState;
use axum::body::Body;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rooms_core::asks::{AskError, Request, ScopeKey};
use rooms_core::plugins::{ContentScript, PluginAsset};
use rooms_core::{CoreError, RoomsCore};
use rooms_protocol::*;
use serde::Deserialize;

/// A JSON error response: `{error: code, message}` with the error's own status.
fn error_response(status: u16, code: &str, message: String) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(ApiError { error: code.into(), message })).into_response()
}

pub struct ApiErr(pub CoreError);
impl IntoResponse for ApiErr {
    fn into_response(self) -> Response { error_response(self.0.status(), self.0.code(), self.0.to_string()) }
}
impl From<CoreError> for ApiErr { fn from(e: CoreError) -> Self { ApiErr(e) } }

pub struct AskErr(AskError);
impl From<AskError> for AskErr { fn from(e: AskError) -> Self { AskErr(e) } }
impl IntoResponse for AskErr {
    fn into_response(self) -> Response { error_response(self.0.status(), self.0.code(), self.0.to_string()) }
}

pub async fn start_ask(State(st): State<AppState>, b: Result<Json<StartAsk>, JsonRejection>) -> Result<(StatusCode, Json<AskTurn>), AskErr> {
    let Json(b) = b.map_err(|e| AskError::BadRequest(e.body_text()))?;
    let turn = ask_blocking(&st, move |a| {
        let images = b.images.unwrap_or_default();
        let req = Request { question: &b.question, model: b.model.as_deref(), images: &images, kind: b.kind.unwrap_or_default() };
        a.start_with(&b.scope, req)
    }).await?;
    Ok((StatusCode::ACCEPTED, Json(turn)))
}

/// `blocking` for `Asks`: start/thread do SQLite and file IO under a std Mutex.
async fn ask_blocking<T, F>(st: &AppState, f: F) -> Result<T, AskErr>
where
    T: Send + 'static,
    F: FnOnce(&rooms_core::asks::Asks) -> Result<T, AskError> + Send + 'static,
{
    let asks = st.asks.clone();
    tokio::task::spawn_blocking(move || f(&asks)).await.map_err(|e| AskError::Io(e.to_string()))?.map_err(AskErr)
}

/// `?scope=<key>`: `doc:<fileKey>`, `room:<roomId>` or `day:<YYYY-MM-DD>`.
#[derive(Deserialize)]
pub struct ScopeQuery { scope: String }

fn scope_of(q: Result<Query<ScopeQuery>, QueryRejection>) -> Result<AskScope, AskError> {
    let Query(q) = q.map_err(|e| AskError::BadRequest(e.body_text()))?;
    AskScope::parse_key(&q.scope)
}

pub async fn ask_thread(State(st): State<AppState>, q: Result<Query<ScopeQuery>, QueryRejection>) -> Result<Json<Vec<AskTurn>>, AskErr> {
    let scope = scope_of(q)?;
    Ok(Json(ask_blocking(&st, move |a| a.thread(&scope)).await?))
}

pub async fn ask_target(State(st): State<AppState>, q: Result<Query<ScopeQuery>, QueryRejection>) -> Result<Json<AskTarget>, AskErr> {
    let scope = scope_of(q)?;
    Ok(Json(ask_blocking(&st, move |a| a.target(&scope)).await?))
}

/// The raw image bytes; the type is read from them, not from content-type.
pub async fn upload_ask_image(State(st): State<AppState>, body: axum::body::Bytes) -> Result<(StatusCode, Json<AskImage>), AskErr> {
    let id = ask_blocking(&st, move |a| a.save_image(&body)).await?;
    Ok((StatusCode::CREATED, Json(AskImage { id })))
}

/// A question image on the files origin. Named by its hash, so it never changes: cache it for good.
pub async fn ask_image(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(path) = st.asks.image_path(&id) else { return ApiErr(CoreError::NotFound).into_response() };
    let Ok(body) = file_body(&path).await else { return ApiErr(CoreError::NotFound).into_response() };
    let ct = rooms_core::asks::images::content_type(&id);
    ([("content-type", ct), ("x-content-type-options", "nosniff"), ("cache-control", "private, max-age=31536000, immutable")], body).into_response()
}

pub async fn cancel_ask(State(st): State<AppState>, Path(ask_id): Path<String>) -> StatusCode {
    // 404 tells the app its "running" turn is stale, so it reloads the thread.
    if st.asks.cancel(&ask_id) { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }
}

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
    h.insert("x-rooms-seq", HeaderValue::from(seq));
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

// `deserialize_with` makes `color` required: `{}` is refused instead of read as an unpin.
#[derive(Deserialize)] pub struct RoomColorBody { #[serde(deserialize_with = "Option::deserialize")] color: Option<RoomColor> }
/// Pins a room with a colour, or unpins it (`null`); returns the room. The new order, if it
/// changed, arrives as `rooms.reordered`.
pub async fn set_room_color(State(st): State<AppState>, Path(room_id): Path<String>, Json(b): Json<RoomColorBody>) -> Result<Json<Room>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.set_room_color(&room_id, b.color)).await?))
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

/// A weak validator from the file's identity (device, inode), length and mtime: cheap (no read),
/// changes on every rewrite, and differs between two files of equal size and mtime (a link
/// retargeted to another original).
fn etag_of(meta: &std::fs::Metadata, suffix: &str) -> Option<HeaderValue> {
    use std::os::unix::fs::MetadataExt;
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    HeaderValue::from_str(&format!("W/\"{:x}-{:x}-{:x}-{:x}{suffix}\"", meta.dev(), meta.ino(), meta.len(), mtime)).ok()
}

/// Whether `If-None-Match` (all its header lines) matches `tag`: `*`, or any listed tag equal
/// to it by weak comparison (opaque tags equal, `W/` ignored; RFC 9110 §13.1.2).
fn none_match_hits<'a>(if_none_match: impl Iterator<Item = &'a str>, tag: &str) -> bool {
    fn opaque(t: &str) -> &str { t.trim().trim_start_matches("W/") }
    if_none_match.flat_map(|v| v.split(',')).any(|t| t.trim() == "*" || opaque(t) == opaque(tag))
}

/// Spliced into every HTML document Rooms shows, so "ask about this" works inside docs. The app
/// frames a doc sandboxed with no origin of its own (agent-written HTML must not reach the app), so
/// it can't read the doc's selection; this script, running inside, posts it out instead. It goes
/// right after `<head>`, before any `<meta>` policy the document declares, which would block a
/// script after it (`inject`). The file on disk is untouched.
const SELECTION_BRIDGE: &[u8] = include_bytes!("selection-bridge.html");
/// Bumped when the bridge or its placement changes, so cached documents pick up the new one.
const BRIDGE_VERSION: &str = "b3";

/// `doc=1` asks for the doc-tab variant: the bridge plus the content scripts of enabled plugins.
/// Card previews send nothing and get the bridge alone.
#[derive(Deserialize)]
pub struct FileQuery { doc: Option<String> }

/// The block spliced into an HTML document: the bridge, then one tag per content script. The
/// tag's URL is absolute so a document's `<base href>` cannot redirect it.
fn inject_block(scripts: &[ContentScript], files_origin: &str) -> axum::body::Bytes {
    let attr = |s: &str| s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;");
    let mut block = SELECTION_BRIDGE.to_vec();
    for s in scripts {
        block.extend_from_slice(format!("<script src=\"{}\"></script>\n", attr(&format!("{files_origin}/_plugins/{}/{}?r={}", s.plugin_id, s.path, s.rev))).as_bytes());
    }
    block.into()
}

/// The ETag suffix of an HTML response: the bridge version, and a hash of the content scripts
/// when there are any, so turning a plugin on or off, or editing its script, misses the cache.
fn inject_version(scripts: &[ContentScript]) -> String {
    use std::hash::{Hash, Hasher};
    if scripts.is_empty() { return BRIDGE_VERSION.to_string(); }
    let mut h = std::hash::DefaultHasher::new();
    for s in scripts { (&s.plugin_id, &s.rev, &s.path).hash(&mut h); }
    format!("{BRIDGE_VERSION}-{:x}", h.finish())
}

/// Serves a room file. Previews remount often (scrolling, tab switches), so responses carry an
/// ETag with `no-cache`: the webview revalidates every time and gets a bodyless 304 while unchanged.
pub async fn file(State(st): State<AppState>, Path((room_id, rel)): Path<(String, String)>, Query(q): Query<FileQuery>, headers: HeaderMap) -> Result<Response, ApiErr> {
    let doc = q.doc.as_deref() == Some("1");
    let (path, ext, scripts) = blocking(&st, move |c| {
        let path = c.resolve_file(&room_id, &rel)?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let scripts = if doc && matches!(ext.as_str(), "html" | "htm") { c.content_scripts() } else { Vec::new() };
        Ok((path, ext, scripts))
    }).await?;
    let read_err = |e: std::io::Error| ApiErr(CoreError::Io(e));
    let html = matches!(ext.as_str(), "html" | "htm");
    let suffix = if html { inject_version(&scripts) } else { String::new() };
    let etag = etag_of(&tokio::fs::metadata(&path).await.map_err(read_err)?, &suffix);
    if let Some(tag) = &etag {
        let tag_str = tag.to_str().unwrap_or_default();
        if none_match_hits(headers.get_all("if-none-match").iter().filter_map(|v| v.to_str().ok()), tag_str) {
            return Ok((StatusCode::NOT_MODIFIED, [("etag", tag.clone()), ("cache-control", HeaderValue::from_static("no-cache"))]).into_response());
        }
    }
    let body = if html {
        let f = tokio::fs::File::open(&path).await.map_err(read_err)?;
        Body::from_stream(crate::inject::splice(inject_block(&scripts, &st.files_origin), tokio_util::io::ReaderStream::new(f)))
    } else {
        file_body(&path).await.map_err(read_err)?
    };
    let mut res = ([("content-type", content_type(&ext)), ("x-content-type-options", "nosniff"), ("cache-control", "no-cache")], body).into_response();
    if let Some(tag) = etag { res.headers_mut().insert("etag", tag); }
    Ok(res)
}

// ---- plugins ----

pub async fn list_tools(State(st): State<AppState>) -> Result<Json<Vec<ToolInfo>>, ApiErr> {
    Ok(Json(blocking(&st, |c| Ok(c.list_tools())).await?))
}

pub async fn call_tool(State(st): State<AppState>, b: Result<Json<ToolCall>, JsonRejection>) -> Result<Json<ToolResult>, ApiErr> {
    let Json(call) = b.map_err(|e| CoreError::BadRequest(e.body_text()))?;
    Ok(Json(blocking(&st, move |c| c.call_tool(&call)).await?))
}

pub async fn list_plugins(State(st): State<AppState>) -> Result<Json<Vec<PluginInfo>>, ApiErr> {
    Ok(Json(blocking(&st, |c| Ok(c.plugins())).await?))
}

/// `permissions`: what the enable card showed; only those (still declared) are granted.
#[derive(Deserialize)] pub struct EnableBody { enabled: bool, #[serde(default)] permissions: Option<Vec<String>> }
pub async fn set_plugin_enabled(State(st): State<AppState>, Path(id): Path<String>, Json(b): Json<EnableBody>) -> Result<Json<PluginInfo>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.set_plugin_enabled(&id, b.enabled, b.permissions)).await?))
}

#[derive(Deserialize)] pub struct PrefixQuery { #[serde(default)] prefix: String }
pub async fn list_plugin_data(State(st): State<AppState>, Path(id): Path<String>, axum::extract::Query(q): axum::extract::Query<PrefixQuery>) -> Result<Json<Vec<String>>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.list_plugin_data(&id, &q.prefix)).await?))
}

pub async fn get_plugin_data(State(st): State<AppState>, Path((id, path)): Path<(String, String)>) -> Result<Response, ApiErr> {
    let text = blocking(&st, move |c| c.read_plugin_data(&id, &path)?.ok_or(CoreError::NotFound)).await?;
    Ok(([("content-type", "text/plain; charset=utf-8")], text).into_response())
}

pub async fn put_plugin_data(State(st): State<AppState>, Path((id, path)): Path<(String, String)>, body: String) -> Result<StatusCode, ApiErr> {
    blocking(&st, move |c| c.write_plugin_data(&id, &path, &body)).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_plugin_data(State(st): State<AppState>, Path((id, path)): Path<(String, String)>) -> Result<StatusCode, ApiErr> {
    blocking(&st, move |c| c.delete_plugin_data(&id, &path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn artifact_by_file_key(State(st): State<AppState>, Path(key): Path<String>) -> Result<Json<Artifact>, ApiErr> {
    Ok(Json(blocking(&st, move |c| c.artifact_by_file_key(&key).ok_or(CoreError::NotFound)).await?))
}

/// A plugin asset with the plugin's own CSP: sources limited to `/_plugins/<id>/`, no network, no
/// frames, and sandbox tokens from its declared permissions (never popups or same-origin).
pub async fn plugin_file(State(st): State<AppState>, Path((id, rel)): Path<(String, String)>) -> Response {
    let id2 = id.clone();
    let Ok(PluginAsset { path, permissions: perms }) = blocking(&st, move |c| c.resolve_plugin_file(&id2, &rel)).await else {
        return ApiErr(CoreError::NotFound).into_response();
    };
    let Ok(body) = file_body(&path).await else { return ApiErr(CoreError::NotFound).into_response() };
    let src = format!("{}/_plugins/{}/", st.files_origin, id);
    let sandbox = if perms.iter().any(|p| p == "downloads") { "sandbox allow-scripts allow-downloads" } else { "sandbox allow-scripts" };
    let csp = format!(
        "{sandbox}; default-src 'none'; script-src {src}; style-src {src} 'unsafe-inline'; img-src {src} data: blob:; font-src {src}; connect-src 'none'; frame-src 'none'; form-action 'none'"
    );
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // `*` because a sandboxed frame's origin is `null` and module scripts load in CORS mode. Only
    // plugin code is served here; plugin data never is.
    let mut r = (
        [("content-type", content_type(&ext)), ("x-content-type-options", "nosniff"), ("access-control-allow-origin", "*")],
        body,
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&csp) { r.headers_mut().insert(axum::http::header::CONTENT_SECURITY_POLICY, v); }
    r
}

/// A file's bytes streamed from disk in small chunks: a document with megabytes of inlined images
/// never sits whole in roomsd's memory, however many frames load it at once.
async fn file_body(path: &std::path::Path) -> std::io::Result<Body> {
    let f = tokio::fs::File::open(path).await?;
    Ok(Body::from_stream(tokio_util::io::ReaderStream::new(f)))
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
        "wasm" => "application/wasm",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
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
        let asks = rooms_core::asks::Asks::new(core.clone(), None);
        (d, AppState { core, asks, token: "t".into(), read_only: false, files_origin: String::new(), net: crate::NetConfig::default() })
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

    #[test]
    fn if_none_match_uses_weak_comparison_and_star() {
        let tag = "W/\"1-2\"";
        assert!(none_match_hits(["W/\"1-2\""].into_iter(), tag));
        assert!(none_match_hits(["\"1-2\""].into_iter(), tag), "a strong spelling of the same tag");
        assert!(none_match_hits(["\"x\", W/\"1-2\""].into_iter(), tag));
        assert!(none_match_hits(["\"x\"", "W/\"1-2\""].into_iter(), tag), "a second header line");
        assert!(none_match_hits(["*"].into_iter(), tag));
        assert!(!none_match_hits(["W/\"1-3\""].into_iter(), tag));
        assert!(!none_match_hits(std::iter::empty(), tag));
    }
}
