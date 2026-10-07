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
    assert!(matches!(core.create_room("연구-도구"), Err(CoreError::RoomExists)));
    assert!(matches!(core.create_room("journal"), Err(CoreError::InvalidRoomName)));
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
    assert!(matches!(core.link_folder(&team.path().join("research/sub"), None), Err(CoreError::OverlappingRoom)));
    assert!(matches!(core.link_folder(team.path(), None), Err(CoreError::OverlappingRoom)));
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
    assert!(matches!(core.resolve_file(&r.id, "../journal"), Err(CoreError::PathEscape)));
    symlink(outside.path(), d.path().join("a/dir")).unwrap();
    assert!(matches!(core.resolve_file(&r.id, "dir/o.html"), Err(CoreError::PathEscape)));
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
    assert!(matches!(core.rename_room(&x.id, "a-b"), Err(CoreError::RoomExists)));
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
    assert!(matches!(core.resolve_file(&r.id, ".env"), Err(CoreError::PathEscape)));
    assert!(matches!(core.resolve_file(&r.id, ".git/config"), Err(CoreError::PathEscape)));
    assert!(core.resolve_file(&r.id, "sub").is_err());
}

use std::time::{Duration, Instant};

/// Scales a timing bound by `ROOMS_TEST_SLOWDOWN` (f64, default 1.0) for slow or loaded machines.
fn slow(d: Duration) -> Duration {
    let k = std::env::var("ROOMS_TEST_SLOWDOWN").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(1.0);
    d.mul_f64(k)
}

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

#[test]
fn finder_mkdir_under_home_adopts_room_then_adds_artifact() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::create_dir(d.path().join("finder")).unwrap();
    fs::write(d.path().join("finder/x.html"), "<title>X</title>").unwrap();
    let evs = wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { .. }), Duration::from_secs(3));
    let added = evs.iter().position(|e| matches!(&e.kind, EventKind::RoomAdded { room } if room.name == "finder" && room.kind == RoomKind::Owned));
    let art = evs.iter().position(|e| matches!(e.kind, EventKind::ArtifactAdded { .. })).unwrap();
    assert!(added.is_some_and(|a| a < art), "room.added must precede artifact.added: {evs:?}");
}

#[test]
fn finder_rename_keeps_room_id_and_updates_path() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::rename(d.path().join("a"), d.path().join("b")).unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::RoomUpdated { room } if room.id == r.id && room.path.ends_with("/b")), Duration::from_secs(3));
    let rooms = core.list_rooms();
    let got = rooms.iter().find(|x| x.id == r.id).unwrap();
    assert!(got.path.ends_with("/b"));
    assert_eq!(got.name, "b");
    assert_eq!(rooms.iter().filter(|x| x.path.ends_with("/b")).count(), 1, "no duplicate adoption: {rooms:?}");
}

#[test]
fn finder_delete_removes_owned_room() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("gone").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::remove_dir(d.path().join("gone")).unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::RoomRemoved { room_id } if *room_id == r.id), Duration::from_secs(3));
    assert!(!core.list_rooms().iter().any(|x| x.id == r.id));
    assert!(matches!(core.list_artifacts(&r.id), Err(CoreError::RoomNotFound)));
}

#[test]
fn create_room_on_existing_plain_folder_is_room_exists() {
    let (d, core) = home();
    fs::create_dir(d.path().join("plain")).unwrap();
    assert!(matches!(core.create_room("plain"), Err(CoreError::RoomExists)));
}

#[test]
fn scan_of_removed_room_writes_nothing() {
    let (d, core) = home();
    let r = core.create_room("gone").unwrap();
    for i in 0..500 { fs::write(d.path().join(format!("gone/{i}.html")), "").unwrap(); }
    let c = core.clone(); let id = r.id.clone();
    let t = std::thread::spawn(move || c.rescan_room(&id));
    fs::remove_dir_all(d.path().join("gone")).unwrap();
    core.sync_home_dirs();
    t.join().unwrap();
    assert!(core.list_rooms().iter().all(|x| x.id != r.id));
    assert!(matches!(core.list_artifacts(&r.id), Err(CoreError::RoomNotFound)));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert!(core.journal_day(&today).unwrap().artifacts.iter().all(|a| a.room_id != r.id));
}



#[test]
fn finder_rename_of_inbox_does_not_move_the_inbox() {
    let (d, core) = home();
    fs::write(d.path().join("inbox/x.html"), "").unwrap();
    fs::rename(d.path().join("inbox"), d.path().join("old-inbox")).unwrap();
    core.sync_home_dirs();
    let rooms = core.list_rooms();
    let inbox = rooms.iter().find(|r| r.id == "inbox").unwrap();
    assert_eq!(std::path::Path::new(&inbox.path), d.path().canonicalize().unwrap().join("inbox"));
    assert!(d.path().join("inbox").is_dir());
    assert!(rooms.iter().any(|r| r.name == "old-inbox" && r.id != "inbox"));
}

#[test]
fn concurrent_save_note_on_one_name_never_fails_or_corrupts() {
    let (d, core) = home();
    let bodies: Vec<String> = (0..8).map(|t| char::from(b'a' + t as u8).to_string().repeat(1 + t * 40_000)).collect();
    let threads: Vec<_> = (0..8).map(|t| {
        let (c, body) = (core.clone(), bodies[t].clone());
        std::thread::spawn(move || (0..25).map(|_| c.save_note(&"2026-10-05".to_string(), "same.md", &body).map(|_| ())).collect::<Vec<_>>())
    }).collect();
    for t in threads { for r in t.join().unwrap() { assert!(r.is_ok(), "{r:?}"); } }
    let got = fs::read_to_string(d.path().join("journal/2026-10-05/same.md")).unwrap();
    assert!(bodies.contains(&got), "final file is not one of the bodies (len {})", got.len());
}

#[test]
fn dropping_handle_and_core_closes_the_event_channel() {
    let d = tempfile::tempdir().unwrap();
    let (core, w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let mut rx = core.subscribe();
    drop(w);
    std::thread::sleep(slow(Duration::from_millis(2500))); // one retry tick, so the retry thread sees the dropped debouncer
    drop(core);
    let s = Instant::now();
    loop {
        match rx.try_recv() {
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
            _ => { assert!(s.elapsed() < slow(Duration::from_secs(3)), "a helper thread still holds the core"); std::thread::sleep(Duration::from_millis(20)); }
        }
    }
}

#[test]
fn resync_all_rescans_and_emits_resync() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    fs::write(d.path().join("a/x.html"), "").unwrap();
    let mut rx = core.subscribe();
    core.resync_all();
    let evs = drain(&mut rx);
    assert!(evs.iter().any(|e| matches!(&e.kind, EventKind::ArtifactAdded { artifact } if artifact.room_id == r.id)));
    assert!(matches!(evs.last().unwrap().kind, EventKind::Resync { room_id: None }));
}

#[test]
fn resync_all_picks_up_finder_created_folders_in_order() {
    let (d, core) = home();
    fs::create_dir(d.path().join("fresh")).unwrap();
    fs::write(d.path().join("fresh/x.html"), "").unwrap();
    let mut rx = core.subscribe();
    core.resync_all();
    let evs = drain(&mut rx);
    let pos = |f: &dyn Fn(&EventKind) -> bool| evs.iter().position(|e| f(&e.kind));
    let room = pos(&|k| matches!(k, EventKind::RoomAdded { .. })).expect("room.added");
    let art = pos(&|k| matches!(k, EventKind::ArtifactAdded { .. })).expect("artifact.added");
    assert!(room < art);
    assert!(matches!(evs.last().unwrap().kind, EventKind::Resync { room_id: None }));
}

#[test]
fn folder_replacing_another_rooms_folder_removes_the_moved_room() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap();
    let b = core.create_room("b").unwrap();
    fs::write(d.path().join("a/x.html"), "<title>x</title>").unwrap();
    core.rescan_room(&a.id);
    fs::remove_dir_all(d.path().join("b")).unwrap();
    fs::rename(d.path().join("a"), d.path().join("b")).unwrap();
    core.sync_home_dirs();
    let rooms = core.list_rooms();
    assert!(rooms.iter().all(|r| r.id != a.id), "ghost room a: {rooms:?}");
    let rb = rooms.iter().find(|r| r.id == b.id).unwrap();
    assert_eq!(std::path::Path::new(&rb.path), d.path().canonicalize().unwrap().join("b"));
    core.create_room("a").unwrap();
}

#[test]
fn read_note_roundtrip_and_not_found() {
    let (_d, core) = home();
    core.save_note(&"2026-10-05".to_string(), "회고", "오늘 배운 것").unwrap();
    assert_eq!(core.read_note(&"2026-10-05".to_string(), "회고").unwrap(), "오늘 배운 것");
    assert!(matches!(core.read_note(&"2026-10-05".to_string(), "없음"), Err(CoreError::NotFound)));
    assert!(core.read_note(&"2026-10-05".to_string(), "../x").is_err());
}

fn day() -> String { "2026-10-05".to_string() }

#[test]
fn rename_note_moves_file_keeps_body_and_emits_removed_then_saved() {
    let (d, core) = home();
    core.save_note(&day(), "New Note", "본문").unwrap();
    let mut rx = core.subscribe();
    let n = core.rename_note(&day(), "New Note", "회고").unwrap();
    assert_eq!(n.name, "회고.md");
    assert_eq!(n.rel_path, "2026-10-05/회고.md");
    assert!(!d.path().join("journal/2026-10-05/New Note.md").exists());
    assert_eq!(fs::read_to_string(d.path().join("journal/2026-10-05/회고.md")).unwrap(), "본문");
    match rx.try_recv().unwrap().kind {
        EventKind::NoteRemoved { date, name } => { assert_eq!(date, day()); assert_eq!(name, "New Note.md"); }
        k => panic!("expected note.removed, got {k:?}"),
    }
    match rx.try_recv().unwrap().kind {
        EventKind::NoteSaved { note } => assert_eq!(note.name, "회고.md"),
        k => panic!("expected note.saved, got {k:?}"),
    }
    let names: Vec<String> = core.journal_day(&day()).unwrap().notes.into_iter().map(|n| n.name).collect();
    assert_eq!(names, vec!["회고.md".to_string()]);
}

#[test]
fn rename_note_missing_source_is_not_found() {
    let (_d, core) = home();
    assert!(matches!(core.rename_note(&day(), "없음", "x"), Err(CoreError::NotFound)));
}

#[test]
fn rename_note_never_overwrites_an_existing_target() {
    let (d, core) = home();
    core.save_note(&day(), "a", "A").unwrap();
    core.save_note(&day(), "b", "B").unwrap();
    assert!(matches!(core.rename_note(&day(), "a", "b"), Err(CoreError::NoteExists)));
    assert!(matches!(core.rename_note(&day(), "a", "B"), Err(CoreError::NoteExists)));
    assert!(matches!(core.rename_note(&day(), "a", "b.md"), Err(CoreError::NoteExists)));
    assert_eq!(fs::read_to_string(d.path().join("journal/2026-10-05/a.md")).unwrap(), "A");
    assert_eq!(fs::read_to_string(d.path().join("journal/2026-10-05/b.md")).unwrap(), "B");
    assert_eq!(CoreError::NoteExists.code(), "note_exists");
    assert_eq!(CoreError::NoteExists.status(), 409);
}

#[test]
fn rename_note_allows_a_case_only_rename() {
    let (d, core) = home();
    core.save_note(&day(), "a", "A").unwrap();
    let n = core.rename_note(&day(), "a", "A").unwrap();
    assert_eq!(n.name, "A.md");
    let names: Vec<String> = fs::read_dir(d.path().join("journal/2026-10-05")).unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(names, vec!["A.md".to_string()]);
    assert_eq!(fs::read_to_string(d.path().join("journal/2026-10-05/A.md")).unwrap(), "A");
}

#[test]
fn rename_note_rejects_invalid_names_and_traversal() {
    let (d, core) = home();
    core.save_note(&day(), "a", "A").unwrap();
    for bad in ["../x", "a/b", "..", ".hidden", "", "x:y"] {
        assert!(matches!(core.rename_note(&day(), "a", bad).unwrap_err(), CoreError::InvalidInput(_)), "to {bad:?}");
        assert!(matches!(core.rename_note(&day(), bad, "z").unwrap_err(), CoreError::InvalidInput(_)), "from {bad:?}");
    }
    assert!(core.rename_note(&"2026-13-01".to_string(), "a", "b").is_err());
    assert!(d.path().join("journal/2026-10-05/a.md").exists());
}

// ---- move_artifact ----

/// An original outside home plus a symlink to it in `inbox`, indexed. Returns (originals dir, original path, artifact).
fn inbox_link(core: &RoomsCore, name: &str, body: &str) -> (tempfile::TempDir, std::path::PathBuf, Artifact) {
    let orig_dir = tempfile::tempdir().unwrap();
    let orig = orig_dir.path().join(name);
    fs::write(&orig, body).unwrap();
    symlink(&orig, core.home().join("inbox").join(name)).unwrap();
    core.rescan_room(&"inbox".to_string());
    let a = core.list_artifacts(&"inbox".to_string()).unwrap().into_iter().find(|a| a.rel_path == name).unwrap();
    (orig_dir, orig, a)
}

fn ino(p: &std::path::Path) -> u64 { use std::os::unix::fs::MetadataExt; fs::metadata(p).unwrap().ino() }

#[test]
fn move_artifact_keeps_first_seen_and_journal_day_and_leaves_original_alone() {
    let (_d, core) = home();
    let r = core.create_room("a").unwrap();
    let (_o, orig, a) = inbox_link(&core, "spec.html", r#"<meta name="rooms:created" content="2026-01-02T03:04:05+09:00"><title>Spec</title>"#);
    let (before_ino, before_body) = (ino(&orig), fs::read(&orig).unwrap());
    let day = rooms_core::rules::local_day(&a.created_at).unwrap();
    let mut rx = core.subscribe();
    let moved = core.move_artifact(&"inbox".to_string(), &a.id, &r.id).unwrap();
    assert_eq!((moved.room_id.as_str(), moved.rel_path.as_str()), (r.id.as_str(), "spec.html"));
    assert_eq!((moved.created_at.as_str(), moved.title.as_str()), (a.created_at.as_str(), "Spec"));
    assert_eq!(moved.updated_at, a.updated_at);
    assert_ne!(moved.id, a.id);
    assert!(core.list_artifacts(&"inbox".to_string()).unwrap().is_empty());
    assert_eq!(core.list_artifacts(&r.id).unwrap(), vec![moved.clone()]);
    assert!(fs::symlink_metadata(core.home().join("a/spec.html")).unwrap().file_type().is_symlink());
    assert!(fs::symlink_metadata(core.home().join("inbox/spec.html")).is_err());
    assert_eq!((ino(&orig), fs::read(&orig).unwrap()), (before_ino, before_body));
    let jd = core.journal_day(&day).unwrap();
    assert_eq!(jd.artifacts.iter().map(|x| x.id.clone()).collect::<Vec<_>>(), vec![moved.id.clone()]);
    let evs = drain(&mut rx);
    assert!(matches!(&evs[..], [
        RoomsEvent { kind: EventKind::ArtifactRemoved { room_id, artifact_id }, .. },
        RoomsEvent { kind: EventKind::ArtifactAdded { artifact }, .. },
        RoomsEvent { kind: EventKind::JournalChanged { date }, .. },
    ] if room_id == "inbox" && artifact_id == &a.id && artifact == &moved && date == &day), "{evs:?}");
    // A rescan of either room afterwards changes nothing.
    core.rescan_room(&"inbox".to_string());
    core.rescan_room(&r.id);
    assert!(drain(&mut rx).is_empty());
}

#[test]
fn move_artifact_name_collision_gets_a_number_and_lands_at_the_top_level() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    fs::write(d.path().join("a/spec.html"), "<title>Old</title>").unwrap();
    fs::write(d.path().join("a/spec (2).html"), "<title>Old 2</title>").unwrap();
    core.rescan_room(&r.id);
    let (_o, _orig, a) = inbox_link(&core, "spec.html", "<title>New</title>");
    let moved = core.move_artifact(&"inbox".to_string(), &a.id, &r.id).unwrap();
    assert_eq!(moved.rel_path, "spec (3).html");
    assert_eq!(fs::read_to_string(core.home().join("a/spec.html")).unwrap(), "<title>Old</title>");
    // From a subfolder of an owned room: lands at the top level of the target.
    let b = core.create_room("b").unwrap();
    fs::create_dir_all(core.home().join("b/sub")).unwrap();
    fs::write(core.home().join("b/sub/deep.html"), "<title>Deep</title>").unwrap();
    core.rescan_room(&b.id);
    let deep = core.list_artifacts(&b.id).unwrap()[0].clone();
    let moved = core.move_artifact(&b.id, &deep.id, &r.id).unwrap();
    assert_eq!((moved.rel_path.as_str(), moved.created_at.as_str()), ("deep.html", deep.created_at.as_str()));
    assert!(core.home().join("a/deep.html").is_file() && !core.home().join("b/sub/deep.html").exists());
    // The plain file's stored target followed it, so rescans find nothing to change.
    let mut rx = core.subscribe();
    core.rescan_room(&b.id);
    core.rescan_room(&r.id);
    assert!(drain(&mut rx).is_empty());
}

fn listing(p: &std::path::Path) -> Vec<(String, std::time::SystemTime)> {
    let mut v: Vec<_> = fs::read_dir(p).unwrap().flatten()
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.metadata().unwrap().modified().unwrap())).collect();
    v.sort();
    v
}

#[test]
fn move_artifact_refuses_linked_rooms_without_touching_them() {
    let (_d, core) = home();
    let r = core.create_room("a").unwrap();
    let team = tempfile::tempdir().unwrap();
    let root = team.path().join("research");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("x.html"), "<title>X</title>").unwrap();
    let l = core.link_folder(&root, Some("linked")).unwrap();
    let lx = core.list_artifacts(&l.id).unwrap()[0].clone();
    let (_o, _orig, a) = inbox_link(&core, "spec.html", "<title>S</title>");
    let (before, root_mtime) = (listing(&root), fs::metadata(&root).unwrap().modified().unwrap());
    assert!(matches!(core.move_artifact(&"inbox".to_string(), &a.id, &l.id), Err(CoreError::InvalidInput(_))));
    assert!(matches!(core.move_artifact(&l.id, &lx.id, &r.id), Err(CoreError::InvalidInput(_))));
    assert_eq!((listing(&root), fs::metadata(&root).unwrap().modified().unwrap()), (before, root_mtime));
    assert!(core.home().join("inbox/spec.html").exists() && !core.home().join("a/x.html").exists());
    assert_eq!(core.list_artifacts(&l.id).unwrap().len(), 1);
}

#[test]
fn move_artifact_refuses_journal_inbox_and_same_room_targets() {
    let (_d, core) = home();
    let r = core.create_room("a").unwrap();
    let (_o, _orig, a) = inbox_link(&core, "spec.html", "");
    let inbox = "inbox".to_string();
    for to in [JOURNAL_ROOM_ID.to_string(), inbox.clone()] {
        assert!(matches!(core.move_artifact(&inbox, &a.id, &to), Err(CoreError::InvalidInput(_))), "{to}");
    }
    let moved = core.move_artifact(&inbox, &a.id, &r.id).unwrap();
    assert!(matches!(core.move_artifact(&r.id, &moved.id, &inbox), Err(CoreError::InvalidInput(_))));
    assert!(matches!(core.move_artifact(&r.id, &moved.id, &r.id), Err(CoreError::InvalidInput(_))));
    assert!(matches!(core.move_artifact(&JOURNAL_ROOM_ID.to_string(), &moved.id, &r.id), Err(CoreError::InvalidInput(_))));
    assert!(matches!(core.move_artifact(&"nope".to_string(), &moved.id, &r.id), Err(CoreError::RoomNotFound)));
    assert!(matches!(core.move_artifact(&r.id, &moved.id, &"nope".to_string()), Err(CoreError::RoomNotFound)));
}

#[test]
fn move_artifact_refuses_a_broken_symlink() {
    let (_d, core) = home();
    let r = core.create_room("a").unwrap();
    let (_o, orig, a) = inbox_link(&core, "spec.html", "");
    fs::remove_file(&orig).unwrap(); // not rescanned: the row is still there
    assert!(matches!(core.move_artifact(&"inbox".to_string(), &a.id, &r.id), Err(CoreError::InvalidInput(_))));
    assert!(fs::symlink_metadata(core.home().join("inbox/spec.html")).is_ok());
    assert!(fs::read_dir(core.home().join("a")).unwrap().next().is_none());
}

#[test]
fn move_artifact_missing_id_is_not_found() {
    let (_d, core) = home();
    let r = core.create_room("a").unwrap();
    assert!(matches!(core.move_artifact(&"inbox".to_string(), "0123456789abcdef", &r.id), Err(CoreError::NotFound)));
}

#[test]
fn move_artifact_under_the_watcher_yields_one_remove_one_add() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    let orig_dir = tempfile::tempdir().unwrap();
    let orig = orig_dir.path().join("spec.html");
    fs::write(&orig, "<title>S</title>").unwrap();
    let mut rx = core.subscribe();
    symlink(&orig, core.home().join("inbox/spec.html")).unwrap();
    let evs = wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.room_id == "inbox"), slow(Duration::from_secs(3)));
    let EventKind::ArtifactAdded { artifact: a } = &evs.last().unwrap().kind else { unreachable!() };
    std::thread::sleep(slow(Duration::from_millis(600))); // let the add's own batch settle
    drain(&mut rx);
    let moved = core.move_artifact(&"inbox".to_string(), &a.id, &r.id).unwrap();
    std::thread::sleep(slow(Duration::from_millis(1500)));
    let evs = drain(&mut rx);
    let mine: Vec<_> = evs.iter().filter(|e| match &e.kind {
        EventKind::ArtifactAdded { artifact } | EventKind::ArtifactUpdated { artifact } => artifact.id == a.id || artifact.id == moved.id,
        EventKind::ArtifactRemoved { artifact_id, .. } => artifact_id == &a.id || artifact_id == &moved.id,
        _ => false,
    }).collect();
    assert!(matches!(&mine[..], [
        RoomsEvent { kind: EventKind::ArtifactRemoved { artifact_id, .. }, .. },
        RoomsEvent { kind: EventKind::ArtifactAdded { artifact }, .. },
    ] if artifact_id == &a.id && artifact.id == moved.id), "{evs:?}");
    assert_eq!(evs.iter().filter(|e| matches!(e.kind, EventKind::JournalChanged { .. })).count(), 1, "{evs:?}");
    assert_eq!(core.list_artifacts(&r.id).unwrap(), vec![moved]);
    assert!(core.list_artifacts(&"inbox".to_string()).unwrap().is_empty());
}

#[test]
fn move_artifact_relative_symlink_from_a_subfolder_keeps_pointing_at_the_original() {
    let (_d, core) = home();
    let a = core.create_room("a").unwrap();
    let b = core.create_room("b").unwrap();
    // The original sits in a hidden (never scanned) folder of home, so `../../.originals/x.html`
    // resolves from `b/sub` but not from `a`.
    fs::create_dir_all(core.home().join(".originals")).unwrap();
    let orig = core.home().join(".originals/x.html");
    fs::write(&orig, "<title>X</title>").unwrap();
    let sub = core.home().join("b/sub");
    fs::create_dir_all(&sub).unwrap();
    symlink("../../.originals/x.html", sub.join("x.html")).unwrap();
    core.rescan_room(&b.id);
    let x = core.list_artifacts(&b.id).unwrap().remove(0);
    let moved = core.move_artifact(&b.id, &x.id, &a.id).unwrap();
    let dst = core.home().join("a/x.html");
    assert!(fs::symlink_metadata(&dst).unwrap().file_type().is_symlink());
    assert_eq!(fs::canonicalize(&dst).unwrap(), orig);
    assert!(fs::symlink_metadata(sub.join("x.html")).is_err());
    assert_eq!(moved.created_at, x.created_at);
    let mut rx = core.subscribe();
    core.rescan_room(&a.id);
    core.rescan_room(&b.id);
    assert!(drain(&mut rx).is_empty());
    assert_eq!(core.list_artifacts(&a.id).unwrap(), vec![moved]);
}

#[test]
fn move_artifact_relative_sibling_symlink_is_not_retargeted_to_a_same_named_file() {
    let (_d, core) = home();
    let a = core.create_room("a").unwrap();
    let b = core.create_room("b").unwrap();
    fs::create_dir_all(core.home().join("b/sub")).unwrap();
    fs::write(core.home().join("b/sub/page.html"), "<title>B page</title>").unwrap();
    fs::write(core.home().join("a/page.html"), "<title>A page</title>").unwrap();
    symlink("page.html", core.home().join("b/sub/link.html")).unwrap();
    core.rescan_room(&a.id);
    core.rescan_room(&b.id);
    let l = core.list_artifacts(&b.id).unwrap().into_iter().find(|x| x.rel_path == "sub/link.html").unwrap();
    let moved = core.move_artifact(&b.id, &l.id, &a.id).unwrap();
    let dst = core.home().join("a/link.html");
    assert_eq!(fs::canonicalize(&dst).unwrap(), fs::canonicalize(core.home().join("b/sub/page.html")).unwrap());
    assert_eq!(fs::read_to_string(&dst).unwrap(), "<title>B page</title>");
    assert_eq!((moved.created_at.as_str(), moved.title.as_str()), (l.created_at.as_str(), l.title.as_str()));
    let mut rx = core.subscribe();
    core.rescan_room(&a.id);
    core.rescan_room(&b.id);
    assert!(drain(&mut rx).is_empty());
}

fn order(core: &RoomsCore) -> Vec<String> {
    core.list_rooms().into_iter().map(|r| r.name).collect()
}

#[test]
fn move_room_reorders_after_the_pinned_inbox_and_persists() {
    let (d, core) = home();
    for n in ["a", "b", "c"] { core.create_room(n).unwrap(); }
    assert_eq!(order(&core), ["inbox", "a", "b", "c"]);
    let c = core.list_rooms().into_iter().find(|r| r.name == "c").unwrap().id;
    let mut rx = core.subscribe();

    let ids = core.move_room(&c, 0).unwrap();
    assert_eq!(order(&core), ["inbox", "c", "a", "b"]);
    assert_eq!(ids, core.list_rooms().into_iter().map(|r| r.id).collect::<Vec<_>>());
    let ev = rx.try_recv().unwrap();
    assert!(matches!(ev.kind, EventKind::RoomsReordered { ref room_ids } if *room_ids == ids));

    core.move_room(&c, 99).unwrap(); // past the end: last
    assert_eq!(order(&core), ["inbox", "a", "b", "c"]);
    core.move_room(&c, 1).unwrap();
    assert_eq!(order(&core), ["inbox", "a", "c", "b"]);
    assert_eq!(order(&RoomsCore::open(d.path()).unwrap()), ["inbox", "a", "c", "b"]);
}

#[test]
fn move_room_refuses_the_inbox_and_unknown_rooms() {
    let (_d, core) = home();
    core.create_room("a").unwrap();
    assert!(matches!(core.move_room(&"inbox".to_string(), 1).unwrap_err(), CoreError::InvalidInput(_)));
    assert!(matches!(core.move_room(&"nope".to_string(), 0), Err(CoreError::RoomNotFound)));
}

// ---- fileKey ----

fn key_of(core: &RoomsCore, room: &str, title_file: &str) -> String {
    core.list_artifacts(&room.to_string()).unwrap().into_iter().find(|a| a.rel_path == title_file).unwrap().file_key
}

#[test]
fn file_key_is_stable_across_moves_for_plain_files_and_links() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap().id;
    let b = core.create_room("b").unwrap().id;
    let outside = tempfile::tempdir().unwrap();
    let orig = outside.path().join("orig.html");
    fs::write(&orig, "<title>o</title>").unwrap();
    fs::write(d.path().join("a/x.html"), "<title>x</title>").unwrap();
    symlink(&orig, d.path().join("a/y.html")).unwrap();
    core.backfill_all().unwrap();
    let (kx, ky) = (key_of(&core, &a, "x.html"), key_of(&core, &a, "y.html"));
    assert_eq!(kx.len(), 16);
    assert!(kx.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(kx, ky);
    let x = core.list_artifacts(&a).unwrap().into_iter().find(|t| t.rel_path == "x.html").unwrap();
    let y = core.list_artifacts(&a).unwrap().into_iter().find(|t| t.rel_path == "y.html").unwrap();
    core.move_artifact(&a, &x.id, &b).unwrap();
    core.move_artifact(&a, &y.id, &b).unwrap();
    assert_eq!(key_of(&core, &b, "x.html"), kx);
    assert_eq!(key_of(&core, &b, "y.html"), ky);
    drop(core);
    let reopened = RoomsCore::open(d.path()).unwrap();
    reopened.backfill_all().unwrap();
    assert_eq!(key_of(&reopened, &b, "x.html"), kx);
    assert_eq!(key_of(&reopened, &b, "y.html"), ky);
}

#[test]
fn same_original_linked_twice_shares_file_key() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap().id;
    let b = core.create_room("b").unwrap().id;
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("o.html"), "").unwrap();
    fs::write(outside.path().join("p.html"), "").unwrap();
    symlink(outside.path().join("o.html"), d.path().join("a/o.html")).unwrap();
    symlink(outside.path().join("o.html"), d.path().join("b/o.html")).unwrap();
    symlink(outside.path().join("p.html"), d.path().join("b/p.html")).unwrap();
    core.backfill_all().unwrap();
    assert_eq!(key_of(&core, &a, "o.html"), key_of(&core, &b, "o.html"));
    assert_ne!(key_of(&core, &b, "o.html"), key_of(&core, &b, "p.html"));
}

#[test]
fn artifact_by_file_key_finds_first_in_room_order() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap().id;
    let b = core.create_room("b").unwrap().id;
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("o.html"), "").unwrap();
    symlink(outside.path().join("o.html"), d.path().join("b/o.html")).unwrap();
    symlink(outside.path().join("o.html"), d.path().join("a/o.html")).unwrap();
    core.backfill_all().unwrap();
    let key = key_of(&core, &a, "o.html");
    assert_eq!(core.artifact_by_file_key(&key).unwrap().room_id, a);
    core.move_room(&b, 0).unwrap();
    assert_eq!(core.artifact_by_file_key(&key).unwrap().room_id, b);
    assert!(core.artifact_by_file_key("0000000000000000").is_none());
}

// ---- plugins ----

const ECHO: &str = r#"{"id":"echo","name":"Echo","version":"0.1.0","minAppVersion":"0.3.0",
    "permissions":["rooms.read"],"slots":{"tab":{"title":"Echo","sidebar":true}}}"#;

fn install(home: &std::path::Path, manifest: &str) {
    let dir = home.join(".rooms/plugins/echo");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("manifest.json"), manifest).unwrap();
    fs::write(dir.join("index.html"), "<p>echo</p>").unwrap();
}

#[test]
fn plugin_enable_and_grants_persist() {
    let (d, core) = home();
    install(d.path(), ECHO);
    let p = core.plugins().into_iter().find(|p| p.id == "echo").unwrap();
    assert_eq!(p.status, PluginStatus::Ok);
    assert!(!p.enabled && p.needs_approval);
    assert!(matches!(core.read_plugin_data("echo", "x.txt"), Err(CoreError::NotFound)));

    let p = core.set_plugin_enabled("echo", true, None).unwrap();
    assert!(p.enabled && !p.needs_approval);
    core.write_plugin_data("echo", "x.txt", "hi").unwrap();
    assert_eq!(core.read_plugin_data("echo", "x.txt").unwrap().as_deref(), Some("hi"));
    assert_eq!(core.list_plugin_data("echo", "").unwrap(), vec!["x.txt"]);

    let reopened = RoomsCore::open(d.path()).unwrap();
    let p = reopened.plugins().into_iter().find(|p| p.id == "echo").unwrap();
    assert!(p.enabled && !p.needs_approval);

    install(d.path(), &ECHO.replace(r#"["rooms.read"]"#, r#"["rooms.read","clipboard"]"#));
    let p = reopened.plugins().into_iter().find(|p| p.id == "echo").unwrap();
    assert!(p.enabled && p.needs_approval);
    // Waiting to approve new permissions doesn't take away storage: it can still save while closing.
    reopened.write_plugin_data("echo", "closed.txt", "yes").unwrap();

    let p = reopened.set_plugin_enabled("echo", false, None).unwrap();
    assert!(!p.enabled);
    assert!(matches!(reopened.set_plugin_enabled("nope", true, None), Err(CoreError::NotFound)));
}

#[test]
fn invalid_plugins_are_listed_but_cannot_be_enabled() {
    let (d, core) = home();
    install(d.path(), "{");
    let p = core.plugins().into_iter().find(|p| p.id == "echo").unwrap();
    assert_eq!(p.status, PluginStatus::Invalid);
    assert!(p.reason.is_some() && !p.needs_approval);
    assert!(matches!(core.set_plugin_enabled("echo", true, None).unwrap_err(), CoreError::InvalidInput(_)));
}

#[test]
fn plugins_changed_emits_event() {
    let (_d, core) = home();
    let mut rx = core.subscribe();
    core.plugins_changed();
    assert!(matches!(rx.try_recv().unwrap().kind, EventKind::PluginsChanged {}));
}

#[test]
fn plugin_assets_resolve_and_data_stays_private() {
    let (d, core) = home();
    install(d.path(), ECHO);
    core.set_plugin_enabled("echo", true, None).unwrap();
    core.write_plugin_data("echo", "x.txt", "hi").unwrap();
    assert!(core.resolve_plugin_file("echo", "index.html").unwrap().ends_with("index.html"));
    assert!(core.resolve_plugin_file("echo", "data/x.txt").is_err());
    assert!(core.resolve_plugin_file("nope", "index.html").is_err());
}

#[test]
fn a_new_file_at_a_moved_files_old_path_gets_its_own_file_key() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap().id;
    let b = core.create_room("b").unwrap().id;
    fs::write(d.path().join("a/report.html"), "<title>first</title>").unwrap();
    core.backfill_all().unwrap();
    let first = core.list_artifacts(&a).unwrap().remove(0);
    core.move_artifact(&a, &first.id, &b).unwrap();
    fs::write(d.path().join("a/report.html"), "<title>second</title>").unwrap();
    core.backfill_all().unwrap();
    let second = key_of(&core, &a, "report.html");
    assert_ne!(second, first.file_key, "a different document must not share the moved one's notes");
    assert_eq!(key_of(&core, &b, "report.html"), first.file_key);
}

#[test]
fn a_link_to_a_moved_files_new_path_shares_its_file_key() {
    let (d, core) = home();
    let a = core.create_room("a").unwrap().id;
    let b = core.create_room("b").unwrap().id;
    let c = core.create_room("c").unwrap().id;
    fs::write(d.path().join("a/report.html"), "<title>r</title>").unwrap();
    core.backfill_all().unwrap();
    let r = core.list_artifacts(&a).unwrap().remove(0);
    core.move_artifact(&a, &r.id, &b).unwrap();
    symlink(d.path().join("b/report.html"), d.path().join("c/report.html")).unwrap();
    core.backfill_all().unwrap();
    assert_eq!(key_of(&core, &c, "report.html"), r.file_key);
}

#[test]
fn turning_on_grants_only_what_was_shown_and_turning_off_keeps_the_approval() {
    let (d, core) = home();
    install(d.path(), &ECHO.replace(r#"["rooms.read"]"#, r#"["rooms.read","clipboard"]"#));
    let p = core.plugins().into_iter().find(|p| p.id == "echo").unwrap();
    assert_eq!(p.granted, None);
    // The card showed only rooms.read (the manifest gained clipboard since): grant only that.
    let p = core.set_plugin_enabled("echo", true, Some(vec!["rooms.read".into()])).unwrap();
    assert!(p.enabled && p.needs_approval);
    assert_eq!(p.granted, Some(vec!["rooms.read".to_string()]));
    let p = core.set_plugin_enabled("echo", true, Some(vec!["rooms.read".into(), "clipboard".into()])).unwrap();
    assert!(p.enabled && !p.needs_approval);
    // Off is a decision, not a reset: no approval needed to turn it back on.
    let p = core.set_plugin_enabled("echo", false, None).unwrap();
    assert!(!p.enabled && !p.needs_approval);
    let p = RoomsCore::open(d.path()).unwrap().plugins().into_iter().find(|p| p.id == "echo").unwrap();
    assert!(!p.enabled && !p.needs_approval);
    // Shown permissions that the manifest no longer declares are not granted.
    let p = core.set_plugin_enabled("echo", true, Some(vec!["downloads".into(), "rooms.read".into(), "clipboard".into()])).unwrap();
    assert_eq!(p.granted, Some(vec!["rooms.read".to_string(), "clipboard".to_string()]));
}

// ---- bundled plugins ----

const GOALS: &str = r#"{"id":"goals","name":"Goals","version":"0.1.0","minAppVersion":"0.4.0",
    "permissions":["rooms.read"],"slots":{"tab":{"title":"Goals","icon":"target","sidebar":true}}}"#;

/// A folder the app ships: `<src>/goals/{manifest.json,index.html,main.js}`.
fn bundle(src: &std::path::Path, manifest: &str, main: &str) {
    let dir = src.join("goals");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("assets")).unwrap();
    fs::write(dir.join("manifest.json"), manifest).unwrap();
    fs::write(dir.join("index.html"), "<p>goals</p>").unwrap();
    fs::write(dir.join("assets/main.js"), main).unwrap();
}

fn goals(core: &RoomsCore) -> PluginInfo {
    core.plugins().into_iter().find(|p| p.id == "goals").unwrap()
}

#[test]
fn bundled_plugins_are_installed_and_on_without_asking() {
    let (d, core) = home();
    let src = tempfile::tempdir().unwrap();
    bundle(src.path(), GOALS, "v1");
    assert_eq!(core.install_bundled_plugins(src.path()).unwrap(), vec!["goals"]);
    let p = goals(&core);
    assert!(p.enabled && !p.needs_approval);
    assert_eq!(p.granted.as_deref(), Some(&["rooms.read".to_string()][..]));
    assert_eq!(fs::read_to_string(d.path().join(".rooms/plugins/goals/assets/main.js")).unwrap(), "v1");
    core.write_plugin_data("goals", "goals.json", "{}").unwrap();

    // Same version again: nothing to do.
    assert!(core.install_bundled_plugins(src.path()).unwrap().is_empty());
}

#[test]
fn a_new_bundled_version_replaces_code_keeps_data_and_respects_turn_off() {
    let (d, core) = home();
    let src = tempfile::tempdir().unwrap();
    bundle(src.path(), GOALS, "v1");
    core.install_bundled_plugins(src.path()).unwrap();
    core.write_plugin_data("goals", "goals.json", "{\"mine\":1}").unwrap();
    fs::write(d.path().join(".rooms/plugins/goals/assets/old.js"), "stale").unwrap();
    core.set_plugin_enabled("goals", false, None).unwrap();

    let v2 = GOALS.replace("0.1.0", "0.2.0").replace(r#"["rooms.read"]"#, r#"["rooms.read","clipboard"]"#);
    bundle(src.path(), &v2, "v2");
    assert_eq!(core.install_bundled_plugins(src.path()).unwrap(), vec!["goals"]);
    let dir = d.path().join(".rooms/plugins/goals");
    assert_eq!(fs::read_to_string(dir.join("assets/main.js")).unwrap(), "v2");
    assert!(!dir.join("assets/old.js").exists());
    assert_eq!(fs::read_to_string(dir.join("data/goals.json")).unwrap(), "{\"mine\":1}");
    let p = goals(&core);
    assert!(!p.enabled, "turned off stays off");
    assert!(!p.needs_approval, "bundled permissions are granted with the app");

    // Removed by the user: comes back with the app, still off.
    fs::remove_dir_all(&dir).unwrap();
    core.install_bundled_plugins(src.path()).unwrap();
    assert!(!goals(&core).enabled);
}

#[test]
fn bundled_plugins_never_replace_a_users_own_plugin_or_install_invalid_ones() {
    let (d, core) = home();
    let mine = d.path().join(".rooms/plugins/goals");
    fs::create_dir_all(&mine).unwrap();
    fs::write(mine.join("manifest.json"), GOALS.replace("Goals\",\"version", "My goals\",\"version")).unwrap();
    fs::write(mine.join("index.html"), "mine").unwrap();
    let src = tempfile::tempdir().unwrap();
    bundle(src.path(), &GOALS.replace("0.1.0", "0.9.0"), "v9");
    assert!(core.install_bundled_plugins(src.path()).unwrap().is_empty());
    assert_eq!(fs::read_to_string(mine.join("index.html")).unwrap(), "mine");
    assert!(!goals(&core).enabled);

    let (_d2, core2) = home();
    let bad = tempfile::tempdir().unwrap();
    bundle(bad.path(), "{", "x");
    assert!(core2.install_bundled_plugins(bad.path()).unwrap().is_empty());
    assert!(core2.plugins().is_empty());
}

#[test]
fn a_big_batch_is_one_room_resync_and_a_small_one_is_per_file() {
    let (d, core) = home();
    let r = core.create_room("big").unwrap();
    for i in 0..300 { fs::write(d.path().join(format!("big/{i}.html")), "").unwrap(); }
    let mut rx = core.subscribe();
    core.rescan_room(&r.id);
    let evs = drain(&mut rx);
    assert!(!evs.iter().any(|e| matches!(e.kind, EventKind::ArtifactAdded { .. })), "{} events", evs.len());
    assert!(evs.iter().any(|e| matches!(&e.kind, EventKind::Resync { room_id: Some(id) } if id == &r.id)));
    assert!(evs.iter().any(|e| matches!(&e.kind, EventKind::RoomUpdated { room } if room.id == r.id && room.artifact_count == 300)));
    assert!(evs.iter().any(|e| matches!(e.kind, EventKind::JournalChanged { .. })), "touched days are still signalled");
    for i in 0..3 { fs::write(d.path().join(format!("big/new{i}.html")), "").unwrap(); }
    core.rescan_room(&r.id);
    let adds = drain(&mut rx).iter().filter(|e| matches!(e.kind, EventKind::ArtifactAdded { .. })).count();
    assert_eq!(adds, 3);
}

fn title_updated(k: &EventKind, title: &str) -> bool {
    matches!(k, EventKind::ArtifactUpdated { artifact } if artifact.title == title)
}

#[test]
fn editing_a_symlinks_original_outside_every_room_updates_the_artifact() {
    let d = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let orig = fs::canonicalize(outside.path()).unwrap().join("orig.html");
    fs::write(&orig, "<title>v1</title>").unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let mut rx = core.subscribe();
    symlink(&orig, d.path().join("inbox/link.html")).unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.title == "v1"), slow(Duration::from_secs(2)));
    std::thread::sleep(Duration::from_millis(500)); // the original's folder gets watched
    fs::write(&orig, "<title>v2</title>").unwrap();
    wait_for(&mut rx, |k| title_updated(k, "v2"), slow(Duration::from_secs(2)));
    // An editor's save: write a temp file, rename it over the original.
    let tmp = orig.with_file_name(".orig.html.swp");
    fs::write(&tmp, "<title>v3</title>").unwrap();
    fs::rename(&tmp, &orig).unwrap();
    wait_for(&mut rx, |k| title_updated(k, "v3"), slow(Duration::from_secs(2)));
}

#[test]
fn editing_an_original_in_another_room_updates_the_link_too() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let a = core.create_room("a").unwrap();
    core.create_room("b").unwrap();
    let orig = core.home().join("b/orig.html");
    fs::write(&orig, "<title>v1</title>").unwrap();
    symlink(&orig, core.home().join("a/link.html")).unwrap();
    core.rescan_room(&a.id);
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::write(&orig, "<title>v2</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactUpdated { artifact } if artifact.room_id == a.id && artifact.title == "v2"), slow(Duration::from_secs(2)));
}

#[test]
fn a_folder_moved_into_a_room_adds_its_files() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    let staging = d.path().join("journal/.staging"); // same volume, not scanned
    fs::create_dir_all(staging.join("sub")).unwrap();
    fs::write(staging.join("sub/x.html"), "<title>x</title>").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::rename(&staging, d.path().join("a/moved")).unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.room_id == r.id && artifact.rel_path == "moved/sub/x.html"), slow(Duration::from_secs(2)));
}

#[test]
fn deleting_a_file_under_the_watcher_removes_only_it() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    fs::write(d.path().join("a/keep.html"), "").unwrap();
    fs::write(d.path().join("a/drop.html"), "").unwrap();
    core.rescan_room(&r.id);
    std::thread::sleep(Duration::from_millis(400));
    let mut rx = core.subscribe();
    fs::remove_file(d.path().join("a/drop.html")).unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactRemoved { .. }), slow(Duration::from_secs(2)));
    let rels: Vec<String> = core.list_artifacts(&r.id).unwrap().into_iter().map(|a| a.rel_path).collect();
    assert_eq!(rels, ["keep.html"]);
}

#[test]
fn rescan_paths_touches_only_the_given_paths() {
    let (d, core) = home();
    let r = core.create_room("a").unwrap();
    fs::write(d.path().join("a/old.html"), "").unwrap();
    fs::write(d.path().join("a/gone.html"), "").unwrap();
    core.rescan_room(&r.id);
    fs::remove_file(d.path().join("a/gone.html")).unwrap();
    fs::write(d.path().join("a/new.html"), "").unwrap();
    fs::write(d.path().join("a/unasked.html"), "").unwrap();
    fs::write(d.path().join("a/.roomsignore"), "ign.html\n").unwrap();
    fs::write(d.path().join("a/ign.html"), "").unwrap();
    let mut rx = core.subscribe();
    let rels = ["gone.html", "new.html", "ign.html", "old.html"].map(std::path::PathBuf::from);
    core.rescan_paths(&r.id, &rels);
    let mut got: Vec<String> = core.list_artifacts(&r.id).unwrap().into_iter().map(|a| a.rel_path).collect();
    got.sort();
    assert_eq!(got, ["new.html", "old.html"]);
    let kinds: Vec<&str> = drain(&mut rx).iter().filter_map(|e| match e.kind {
        EventKind::ArtifactAdded { .. } => Some("added"),
        EventKind::ArtifactRemoved { .. } => Some("removed"),
        EventKind::ArtifactUpdated { .. } => Some("updated"),
        _ => None,
    }).collect();
    assert_eq!(kinds, ["added", "removed"], "old.html is unchanged");
}

/// Polls until `cond` holds (or fails after `max`), returning the last value it saw.
fn eventually<T: std::fmt::Debug>(max: Duration, mut get: impl FnMut() -> T, cond: impl Fn(&T) -> bool) -> T {
    let start = Instant::now();
    loop {
        let v = get();
        if cond(&v) { return v; }
        assert!(start.elapsed() < max, "never happened; last: {v:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn rels_of(core: &RoomsCore, room: &RoomId) -> Vec<String> {
    let mut v: Vec<String> = core.list_artifacts(room).unwrap().into_iter().map(|a| a.rel_path).collect();
    v.sort();
    v
}

fn titles_of(core: &RoomsCore, room: &RoomId) -> Vec<String> {
    core.list_artifacts(room).unwrap().into_iter().map(|a| a.title).collect()
}

#[test]
fn case_and_normalization_only_renames_leave_one_row() {
    use unicode_normalization::UnicodeNormalization;
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    let a = core.home().join("a");
    fs::write(a.join("x.html"), "<title>X</title>").unwrap();
    eventually(slow(Duration::from_secs(2)), || rels_of(&core, &r.id), |v| v == &["x.html"]);
    fs::rename(a.join("x.html"), a.join("X.html")).unwrap();
    eventually(slow(Duration::from_secs(2)), || rels_of(&core, &r.id), |v| v == &["X.html"]);
    let (nfc, nfd): (String, String) = ("회의.html".nfc().collect(), "회의.html".nfd().collect());
    fs::write(a.join(&nfd), "").unwrap();
    eventually(slow(Duration::from_secs(2)), || rels_of(&core, &r.id), |v| v.len() == 2);
    fs::rename(a.join(&nfd), a.join(&nfc)).unwrap();
    eventually(slow(Duration::from_secs(2)), || rels_of(&core, &r.id), |v| v == &["X.html".to_string(), nfc.clone()]);
}

#[test]
fn a_dotted_folder_moved_out_or_hidden_drops_its_rows() {
    let d = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let r = core.create_room("a").unwrap();
    let a = core.home().join("a");
    for dir in ["v1.2", "v2.0"] {
        fs::create_dir_all(a.join(dir)).unwrap();
        fs::write(a.join(dir).join("x.html"), "").unwrap();
    }
    eventually(slow(Duration::from_secs(2)), || rels_of(&core, &r.id), |v| v.len() == 2);
    fs::rename(a.join("v1.2"), out.path().join("v1.2")).unwrap();
    eventually(slow(Duration::from_secs(2)), || rels_of(&core, &r.id), |v| v == &["v2.0/x.html"]);
    fs::rename(a.join("v2.0"), a.join(".old")).unwrap();
    eventually(slow(Duration::from_secs(2)), || rels_of(&core, &r.id), |v| v.is_empty());
}

#[test]
fn an_original_inside_an_ignored_folder_still_refreshes_its_link() {
    let d = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let a = core.create_room("a").unwrap();
    core.create_room("b").unwrap();
    let orig = core.home().join("b/dist/o.html");
    fs::create_dir_all(orig.parent().unwrap()).unwrap();
    fs::write(&orig, "<title>One</title>").unwrap();
    symlink(&orig, core.home().join("a/s.html")).unwrap();
    eventually(slow(Duration::from_secs(2)), || titles_of(&core, &a.id), |v| v == &["One"]);
    std::thread::sleep(Duration::from_millis(500)); // the original's folder gets watched
    fs::write(&orig, "<title>Two</title>").unwrap();
    eventually(slow(Duration::from_secs(2)), || titles_of(&core, &a.id), |v| v == &["Two"]);
}

#[test]
fn an_original_deleted_and_recreated_comes_back() {
    let d = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let a = core.create_room("a").unwrap();
    let dir = fs::canonicalize(out.path()).unwrap().join("o");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("o.html"), "<title>One</title>").unwrap();
    symlink(dir.join("o.html"), core.home().join("a/s.html")).unwrap();
    eventually(slow(Duration::from_secs(2)), || titles_of(&core, &a.id), |v| v == &["One"]);
    std::thread::sleep(Duration::from_millis(500));
    // The file alone, then its whole folder.
    fs::remove_file(dir.join("o.html")).unwrap();
    eventually(slow(Duration::from_secs(2)), || titles_of(&core, &a.id), |v| v.is_empty());
    fs::write(dir.join("o.html"), "<title>Back</title>").unwrap();
    eventually(slow(Duration::from_secs(3)), || titles_of(&core, &a.id), |v| v == &["Back"]);
    std::thread::sleep(Duration::from_millis(500));
    fs::remove_dir_all(&dir).unwrap();
    eventually(slow(Duration::from_secs(2)), || titles_of(&core, &a.id), |v| v.is_empty());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("o.html"), "<title>Again</title>").unwrap();
    eventually(slow(Duration::from_secs(3)), || titles_of(&core, &a.id), |v| v == &["Again"]);
}
