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
    let asks = rooms_core::asks::Asks::new(core.clone(), None);
    let st = AppState { core, asks, token: "t0k".into(), read_only, files_origin: "http://127.0.0.1:4318".into(), net: NetConfig::default() };
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

fn put_json(uri: &str, json: &str, token: Option<&str>) -> Request<Body> {
    let mut b = Request::put(uri).header("content-type", "application/json").header("host", API_HOST);
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::from(json.to_string())).unwrap()
}

#[tokio::test]
async fn without_collect_data_there_are_no_conversations() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    let r = app.clone().oneshot(get("/v1/rooms/inbox/conversations", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.headers().get("x-rooms-seq").is_some());
    assert_eq!(body_json(r).await, serde_json::json!([]));
    let r = app.clone().oneshot(get("/v1/journal/2026-10-05", API_HOST)).await.unwrap();
    assert_eq!(body_json(r).await["conversations"], serde_json::json!([]));
    let r = app.oneshot(put_json("/v1/conversations/claude-code/s1/room", r#""inbox""#, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn conversations_join_and_leave_a_room() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    let data = d.path().join("collect");
    let db = rooms_collect::store::open(&rooms_collect::store::path_in(&data)).unwrap();
    db.execute("INSERT INTO events(id, kind, agent, session, ts, role, src_path, file_key, src_offset, src_len, preview)
                VALUES('e1', 'message', 'codex', 's-1', '2026-10-05T01:00:00Z', 'user', '/log', 'k', 0, 0, 'tidy the report')", []).unwrap();
    st.core.set_collect_data(&data);
    let r = app.clone().oneshot(put_json("/v1/conversations/codex/s-1/room", r#""inbox""#, None)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN, "writes need the token");
    let r = app.clone().oneshot(put_json("/v1/conversations/codex/s-1/room", r#""inbox""#, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let v = body_json(r).await;
    assert_eq!((&v["roomId"], &v["title"], &v["id"]), (&serde_json::json!("inbox"), &serde_json::json!("tidy the report"), &serde_json::json!({"agent": "codex", "session": "s-1"})));
    let r = app.clone().oneshot(get("/v1/rooms/inbox/conversations", API_HOST)).await.unwrap();
    assert_eq!(body_json(r).await.as_array().map(Vec::len), Some(1));
    let r = app.clone().oneshot(put_json("/v1/conversations/codex/s-1/room", "null", Some("t0k"))).await.unwrap();
    assert_eq!(body_json(r).await["roomId"], serde_json::Value::Null);
    let r = app.clone().oneshot(get("/v1/rooms/inbox/conversations", API_HOST)).await.unwrap();
    assert_eq!(body_json(r).await, serde_json::json!([]));
    for (uri, body) in [("/v1/conversations/cursor/s-1/room", r#""inbox""#), ("/v1/conversations/codex/s%3B1/room", r#""inbox""#), ("/v1/conversations/codex/s-1/room", "{}")] {
        let r = app.clone().oneshot(put_json(uri, body, Some("t0k"))).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{uri} {body}");
    }
    let r = app.oneshot(put_json("/v1/conversations/codex/s-1/room", r#""nope""#, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
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
async fn files_stream_a_big_document_whole() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    // Several read chunks' worth, with bytes that differ along the way.
    let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(d.path().join("a/big.html"), &big).unwrap();
    let files = build_files_router(st);
    let r = files.oneshot(get(&format!("/{}/big.html", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-type"], "text/html; charset=utf-8");
    // No <head> anywhere, so the bridge Rooms splices into every HTML document goes first, then the whole file.
    let body = r.into_body().collect().await.unwrap().to_bytes();
    let head = std::str::from_utf8(&body[..body.len() - big.len()]).unwrap();
    assert!(head.starts_with("<script data-rooms-bridge>") && head.contains("roomsSelection") && head.contains("roomsTone"), "{head}");
    assert_eq!(&body[body.len() - big.len()..], big.as_slice());
    assert_eq!(std::fs::read(d.path().join("a/big.html")).unwrap(), big, "the file on disk is unchanged");
}

const DOC: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head><body><p>hi</p></body></html>\n";

/// The bytes between `<head>` and the file's own `<meta charset>`: what Rooms spliced in.
fn spliced(body: &str) -> &str {
    let (start, rest) = body.split_once("<head>").unwrap();
    assert_eq!(start, "<!doctype html><html>");
    let (block, rest) = rest.split_once("<meta charset=\"utf-8\">").unwrap();
    assert_eq!(rest, "<title>t</title></head><body><p>hi</p></body></html>\n", "the rest of the file is untouched, nothing after </html>");
    block
}

#[tokio::test]
async fn only_html_gets_the_selection_bridge() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.css"), "p{}").unwrap();
    std::fs::write(d.path().join("a/x.html"), DOC).unwrap();
    let files = build_files_router(st);
    let r = files.clone().oneshot(get(&format!("/{}/x.css", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(r.into_body().collect().await.unwrap().to_bytes().as_ref(), b"p{}");
    let r = files.oneshot(get(&format!("/{}/x.html", room.id), FILES_HOST)).await.unwrap();
    let block = text(r).await;
    let block = spliced(&block);
    assert!(block.starts_with("<script data-rooms-bridge>") && block.trim_end().ends_with("</script>") && block.contains("roomsSelection"), "{block}");
    assert_eq!(block.matches("<script").count(), 1, "the bridge alone");
}

fn install_marker(home: &std::path::Path, id: &str) {
    let dir = home.join(".rooms/plugins").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), format!(
        r#"{{"id":"{id}","name":"{id}","version":"0.1.0","minAppVersion":"0.3.0","permissions":["artifact.content"],"contentScripts":["content.js","lib/more.js"]}}"#)).unwrap();
    std::fs::write(dir.join("content.js"), "mark()").unwrap();
    std::fs::create_dir_all(dir.join("lib")).unwrap();
    std::fs::write(dir.join("lib/more.js"), "more()").unwrap();
}

fn rev_of(st: &AppState, id: &str) -> String {
    st.core.plugins().into_iter().find(|p| p.id == id).unwrap().rev
}

#[tokio::test]
async fn doc_variant_injects_bridge_then_content_scripts() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), DOC).unwrap();
    install_marker(d.path(), "marker");
    install_marker(d.path(), "alpha");
    install_marker(d.path(), "off");
    install_marker(d.path(), "unapproved");
    install_echo(d.path(), r#"["rooms.read"]"#);
    for id in ["marker", "alpha", "echo"] { st.core.set_plugin_enabled(id, true, None).unwrap(); }
    st.core.set_plugin_enabled("unapproved", true, Some(Vec::new())).unwrap();
    let files = build_files_router(st.clone());
    let r = files.clone().oneshot(get(&format!("/{}/x.html?v=1&doc=1&cs=abc", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-type"], "text/html; charset=utf-8");
    let body = text(r).await;
    let block = spliced(&body);
    let (bridge, tags) = block.split_once("</script>\n").unwrap();
    assert!(bridge.starts_with("<script data-rooms-bridge>"), "{bridge}");
    let tag = |id: &str, path: &str| format!("<script src=\"http://127.0.0.1:4318/_plugins/{id}/{path}?r={}\"></script>\n", rev_of(&st, id));
    assert_eq!(tags, format!("{}{}{}{}", tag("alpha", "content.js"), tag("alpha", "lib/more.js"), tag("marker", "content.js"), tag("marker", "lib/more.js")));
    assert_eq!(std::fs::read_to_string(d.path().join("a/x.html")).unwrap(), DOC, "the file on disk is unchanged");

    std::fs::write(d.path().join("a/x.svg"), "<svg/>").unwrap();
    let r = files.oneshot(get(&format!("/{}/x.svg?doc=1", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(text(r).await, "<svg/>", "a non-HTML file is served as is, whatever the query says");
}

#[tokio::test]
async fn a_policy_before_a_late_head_lands_after_the_block() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    let doc = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/desktop/e2e/fixtures/csp/csp-implied-head.html")).unwrap();
    std::fs::write(d.path().join("a/x.html"), &doc).unwrap();
    install_marker(d.path(), "marker");
    st.core.set_plugin_enabled("marker", true, None).unwrap();
    let files = build_files_router(st.clone());
    let r = files.oneshot(get(&format!("/{}/x.html?doc=1", room.id), FILES_HOST)).await.unwrap();
    let body = text(r).await;
    let at = "<!doctype html>\n<html>".len();
    assert_eq!(&body[..at], &doc[..at]);
    let (block, after) = body[at..].split_at(body.len() - doc.len());
    assert!(block.starts_with("<script data-rooms-bridge>") && block.contains("_plugins/marker/content.js") && block.ends_with("</script>\n"), "{block}");
    assert_eq!(after, &doc[at..], "the <meta> before <head> opens the head itself, so the block goes right after <html> and the late <head> stays where it was");
    assert!(after.starts_with("\n<meta http-equiv"), "{after}");
}

#[tokio::test]
async fn card_variant_has_only_the_bridge() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), DOC).unwrap();
    install_marker(d.path(), "marker");
    st.core.set_plugin_enabled("marker", true, None).unwrap();
    let files = build_files_router(st);
    for query in ["", "?v=1", "?doc=0", "?doc="] {
        let r = files.clone().oneshot(get(&format!("/{}/x.html{query}", room.id), FILES_HOST)).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK, "{query}");
        let body = text(r).await;
        let block = spliced(&body);
        assert_eq!(block.matches("<script").count(), 1, "{query}: {block}");
        assert!(!block.contains("_plugins"), "{query}");
    }
}

#[tokio::test]
async fn doc_etag_changes_when_a_content_plugin_toggles() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), DOC).unwrap();
    install_marker(d.path(), "marker");
    let files = build_files_router(st.clone());
    let uri = format!("/{}/x.html?doc=1", room.id);
    let fetch = |tag: Option<String>| {
        let mut b = Request::get(&uri).header("host", FILES_HOST);
        if let Some(t) = tag { b = b.header("if-none-match", t); }
        files.clone().oneshot(b.body(Body::empty()).unwrap())
    };
    let etag = |r: &axum::response::Response| r.headers()["etag"].to_str().unwrap().to_string();
    let off = fetch(None).await.unwrap();
    let card = files.clone().oneshot(get(&format!("/{}/x.html", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(etag(&off), etag(&card), "with no content plugin on, the doc variant is the card body");
    let off_tag = etag(&off);

    st.core.set_plugin_enabled("marker", true, None).unwrap();
    let on = fetch(Some(off_tag.clone())).await.unwrap();
    assert_eq!(on.status(), StatusCode::OK, "the cached body has no tag, so the old tag must miss");
    let on_tag = etag(&on);
    assert_ne!(on_tag, off_tag);
    assert!(text(on).await.contains("_plugins/marker/content.js"));
    assert_eq!(fetch(Some(on_tag.clone())).await.unwrap().status(), StatusCode::NOT_MODIFIED);

    std::fs::write(d.path().join(".rooms/plugins/marker/content.js"), "mark(); mark()").unwrap();
    let edited = fetch(Some(on_tag.clone())).await.unwrap();
    assert_eq!(edited.status(), StatusCode::OK, "an edited content script changes the rev, so the tag misses");
    assert_ne!(etag(&edited), on_tag);
    assert!(text(edited).await.contains(&format!("content.js?r={}", rev_of(&st, "marker"))));

    st.core.set_plugin_enabled("marker", false, None).unwrap();
    let back = fetch(Some(on_tag)).await.unwrap();
    assert_eq!(back.status(), StatusCode::OK, "off again: the on tag must miss");
    assert_eq!(etag(&back), off_tag, "and the body is the card body again");
}

#[tokio::test]
async fn big_doc_variant_streams_whole() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    let mut big = b"<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n</head>\n<body>".to_vec();
    big.extend((0..300_000u32).map(|i| b"ab \n"[(i % 4) as usize]));
    big.extend_from_slice(b"</body>\n</html>\n");
    std::fs::write(d.path().join("a/big.html"), &big).unwrap();
    install_marker(d.path(), "marker");
    st.core.set_plugin_enabled("marker", true, None).unwrap();
    let files = build_files_router(st);
    let r = files.oneshot(get(&format!("/{}/big.html?doc=1", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let body = r.into_body().collect().await.unwrap().to_bytes();
    let at = b"<!doctype html>\n<html>\n<head>".len();
    assert_eq!(&body[..at], &big[..at]);
    let block_len = body.len() - big.len();
    let block = std::str::from_utf8(&body[at..at + block_len]).unwrap();
    assert!(block.starts_with("<script data-rooms-bridge>") && block.contains("_plugins/marker/lib/more.js"), "{block}");
    assert_eq!(&body[at + block_len..], &big[at..], "the rest of the file, byte for byte, with nothing after </html>");
}

#[tokio::test]
async fn files_revalidate_with_etag() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    let path = d.path().join("a/x.html");
    std::fs::write(&path, "<p>hi</p>").unwrap();
    let files = build_files_router(st);
    let uri = format!("/{}/x.html", room.id);
    let r = files.clone().oneshot(get(&uri, FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["cache-control"], "no-cache");
    let etag = r.headers()["etag"].to_str().unwrap().to_string();

    let with_tag = |tag: &str| Request::builder().uri(&uri).header("host", FILES_HOST).header("if-none-match", tag).body(Body::empty()).unwrap();
    let r = files.clone().oneshot(with_tag(&etag)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(r.headers()["etag"].to_str().unwrap(), etag);
    assert_eq!(r.headers()["content-security-policy"], "sandbox allow-scripts allow-popups");
    assert!(r.into_body().collect().await.unwrap().to_bytes().is_empty());

    // A changed file gets a new tag, so the old one no longer matches.
    std::fs::write(&path, "<p>hello again</p>").unwrap();
    let r = files.oneshot(with_tag(&etag)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_ne!(r.headers()["etag"].to_str().unwrap(), etag);
}

#[tokio::test]
async fn a_retargeted_link_to_a_same_size_same_mtime_file_is_not_a_304() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    let (one, two) = (d.path().join("one.html"), d.path().join("two.html"));
    std::fs::write(&one, "<p>1</p>").unwrap();
    std::fs::write(&two, "<p>2</p>").unwrap();
    let t = std::fs::metadata(&one).unwrap().modified().unwrap();
    std::fs::File::options().write(true).open(&two).unwrap().set_modified(t).unwrap();
    let link = d.path().join("a/x.html");
    std::os::unix::fs::symlink(&one, &link).unwrap();
    let files = build_files_router(st);
    let uri = format!("/{}/x.html", room.id);
    let etag = files.clone().oneshot(get(&uri, FILES_HOST)).await.unwrap().headers()["etag"].to_str().unwrap().to_string();
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&two, &link).unwrap();
    let req = Request::builder().uri(&uri).header("host", FILES_HOST).header("if-none-match", &etag).body(Body::empty()).unwrap();
    assert_eq!(files.oneshot(req).await.unwrap().status(), StatusCode::OK);
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
    let asks = rooms_core::asks::Asks::new(core.clone(), None);
    let st = AppState { core, asks, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:14318".into(), net };
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
    let asks = rooms_core::asks::Asks::new(core.clone(), None);
    let st = AppState { core, asks, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:14318".into(), net };
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
    let asks = rooms_core::asks::Asks::new(core.clone(), None);
    let st = AppState { core, asks, token: "t0k".into(), read_only: false, files_origin: "http://127.0.0.1:14318".into(), net };
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

fn put_color(room_id: &str, json: &str, token: Option<&str>) -> Request<Body> {
    let mut b = Request::put(format!("/v1/rooms/{room_id}/color")).header("content-type", "application/json").header("host", API_HOST);
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::from(json.to_string())).unwrap()
}

#[tokio::test]
async fn room_color_pins_and_unpins_and_the_list_follows() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    for n in ["a", "b"] { st.core.create_room(n).unwrap(); }
    let b = st.core.list_rooms().into_iter().find(|r| r.name == "b").unwrap().id;
    let names = || async {
        let v = body_json(app.clone().oneshot(get("/v1/rooms", API_HOST)).await.unwrap()).await;
        v.as_array().unwrap().iter().map(|r| format!("{}:{}", r["name"].as_str().unwrap(), r["color"])).collect::<Vec<_>>()
    };
    assert_eq!(names().await, ["inbox:null", "a:null", "b:null"]);

    let r = app.clone().oneshot(put_color(&b, r#"{"color":"sage"}"#, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let v = body_json(r).await;
    assert_eq!((v["id"].as_str().unwrap(), v["color"].as_str().unwrap()), (b.as_str(), "sage"));
    assert_eq!(names().await, ["inbox:null", "b:\"sage\"", "a:null"]);

    let r = app.clone().oneshot(put_color(&b, r#"{"color":null}"#, Some("t0k"))).await.unwrap();
    assert!(body_json(r).await["color"].is_null());
    assert_eq!(names().await, ["inbox:null", "b:null", "a:null"]);

    let r = app.clone().oneshot(put_color(&b, r#"{"color":"sage"}"#, None)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(names().await, ["inbox:null", "b:null", "a:null"]);

    st.core.set_room_color(&b, Some(rooms_protocol::RoomColor::Sea)).unwrap();
    for bad in ["{}", r#"{"color":"teal"}"#] {
        let r = app.clone().oneshot(put_color(&b, bad, Some("t0k"))).await.unwrap();
        assert!(r.status().is_client_error(), "{bad}: {}", r.status());
    }
    assert_eq!(names().await, ["inbox:null", "b:\"sea\"", "a:null"]);
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

#[tokio::test]
async fn room_move_reorders_and_needs_the_token() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let a = st.core.create_room("a").unwrap().id;
    let b = st.core.create_room("b").unwrap().id;
    let r = app.clone().oneshot(post(&format!("/v1/rooms/{b}/move"), r#"{"to":0}"#, None, API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = app.clone().oneshot(post(&format!("/v1/rooms/{b}/move"), r#"{"to":0}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body_json(r).await, serde_json::json!(["inbox", b, a]));
    let r = app.clone().oneshot(post("/v1/rooms/inbox/move", r#"{"to":1}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = app.oneshot(post("/v1/rooms/nope/move", r#"{"to":0}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

// ---- plugins ----

fn send(method: &str, uri: &str, body: &str, token: Option<&str>) -> Request<Body> {
    let mut b = Request::builder().method(method).uri(uri).header("host", API_HOST).header("content-type", "application/json");
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::from(body.to_string())).unwrap()
}

fn install_echo(home: &std::path::Path, permissions: &str) {
    let dir = home.join(".rooms/plugins/echo");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), format!(
        r#"{{"id":"echo","name":"Echo","version":"0.1.0","minAppVersion":"0.3.0","permissions":{permissions},"slots":{{"tab":{{"title":"Echo","sidebar":true}}}}}}"#)).unwrap();
    std::fs::write(dir.join("index.html"), "<p>echo</p>").unwrap();
    std::fs::write(dir.join("font.woff2"), "w").unwrap();
    std::fs::write(dir.join("main.js"), "1").unwrap();
}

async fn text(r: axum::response::Response) -> String {
    String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
}

#[tokio::test]
async fn plugins_list_and_enable() {
    let (d, app, _) = app(false, "127.0.0.1:5000");
    install_echo(d.path(), r#"["rooms.read"]"#);
    let r = app.clone().oneshot(get("/v1/plugins", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let v = body_json(r).await;
    assert_eq!(v[0]["id"], "echo");
    assert_eq!(v[0]["needsApproval"], true);
    assert_eq!(v[0]["slots"]["tab"]["sidebar"], true);
    let r = app.clone().oneshot(send("PATCH", "/v1/plugins/echo", r#"{"enabled":true}"#, None)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = app.clone().oneshot(send("PATCH", "/v1/plugins/echo", r#"{"enabled":true}"#, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let v = body_json(r).await;
    assert_eq!((v["enabled"].clone(), v["needsApproval"].clone()), (serde_json::json!(true), serde_json::json!(false)));
    let r = app.oneshot(send("PATCH", "/v1/plugins/nope", r#"{"enabled":true}"#, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn plugin_list_reports_content_script_manifests() {
    let (d, app, _) = app(false, "127.0.0.1:5000");
    let write = |id: &str, permissions: &str| {
        let dir = d.path().join(".rooms/plugins").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), format!(
            r#"{{"id":"{id}","name":"{id}","version":"0.1.0","minAppVersion":"0.3.0","permissions":{permissions},"contentScripts":["content.js"]}}"#)).unwrap();
        std::fs::write(dir.join("content.js"), "").unwrap();
    };
    write("marker", r#"["artifact.content"]"#);
    write("sneaky", r#"["rooms.read"]"#);
    let v = body_json(app.oneshot(get("/v1/plugins", API_HOST)).await.unwrap()).await;
    assert_eq!(v[0]["id"], "marker");
    assert_eq!((v[0]["status"].clone(), v[0]["needsApproval"].clone()), (serde_json::json!("ok"), serde_json::json!(true)));
    assert_eq!(v[0]["permissions"], serde_json::json!(["artifact.content"]));
    assert_eq!(v[0]["slots"], serde_json::json!({"artifactSidePanel": null, "tab": null}));
    assert_eq!(v[1]["id"], "sneaky");
    assert_eq!(v[1]["status"], "invalid");
    assert_eq!(v[1]["reason"], "contentScripts needs the artifact.content permission");
}

#[tokio::test]
async fn plugin_data_round_trip_errors_and_privacy() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    install_echo(d.path(), "[]");
    let r = app.clone().oneshot(send("GET", "/v1/plugins/echo/data/a.txt", "", Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND, "not enabled yet");
    st.core.set_plugin_enabled("echo", true, None).unwrap();
    let r = app.clone().oneshot(send("PUT", "/v1/plugins/echo/data/notes/a.txt", "hello", Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let r = app.clone().oneshot(send("GET", "/v1/plugins/echo/data/notes/a.txt", "", None)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN, "plugin data is private");
    let r = app.clone().oneshot(send("GET", "/v1/plugins/echo/data/notes/a.txt", "", Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(text(r).await, "hello");
    let r = app.clone().oneshot(send("GET", "/v1/plugins/echo/data?prefix=notes/", "", Some("t0k"))).await.unwrap();
    assert_eq!(body_json(r).await, serde_json::json!(["notes/a.txt"]));
    let r = app.clone().oneshot(send("GET", "/v1/plugins/echo/data/missing.txt", "", Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = app.clone().oneshot(send("PUT", "/v1/plugins/echo/data/..%2Ftoken", "x", Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(r).await["error"], "invalid_path");
    let big = "x".repeat(10 * 1024 * 1024 + 1);
    let r = app.clone().oneshot(send("PUT", "/v1/plugins/echo/data/big.txt", &big, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let nine = "x".repeat(9 * 1024 * 1024);
    let r = app.clone().oneshot(send("PUT", "/v1/plugins/echo/data/nine.txt", &nine, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT, "under the limit is fine");
    let r = app.clone().oneshot(send("DELETE", "/v1/plugins/echo/data/notes/a.txt", "", Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let r = app.oneshot(send("GET", "/v1/plugins/echo/data/notes/a.txt", "", Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn artifact_by_file_key() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), "<title>x</title>").unwrap();
    st.core.backfill_all().unwrap();
    let key = st.core.list_artifacts(&room.id).unwrap()[0].file_key.clone();
    let r = app.clone().oneshot(get(&format!("/v1/artifacts/by-file-key/{key}"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body_json(r).await["title"], "x");
    let r = app.oneshot(get("/v1/artifacts/by-file-key/0000000000000000", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn plugin_assets_get_their_own_narrow_csp() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    install_echo(d.path(), r#"["downloads"]"#);
    st.core.set_plugin_enabled("echo", true, None).unwrap();
    st.core.write_plugin_data("echo", "secret.txt", "s").unwrap();
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), "<p>hi</p>").unwrap();
    let files = build_files_router(st);
    let r = files.clone().oneshot(get("/_plugins/echo/index.html", FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let p = "http://127.0.0.1:4318/_plugins/echo/";
    assert_eq!(r.headers()["content-security-policy"], format!(
        "sandbox allow-scripts allow-downloads; default-src 'none'; script-src {p}; style-src {p} 'unsafe-inline'; img-src {p} data: blob:; font-src {p}; connect-src 'none'; frame-src 'none'; form-action 'none'"));
    let r = files.clone().oneshot(get("/_plugins/echo/font.woff2", FILES_HOST)).await.unwrap();
    assert_eq!(r.headers()["content-type"], "font/woff2");
    // Module scripts load in CORS mode from the sandbox's opaque origin; assets are code, never data.
    assert_eq!(r.headers()["access-control-allow-origin"], "*");
    let r = files.clone().oneshot(get("/_plugins/echo/data/secret.txt", FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = files.clone().oneshot(get("/_plugins/nope/index.html", FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = files.oneshot(get(&format!("/{}/x.html", room.id), FILES_HOST)).await.unwrap();
    assert_eq!(r.headers()["content-security-policy"], "sandbox allow-scripts allow-popups");
}

#[tokio::test]
async fn plugin_csp_without_downloads_has_no_extra_sandbox_tokens() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    install_echo(d.path(), "[]");
    st.core.set_plugin_enabled("echo", true, None).unwrap();
    let files = build_files_router(st);
    let r = files.oneshot(get("/_plugins/echo/index.html", FILES_HOST)).await.unwrap();
    let csp = r.headers()["content-security-policy"].to_str().unwrap().to_string();
    assert!(csp.starts_with("sandbox allow-scripts; "), "{csp}");
    assert!(!csp.contains("allow-popups") && !csp.contains("allow-same-origin"));
}

#[tokio::test]
async fn disabled_plugin_files_are_not_served() {
    let (d, _app, st) = app(false, "127.0.0.1:5000");
    install_echo(d.path(), "[]");
    let files = build_files_router(st.clone());
    let expect = |want: StatusCode, why: &'static str| {
        let files = files.clone();
        async move {
            for path in ["/_plugins/echo/index.html", "/_plugins/echo/main.js"] {
                assert_eq!(files.clone().oneshot(get(path, FILES_HOST)).await.unwrap().status(), want, "{why}: {path}");
            }
        }
    };
    expect(StatusCode::NOT_FOUND, "installed but off").await;
    st.core.set_plugin_enabled("echo", true, None).unwrap();
    expect(StatusCode::OK, "on").await;
    st.core.set_plugin_enabled("echo", false, None).unwrap();
    expect(StatusCode::NOT_FOUND, "turned off again").await;
}

fn delete(uri: &str, token: Option<&str>, host: &str) -> Request<Body> {
    let mut b = Request::delete(uri).header("host", host);
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn ask_routes() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("r").unwrap();
    let root = st.core.room_root(&room.id).unwrap().0;
    std::fs::write(root.join("doc.html"), "<title>d</title>").unwrap();
    st.core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = [\"/bin/echo\", \"hi\"]\n").unwrap();
    let art = st.core.list_artifacts(&room.id).unwrap().remove(0);
    let mut rx = st.core.subscribe();

    let body = format!(r#"{{"scope":{{"kind":"doc","fileKey":"{}"}},"question":"q"}}"#, art.file_key);
    let r = app.clone().oneshot(post("/v1/asks", &body, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::ACCEPTED);
    let turn = body_json(r).await;
    assert_eq!(turn["status"], "running");
    assert_eq!(turn["scope"], serde_json::json!({"kind": "doc", "fileKey": art.file_key}));
    loop {
        let ev = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        if let rooms_protocol::EventKind::AskDone { turn: t } = ev.kind { assert_eq!(t.answer, "hi"); break; }
    }
    let r = app.clone().oneshot(get(&format!("/v1/asks?scope=doc:{}", art.file_key), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let thread = body_json(r).await;
    assert_eq!(thread[0]["answer"], "hi");
    assert_eq!(thread[0]["scope"], serde_json::json!({"kind": "doc", "fileKey": art.file_key}));
    assert!(d.path().join(format!(".rooms/asks/{}.jsonl", art.file_key)).exists());

    let r = app.clone().oneshot(post("/v1/asks", &body.replace("\"q\"", "\"  \""), Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(r).await["error"], "bad_request");
    let r = app.clone().oneshot(post("/v1/asks", &body.replace(&art.file_key, "0000000000000000"), Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    std::fs::write(d.path().join(".rooms/agents.toml"), "default = [").unwrap();
    let r = app.clone().oneshot(post("/v1/asks", &body, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(r).await["error"], "agent_config");
    let r = app.clone().oneshot(get("/v1/asks?scope=doc:..%2Fx", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    // nothing running under that id: the app's "running" turn is stale
    let r = app.clone().oneshot(delete("/v1/asks/whatever", Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = app.clone().oneshot(post("/v1/asks", &body, None, API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ask_writes_are_forbidden_read_only() {
    let (_d, app, _) = app(true, "127.0.0.1:5000");
    let r = app.clone().oneshot(post("/v1/asks", r#"{"scope":{"kind":"doc","fileKey":"0123456789abcdef"},"question":"q"}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ask_routes_take_a_scope_key() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("r").unwrap();
    std::fs::write(st.core.room_root(&room.id).unwrap().0.join("doc.html"), "<title>d</title>").unwrap();
    st.core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = [\"/bin/echo\", \"hi\"]\n").unwrap();
    let art = st.core.list_artifacts(&room.id).unwrap().remove(0);

    for path in ["/v1/asks", "/v1/asks/target"] {
        let r = app.clone().oneshot(get(&format!("{path}?scope=doc:{}", art.file_key), API_HOST)).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK, "{path}");
        for bad in ["doc:..%2Fx", "room:journal", "room:Journal", "room:a.b", "day:2026-13-01", "nope", &format!("doc:{}", "a".repeat(65))] {
            let r = app.clone().oneshot(get(&format!("{path}?scope={bad}"), API_HOST)).await.unwrap();
            assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{path} {bad}");
            assert_eq!(body_json(r).await["error"], "bad_request");
        }
        // a room scope until F1-2; room ids are nanoids, which can start with `-` or `_`
        for id in ["-Ab3_xYz9Q-0", "_abc", "abc"] {
            let r = app.clone().oneshot(get(&format!("{path}?scope=room:{id}"), API_HOST)).await.unwrap();
            assert_eq!(r.status(), if path == "/v1/asks" { StatusCode::OK } else { StatusCode::BAD_REQUEST }, "{path} room:{id}");
        }
        let r = app.clone().oneshot(get(&format!("{path}?fileKey={}", art.file_key), API_HOST)).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST, "the old query is gone");
    }
    for (scope, status) in [
        (r#"{"kind":"room","roomId":"-Ab3_xYz9Q-0"}"#.to_string(), StatusCode::BAD_REQUEST),
        (r#"{"kind":"day","date":"2026-10-09"}"#.to_string(), StatusCode::BAD_REQUEST),
        (r#"{"kind":"room","roomId":"journal"}"#.to_string(), StatusCode::BAD_REQUEST),
        (r#"{"kind":"doc","fileKey":"../x"}"#.to_string(), StatusCode::BAD_REQUEST),
        (r#"{"kind":"doc","fileKey":"0000000000000000"}"#.to_string(), StatusCode::NOT_FOUND),
    ] {
        let r = app.clone().oneshot(post("/v1/asks", &format!(r#"{{"scope":{scope},"question":"q"}}"#), Some("t0k"), API_HOST)).await.unwrap();
        assert_eq!(r.status(), status, "{scope}");
        if status == StatusCode::BAD_REQUEST { assert_eq!(body_json(r).await["error"], "bad_request", "{scope}"); }
    }
    assert!(!d.path().join(".rooms/asks").exists(), "nothing was written for a refused scope");
}

#[tokio::test]
async fn ask_extractor_rejections_use_the_error_shape() {
    let (_d, app, _) = app(false, "127.0.0.1:5000");
    for body in ["{", r#"{"scope":{"kind":"doc"},"question":"q"}"#, r#"{"roomId":"r","artifactId":"a","question":"q"}"#] {
        let r = app.clone().oneshot(post("/v1/asks", body, Some("t0k"), API_HOST)).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body_json(r).await["error"], "bad_request");
    }
    let r = app.clone().oneshot(get("/v1/asks", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(r).await["error"], "bad_request");
}

#[tokio::test]
async fn ask_target_route_and_model() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("r").unwrap();
    std::fs::write(st.core.room_root(&room.id).unwrap().0.join("doc.html"), "<title>d</title>").unwrap();
    st.core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = [\"/bin/echo\", \"-m\", \"{model}\"]\nmodels = [\"m1\"]\n").unwrap();
    let art = st.core.list_artifacts(&room.id).unwrap().remove(0);

    let uri = format!("/v1/asks/target?scope=doc:{}", art.file_key);
    let r = app.clone().oneshot(get(&uri, API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body_json(r).await, serde_json::json!({"agent": "claude-code", "mode": "new", "models": ["m1"]}));
    let r = app.clone().oneshot(get("/v1/asks/target?scope=doc:0000000000000000", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = app.clone().oneshot(get("/v1/asks/target", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(r).await["error"], "bad_request");
    let r = app.clone().oneshot(get(&uri, "evil.example:4317")).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);

    let mut rx = st.core.subscribe();
    let body = format!(r#"{{"scope":{{"kind":"doc","fileKey":"{}"}},"question":"q","model":"m1"}}"#, art.file_key);
    let r = app.clone().oneshot(post("/v1/asks", &body, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::ACCEPTED);
    assert_eq!(body_json(r).await["model"], "m1");
    loop {
        let ev = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        if let rooms_protocol::EventKind::AskDone { turn: t } = ev.kind { assert_eq!(t.answer, "-m m1"); break; }
    }
    let r = app.clone().oneshot(post("/v1/asks", &body.replace("m1", "zz"), Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    std::fs::write(d.path().join(".rooms/agents.toml"), "default = [").unwrap();
    let r = app.clone().oneshot(get(&uri, API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(r).await["error"], "agent_config");
}

// ---- plugin tools ----

fn install_drawer(home: &std::path::Path) {
    let dir = home.join(".rooms/plugins/draw");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"),
        r#"{"id":"draw","name":"Draw","version":"0.1.0","minAppVersion":"0.3.0","permissions":[],"slots":{"tab":{"title":"Draw"}},"tools":{"draw":{"description":"Draw things","input":{"type":"object"},"appendTo":"ops/{doc}.jsonl"}}}"#).unwrap();
    std::fs::write(dir.join("index.html"), "<p>draw</p>").unwrap();
}

#[tokio::test]
async fn tools_list_is_private_and_call_maps_errors() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("a").unwrap();
    std::fs::write(d.path().join("a/x.html"), "<title>x</title>").unwrap();
    st.core.backfill_all().unwrap();
    let key = st.core.list_artifacts(&room.id).unwrap()[0].file_key.clone();
    install_drawer(d.path());

    let r = app.clone().oneshot(send("GET", "/v1/tools", "", None)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN, "tool list is private");
    let r = app.clone().oneshot(send("GET", "/v1/tools", "", Some("t0k"))).await.unwrap();
    assert_eq!((r.status(), body_json(r).await), (StatusCode::OK, serde_json::json!([])), "disabled plugin has no tools");
    st.core.set_plugin_enabled("draw", true, None).unwrap();
    let r = app.clone().oneshot(send("GET", "/v1/tools", "", Some("t0k"))).await.unwrap();
    let v = body_json(r).await;
    assert_eq!((v[0]["pluginId"].as_str(), v[0]["name"].as_str()), (Some("draw"), Some("draw")));

    let call = |body: String, tok| send("POST", "/v1/tools/call", &body, tok);
    let ok = format!(r#"{{"pluginId":"draw","name":"draw","input":{{"doc":"{key}","ops":[]}}}}"#);
    let r = app.clone().oneshot(call(ok.clone(), None)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = app.clone().oneshot(call(ok.clone(), Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body_json(r).await["path"], format!("ops/{key}.jsonl"));

    for body in ["not json".to_string(), r#"{"pluginId":"draw"}"#.into(),
                 r#"{"pluginId":"draw","name":"draw","input":[]}"#.into(),
                 r#"{"pluginId":"draw","name":"draw","input":{}}"#.into()] {
        let r = app.clone().oneshot(call(body.clone(), Some("t0k"))).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{body}");
        let v = body_json(r).await;
        assert_eq!(v["error"], "bad_request", "{body}");
        assert!(!v["message"].as_str().unwrap().is_empty());
    }
    for body in [format!(r#"{{"pluginId":"nope","name":"draw","input":{{"doc":"{key}"}}}}"#),
                 format!(r#"{{"pluginId":"draw","name":"nope","input":{{"doc":"{key}"}}}}"#),
                 r#"{"pluginId":"draw","name":"draw","input":{"doc":"0000000000000000"}}"#.to_string()] {
        let r = app.clone().oneshot(call(body.clone(), Some("t0k"))).await.unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body_json(r).await["error"], "not_found");
    }

    st.core.write_plugin_data("draw", &format!("ops/{key}.jsonl"), &"x".repeat(10 * 1024 * 1024)).unwrap();
    let r = app.oneshot(call(ok, Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body_json(r).await["error"], "too_large");
}

#[tokio::test]
async fn rooms_mcp_shaped_request_passes_the_guard() {
    // rooms-mcp (ureq) sends Host + Bearer + User-Agent and no Origin; it must reach the tool routes.
    let (d, app, _st) = app(false, "127.0.0.1:5000");
    install_drawer(d.path());
    let req = |method: &str, uri: &str, body: &str| Request::builder().method(method).uri(uri)
        .header("host", API_HOST).header("authorization", "Bearer t0k").header("user-agent", "ureq/2")
        .header("accept", "*/*").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
    let r = app.clone().oneshot(req("GET", "/v1/tools", "")).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let r = app.oneshot(req("POST", "/v1/tools/call", r#"{"pluginId":"nope","name":"x","input":{}}"#)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND, "past the guard, rejected by the handler");
}

fn upload(bytes: Vec<u8>, token: Option<&str>) -> Request<Body> {
    let mut b = Request::post("/v1/asks/images").header("host", API_HOST).header("content-type", "image/png");
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::from(bytes)).unwrap()
}

#[tokio::test]
async fn ask_images_upload_then_serve_from_the_files_origin() {
    let (_d, app, st) = app(false, "127.0.0.1:5000");
    let png = b"\x89PNG\r\n\x1a\nimage-bytes".to_vec();
    assert_eq!(app.clone().oneshot(upload(png.clone(), None)).await.unwrap().status(), StatusCode::FORBIDDEN);
    let r = app.clone().oneshot(upload(png.clone(), Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::CREATED);
    let id = body_json(r).await["id"].as_str().unwrap().to_string();
    assert!(id.ends_with(".png"));
    let r = app.clone().oneshot(upload(b"<svg/>".to_vec(), Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert!(body_json(r).await["message"].as_str().unwrap().contains("PNG"));
    let r = app.clone().oneshot(upload(vec![0x89; rooms_core::asks::images::MAX_IMAGE_BYTES + 10], Some("t0k"))).await.unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let files = build_files_router(st);
    let r = files.clone().oneshot(get(&format!("/_asks/images/{id}"), FILES_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-type"], "image/png");
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(r.into_body().collect().await.unwrap().to_bytes().to_vec(), png);
    for bad in ["/_asks/images/..%2F..%2Fagents.toml", "/_asks/images/0123456789abcdef0123456789abcdef.png"] {
        assert_eq!(files.clone().oneshot(get(bad, FILES_HOST)).await.unwrap().status(), StatusCode::NOT_FOUND, "{bad}");
    }
}
