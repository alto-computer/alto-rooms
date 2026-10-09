use rooms_core::asks::{AskError, Asks, Limits, Request};
use rooms_core::RoomsCore;
use rooms_protocol::{AskKind, AskMode, AskScope, AskStatus, AskTurn, EventKind};
use std::time::Duration;

const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-agent.sh");

/// A home with one owned room "r" holding `doc.html` with the given <head> meta, and an agents.toml
/// whose `default` and `claude-code` profiles both point at the fake agent. Returns the doc's scope
/// and the room id.
fn setup(meta: &str) -> (tempfile::TempDir, RoomsCore, AskScope, String) {
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
    (d, core, AskScope::Doc { file_key: a.file_key }, room.id)
}

fn file_key(scope: &AskScope) -> &str {
    match scope { AskScope::Doc { file_key } => file_key, _ => panic!("{scope:?} is not a doc") }
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
    let (d, core, doc, _room) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "  왜?  ", None).unwrap();
    assert_eq!((t.status, t.mode, t.question.as_str(), t.agent.as_str()), (AskStatus::Running, AskMode::Resume, "왜?", "claude-code"));
    wait_started(&mut rx, &t.id).await;
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!(done.status, AskStatus::Done);
    assert!(done.answer.starts_with("ARGV: [resume] [S-1] ["), "{}", done.answer);
    assert!(done.answer.contains("Question: 왜?"));
    assert!(done.ended_at.is_some());
    // thread reads it back from disk
    let th = asks.thread(&t.scope).unwrap();
    assert_eq!(th.len(), 1);
    assert_eq!(th[0].status, AskStatus::Done);
    assert_eq!(t.scope, doc);
    assert!(d.path().join(format!(".rooms/asks/{}.jsonl", file_key(&doc))).exists());
}

#[tokio::test]
async fn mcp_config_arg_is_passed_only_when_the_file_exists() {
    let (d, core, doc, _room) = setup("");
    std::fs::write(d.path().join(".rooms/agents.toml"), format!(
        "[agents.claude-code]\nnew = [\"{FAKE}\", \"--mcp-config\", \"{{mcp_config}}\", \"{{prompt}}\"]\n")).unwrap();
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "one", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(!done.answer.contains("--mcp-config"), "{}", done.answer);
    let mcp = d.path().join(".rooms/mcp.json");
    std::fs::write(&mcp, "{}").unwrap();
    let t = asks.start(&doc, "two", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    let canon = std::fs::canonicalize(&mcp).unwrap();
    assert!(done.answer.contains(&format!("[--mcp-config] [{}]", canon.display())), "{}", done.answer);
    assert!(done.answer.contains(&format!("Rooms doc: {}\n", file_key(&doc))), "{}", done.answer);
}

#[tokio::test]
async fn second_question_carries_the_first_and_still_resumes() {
    let (_d, core, doc, _room) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t1 = asks.start(&doc, "first", None).unwrap();
    wait_done(&mut rx, &t1.id).await;
    let t2 = asks.start(&doc, "second", None).unwrap();
    let d2 = wait_done(&mut rx, &t2.id).await;
    assert!(d2.answer.contains("[resume] [S-1]"));
    assert!(d2.answer.contains("Previous Q&A:\nQ: first\nA: ARGV:"));
}

#[tokio::test]
async fn no_session_or_flag_shaped_session_runs_new_mode() {
    let (_d, core, doc, _room) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="--dangerously-bypass-approvals-and-sandbox">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "q", None).unwrap();
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
    let (_d, core, doc, _room) = setup(&format!(r#"<meta name="rooms:cwd" content="{}">"#, real.display()));
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "q", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains(&format!("CWD: {}", real.display())), "{}", done.answer);
}

#[tokio::test]
async fn failure_busy_cancel_and_validation() {
    let (_d, core, doc, _room) = setup("");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    // validation
    assert!(matches!(asks.start(&doc, "   ", None), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.start(&doc, &"x".repeat(8001), None), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.start(&AskScope::Doc { file_key: "0000000000000000".into() }, "q", None), Err(AskError::NotFound)));
    assert!(matches!(asks.thread(&AskScope::Doc { file_key: "../etc".into() }), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.thread(&AskScope::Room { room_id: "journal".into() }), Err(AskError::BadRequest(_))));
    // non-zero exit
    let f = asks.start(&doc, "FAIL", None).unwrap();
    let fd = wait_done(&mut rx, &f.id).await;
    assert_eq!(fd.status, AskStatus::Failed);
    assert!(fd.error.as_deref().unwrap().contains("code 7"));
    assert!(fd.error.as_deref().unwrap().contains("bad thing happened"));
    // busy, then cancel keeps partial
    let s = asks.start(&doc, "SLEEP", None).unwrap();
    assert!(matches!(asks.start(&doc, "again", None), Err(AskError::Busy)));
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
    let (d, core, doc, _room) = setup("");
    let asks = Asks::new(core.clone(), None);
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = []\n").unwrap();
    match asks.start(&doc, "q", None) { Err(AskError::AgentConfig(m)) => assert!(m.contains("agents.claude-code.new")), other => panic!("{other:?}") }
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = [\"no-such-cli-xyz\", \"{prompt}\"]\n").unwrap();
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "q", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!(done.status, AskStatus::Failed);
    assert!(done.error.as_deref().unwrap().contains("Command not found: no-such-cli-xyz"));
}

#[tokio::test]
async fn timeout_is_failed() {
    let (_d, core, doc, _room) = setup("");
    let asks = Asks::with_limits(core.clone(), None, Limits { timeout: Duration::from_millis(300), ..Limits::default() });
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "SLEEP", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!((done.status, done.error.as_deref()), (AskStatus::Failed, Some("Stopped: took too long")));
}

#[tokio::test]
async fn restart_turns_running_into_failed_and_unblocks() {
    let (_d, core, doc, _room) = setup("");
    let asks = Asks::new(core.clone(), None);
    let t = asks.start(&doc, "SLEEP", None).unwrap();
    // A new Asks over the same home = roomsd restarted while t was running.
    let fresh = Asks::new(core.clone(), None);
    let th = fresh.thread(&t.scope).unwrap();
    assert_eq!((th[0].status, th[0].error.as_deref()), (AskStatus::Failed, Some("Stopped because Rooms restarted")));
    assert!(fresh.start(&doc, "after restart", None).is_ok());
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
    let scope = |a: &rooms_protocol::Artifact| AskScope::Doc { file_key: a.file_key.clone() };
    for a in &arts[..4] { asks.start(&scope(a), "SLEEP", None).unwrap(); }
    assert!(matches!(asks.start(&scope(&arts[4]), "SLEEP", None), Err(AskError::Capacity)));
    asks.shutdown().await;
}

#[tokio::test]
async fn start_after_shutdown_is_refused() {
    let (_d, core, doc, _room) = setup("");
    let asks = Asks::new(core.clone(), None);
    asks.shutdown().await;
    assert!(matches!(asks.start(&doc, "q", None), Err(AskError::Capacity)));
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
    let (d, core, doc, room) = setup("");
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "S-9", &real.to_string_lossy());
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "q", None).unwrap();
    assert_eq!(t.mode, AskMode::Resume);
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains("[resume] [S-9]"), "{}", done.answer);
    assert!(done.answer.contains(&format!("CWD: {}", real.display())), "{}", done.answer);
}

#[tokio::test]
async fn meta_session_wins_over_sidecar() {
    let (d, core, doc, room) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "S-9", "/");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "q", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains("[resume] [S-1]"), "{}", done.answer);
}

#[tokio::test]
async fn sidecar_entry_is_used_whole_not_mixed_with_meta_agent() {
    let (d, core, doc, room) = setup(r#"<meta name="rooms:agent" content="codex">"#);
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "S-9", "/");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "q", None).unwrap();
    assert_eq!((t.agent.as_str(), t.mode), ("claude-code", AskMode::Resume));
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains("[resume] [S-9]"), "{}", done.answer);
}

#[tokio::test]
async fn sidecar_values_are_still_validated() {
    let (d, core, doc, room) = setup("");
    write_sources(d.path(), &doc_path(&core, &room), "claude-code", "--bad", "/");
    let asks = Asks::new(core.clone(), None);
    let t = asks.start(&doc, "q", None).unwrap();
    assert_eq!(t.mode, AskMode::New);
}

#[tokio::test]
async fn corrupt_sidecar_means_new_mode_without_error() {
    let (d, core, doc, _room) = setup("");
    std::fs::write(d.path().join(".rooms/sources.json"), "{").unwrap();
    let asks = Asks::new(core.clone(), None);
    let t = asks.start(&doc, "q", None).unwrap();
    assert_eq!(t.mode, AskMode::New);
}

// ---- target and model ----

fn with_models(home: &std::path::Path) {
    std::fs::write(home.join(".rooms/agents.toml"), format!(
        "[agents.claude-code]\nresume = [\"{FAKE}\", \"resume\", \"{{session}}\", \"{{prompt}}\"]\nnew = [\"{FAKE}\", \"new\", \"-m\", \"{{model}}\", \"{{prompt}}\"]\nmodels = [\"m1\", \"m2\"]\n[agents.codex]\nnew = [\"{FAKE}\", \"codex\", \"{{prompt}}\"]\n"
    )).unwrap();
}

#[tokio::test]
async fn target_matches_what_start_picks() {
    // (doc meta, sidecar (agent, session), models offered) → the same agent, mode and models from target and start
    type Case<'a> = (&'a str, Option<(&'a str, &'a str)>, &'a [&'a str]);
    let cases: [Case; 5] = [
        (r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#, None, &[]),
        ("", Some(("claude-code", "S-9")), &[]),
        (r#"<meta name="rooms:agent" content="codex">"#, Some(("claude-code", "S-9")), &[]),
        (r#"<meta name="rooms:agent" content="codex">"#, None, &[]),
        ("", None, &["m1", "m2"]),
    ];
    for (meta, side, models) in cases {
        let (d, core, doc, room) = setup(meta);
        with_models(d.path());
        if let Some((agent, session)) = side { write_sources(d.path(), &doc_path(&core, &room), agent, session, "/"); }
        let asks = Asks::new(core.clone(), None);
        let target = asks.target(&doc).unwrap();
        assert_eq!(target.models, models, "{meta} {side:?}");
        // start validates the model before anything else: a not-offered one is refused, an offered one is not
        assert!(matches!(asks.start(&doc, "q", Some("not-offered")), Err(AskError::BadRequest(_))));
        let t = asks.start(&doc, "q", models.first().copied()).unwrap();
        assert_eq!((target.agent.as_str(), target.mode), (t.agent.as_str(), t.mode), "{meta} {side:?}");
        assert_eq!(t.model.as_deref(), models.first().copied());
        asks.shutdown().await;
    }
}

#[tokio::test]
async fn target_lists_models_only_for_a_template_that_takes_one() {
    let (d, core, doc, _room) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    with_models(d.path());
    let asks = Asks::new(core.clone(), None);
    let resumed = asks.target(&doc).unwrap();
    assert_eq!((resumed.mode, resumed.models.len()), (AskMode::Resume, 0));
    // a model the resume template can't take is refused
    assert!(matches!(asks.start(&doc, "q", Some("m1")), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.target(&AskScope::Doc { file_key: "0000000000000000".into() }), Err(AskError::NotFound)));
    std::fs::write(d.path().join(".rooms/agents.toml"), "default = [").unwrap();
    assert!(matches!(asks.target(&doc), Err(AskError::AgentConfig(_))));
}

#[tokio::test]
async fn model_is_passed_and_recorded() {
    let (d, core, doc, _room) = setup("");
    with_models(d.path());
    let asks = Asks::new(core.clone(), None);
    let target = asks.target(&doc).unwrap();
    assert_eq!((target.agent.as_str(), target.mode, target.models.clone()), ("claude-code", AskMode::New, vec!["m1".to_string(), "m2".to_string()]));
    for bad in ["nope", "--evil", "m1 "] {
        assert!(matches!(asks.start(&doc, "q", Some(bad)), Err(AskError::BadRequest(_))), "{bad}");
    }
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "q", Some("m2")).unwrap();
    assert_eq!(t.model.as_deref(), Some("m2"));
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.starts_with("ARGV: [new] [-m] [m2] ["), "{}", done.answer);
    assert_eq!(asks.thread(&t.scope).unwrap().last().unwrap().model.as_deref(), Some("m2"));
    // "" is the agent's default: no flag, nothing recorded
    let t = asks.start(&doc, "q2", Some("")).unwrap();
    assert_eq!(t.model, None);
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.starts_with("ARGV: [new] [[Rooms]"), "{}", done.answer);
}

#[tokio::test]
async fn json_lines_stream_as_progress_then_the_final_answer() {
    let (d, core, doc, _room) = setup("");
    let script = d.path().join("stream-agent.sh");
    std::fs::write(&script, concat!(
        "#!/bin/sh\n",
        "echo '{\"type\":\"tool\",\"name\":\"Read\",\"path\":\"/x/doc.html\"}'; sleep 0.3\n",
        "echo '{\"type\":\"delta\",\"text\":\"표는 \"}'; sleep 0.3\n",
        "echo '{\"type\":\"delta\",\"text\":\"이렇게\"}'; sleep 0.3\n",
        "echo '{\"type\":\"result\",\"result\":\"표는 이렇게 읽어요.\"}'\n",
    )).unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), format!(concat!(
        "[agents.claude-code]\nnew = [\"{}\", \"{{prompt}}\"]\n",
        "[[agents.claude-code.events]]\nmatch = {{ \"/type\" = \"tool\" }}\nactivity = [\"/name\", \"/path\"]\n",
        "[[agents.claude-code.events]]\nmatch = {{ \"/type\" = \"delta\" }}\ndelta = \"/text\"\n",
        "[[agents.claude-code.events]]\nmatch = {{ \"/type\" = \"result\" }}\nanswer = \"/result\"\n",
    ), script.display())).unwrap();
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&doc, "표 설명", None).unwrap();
    let mut progress = Vec::new();
    let done = loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("events in time").unwrap();
        match ev.kind {
            EventKind::AskProgress { id, scope, answer, activity } if id == t.id => {
                assert_eq!(scope, doc);
                progress.push((answer, activity));
            }
            EventKind::AskDone { turn } if turn.id == t.id => break turn,
            _ => {}
        }
    };
    assert!(progress.contains(&(String::new(), Some("Read · doc.html".into()))), "{progress:?}");
    assert!(progress.iter().any(|(a, act)| a == "표는" && act.is_none()), "{progress:?}");
    assert!(progress.iter().any(|(a, _)| a == "표는 이렇게"), "{progress:?}");
    assert_eq!((done.status, done.answer.as_str()), (AskStatus::Done, "표는 이렇게 읽어요."));
    assert_eq!(asks.thread(&t.scope).unwrap()[0].answer, "표는 이렇게 읽어요.");
}

#[tokio::test]
async fn images_reach_the_template_and_the_prompt_and_stay_on_the_turn() {
    let (d, core, doc, _room) = setup("");
    std::fs::write(d.path().join(".rooms/agents.toml"), format!(
        "[agents.claude-code]\nnew = [\"{FAKE}\", \"--dir\", \"{{image_dir}}\", \"-i\", \"{{image}}\", \"{{prompt}}\"]\n")).unwrap();
    let asks = Asks::new(core.clone(), None);
    let id = asks.save_image(b"\x89PNG\r\n\x1a\none").unwrap();
    let id2 = asks.save_image(b"GIF89a-two").unwrap();
    let mut rx = core.subscribe();
    let both = [id.clone(), id2.clone()];
    let t = asks.start_with(&doc, Request { images: &both, ..Request::question("이 화면 뭐야?") }).unwrap();
    assert_eq!(t.images, vec![id.clone(), id2.clone()]);
    let done = wait_done(&mut rx, &t.id).await;
    let dir = core.home().join(".rooms/asks/images");
    let (p1, p2) = (dir.join(&id), dir.join(&id2));
    assert!(done.answer.contains(&format!("[--dir] [{}] [-i] [{}] [-i] [{}]", dir.display(), p1.display(), p2.display())), "{}", done.answer);
    assert!(done.answer.contains(&format!("Attached images (open each one to see it):\n- {}\n- {}", p1.display(), p2.display())), "{}", done.answer);
    assert_eq!(asks.thread(&t.scope).unwrap()[0].images, vec![id.clone(), id2]);
    // Without images the flags go away.
    let t = asks.start(&doc, "no images", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    let argv = done.answer.lines().next().unwrap();
    assert!(!argv.contains("[-i]") && !argv.contains("[--dir]"), "{argv}");
    // Unknown or too many images are refused before anything runs.
    let missing = "0123456789abcdef0123456789abcdef.png".to_string();
    assert!(matches!(asks.start_with(&doc, Request { images: &[missing], ..Request::question("q") }), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.start_with(&doc, Request { images: &vec![id; 6], ..Request::question("q") }), Err(AskError::BadRequest(_))));
}

#[tokio::test]
async fn new_starts_over_and_compact_sends_the_agents_summary_instead() {
    let (_d, core, doc, _room) = setup("");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let start = |kind| asks.start_with(&doc, Request::command(kind));
    assert!(matches!(start(AskKind::Clear), Err(AskError::BadRequest(m)) if m == "Nothing to clear yet"));
    assert!(matches!(start(AskKind::Compact), Err(AskError::BadRequest(m)) if m == "Nothing to summarize yet"));
    let t1 = asks.start(&doc, "first", None).unwrap();
    wait_done(&mut rx, &t1.id).await;

    // /compact: the agent gets the Q&A and the summary ask; its answer is the summary.
    let c = start(AskKind::Compact).unwrap();
    assert_eq!((c.kind, c.question.as_str(), c.status), (AskKind::Compact, "/compact", AskStatus::Running));
    let c = wait_done(&mut rx, &c.id).await;
    assert!(c.answer.contains("Q: first\n") && c.answer.contains("Question: Summarize the Q&A above"), "{}", c.answer);
    let t2 = asks.start(&doc, "second", None).unwrap();
    let d2 = wait_done(&mut rx, &t2.id).await;
    // (the fake agent echoes its prompt, so the summary holds the first Q&A once; nothing else does)
    assert!(d2.answer.contains("Summary of the earlier Q&A:\nARGV:"), "{}", d2.answer);
    assert_eq!(d2.answer.matches("Previous Q&A:").count(), 1, "{}", d2.answer);

    // /new: recorded at once, nothing runs, and nothing earlier goes along.
    let n = start(AskKind::Clear).unwrap();
    assert_eq!((n.kind, n.status, n.question.as_str()), (AskKind::Clear, AskStatus::Done, "/new"));
    assert_eq!(wait_done(&mut rx, &n.id).await.id, n.id);
    let t3 = asks.start(&doc, "third", None).unwrap();
    let d3 = wait_done(&mut rx, &t3.id).await;
    assert!(!d3.answer.contains("Summary of") && !d3.answer.contains("Previous Q&A"), "{}", d3.answer);
    let kinds: Vec<AskKind> = asks.thread(&t3.scope).unwrap().iter().map(|t| t.kind).collect();
    assert_eq!(kinds, [AskKind::Question, AskKind::Compact, AskKind::Question, AskKind::Clear, AskKind::Question]);
}

/// Two rooms link one original; the first room's link is gone (the index still lists it until a
/// rescan). The ask goes through the second room's link.
#[tokio::test]
async fn doc_scope_skips_a_dangling_link_and_uses_the_next_room() {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let a = core.create_room("a").unwrap().id;
    let b = core.create_room("b").unwrap().id;
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("o.html"), "<html><head><title>O</title></head><body>x</body></html>").unwrap();
    std::os::unix::fs::symlink(outside.path().join("o.html"), d.path().join("a/o.html")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("o.html"), d.path().join("b/o.html")).unwrap();
    core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), format!("[agents.claude-code]\nnew = [\"{FAKE}\", \"new\", \"{{prompt}}\"]\n")).unwrap();
    let key = core.list_artifacts(&a).unwrap().remove(0).file_key;
    assert_eq!(core.artifacts_by_file_key(&key).iter().map(|x| x.room_id.as_str()).collect::<Vec<_>>(), [a.as_str(), b.as_str()]);
    let doc = AskScope::Doc { file_key: key.clone() };
    std::fs::remove_file(d.path().join("a/o.html")).unwrap();
    assert_eq!(core.artifact_by_file_key(&key).unwrap().room_id, a, "the index still lists the dangling link first");

    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    assert!(asks.target(&doc).is_ok());
    let t = asks.start(&doc, "q", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!(done.status, AskStatus::Done);
    assert!(done.answer.contains(&format!("Document: {}", outside.path().join("o.html").canonicalize().unwrap().display())), "{}", done.answer);
    // both links gone: nothing resolves
    std::fs::remove_file(d.path().join("b/o.html")).unwrap();
    assert!(matches!(asks.target(&doc), Err(AskError::NotFound)));
    asks.shutdown().await;
}

#[tokio::test]
async fn a_conversation_ask_resumes_that_conversation_in_its_folder() {
    let (d, core, _doc, _room) = setup("");
    let data = d.path().join("collect");
    let work = tempfile::tempdir().unwrap();
    let work_dir = std::fs::canonicalize(work.path()).unwrap();
    let db = rooms_collect::store::open(&rooms_collect::store::path_in(&data)).unwrap();
    db.execute("INSERT INTO events(id, kind, agent, session, ts, cwd, role, src_path, file_key, src_offset, src_len, preview)
                VALUES('e1', 'message', 'claude-code', 'C-7', '2026-10-05T01:00:00Z', ?1, 'user', '/log', 'k', 0, 0, 'why is cold start slow')",
        [work_dir.to_string_lossy()]).unwrap();
    core.set_collect_data(&data);
    let asks = Asks::new(core.clone(), None);
    let scope = AskScope::Conversation { agent: rooms_protocol::Agent::ClaudeCode, session: rooms_protocol::SessionId::parse("C-7").unwrap() };
    assert_eq!(asks.target(&scope).unwrap().mode, AskMode::Resume);
    let mut rx = core.subscribe();
    let t = asks.start(&scope, "three lines?", None).unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.starts_with("ARGV: [resume] [C-7] ["), "{}", done.answer);
    assert!(done.answer.contains("Conversation: why is cold start slow\nAgent: claude-code, session C-7\n"), "{}", done.answer);
    assert!(done.answer.contains(&format!("CWD: {}", work_dir.display())), "{}", done.answer);
    assert_eq!(asks.thread(&scope).unwrap()[0].id, t.id);

    let gone = AskScope::Conversation { agent: rooms_protocol::Agent::Codex, session: rooms_protocol::SessionId::parse("nope").unwrap() };
    assert!(matches!(asks.start(&gone, "q", None), Err(AskError::ConversationNotFound)));
    let flag_shaped = AskScope::Conversation { agent: rooms_protocol::Agent::ClaudeCode, session: rooms_protocol::SessionId::parse("-x").unwrap() };
    db.execute("INSERT INTO events(id, kind, agent, session, ts, role, src_path, file_key, src_offset, src_len, preview)
                VALUES('e2', 'message', 'claude-code', '-x', '2026-10-05T01:00:00Z', 'user', '/log', 'k', 0, 0, 'hi')", []).unwrap();
    assert_eq!(asks.target(&flag_shaped).unwrap().mode, AskMode::New, "a session id that reads as a flag is never resumed");
    asks.shutdown().await;
}
