use rooms_core::{CoreError, RoomsCore};
use rooms_protocol::*;
use std::fs;
use std::os::unix::fs::symlink;

fn home() -> (tempfile::TempDir, RoomsCore) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    core.backfill_all().unwrap();
    (d, core)
}

#[test]
fn create_room_makes_slug_folder_and_keeps_display_name() {
    let (d, core) = home();
    let r = core.create_room("연구 도구").unwrap();
    assert_eq!(r.name, "연구 도구");
    assert!(d.path().join("연구-도구").is_dir());
    assert_eq!(core.create_room("연구-도구").unwrap_err(), CoreError::RoomExists);
    assert_eq!(core.create_room("journal").unwrap_err(), CoreError::InvalidRoomName);
    let reopened = RoomsCore::open(d.path()).unwrap();
    assert_eq!(reopened.list_rooms().iter().find(|x| x.id == r.id).unwrap().name, "연구 도구");
}

#[test]
fn inbox_is_listed_journal_is_not() {
    let (_d, core) = home();
    let names: Vec<String> = core.list_rooms().into_iter().map(|r| r.name).collect();
    assert!(names.contains(&"inbox".to_string()));
    assert!(!names.contains(&"journal".to_string()));
}

#[test]
fn rename_owned_renames_folder_keeps_id_and_artifact_ids() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    fs::write(d.path().join("a/x.html"), "").unwrap();
    core.rescan_room(&r.id);
    let before = core.list_artifacts(&r.id).unwrap()[0].id.clone();
    let mut rx = core.subscribe();
    let r2 = core.rename_room(&r.id, "b c").unwrap();
    assert_eq!(r2.id, r.id);
    assert!(d.path().join("b-c").is_dir());
    assert_eq!(core.list_artifacts(&r.id).unwrap()[0].id, before);
    let ev = rx.try_recv().unwrap();
    assert!(matches!(ev.kind, EventKind::RoomUpdated { .. }));
    assert!(rx.try_recv().is_err(), "exactly one event");
}

#[test]
fn link_folder_rules_and_rename_is_display_only() {
    let (d, core) = home();
    let team = tempfile::tempdir().unwrap();
    fs::create_dir_all(team.path().join("research/sub")).unwrap();
    let r = core.link_folder(&team.path().join("research"), Some("팀 리서치")).unwrap();
    assert_eq!(r.kind, RoomKind::Linked);
    assert_eq!(core.link_folder(&team.path().join("research/sub"), None).unwrap_err(), CoreError::OverlappingRoom);
    assert_eq!(core.link_folder(team.path(), None).unwrap_err(), CoreError::OverlappingRoom);
    assert!(matches!(core.link_folder(d.path(), None).unwrap_err(), CoreError::InvalidLinkPath(_)));
    core.rename_room(&r.id, "리서치").unwrap();
    assert!(team.path().join("research").is_dir(), "linked folder name untouched");
    assert_eq!(fs::read_dir(team.path().join("research")).unwrap().count(), 1, "nothing written into linked folder");
}

#[test]
fn journal_day_merges_journal_files_rooms_and_dedupes_symlinks() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap();
    let b = core.create_room("b").unwrap();
    let orig = tempfile::tempdir().unwrap();
    fs::write(orig.path().join("spec.html"), r#"<meta name="rooms:created" content="2026-10-05T10:00:00+09:00">"#).unwrap();
    symlink(orig.path().join("spec.html"), d.path().join("a/spec.html")).unwrap();
    symlink(orig.path().join("spec.html"), d.path().join("b/spec.html")).unwrap();
    fs::create_dir_all(d.path().join("journal/2026-10-05")).unwrap();
    fs::write(d.path().join("journal/2026-10-05/dream.html"), r#"<meta name="rooms:created" content="2026-10-05T23:00:00+09:00">"#).unwrap();
    core.backfill_all().unwrap();
    let day = core.journal_day(&"2026-10-05".to_string()).unwrap();
    let titles: Vec<&str> = day.artifacts.iter().map(|x| x.title.as_str()).collect();
    assert_eq!(titles, vec!["spec", "dream"], "deduped by target, sorted by createdAt");
    let _ = (a, b);
}

#[test]
fn save_note_is_atomic_and_listed() {
    let (d, core) = home();
    let n = core.save_note(&"2026-10-05".to_string(), "회고", "# 오늘").unwrap();
    assert_eq!(n.name, "회고.md");
    assert_eq!(fs::read_to_string(d.path().join("journal/2026-10-05/회고.md")).unwrap(), "# 오늘");
    let day = core.journal_day(&"2026-10-05".to_string()).unwrap();
    assert_eq!(day.notes.len(), 1);
    assert!(core.save_note(&"2026-13-01".to_string(), "x", "").is_err());
    assert!(core.save_note(&"2026-10-05".to_string(), "x", &"a".repeat(1_048_577)).is_err());
}

#[test]
fn resolve_file_blocks_escape_but_allows_html_file_links() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("o.html"), "").unwrap();
    symlink(outside.path().join("o.html"), d.path().join("a/o.html")).unwrap();
    fs::write(d.path().join("a/in.html"), "").unwrap();
    assert!(core.resolve_file(&r.id, "in.html").is_ok());
    assert_eq!(core.resolve_file(&r.id, "o.html").unwrap(), fs::canonicalize(outside.path().join("o.html")).unwrap());
    assert_eq!(core.resolve_file(&r.id, "../journal").unwrap_err(), CoreError::PathEscape);
    symlink(outside.path(), d.path().join("a/dir")).unwrap();
    assert_eq!(core.resolve_file(&r.id, "dir/o.html").unwrap_err(), CoreError::PathEscape);
}

#[test]
fn seq_increases_monotonically() {
    let (_d, core) = home();
    let s0 = core.current_seq();
    core.create_room("x").unwrap();
    core.create_room("y").unwrap();
    assert_eq!(core.current_seq(), s0 + 2);
}

#[test]
fn rename_refuses_slug_collision_with_existing_folder() {
    let (d, core) = home();
    core.create_room("a b").unwrap();
    let x = core.create_room("x").unwrap();
    assert_eq!(core.rename_room(&x.id, "a-b").unwrap_err(), CoreError::RoomExists);
    assert!(d.path().join("a-b").is_dir());
    assert!(d.path().join("x").is_dir());
}

#[test]
fn open_does_not_adopt_symlinked_dirs() {
    let d = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), d.path().join("lnk")).unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    assert!(!core.list_rooms().iter().any(|r| r.name == "lnk"));
}

#[test]
fn resolve_file_rejects_dotfiles_and_directories() {
    let (_d, core) = home();
    let team = tempfile::tempdir().unwrap();
    let root = team.path().join("r");
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join(".env"), "s").unwrap();
    fs::write(root.join(".git/config"), "s").unwrap();
    let r = core.link_folder(&root, Some("r")).unwrap();
    assert_eq!(core.resolve_file(&r.id, ".env").unwrap_err(), CoreError::PathEscape);
    assert_eq!(core.resolve_file(&r.id, ".git/config").unwrap_err(), CoreError::PathEscape);
    assert!(core.resolve_file(&r.id, "sub").is_err());
}
