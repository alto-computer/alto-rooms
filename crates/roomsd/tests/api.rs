use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use rooms_core::RoomsCore;
use roomsd::{build_api_router, build_files_router, AppState, NetConfig};
use std::net::SocketAddr;
use tower::ServiceExt;

const API_HOST: &str = "127.0.0.1:4317";
const FILES_HOST: &str = "127.0.0.1:4318";

fn app(read_only: bool, peer: &str) -> (tempfile::TempDir, axum::Router, AppState) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    core.backfill_all().unwrap();
    let st = AppState { core, token: "t0k".into(), read_only, files_origin: "http://127.0.0.1:4318".into(), net: NetConfig::default() };
    let addr: SocketAddr = peer.parse().unwrap();
    (d, build_api_router(st.clone()).layer(MockConnectInfo(addr)), st)
}

async fn body_json(r: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn get(uri: &str, host: &str) -> Request<Body> {
    Request::get(uri).header("host", host).body(Body::empty()).unwrap()
}

fn post(uri: &str, json: &str, token: Option<&str>, host: &str) -> Request<Body> {
    let mut b = Request::post(uri).header("content-type", "application/json").header("host", host);
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::from(json.to_string())).unwrap()
}

#[tokio::test]
async fn info_and_rooms_with_seq_header() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let r = app.clone().oneshot(get("/v1/info", API_HOST)).await.unwrap();
    let v = body_json(r).await;
    assert_eq!(v["version"], "1");
    assert_eq!(v["journalRoomId"], "journal");
    let r = app.oneshot(get("/v1/rooms", "localhost:4317")).await.unwrap();
    assert!(r.headers().get("x-rooms-seq").is_some());
    assert_eq!(r.status(), StatusCode::OK);
}

#[tokio::test]
async fn get_with_foreign_host_is_forbidden() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let r = app.clone().oneshot(get("/v1/rooms", "evil.example:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(r).await["error"], "forbidden_host");
    let r = app.oneshot(Request::get("/v1/info").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn read_only_listener_skips_host_check_but_refuses_writes() {
    let (_d, app, _) = app(true, "100.64.1.2:5000");
    let r = app.clone().oneshot(get("/v1/rooms", "100.64.1.1:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let r = app.oneshot(post("/v1/rooms", r#"{"name":"x"}"#, Some("t0k"), "100.64.1.1:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(r).await["error"], "read_only");
}

#[tokio::test]
async fn cors_preflight_allows_tauri_only() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let pre = |origin: &str| Request::options("/v1/rooms").header("host", API_HOST)
        .header("origin", origin).header("access-control-request-method", "POST")
        .header("access-control-request-headers", "authorization,content-type").body(Body::empty()).unwrap();
    let r = app.clone().oneshot(pre("tauri://localhost")).await.unwrap();
    assert_eq!(r.headers()["access-control-allow-origin"], "tauri://localhost");
    let r = app.oneshot(pre("https://evil.example")).await.unwrap();
    assert!(r.headers().get("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn create_room_requires_token_host_and_loopback() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let ok = app.clone().oneshot(post("/v1/rooms", r#"{"name":"연구 도구"}"#, Some("t0k"), "127.0.0.1:4317")).await.unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let no_token = app.clone().oneshot(post("/v1/rooms", r#"{"name":"b"}"#, None, "127.0.0.1:4317")).await.unwrap();
    assert_eq!(no_token.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(no_token).await["error"], "read_only");
    let rebinding = app.clone().oneshot(post("/v1/rooms", r#"{"name":"c"}"#, Some("t0k"), "evil.example:4317")).await.unwrap();
    assert_eq!(rebinding.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(rebinding).await["error"], "forbidden_host");
    let dup = app.oneshot(post("/v1/rooms", r#"{"name":"연구-도구"}"#, Some("t0k"), "localhost:4317")).await.unwrap();
    assert_eq!(dup.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(dup).await["error"], "room_exists");
}

#[tokio::test]
async fn remote_peer_cannot_write_even_with_token() {
    let (_d, app, _) = app(false, "100.64.1.2:5000");
    let r = app.oneshot(post("/v1/rooms", r#"{"name":"x"}"#, Some("t0k"), "127.0.0.1:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(r).await["error"], "read_only");
}

#[tokio::test]
async fn foreign_origin_is_rejected() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let mut req = post("/v1/rooms", r#"{"name":"x"}"#, Some("t0k"), "127.0.0.1:4317");
    req.headers_mut().insert("origin", "https://evil.example".parse().unwrap());
    let r = app.oneshot(req).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(r).await["error"], "read_only");
}

#[tokio::test]
async fn note_put_and_journal_get() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let req = Request::put("/v1/journal/2026-10-05/notes/%ED%9A%8C%EA%B3%A0") // "회고" percent-encoded
        .header("host", "127.0.0.1:4317").header("authorization", "Bearer t0k")
        .header("content-type", "text/markdown").body(Body::from("# 오늘")).unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);
    let r = app.oneshot(get("/v1/journal/2026-10-05", API_HOST)).await.unwrap();
    assert_eq!(body_json(r).await["notes"][0]["name"], "회고.md");
}

#[tokio::test]
async fn unknown_room_is_404_and_bad_date_400() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let r = app.clone().oneshot(get("/v1/rooms/nope/artifacts", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = app.oneshot(get("/v1/journal/2026-13-40", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn files_router_sets_sandbox_csp_and_blocks_escape() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), "<p>hi</p>").unwrap();
    let files = build_files_router(st);
    let r = files.clone().oneshot(get(&format!("/{}/x.html", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-security-policy"], "sandbox allow-scripts allow-popups");
    let r = files.clone().oneshot(get(&format!("/{}/..%2Fjournal", room.id), "localhost:4318")).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(r.headers()["content-security-policy"], "sandbox allow-scripts allow-popups");
    let r = files.oneshot(get(&format!("/{}/x.html", room.id), "evil.example:4318")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn files_content_types_and_forbidden_csp() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/s.css"), "p{}").unwrap();
    std::fs::write(d.path().join("a/m.JS"), "export{}").unwrap();
    std::fs::write(d.path().join("a/z.xyz"), "?").unwrap();
    let files = build_files_router(st);
    for (f, ct) in [("s.css", "text/css; charset=utf-8"), ("m.JS", "text/javascript; charset=utf-8"), ("z.xyz", "application/octet-stream")] {
        let r = files.clone().oneshot(get(&format!("/{}/{f}", room.id), FILES_HOST)).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK, "{f}");
        assert_eq!(r.headers()["content-type"], ct, "{f}");
        assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    }
    let r = files.oneshot(get(&format!("/{}/s.css", room.id), "evil.example:4318")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(r.headers()["content-security-policy"], "sandbox allow-scripts allow-popups");
}

/// Next SSE frame carrying data, as (id, parsed data).
async fn next_event(body: &mut Body) -> (String, serde_json::Value) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match body.frame().await {
                None => panic!("event stream ended"),
                Some(Ok(f)) => {
                    let Ok(d) = f.into_data() else { continue };
                    let s = String::from_utf8_lossy(&d).to_string();
                    let Some(data) = s.lines().find_map(|l| l.strip_prefix("data:")) else { continue };
                    let id = s.lines().find_map(|l| l.strip_prefix("id:")).expect("id line").trim().to_string();
                    return (id, serde_json::from_str(data.trim()).unwrap());
                }
                Some(Err(e)) => panic!("stream error: {e}"),
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn events_stream_starts_with_resync_at_current_seq() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    st.core.create_room("before").unwrap();
    let seq = st.core.current_seq();
    let r = app.oneshot(get("/v1/events", API_HOST)).await.unwrap();
    let mut body = r.into_body();
    let (id, v) = next_event(&mut body).await;
    assert_eq!(v["type"], "resync");
    assert!(v["roomId"].is_null());
    assert_eq!(v["seq"].as_u64().unwrap(), seq);
    assert_eq!(id, seq.to_string());
}

#[tokio::test]
async fn events_stream_delivers_room_added_with_seq() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let r = app.oneshot(get("/v1/events", API_HOST)).await.unwrap();
    assert_eq!(r.headers()["content-type"], "text/event-stream");
    let mut body = r.into_body();
    st.core.create_room("x").unwrap();
    let (_, first) = next_event(&mut body).await;
    assert_eq!(first["type"], "resync", "every connection starts with resync");
    let (id, v) = next_event(&mut body).await;
    assert_eq!(v["type"], "room.added");
    assert_eq!(v["seq"].as_u64().unwrap().to_string(), id);
    assert!(v["seq"].as_u64().unwrap() > first["seq"].as_u64().unwrap());
}

#[tokio::test]
async fn note_get_returns_markdown_and_404_for_missing() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let put = Request::put("/v1/journal/2026-10-05/notes/%EA%B3%84%ED%9A%8D")
        .header("host", "127.0.0.1:4317").header("authorization", "Bearer t0k")
        .header("content-type", "text/markdown").body(Body::from("- 할 일")).unwrap();
    assert_eq!(app.clone().oneshot(put).await.unwrap().status(), StatusCode::OK);
    let r = app.clone().oneshot(Request::get("/v1/journal/2026-10-05/notes/%EA%B3%84%ED%9A%8D").header("host", "127.0.0.1:4317").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.headers()["content-type"].to_str().unwrap().starts_with("text/markdown"));
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(&r.into_body().collect().await.unwrap().to_bytes()[..], "- 할 일".as_bytes());
    let r = app.oneshot(Request::get("/v1/journal/2026-10-05/notes/none").header("host", "127.0.0.1:4317").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(r).await["error"], "not_found");
}

#[tokio::test]
async fn custom_ports_and_dev_origin() {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let net = NetConfig { api_port: 14317, files_port: 14318, dev_origin: Some("http://localhost:4173".into()) };
    let st = AppState { core, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:14318".into(), net };
    let app = build_api_router(st).layer(MockConnectInfo("127.0.0.1:5000".parse::<SocketAddr>().unwrap()));
    let mut ok = post("/v1/rooms", r#"{"name":"a"}"#, Some("t0k"), "127.0.0.1:14317");
    ok.headers_mut().insert("origin", "http://localhost:4173".parse().unwrap());
    assert_eq!(app.clone().oneshot(ok).await.unwrap().status(), StatusCode::OK);
    let old_port = Request::get("/v1/rooms").header("host", "127.0.0.1:4317").body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(old_port).await.unwrap().status(), StatusCode::FORBIDDEN);
    let mut evil = post("/v1/rooms", r#"{"name":"b"}"#, Some("t0k"), "127.0.0.1:14317");
    evil.headers_mut().insert("origin", "http://localhost:9999".parse().unwrap());
    assert_eq!(app.oneshot(evil).await.unwrap().status(), StatusCode::FORBIDDEN);
}

fn dev_app() -> axum::Router {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let net = NetConfig { api_port: 14317, files_port: 14318, dev_origin: Some("http://localhost:4173".into()) };
    let st = AppState { core, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:14318".into(), net };
    std::mem::forget(d);
    build_api_router(st).layer(MockConnectInfo("127.0.0.1:5000".parse::<SocketAddr>().unwrap()))
}

fn preflight(origin: &str) -> Request<Body> {
    Request::builder().method("OPTIONS").uri("/v1/rooms").header("host", "127.0.0.1:14317")
        .header("origin", origin).header("access-control-request-method", "POST").body(Body::empty()).unwrap()
}

#[tokio::test]
async fn null_origin_is_rejected_even_with_dev_origin() {
    let app = dev_app();
    let mut w = post("/v1/rooms", r#"{"name":"a"}"#, Some("t0k"), "127.0.0.1:14317");
    w.headers_mut().insert("origin", "null".parse().unwrap());
    assert_eq!(app.clone().oneshot(w).await.unwrap().status(), StatusCode::FORBIDDEN);
    let r = app.oneshot(preflight("null")).await.unwrap();
    assert!(r.headers().get("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn cors_preflight_allows_dev_origin() {
    let r = dev_app().oneshot(preflight("http://localhost:4173")).await.unwrap();
    assert_eq!(r.headers()["access-control-allow-origin"], "http://localhost:4173");
}

#[tokio::test]
async fn files_host_guard_uses_custom_port() {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let net = NetConfig { api_port: 14317, files_port: 14318, dev_origin: None };
    let st = AppState { core, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:14318".into(), net };
    let app = build_files_router(st);
    let bad = app.clone().oneshot(get("/x/y.html", "127.0.0.1:4318")).await.unwrap();
    assert_eq!(bad.status(), StatusCode::FORBIDDEN);
    let ok = app.oneshot(get("/x/y.html", "127.0.0.1:14318")).await.unwrap();
    assert_ne!(ok.status(), StatusCode::FORBIDDEN);
}

fn put_note(app: &axum::Router, name: &str, body: &str) -> impl std::future::Future<Output = StatusCode> {
    let req = Request::put(format!("/v1/journal/2026-10-05/notes/{name}"))
        .header("host", API_HOST).header("authorization", "Bearer t0k")
        .header("content-type", "text/markdown").body(Body::from(body.to_string())).unwrap();
    let app = app.clone();
    async move { app.oneshot(req).await.unwrap().status() }
}

#[tokio::test]
async fn note_rename_returns_the_note_and_moves_the_body() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    assert_eq!(put_note(&app, "New%20Note", "본문").await, StatusCode::OK);
    let r = app.clone().oneshot(post("/v1/journal/2026-10-05/notes/New%20Note/rename", r#"{"to":"회고"}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let v = body_json(r).await;
    assert_eq!(v["name"], "회고.md");
    assert_eq!(v["relPath"], "2026-10-05/회고.md");
    let r = app.oneshot(get("/v1/journal/2026-10-05/notes/%ED%9A%8C%EA%B3%A0", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(&r.into_body().collect().await.unwrap().to_bytes()[..], "본문".as_bytes());
}

#[tokio::test]
async fn note_rename_missing_is_404_and_taken_is_409() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let r = app.clone().oneshot(post("/v1/journal/2026-10-05/notes/none/rename", r#"{"to":"x"}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(r).await["error"], "not_found");
    assert_eq!(put_note(&app, "a", "A").await, StatusCode::OK);
    assert_eq!(put_note(&app, "b", "B").await, StatusCode::OK);
    let r = app.oneshot(post("/v1/journal/2026-10-05/notes/a/rename", r#"{"to":"B"}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(r).await["error"], "note_exists");
}

#[tokio::test]
async fn note_rename_is_behind_the_write_guard() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    st.core.save_note(&"2026-10-05".to_string(), "a", "A").unwrap();
    let uri = "/v1/journal/2026-10-05/notes/a/rename";
    let r = app.clone().oneshot(post(uri, r#"{"to":"b"}"#, None, API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(r).await["error"], "read_only");
    let r = app.clone().oneshot(post(uri, r#"{"to":"b"}"#, Some("t0k"), "evil.example:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let (_d2, remote, st2) = self::app(false, "100.64.1.2:5000");
    st2.core.save_note(&"2026-10-05".to_string(), "a", "A").unwrap();
    let r = remote.oneshot(post(uri, r#"{"to":"b"}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let (_d3, ro, st3) = self::app(true, "100.64.1.2:5000");
    st3.core.save_note(&"2026-10-05".to_string(), "a", "A").unwrap();
    let r = ro.oneshot(post(uri, r#"{"to":"b"}"#, Some("t0k"), "100.64.1.1:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(st.core.read_note(&"2026-10-05".to_string(), "a").unwrap(), "A");
    assert_eq!(st3.core.read_note(&"2026-10-05".to_string(), "a").unwrap(), "A");
    // The same request passes once token, host and peer are all right.
    let r = app.oneshot(post(uri, r#"{"to":"b"}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
}

/// An indexed symlink `inbox/spec.html` to an original outside home, plus an owned room `a`.
fn inbox_artifact(st: &AppState) -> (tempfile::TempDir, rooms_protocol::Artifact, rooms_protocol::Room) {
    let o = tempfile::tempdir().unwrap();
    std::fs::write(o.path().join("spec.html"), "<title>S</title>").unwrap();
    std::os::unix::fs::symlink(o.path().join("spec.html"), st.core.home().join("inbox/spec.html")).unwrap();
    st.core.rescan_room(&"inbox".to_string());
    let a = st.core.list_artifacts(&"inbox".to_string()).unwrap().remove(0);
    let r = st.core.create_room("a").unwrap();
    (o, a, r)
}

#[tokio::test]
async fn artifact_move_returns_the_moved_artifact() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let (_o, a, r) = inbox_artifact(&st);
    let body = format!(r#"{{"roomId":"inbox","artifactId":"{}","toRoomId":"{}"}}"#, a.id, r.id);
    let res = app.oneshot(post("/v1/artifacts/move", &body, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    assert_eq!((v["roomId"].as_str(), v["relPath"].as_str()), (Some(r.id.as_str()), Some("spec.html")));
    assert_eq!(v["createdAt"].as_str(), Some(a.created_at.as_str()));
    assert_eq!(st.core.list_artifacts(&r.id).unwrap()[0].id, v["id"].as_str().unwrap());
}

#[tokio::test]
async fn artifact_move_without_token_is_403() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let (_o, a, r) = inbox_artifact(&st);
    let body = format!(r#"{{"roomId":"inbox","artifactId":"{}","toRoomId":"{}"}}"#, a.id, r.id);
    let res = app.oneshot(post("/v1/artifacts/move", &body, None, API_HOST)).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(res).await["error"], "read_only");
    assert_eq!(st.core.list_artifacts(&"inbox".to_string()).unwrap().len(), 1);
}

#[tokio::test]
async fn artifact_move_to_linked_room_is_400() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let (_o, a, _r) = inbox_artifact(&st);
    let team = tempfile::tempdir().unwrap();
    let l = st.core.link_folder(team.path(), Some("linked")).unwrap();
    let body = format!(r#"{{"roomId":"inbox","artifactId":"{}","toRoomId":"{}"}}"#, a.id, l.id);
    let res = app.oneshot(post("/v1/artifacts/move", &body, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(res).await["error"], "invalid_input");
    assert!(std::fs::read_dir(team.path()).unwrap().next().is_none());
}
