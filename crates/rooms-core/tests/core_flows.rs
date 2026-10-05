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

use std::time::{Duration, Instant};

fn wait_for(rx: &mut tokio::sync::broadcast::Receiver<RoomsEvent>, pred: impl Fn(&EventKind) -> bool, max: Duration) -> Vec<RoomsEvent> {
    let start = Instant::now();
    let mut got = Vec::new();
    while start.elapsed() < max {
        match rx.try_recv() {
            Ok(e) => { let hit = pred(&e.kind); got.push(e); if hit { return got; } }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    panic!("timed out; got {got:?}");
}

#[test]
fn new_file_emits_added_within_two_seconds() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::write(d.path().join("a/new.html"), "<title>N</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.room_id == r.id), Duration::from_secs(2));
}

#[test]
fn atomic_rename_write_yields_single_add() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::write(d.path().join("a/x.html.tmp"), "<title>X</title>").unwrap();
    fs::rename(d.path().join("a/x.html.tmp"), d.path().join("a/x.html")).unwrap();
    let evs = wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { .. }), Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(600));
    let mut all = evs;
    while let Ok(e) = rx.try_recv() { all.push(e); }
    let adds = all.iter().filter(|e| matches!(e.kind, EventKind::ArtifactAdded { .. })).count();
    let removes = all.iter().filter(|e| matches!(e.kind, EventKind::ArtifactRemoved { .. })).count();
    assert_eq!((adds, removes), (1, 0), "{all:?}");
}

#[test]
fn open_returns_before_backfill_completes_for_big_room() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), "").unwrap(); }
    let t = Instant::now();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    assert!(t.elapsed() < Duration::from_millis(500), "open must not wait for backfill");
    assert!(!core.list_rooms().is_empty());
}

#[test]
fn room_for_path_picks_longest_root() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    let d = d.path().canonicalize().unwrap();
    assert_eq!(core.room_for_path(&d.join("a/x.html")).unwrap(), r.id);
    assert_eq!(core.room_for_path(&d.join("journal/2026-01-01/n.md")).unwrap(), "journal");
    let inbox = core.list_rooms().into_iter().find(|x| x.name == "inbox").unwrap();
    assert_eq!(core.room_for_path(&d.join("inbox/y.html")).unwrap(), inbox.id);
    assert!(core.room_for_path(&d.join("zzz-unknown/y.html")).is_none());
}

#[test]
fn burst_of_twenty_files_yields_twenty_adds() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    for i in 0..20 { fs::write(d.path().join(format!("a/f{i}.html")), "<title>F</title>").unwrap(); }
    let start = Instant::now();
    let mut adds = 0;
    while start.elapsed() < Duration::from_secs(2) && adds < 20 {
        match rx.try_recv() {
            Ok(e) => if matches!(e.kind, EventKind::ArtifactAdded { .. }) { adds += 1 },
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    assert_eq!(adds, 20);
}

#[test]
fn rooms_dir_changes_are_ignored_but_rooms_named_folder_elsewhere_is_not() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::create_dir_all(d.path().join("a/.rooms")).unwrap();
    fs::write(d.path().join("a/.rooms/z.html"), "").unwrap();
    fs::write(d.path().join("a/ok.html"), "<title>O</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.room_id == r.id), Duration::from_secs(2));
}

#[test]
fn dropping_watch_handle_stops_watching() {
    let d = tempfile::tempdir().unwrap();
    let (core, w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx0 = core.subscribe();
    fs::write(d.path().join("a/before.html"), "<title>B</title>").unwrap();
    wait_for(&mut rx0, |k| matches!(k, EventKind::ArtifactAdded { .. }), Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(400));
    drop(w);
    std::thread::sleep(Duration::from_millis(100));
    let mut rx = core.subscribe();
    fs::write(d.path().join("a/after.html"), "<title>A</title>").unwrap();
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1200) {
        if let Ok(e) = rx.try_recv() {
            assert!(!matches!(e.kind, EventKind::ArtifactAdded { .. }), "got event after drop: {e:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<RoomsEvent>) -> Vec<RoomsEvent> {
    let mut v = Vec::new();
    while let Ok(e) = rx.try_recv() { v.push(e); }
    v
}

fn room_updates(evs: &[RoomsEvent]) -> Vec<RoomStatus> {
    evs.iter().filter_map(|e| match &e.kind { EventKind::RoomUpdated { room } => Some(room.status), _ => None }).collect()
}

#[test]
fn unavailable_linked_root_keeps_rows_and_emits_one_update_per_transition() {
    let (_d, core) = home();
    let team = tempfile::tempdir().unwrap();
    let root = team.path().join("research");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a.html"), "<title>A</title>").unwrap();
    let r = core.link_folder(&root, Some("r")).unwrap();
    let created = core.list_artifacts(&r.id).unwrap()[0].created_at.clone();
    let mut rx = core.subscribe();

    fs::rename(&root, team.path().join("away")).unwrap();
    core.rescan_room(&r.id);
    core.rescan_room(&r.id);
    let evs = drain(&mut rx);
    assert_eq!(room_updates(&evs), vec![RoomStatus::Unavailable], "{evs:?}");
    assert!(!evs.iter().any(|e| matches!(e.kind, EventKind::ArtifactRemoved { .. })), "{evs:?}");
    let arts = core.list_artifacts(&r.id).unwrap();
    assert_eq!(arts.len(), 1);
    assert_eq!(arts[0].created_at, created);
    let listed = core.list_rooms().into_iter().find(|x| x.id == r.id).unwrap();
    assert_eq!(listed.status, RoomStatus::Unavailable);

    fs::rename(team.path().join("away"), &root).unwrap();
    core.rescan_room(&r.id);
    core.rescan_room(&r.id);
    let evs = drain(&mut rx);
    assert_eq!(room_updates(&evs), vec![RoomStatus::Ok], "{evs:?}");
    assert_eq!(core.list_rooms().into_iter().find(|x| x.id == r.id).unwrap().status, RoomStatus::Ok);
    assert_eq!(core.list_artifacts(&r.id).unwrap()[0].created_at, created);
}

#[test]
fn unreadable_linked_root_is_unavailable_not_empty() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, core) = home();
    let team = tempfile::tempdir().unwrap();
    let root = team.path().join("research");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a.html"), "").unwrap();
    let r = core.link_folder(&root, Some("r")).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();
    core.rescan_room(&r.id);
    let status = core.list_rooms().into_iter().find(|x| x.id == r.id).unwrap().status;
    let n = core.list_artifacts(&r.id).unwrap().len();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!((status, n), (RoomStatus::Unavailable, 1));
}

#[test]
fn linked_root_missing_at_startup_is_watched_once_it_returns() {
    let d = tempfile::tempdir().unwrap();
    let team = tempfile::tempdir().unwrap();
    let root = team.path().join("research");
    fs::create_dir_all(&root).unwrap();
    let id = {
        let core = RoomsCore::open(d.path()).unwrap();
        core.link_folder(&root, Some("r")).unwrap().id
    };
    fs::rename(&root, team.path().join("away")).unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let mut rx = core.subscribe();
    wait_for(&mut rx, |k| matches!(k, EventKind::RoomUpdated { room } if room.id == id && room.status == RoomStatus::Unavailable), Duration::from_secs(3));
    fs::rename(team.path().join("away"), &root).unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::RoomUpdated { room } if room.id == id && room.status == RoomStatus::Ok), Duration::from_secs(5));
    std::thread::sleep(Duration::from_millis(400));
    fs::write(root.join("new.html"), "<title>N</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.room_id == id), Duration::from_secs(3));
}

fn journal_dates(evs: &[RoomsEvent]) -> Vec<String> {
    let mut v: Vec<String> = evs.iter().filter_map(|e| match &e.kind { EventKind::JournalChanged { date } => Some(date.clone()), _ => None }).collect();
    v.sort();
    v
}

#[test]
fn journal_folder_artifact_is_filed_by_folder_date_not_created_at() {
    // spec example: journal/2026-10-05/dream.html written at 2026-10-06T00:30+09:00 belongs to 10-05.
    // Use a created instant that is 10-07 in every local timezone so the test is TZ-independent.
    let (d, core) = home();
    let mut rx = core.subscribe();
    fs::create_dir_all(d.path().join("journal/2026-10-05")).unwrap();
    fs::write(d.path().join("journal/2026-10-05/dream.html"), r#"<meta name="rooms:created" content="2026-10-07T12:00:00+00:00">"#).unwrap();
    core.rescan_room(&JOURNAL_ROOM_ID.to_string());
    assert_eq!(core.journal_day(&"2026-10-05".to_string()).unwrap().artifacts.len(), 1);
    assert!(core.journal_day(&"2026-10-07".to_string()).unwrap().artifacts.is_empty());
    assert_eq!(journal_dates(&drain(&mut rx)), vec!["2026-10-05".to_string()]);
}

#[test]
fn day_move_notifies_old_and_new_day() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    let f = d.path().join("a/x.html");
    fs::write(&f, r#"<meta name="rooms:created" content="2026-10-07T12:00:00+00:00">"#).unwrap();
    core.rescan_room(&r.id);
    let mut rx = core.subscribe();
    fs::write(&f, r#"<meta name="rooms:created" content="2026-10-09T12:00:00+00:00"><title>moved</title>"#).unwrap();
    core.rescan_room(&r.id);
    assert_eq!(journal_dates(&drain(&mut rx)), vec!["2026-10-07".to_string(), "2026-10-09".to_string()]);
    assert_eq!(core.journal_day(&"2026-10-09".to_string()).unwrap().artifacts.len(), 1);
}
