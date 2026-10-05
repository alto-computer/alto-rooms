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
    ApiError::export_all().unwrap();
}
