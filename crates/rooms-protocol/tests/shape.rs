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
    };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["kind"], "owned");
    assert_eq!(v["artifactCount"], 2);
    assert!(v["updatedAt"].is_null());
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
    AskTurn::export_all().unwrap();
    StartAsk::export_all().unwrap();
}

#[test]
fn ask_events_are_camel_and_tagged() {
    let turn = AskTurn {
        id: "a1".into(), file_key: "0123456789abcdef".into(), question: "q".into(), answer: "".into(),
        agent: "claude-code".into(), mode: AskMode::Resume, status: AskStatus::Running,
        error: None, started_at: "2026-10-06T10:00:00+09:00".into(), ended_at: None,
    };
    let v = serde_json::to_value(&RoomsEvent { seq: 3, kind: EventKind::AskStarted { turn: turn.clone() } }).unwrap();
    assert_eq!(v["type"], "ask.started");
    assert_eq!(v["turn"]["fileKey"], "0123456789abcdef");
    assert_eq!(v["turn"]["mode"], "resume");
    assert_eq!(v["turn"]["status"], "running");
    assert_eq!(v["turn"]["endedAt"], serde_json::Value::Null);
    let d = serde_json::to_value(&RoomsEvent { seq: 4, kind: EventKind::AskDone { turn } }).unwrap();
    assert_eq!(d["type"], "ask.done");
    let s: StartAsk = serde_json::from_str(r#"{"roomId":"r","artifactId":"a","question":"hi"}"#).unwrap();
    assert_eq!((s.room_id.as_str(), s.artifact_id.as_str(), s.question.as_str()), ("r", "a", "hi"));
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
