use rooms_core::asks::{AskError, Asks, Limits};
use rooms_core::RoomsCore;
use rooms_protocol::{AskMode, AskStatus, AskTurn, EventKind};
use std::time::Duration;

const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-agent.sh");

/// A home with one owned room "r" holding `doc.html` with the given <head> meta, and an agents.toml
/// whose `default` and `claude-code` profiles both point at the fake agent.
fn setup(meta: &str) -> (tempfile::TempDir, RoomsCore, String, String) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let room = core.create_room("r").unwrap();
    let html = format!("<html><head><title>Doc</title>{meta}</head><body>x</body></html>");
    std::fs::write(core.room_root(&room.id).unwrap().0.join("doc.html"), html).unwrap();
    core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), format!(
        "[agents.claude-code]\nresume = [\"{FAKE}\", \"resume\", \"{{session}}\", \"{{prompt}}\"]\nnew = [\"{FAKE}\", \"new\", \"{{prompt}}\"]\n"
    )).unwrap();
    let a = core.list_artifacts(&room.id).unwrap().remove(0);
    (d, core, room.id, a.id)
}

async fn wait_started(rx: &mut tokio::sync::broadcast::Receiver<rooms_protocol::RoomsEvent>, id: &str) {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("ask.started in time").unwrap();
        if let EventKind::AskStarted { turn } = ev.kind { if turn.id == id { return; } }
    }
}

async fn wait_done(rx: &mut tokio::sync::broadcast::Receiver<rooms_protocol::RoomsEvent>, id: &str) -> AskTurn {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("ask.done in time").unwrap();
        if let EventKind::AskDone { turn } = ev.kind { if turn.id == id { return turn; } }
    }
}

#[tokio::test]
async fn resume_turn_runs_template_and_records() {
    let (d, core, room, art) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "  왜?  ").unwrap();
    assert_eq!((t.status, t.mode, t.question.as_str(), t.agent.as_str()), (AskStatus::Running, AskMode::Resume, "왜?", "claude-code"));
    wait_started(&mut rx, &t.id).await;
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!(done.status, AskStatus::Done);
    assert!(done.answer.starts_with("ARGV: [resume] [S-1] ["), "{}", done.answer);
    assert!(done.answer.contains("Question: 왜?"));
    assert!(done.ended_at.is_some());
    // thread reads it back from disk
    let th = asks.thread(&t.file_key).unwrap();
    assert_eq!(th.len(), 1);
    assert_eq!(th[0].status, AskStatus::Done);
    assert!(d.path().join(format!(".rooms/asks/{}.jsonl", t.file_key)).exists());
}

#[tokio::test]
async fn mcp_config_arg_is_passed_only_when_the_file_exists() {
    let (d, core, room, art) = setup("");
    std::fs::write(d.path().join(".rooms/agents.toml"), format!(
        "[agents.claude-code]\nnew = [\"{FAKE}\", \"--mcp-config\", \"{{mcp_config}}\", \"{{prompt}}\"]\n")).unwrap();
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "one").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(!done.answer.contains("--mcp-config"), "{}", done.answer);
    let mcp = d.path().join(".rooms/mcp.json");
    std::fs::write(&mcp, "{}").unwrap();
    let t = asks.start(&room, &art, "two").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    let canon = std::fs::canonicalize(&mcp).unwrap();
    assert!(done.answer.contains(&format!("[--mcp-config] [{}]", canon.display())), "{}", done.answer);
    assert!(done.answer.contains(&format!("Rooms doc: {}\n", t.file_key)), "{}", done.answer);
}

#[tokio::test]
async fn second_question_carries_the_first_and_still_resumes() {
    let (_d, core, room, art) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t1 = asks.start(&room, &art, "first").unwrap();
    wait_done(&mut rx, &t1.id).await;
    let t2 = asks.start(&room, &art, "second").unwrap();
    let d2 = wait_done(&mut rx, &t2.id).await;
    assert!(d2.answer.contains("[resume] [S-1]"));
    assert!(d2.answer.contains("Previous Q&A:\nQ: first\nA: ARGV:"));
}

#[tokio::test]
async fn no_session_or_flag_shaped_session_runs_new_mode() {
    let (_d, core, room, art) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="--dangerously-bypass-approvals-and-sandbox">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    assert_eq!(t.mode, AskMode::New);
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.starts_with("ARGV: [new] ["));
    assert!(done.answer.contains("Read this file first"));
    assert!(!done.answer.contains("dangerously"));
}

#[tokio::test]
async fn cwd_meta_used_only_when_it_is_a_real_dir() {
    let other = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(other.path()).unwrap();
    let (_d, core, room, art) = setup(&format!(r#"<meta name="rooms:cwd" content="{}">"#, real.display()));
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains(&format!("CWD: {}", real.display())), "{}", done.answer);
}

#[tokio::test]
async fn failure_busy_cancel_and_validation() {
    let (_d, core, room, art) = setup("");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    // validation
    assert!(matches!(asks.start(&room, &art, "   "), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.start(&room, &art, &"x".repeat(8001)), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.start(&room, "nope", "q"), Err(AskError::NotFound)));
    assert!(matches!(asks.thread("../etc"), Err(AskError::BadRequest(_))));
    // non-zero exit
    let f = asks.start(&room, &art, "FAIL").unwrap();
    let fd = wait_done(&mut rx, &f.id).await;
    assert_eq!(fd.status, AskStatus::Failed);
    assert!(fd.error.as_deref().unwrap().contains("code 7"));
    assert!(fd.error.as_deref().unwrap().contains("bad thing happened"));
    // busy, then cancel keeps partial
    let s = asks.start(&room, &art, "SLEEP").unwrap();
    assert!(matches!(asks.start(&room, &art, "again"), Err(AskError::Busy)));
    tokio::time::sleep(Duration::from_millis(300)).await;
    asks.cancel(&s.id);
    asks.cancel(&s.id); // idempotent
    let sd = wait_done(&mut rx, &s.id).await;
    assert_eq!(sd.status, AskStatus::Cancelled);
    assert_eq!(sd.answer, "partial");
    asks.cancel("unknown-id");
}

#[tokio::test]
async fn bad_config_and_missing_program() {
    let (d, core, room, art) = setup("");
    let asks = Asks::new(core.clone(), None);
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = []\n").unwrap();
    match asks.start(&room, &art, "q") { Err(AskError::AgentConfig(m)) => assert!(m.contains("agents.claude-code.new")), other => panic!("{other:?}") }
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = [\"no-such-cli-xyz\", \"{prompt}\"]\n").unwrap();
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!(done.status, AskStatus::Failed);
    assert!(done.error.as_deref().unwrap().contains("Command not found: no-such-cli-xyz"));
}

#[tokio::test]
async fn timeout_is_failed() {
    let (_d, core, room, art) = setup("");
    let asks = Asks::with_limits(core.clone(), None, Limits { timeout: Duration::from_millis(300), ..Limits::default() });
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "SLEEP").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!((done.status, done.error.as_deref()), (AskStatus::Failed, Some("Stopped: took too long")));
}

#[tokio::test]
async fn restart_turns_running_into_failed_and_unblocks() {
    let (_d, core, room, art) = setup("");
    let asks = Asks::new(core.clone(), None);
    let t = asks.start(&room, &art, "SLEEP").unwrap();
    // A new Asks over the same home = roomsd restarted while t was running.
    let fresh = Asks::new(core.clone(), None);
    let th = fresh.thread(&t.file_key).unwrap();
    assert_eq!((th[0].status, th[0].error.as_deref()), (AskStatus::Failed, Some("Stopped because Rooms restarted")));
    assert!(fresh.start(&room, &art, "after restart").is_ok());
    asks.shutdown().await;
    fresh.shutdown().await;
}

#[tokio::test]
async fn capacity_is_four() {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let room = core.create_room("r").unwrap();
    for i in 0..5 { std::fs::write(core.room_root(&room.id).unwrap().0.join(format!("d{i}.html")), format!("<title>d{i}</title>")).unwrap(); }
    core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), format!("[agents.claude-code]\nnew = [\"{FAKE}\", \"{{prompt}}\"]\n")).unwrap();
    let asks = Asks::new(core.clone(), None);
    let arts = core.list_artifacts(&room.id).unwrap();
    for a in &arts[..4] { asks.start(&room.id, &a.id, "SLEEP").unwrap(); }
    assert!(matches!(asks.start(&room.id, &arts[4].id, "SLEEP"), Err(AskError::Capacity)));
    asks.shutdown().await;
}

#[tokio::test]
async fn start_after_shutdown_is_refused() {
    let (_d, core, room, art) = setup("");
    let asks = Asks::new(core.clone(), None);
    asks.shutdown().await;
    assert!(matches!(asks.start(&room, &art, "q"), Err(AskError::Capacity)));
}

// ---- sources.json sidecar (doc has no usable rooms:session) ----

fn write_sources(home: &std::path::Path, doc: &std::path::Path, agent: &str, session: &str, cwd: &str) {
    let key = std::fs::canonicalize(doc).unwrap().to_string_lossy().into_owned();
    let body = serde_json::json!({"version": 1, "sources": {key: {
        "agent": agent, "session": session, "cwd": cwd, "writtenAt": "2026-10-06T00:00:00Z"}}});
    std::fs::create_dir_all(home.join(".rooms")).unwrap();
    std::fs::write(home.join(".rooms/sources.json"), body.to_string()).unwrap();
}

fn doc_path(core: &RoomsCore, room: &str) -> std::path::PathBuf {
    core.room_root(&room.to_string()).unwrap().0.join("doc.html")
}

#[tokio::test]
async fn sidecar_resumes_when_doc_has_no_meta() {
    let cwd = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(cwd.path()).unwrap();
    let (d, core, room, art) = setup("");
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "S-9", &real.to_string_lossy());
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    assert_eq!(t.mode, AskMode::Resume);
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains("[resume] [S-9]"), "{}", done.answer);
    assert!(done.answer.contains(&format!("CWD: {}", real.display())), "{}", done.answer);
}

#[tokio::test]
async fn meta_session_wins_over_sidecar() {
    let (d, core, room, art) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "S-9", "/");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains("[resume] [S-1]"), "{}", done.answer);
}

#[tokio::test]
async fn sidecar_entry_is_used_whole_not_mixed_with_meta_agent() {
    let (d, core, room, art) = setup(r#"<meta name="rooms:agent" content="codex">"#);
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "S-9", "/");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    assert_eq!((t.agent.as_str(), t.mode), ("claude-code", AskMode::Resume));
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains("[resume] [S-9]"), "{}", done.answer);
}

#[tokio::test]
async fn sidecar_values_are_still_validated() {
    let (d, core, room, art) = setup("");
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "--bad", "/");
    let asks = Asks::new(core.clone(), None);
    let t = asks.start(&room, &art, "q").unwrap();
    assert_eq!(t.mode, AskMode::New);
}

#[tokio::test]
async fn corrupt_sidecar_means_new_mode_without_error() {
    let (d, core, room, art) = setup("");
    std::fs::write(d.path().join(".rooms/sources.json"), "{").unwrap();
    let asks = Asks::new(core.clone(), None);
    let t = asks.start(&room, &art, "q").unwrap();
    assert_eq!(t.mode, AskMode::New);
}
