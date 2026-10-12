use rooms_protocol::*;

#[test]
fn room_serializes_camel_case() {
    let r = Room {
        id: "abc123def456".into(),
        name: "연구 도구".into(),
        kind: RoomKind::Owned,
        path: "/Users/x/rooms/연구-도구".into(),
        status: RoomStatus::Ok,
        artifact_count: 2,
        updated_at: None,
        color: None,
    };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["kind"], "owned");
    assert_eq!(v["artifactCount"], 2);
    assert!(v["updatedAt"].is_null());
    assert!(v["color"].is_null());
    let pinned = serde_json::to_value(Room { color: Some(RoomColor::Lilac), ..r }).unwrap();
    assert_eq!(pinned["color"], "lilac");
}

#[test]
fn event_flattens_seq_and_type() {
    let e = RoomsEvent { seq: 7, kind: EventKind::JournalChanged { date: "2026-10-05".into() } };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["seq"], 7);
    assert_eq!(v["type"], "journal.changed");
    assert_eq!(v["date"], "2026-10-05");
}

#[test]
fn artifact_removed_uses_camel_ids() {
    let e = RoomsEvent { seq: 1, kind: EventKind::ArtifactRemoved { room_id: "r".into(), artifact_id: "a".into() } };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "artifact.removed");
    assert_eq!(v["roomId"], "r");
    assert_eq!(v["artifactId"], "a");
}

#[test]
fn export_typescript_bindings() {
    // ts-rs writes files when `export` is called; the files are committed.
    Room::export_all().unwrap();
    Artifact::export_all().unwrap();
    JournalDay::export_all().unwrap();
    Info::export_all().unwrap();
    RoomsEvent::export_all().unwrap();
    ToolInfo::export_all().unwrap();
    ToolCall::export_all().unwrap();
    ToolResult::export_all().unwrap();
    ApiError::export_all().unwrap();
    AskScope::export_all().unwrap();
    AskTurn::export_all().unwrap();
    StartAsk::export_all().unwrap();
    AskTarget::export_all().unwrap();
    AskImage::export_all().unwrap();
    Session::export_all().unwrap();
    SessionRef::export_all().unwrap();
    JournalSession::export_all().unwrap();
    let list = PERMISSIONS.iter().map(|p| format!("\"{p}\"")).collect::<Vec<_>>().join(", ");
    let ts = format!("// Generated from rooms_protocol::PERMISSIONS by crates/rooms-protocol/tests/shape.rs. Do not edit.\n\nexport const PERMISSIONS = [{list}] as const;\n\nexport type Permission = (typeof PERMISSIONS)[number];\n");
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/protocol-ts/src/generated/permissions.ts"), ts).unwrap();
}

#[test]
fn ask_events_are_camel_and_tagged() {
    let turn = AskTurn {
        id: "a1".into(), scope: AskScope::Artifact { file_key: "0123456789abcdef".into() }, question: "q".into(), answer: "".into(),
        agent: "claude-code".into(), model: None, mode: AskMode::Resume, status: AskStatus::Running,
        error: None, started_at: "2026-10-06T10:00:00+09:00".into(), ended_at: None, images: vec![],
        kind: AskKind::Question, left_out: 0, session: None,
    };
    let v = serde_json::to_value(&RoomsEvent { seq: 3, kind: EventKind::AskStarted { turn: turn.clone() } }).unwrap();
    assert_eq!(v["type"], "ask.started");
    assert_eq!(v["turn"]["scope"], serde_json::json!({"kind": "artifact", "fileKey": "0123456789abcdef"}));
    assert_eq!(v["turn"]["mode"], "resume");
    assert_eq!(v["turn"]["status"], "running");
    assert_eq!(v["turn"]["endedAt"], serde_json::Value::Null);
    let d = serde_json::to_value(&RoomsEvent { seq: 4, kind: EventKind::AskDone { turn } }).unwrap();
    assert_eq!(d["type"], "ask.done");
    let s: StartAsk = serde_json::from_str(r#"{"scope":{"kind":"artifact","fileKey":"k"},"question":"hi"}"#).unwrap();
    assert_eq!((&s.scope, s.question.as_str(), s.model), (&AskScope::Artifact { file_key: "k".into() }, "hi", None));
    assert_eq!(v["turn"]["kind"], "question");
    assert_eq!(v["turn"]["leftOut"], 0);
    assert_eq!(v["turn"]["session"], serde_json::Value::Null);
    assert_eq!(serde_json::to_value(AskMode::Continue).unwrap(), "continue");
    let c: StartAsk = serde_json::from_str(r#"{"scope":{"kind":"artifact","fileKey":"k"},"question":"","kind":"compact"}"#).unwrap();
    assert_eq!(c.kind, Some(AskKind::Compact));
    // records written before kinds existed read back as questions
    let old: AskTurn = serde_json::from_value(serde_json::json!({"id":"a","scope":{"kind":"artifact","fileKey":"k"},"question":"q","answer":"","agent":"x","model":null,"mode":"new","status":"done","error":null,"startedAt":"t","endedAt":null})).unwrap();
    assert_eq!((old.kind, old.left_out), (AskKind::Question, 0));
}

#[test]
fn ask_scope_is_tagged_by_kind_and_round_trips() {
    let cases = [
        (AskScope::Artifact { file_key: "0123456789abcdef".into() }, serde_json::json!({"kind": "artifact", "fileKey": "0123456789abcdef"})),
        (AskScope::Room { room_id: "연구-도구".into() }, serde_json::json!({"kind": "room", "roomId": "연구-도구"})),
        (AskScope::Day { date: "2026-10-09".into() }, serde_json::json!({"kind": "day", "date": "2026-10-09"})),
        (AskScope::Session(SessionRef { agent: Agent::Codex, id: SessionId::parse("s-1").unwrap() }), serde_json::json!({"kind": "session", "agent": "codex", "id": "s-1"})),
    ];
    for (scope, json) in cases {
        assert_eq!(serde_json::to_value(&scope).unwrap(), json);
        assert_eq!(serde_json::from_value::<AskScope>(json).unwrap(), scope);
    }
    assert!(serde_json::from_str::<AskScope>(r#"{"kind":"artifact","roomId":"r"}"#).is_err());
    assert!(serde_json::from_str::<AskScope>(r#"{"fileKey":"k"}"#).is_err());
    assert!(serde_json::from_str::<AskScope>(r#"{"kind":"week","date":"2026-10-09"}"#).is_err());
    assert!(serde_json::from_str::<AskScope>(r#"{"kind":"session","agent":"codex","id":"--yolo x"}"#).is_err(), "a session id never reaches an argv unchecked");
    assert!(serde_json::from_str::<AskScope>(r#"{"kind":"session","agent":"codex","id":"-x"}"#).is_err(), "nor one that reads as a flag");
    assert!(serde_json::from_str::<AskScope>(r#"{"kind":"session","agent":"gemini","id":"s"}"#).is_err());
}

#[test]
fn start_ask_takes_any_scope_with_images_and_kind() {
    let room: StartAsk = serde_json::from_str(r#"{"scope":{"kind":"room","roomId":"r1"},"question":"q","model":"opus","images":["i1","i2"],"kind":"question"}"#).unwrap();
    assert_eq!(room.scope, AskScope::Room { room_id: "r1".into() });
    assert_eq!((room.model.as_deref(), room.images.as_deref(), room.kind), (Some("opus"), Some(&["i1".to_string(), "i2".to_string()][..]), Some(AskKind::Question)));
    let day: StartAsk = serde_json::from_str(r#"{"scope":{"kind":"day","date":"2026-10-09"},"question":"","model":null,"kind":"clear"}"#).unwrap();
    assert_eq!((day.scope, day.images, day.kind), (AskScope::Day { date: "2026-10-09".into() }, None, Some(AskKind::Clear)));
    // the old shape no longer parses: a client at the stack base gets 400, not an artifact ask under some default
    assert!(serde_json::from_str::<StartAsk>(r#"{"roomId":"r","artifactId":"a","question":"hi"}"#).is_err());
}

#[test]
fn ask_progress_carries_the_scope_object() {
    let e = RoomsEvent { seq: 5, kind: EventKind::AskProgress { id: "t1".into(), scope: AskScope::Room { room_id: "r1".into() }, answer: "so far".into(), activity: Some("Read · a.html".into()) } };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "ask.progress");
    assert_eq!(v["scope"], serde_json::json!({"kind": "room", "roomId": "r1"}));
    assert_eq!(v["activity"], "Read · a.html");
    let back: RoomsEvent = serde_json::from_value(v).unwrap();
    assert_eq!(back, e);
}

#[test]
fn ask_model_is_optional_on_the_wire() {
    let s: StartAsk = serde_json::from_str(r#"{"scope":{"kind":"artifact","fileKey":"k"},"question":"hi","model":"sonnet"}"#).unwrap();
    assert_eq!(s.model.as_deref(), Some("sonnet"));
    // turns recorded before models existed still read back
    let old = r#"{"id":"a1","scope":{"kind":"artifact","fileKey":"k"},"question":"q","answer":"","agent":"codex","mode":"new","status":"done","error":null,"startedAt":"t","endedAt":null}"#;
    assert_eq!(serde_json::from_str::<AskTurn>(old).unwrap().model, None);
    let t = serde_json::to_value(AskTarget { agent: "codex".into(), mode: AskMode::New, models: vec!["m".into()], scoped: false }).unwrap();
    assert_eq!(t, serde_json::json!({"agent": "codex", "mode": "new", "models": ["m"], "scoped": false}));
}

#[test]
fn plugin_data_changed_and_tool_types_have_camel_case_json() {
    let e = serde_json::to_value(&RoomsEvent { seq: 9, kind: EventKind::PluginDataChanged { plugin_id: "p".into(), path: "notes/a.jsonl".into() } }).unwrap();
    assert_eq!(e["type"], "plugin.data.changed");
    assert_eq!(e["pluginId"], "p");
    assert_eq!(e["path"], "notes/a.jsonl");
    let i = serde_json::to_value(&ToolInfo { plugin_id: "p".into(), name: "t".into(), description: "d".into(), input: serde_json::json!({"type":"object"}) }).unwrap();
    assert_eq!(i["pluginId"], "p");
    assert_eq!(i["input"]["type"], "object");
    let c: ToolCall = serde_json::from_str(r#"{"pluginId":"p","name":"t","input":{"doc":"x"}}"#).unwrap();
    assert_eq!((c.plugin_id.as_str(), c.input["doc"].as_str()), ("p", Some("x")));
    assert_eq!(serde_json::to_value(&ToolResult { path: "a".into() }).unwrap()["path"], "a");
}

#[test]
fn session_refs_validate_the_id_at_the_boundary() {
    let r: SessionRef = serde_json::from_str(r#"{"agent":"claude-code","id":"4b264772-d86b_42ef"}"#).unwrap();
    assert_eq!(r.key(), "claude-code:4b264772-d86b_42ef");
    assert_eq!(SessionRef::parse_key(&r.key()), Some(r.clone()));
    assert_eq!(r.resume_argv(), ["claude", "--resume", "4b264772-d86b_42ef"]);
    let codex = SessionRef { agent: Agent::Codex, id: SessionId::parse("019c").unwrap() };
    assert_eq!(codex.resume_argv(), ["codex", "resume", "019c"]);
    assert_eq!(serde_json::to_value(&codex).unwrap(), serde_json::json!({"agent": "codex", "id": "019c"}));
    for bad in ["", "a b", "a;rm -rf", "../x", "x:y", "-x", "--resume", &"a".repeat(129)] {
        assert!(SessionId::parse(bad).is_none(), "{bad:?}");
        assert!(serde_json::from_value::<SessionRef>(serde_json::json!({"agent": "codex", "id": bad})).is_err(), "{bad:?}");
    }
    assert!(SessionId::parse("x-").is_some(), "a dash after the first character is fine");
    assert!(serde_json::from_str::<SessionRef>(r#"{"agent":"cursor","id":"s"}"#).is_err());
    assert_eq!(SessionRef::parse_key("cursor:s"), None);
}

#[test]
fn a_source_points_at_its_session_only_when_both_parts_are_valid() {
    let src = |agent: Option<&str>, session: Option<&str>| Source { agent: agent.map(Into::into), session: session.map(Into::into), cwd: None, machine: None };
    assert_eq!(src(Some("codex"), Some("s-1")).session_ref(), Some(SessionRef { agent: Agent::Codex, id: SessionId::parse("s-1").unwrap() }));
    for (agent, session) in [(None, Some("s-1")), (Some("codex"), None), (Some("cursor"), Some("s-1")), (Some("codex"), Some("-x"))] {
        assert_eq!(src(agent, session).session_ref(), None, "{agent:?} {session:?}");
    }
}

#[test]
fn session_moved_is_camel_case_with_the_session_flattened() {
    let s = Session {
        agent: Agent::Aside, id: SessionId::parse("s1").unwrap(),
        title: Some("t".into()), cwd: None, started_at: "2026-10-01T00:00:00Z".into(), ended_at: "2026-10-01T01:00:00Z".into(),
        messages: 2, last_reply: None, artifacts_written: vec!["/a.html".into()], room_id: Some("r1".into()),
    };
    assert_eq!(s.session_ref(), SessionRef { agent: Agent::Aside, id: SessionId::parse("s1").unwrap() });
    let v = serde_json::to_value(&RoomsEvent { seq: 1, kind: EventKind::SessionMoved { session: s, from_room_id: None } }).unwrap();
    assert_eq!(v["type"], "session.moved");
    assert_eq!(v["fromRoomId"], serde_json::Value::Null);
    assert_eq!(v["session"]["roomId"], "r1");
    assert_eq!(v["session"]["artifactsWritten"][0], "/a.html");
    assert_eq!((&v["session"]["agent"], &v["session"]["id"]), (&serde_json::json!("aside"), &serde_json::json!("s1")));
}
