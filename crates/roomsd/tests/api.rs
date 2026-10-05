use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use rooms_core::RoomsCore;
use roomsd::{build_api_router, build_files_router, AppState};
use std::net::SocketAddr;
use tower::ServiceExt;

const API_HOST: &str = "127.0.0.1:4317";
const FILES_HOST: &str = "127.0.0.1:4318";

fn app(read_only: bool, peer: &str) -> (tempfile::TempDir, axum::Router, AppState) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    core.backfill_all().unwrap();
    let st = AppState { core, token: "t0k".into(), read_only, files_origin: "http://127.0.0.1:4318".into() };
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

#[tokio::test]
async fn events_stream_delivers_room_added_with_seq() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let r = app.oneshot(get("/v1/events", API_HOST)).await.unwrap();
    assert_eq!(r.headers()["content-type"], "text/event-stream");
    let mut body = r.into_body();
    st.core.create_room("x").unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match body.frame().await {
                None => panic!("event stream ended"),
                Some(Ok(f)) => {
                    if let Ok(d) = f.into_data() {
                        let s = String::from_utf8_lossy(&d).to_string();
                        if s.contains("room.added") { return s; }
                    }
                }
                Some(Err(e)) => panic!("stream error: {e}"),
            }
        }
    })
    .await
    .unwrap();
    let id = frame.lines().find_map(|l| l.strip_prefix("id:")).expect("id line").trim().to_string();
    let data = frame.lines().find_map(|l| l.strip_prefix("data:")).expect("data line").trim();
    let v: serde_json::Value = serde_json::from_str(data).unwrap();
    assert_eq!(v["type"], "room.added");
    assert_eq!(v["seq"].as_u64().unwrap().to_string(), id);
}
