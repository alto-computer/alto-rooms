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
    assert_eq!(core.list_artifacts(&r.id).unwrap_err(), CoreError::RoomNotFound);
}

#[test]
fn create_room_on_existing_plain_folder_is_room_exists() {
    let (d, core) = home();
    fs::create_dir(d.path().join("plain")).unwrap();
    assert_eq!(core.create_room("plain").unwrap_err(), CoreError::RoomExists);
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
    assert_eq!(core.list_artifacts(&r.id).unwrap_err(), CoreError::RoomNotFound);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert!(core.journal_day(&today).unwrap().artifacts.iter().all(|a| a.room_id != r.id));
}

#[test]
fn api_calls_stay_fast_during_big_backfill() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    let head = format!("<title>t</title>{}", "x".repeat(20_000));
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), &head).unwrap(); }
    let core = RoomsCore::open(d.path()).unwrap();
    let c = core.clone();
    let t = std::thread::spawn(move || c.backfill_all().unwrap());
    let mut worst = Duration::ZERO;
    while !t.is_finished() {
        let s = Instant::now();
        let _ = core.list_rooms();
        let _ = core.current_seq();
        worst = worst.max(s.elapsed());
        std::thread::sleep(Duration::from_millis(5));
    }
    t.join().unwrap();
    assert!(worst < slow(Duration::from_millis(150)), "worst {worst:?}");
}

#[test]
fn one_new_file_in_big_room_is_added_within_a_second() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), "<title>t</title>").unwrap(); }
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let id = core.list_rooms().into_iter().find(|r| r.name == "big").unwrap().id;
    let deadline = Instant::now() + Duration::from_secs(30);
    while core.list_artifacts(&id).unwrap().len() < 3000 { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(50)); }
    let mut rx = core.subscribe();
    let s = Instant::now();
    fs::write(big.join("fresh.html"), "<title>fresh</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.rel_path == "fresh.html"), slow(Duration::from_secs(2)));
    assert!(s.elapsed() < slow(Duration::from_secs(1)), "{:?}", s.elapsed());
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
    for t in threads { for r in t.join().unwrap() { assert_eq!(r, Ok(())); } }
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
    assert_eq!(core.read_note(&"2026-10-05".to_string(), "없음").unwrap_err(), CoreError::NotFound);
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
    assert_eq!(core.rename_note(&day(), "없음", "x").unwrap_err(), CoreError::NotFound);
}

#[test]
fn rename_note_never_overwrites_an_existing_target() {
    let (d, core) = home();
    core.save_note(&day(), "a", "A").unwrap();
    core.save_note(&day(), "b", "B").unwrap();
    assert_eq!(core.rename_note(&day(), "a", "b").unwrap_err(), CoreError::NoteExists);
    assert_eq!(core.rename_note(&day(), "a", "B").unwrap_err(), CoreError::NoteExists);
    assert_eq!(core.rename_note(&day(), "a", "b.md").unwrap_err(), CoreError::NoteExists);
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
