//! The error wire contract: for every way a route can fail, the exact status, `error` code and
//! `message`. Pinned before the error types were restructured; must not change without a
//! protocol bump.
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::Request;
use http_body_util::BodyExt;
use rooms_core::RoomsCore;
use roomsd::{build_api_router, build_files_router, AppState, NetConfig};
use std::net::SocketAddr;
use tower::ServiceExt;

const API_HOST: &str = "127.0.0.1:4317";
const FILES_HOST: &str = "127.0.0.1:4318";

fn app() -> (tempfile::TempDir, axum::Router, AppState) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let asks = rooms_core::asks::Asks::new(core.clone(), None);
    let st = AppState { core, asks, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:4318".into(), net: NetConfig::default() };
    let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
    (d, build_api_router(st.clone()).layer(MockConnectInfo(addr)), st)
}

fn req(method: &str, uri: &str, body: &str) -> Request<Body> {
    Request::builder().method(method).uri(uri).header("host", API_HOST).header("authorization", "Bearer t0k")
        .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()
}

/// (status, error code, message) of a JSON error response.
async fn wire(app: &axum::Router, r: Request<Body>) -> (u16, String, String) {
    let res = app.clone().oneshot(r).await.unwrap();
    let status = res.status().as_u16();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("{status}: {}", String::from_utf8_lossy(&bytes)));
    let field = |k: &str| v[k].as_str().unwrap_or_else(|| panic!("{status}: {v}")).to_string();
    (status, field("error"), field("message"))
}

fn w(status: u16, code: &str, message: &str) -> (u16, String, String) { (status, code.to_string(), message.to_string()) }

#[tokio::test]
async fn core_errors() {
    let (d, app, st) = app();
    assert_eq!(wire(&app, req("POST", "/v1/rooms", r#"{"name":""}"#)).await, w(400, "invalid_room_name", "invalid room name"));
    st.core.create_room("a").unwrap();
    assert_eq!(wire(&app, req("POST", "/v1/rooms", r#"{"name":"a"}"#)).await, w(409, "room_exists", "room exists"));
    assert_eq!(wire(&app, req("POST", "/v1/rooms/link", r#"{"path":"/nope/nope"}"#)).await, w(400, "invalid_link_path", "invalid link path: not found"));
    let team = tempfile::tempdir().unwrap();
    std::fs::create_dir(team.path().join("sub")).unwrap();
    st.core.link_folder(team.path(), Some("team")).unwrap();
    let sub = format!(r#"{{"path":"{}"}}"#, team.path().join("sub").display());
    assert_eq!(wire(&app, req("POST", "/v1/rooms/link", &sub)).await, w(409, "overlapping_room", "overlapping room"));
    assert_eq!(wire(&app, req("GET", "/v1/rooms/nope/artifacts", "")).await, w(404, "room_not_found", "room not found"));
    assert_eq!(wire(&app, req("GET", "/v1/artifacts/by-file-key/0000000000000000", "")).await, w(404, "not_found", "not found"));
    assert_eq!(wire(&app, req("GET", "/v1/journal/2026-13-40", "")).await, w(400, "invalid_input", "invalid input: date"));
    assert_eq!(wire(&app, req("POST", "/v1/rooms/inbox/move", r#"{"to":1}"#)).await, w(400, "invalid_input", "invalid input: the inbox can't be moved"));
    assert_eq!(wire(&app, req("PUT", "/v1/rooms/inbox/color", r#"{"color":"sage"}"#)).await, w(400, "invalid_input", "invalid input: the inbox can't be pinned"));
    assert_eq!(wire(&app, req("PUT", "/v1/rooms/nope/color", r#"{"color":"sage"}"#)).await, w(404, "room_not_found", "room not found"));
    let big = "x".repeat(1_048_577);
    assert_eq!(wire(&app, req("PUT", "/v1/journal/2026-10-05/notes/a", &big)).await, w(400, "invalid_input", "invalid input: note too large"));
    assert_eq!(wire(&app, req("GET", "/v1/journal/2026-10-05/notes/missing", "")).await, w(404, "not_found", "not found"));
    st.core.save_note(&"2026-10-05".to_string(), "a", "A").unwrap();
    st.core.save_note(&"2026-10-05".to_string(), "b", "B").unwrap();
    assert_eq!(wire(&app, req("POST", "/v1/journal/2026-10-05/notes/a/rename", r#"{"to":"b"}"#)).await, w(409, "note_exists", "note exists"));
    assert_eq!(wire(&app, req("POST", "/v1/journal/2026-10-05/notes/a/rename", r#"{"to":"../x"}"#)).await, w(400, "invalid_input", "invalid input: note name"));
    let body = r#"{"roomId":"inbox","artifactId":"nope","toRoomId":"journal"}"#;
    assert_eq!(wire(&app, req("POST", "/v1/artifacts/move", body)).await, w(400, "invalid_input", "invalid input: journal is not a move room"));
    let files = build_files_router(st.clone());
    let r = Request::get("/inbox/..%2Fjournal").header("host", FILES_HOST).body(Body::empty()).unwrap();
    assert_eq!(wire(&files, r).await, w(400, "path_escape", "path escape"));

    // An IO failure saving state.json (here: a non-empty folder in its place).
    let state = d.path().join(".rooms/state.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir_all(state.join("x")).unwrap();
    let (status, code, message) = wire(&app, req("POST", "/v1/rooms", r#"{"name":"c"}"#)).await;
    assert_eq!((status, code.as_str()), (500, "write_failed"));
    assert!(message.starts_with("write failed: "), "{message}");
}

fn install_plugin(home: &std::path::Path) {
    let dir = home.join(".rooms/plugins/draw");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"),
        r#"{"id":"draw","name":"Draw","version":"0.1.0","minAppVersion":"0.3.0","permissions":[],"slots":{"tab":{"title":"Draw"}},"tools":{"draw":{"description":"Draw things","input":{"type":"object"},"appendTo":"ops/{doc}.jsonl"}}}"#).unwrap();
    std::fs::write(dir.join("index.html"), "<p>draw</p>").unwrap();
}

#[tokio::test]
async fn plugin_errors() {
    let (d, app, st) = app();
    install_plugin(d.path());
    assert_eq!(wire(&app, req("GET", "/v1/plugins/draw/data/a.txt", "")).await, w(404, "not_found", "not found"));
    assert_eq!(wire(&app, req("PATCH", "/v1/plugins/nope", r#"{"enabled":true}"#)).await, w(404, "not_found", "not found"));
    st.core.set_plugin_enabled("draw", true, None).unwrap();
    assert_eq!(wire(&app, req("GET", "/v1/plugins/draw/data/missing.txt", "")).await, w(404, "not_found", "not found"));
    assert_eq!(wire(&app, req("PUT", "/v1/plugins/draw/data/..%2Ftoken", "x")).await, w(400, "invalid_path", "invalid path"));
    assert_eq!(wire(&app, req("GET", "/v1/plugins/draw/data/a%20b", "")).await, w(400, "invalid_path", "invalid path"));
    assert_eq!(wire(&app, req("DELETE", "/v1/plugins/draw/data/..%2Fx", "")).await, w(400, "invalid_path", "invalid path"));
    let big = "x".repeat(10 * 1024 * 1024 + 1);
    assert_eq!(wire(&app, req("PUT", "/v1/plugins/draw/data/big.txt", &big)).await, w(413, "too_large", "too large"));
    let data = d.path().join(".rooms/plugins/draw/data");
    std::fs::create_dir_all(data.join("folder")).unwrap();
    std::fs::write(data.join("bin"), [0xff, 0xfe]).unwrap();
    assert_eq!(wire(&app, req("GET", "/v1/plugins/draw/data/bin", "")).await, w(400, "invalid_input", "invalid input: not_text"));
    let (status, code, message) = wire(&app, req("GET", "/v1/plugins/draw/data/folder", "")).await;
    assert_eq!((status, code.as_str()), (400, "invalid_input"));
    assert!(message.starts_with("invalid input: is a folder: "), "{message}");

    // An invalid manifest can't be turned on.
    std::fs::create_dir_all(d.path().join(".rooms/plugins/bad")).unwrap();
    std::fs::write(d.path().join(".rooms/plugins/bad/manifest.json"), "{").unwrap();
    assert_eq!(wire(&app, req("PATCH", "/v1/plugins/bad", r#"{"enabled":true}"#)).await, w(400, "invalid_input", "invalid input: manifest.json is not valid JSON"));
}

#[tokio::test]
async fn tool_errors() {
    let (d, app, st) = app();
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), "<title>x</title>").unwrap();
    st.core.backfill_all().unwrap();
    let key = st.core.list_artifacts(&room.id).unwrap()[0].file_key.clone();
    install_plugin(d.path());
    let call = |body: &str| req("POST", "/v1/tools/call", body);
    assert_eq!(wire(&app, call(r#"{"pluginId":"draw","name":"draw","input":{}}"#)).await, w(404, "not_found", "not found"), "disabled");
    st.core.set_plugin_enabled("draw", true, None).unwrap();
    let (status, code, _) = wire(&app, call("not json")).await;
    assert_eq!((status, code.as_str()), (400, "bad_request"));
    assert_eq!(wire(&app, call(r#"{"pluginId":"draw","name":"draw","input":[]}"#)).await, w(400, "bad_request", "input must be an object"));
    assert_eq!(wire(&app, call(r#"{"pluginId":"draw","name":"draw","input":{}}"#)).await, w(400, "bad_request", "doc is required"));
    assert_eq!(wire(&app, call(r#"{"pluginId":"draw","name":"draw","input":{"doc":"rel/x.html"}}"#)).await, w(400, "bad_request", "doc must be a fileKey or an absolute path"));
    let huge = format!(r#"{{"pluginId":"draw","name":"draw","input":{{"doc":"{key}","x":"{}"}}}}"#, "x".repeat(64 * 1024));
    assert_eq!(wire(&app, call(&huge)).await, w(400, "bad_request", "input too large"));
    assert_eq!(wire(&app, call(r#"{"pluginId":"draw","name":"nope","input":{"doc":"0000000000000000"}}"#)).await, w(404, "not_found", "not found"));
    assert_eq!(wire(&app, call(r#"{"pluginId":"draw","name":"draw","input":{"doc":"0000000000000000"}}"#)).await, w(404, "not_found", "not found"));
    let ok = format!(r#"{{"pluginId":"draw","name":"draw","input":{{"doc":"{key}"}}}}"#);
    // A symlink in the plugin's data folder is refused; on this route it reads as invalid_input.
    let data = d.path().join(".rooms/plugins/draw/data");
    std::fs::create_dir_all(&data).unwrap();
    std::os::unix::fs::symlink(d.path(), data.join("ops")).unwrap();
    assert_eq!(wire(&app, call(&ok)).await, w(400, "invalid_input", "invalid input: invalid_path"));
    std::fs::remove_file(data.join("ops")).unwrap();
    st.core.write_plugin_data("draw", &format!("ops/{key}.jsonl"), &"x".repeat(10 * 1024 * 1024)).unwrap();
    assert_eq!(wire(&app, call(&ok)).await, w(413, "too_large", "too large"));
}

#[tokio::test]
async fn ask_errors() {
    let (d, app, st) = app();
    assert_eq!(wire(&app, req("GET", "/v1/asks?scope=doc:..%2Fx", "")).await, w(400, "bad_request", "bad scope key"));
    assert_eq!(wire(&app, req("GET", "/v1/asks/target?scope=doc:0000000000000000", "")).await, w(404, "not_found", "Can't find this doc"));
    assert_eq!(wire(&app, req("GET", "/v1/asks/target?scope=room:inbox", "")).await, w(400, "bad_request", "Room and day asks are not available yet"));
    let (status, code, _) = wire(&app, req("GET", "/v1/asks", "")).await;
    assert_eq!((status, code.as_str()), (400, "bad_request"));
    std::fs::write(d.path().join("inbox/x.html"), "<title>x</title>").unwrap();
    st.core.backfill_all().unwrap();
    let art = st.core.list_artifacts(&"inbox".to_string()).unwrap().remove(0);
    let body = format!(r#"{{"scope":{{"kind":"doc","fileKey":"{}"}},"question":" "}}"#, art.file_key);
    assert_eq!(wire(&app, req("POST", "/v1/asks", &body)).await, w(400, "bad_request", "A question must be 1–8000 characters"));
    std::fs::write(d.path().join(".rooms/agents.toml"), "not = [toml").unwrap();
    let uri = format!("/v1/asks/target?scope=doc:{}", art.file_key);
    let (status, code, message) = wire(&app, req("GET", &uri, "")).await;
    assert_eq!((status, code.as_str()), (422, "agent_config"));
    assert!(message.starts_with("Couldn't read agent settings: "), "{message}");
}
