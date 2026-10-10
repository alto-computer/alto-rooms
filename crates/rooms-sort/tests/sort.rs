//! Whole runs against a fake roomsd and a fake Jev: targets (T1–T3), R1–R5 end to end, undo.
use chrono::{Duration, Utc};
use rooms_protocol::{Artifact, Author, Room, RoomKind, RoomStatus, Source};
use rooms_sort::api::Rooms;
use rooms_sort::config::Config;
use rooms_sort::jev::{Classifier, JevError, Reply};
use rooms_sort::rules::Answer;
use rooms_sort::run::{self, Opts, Summary};
use rooms_sort::store::Store;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
struct FakeRooms {
    rooms: RefCell<Vec<Room>>,
    arts: RefCell<HashMap<String, Vec<Artifact>>>,
    n: RefCell<u32>,
}

fn room(id: &str, name: &str, home: &Path) -> Room {
    Room { id: id.into(), name: name.into(), kind: RoomKind::Owned, path: home.join(name).to_string_lossy().into(), status: RoomStatus::Ok, artifact_count: 0, updated_at: None, color: None }
}

impl FakeRooms {
    fn add(&self, room_id: &str, rel: &str, title: &str, key: &str) {
        let mut n = self.n.borrow_mut();
        *n += 1;
        let a = Artifact { id: format!("a{n}"), room_id: room_id.into(), rel_path: rel.into(), title: title.into(), created_at: "2026-10-09T00:00:00Z".into(),
            updated_at: format!("2026-10-09T00:00:{:02}Z", *n % 60), author: Author::Agent, source: Source::default(), file_key: key.into() };
        self.arts.borrow_mut().entry(room_id.into()).or_default().push(a);
    }
    fn in_room(&self, room_id: &str) -> Vec<String> {
        let mut v: Vec<String> = self.arts.borrow().get(room_id).map(|a| a.iter().map(|a| a.file_key.clone()).collect()).unwrap_or_default();
        v.sort();
        v
    }
    fn rename(&self, id: &str, name: &str) { self.rooms.borrow_mut().iter_mut().find(|r| r.id == id).unwrap().name = name.into(); }
}

impl Rooms for FakeRooms {
    fn rooms(&self) -> Result<Vec<Room>, String> { Ok(self.rooms.borrow().clone()) }
    fn artifacts(&self, room_id: &str) -> Result<Vec<Artifact>, String> { Ok(self.arts.borrow().get(room_id).cloned().unwrap_or_default()) }
    fn move_artifact(&self, from: &str, id: &str, to: &str) -> Result<Artifact, String> {
        let mut arts = self.arts.borrow_mut();
        let list = arts.get_mut(from).ok_or("no room")?;
        let i = list.iter().position(|a| a.id == id).ok_or("not found")?;
        let mut a = list.remove(i);
        // Like roomsd: the link itself moves.
        let path = |id: &str| PathBuf::from(&self.rooms.borrow().iter().find(|r| r.id == id).unwrap().path);
        let (src, dst) = (path(from).join(&a.rel_path), path(to).join(&a.rel_path));
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::rename(src, dst).unwrap();
        a.room_id = to.into();
        arts.entry(to.into()).or_default().push(a.clone());
        Ok(a)
    }
    fn create_room(&self, name: &str) -> Result<Room, String> {
        let home = PathBuf::from(&self.rooms.borrow()[0].path).parent().unwrap().to_path_buf();
        let r = room(&format!("new_{name}"), name, &home);
        std::fs::create_dir_all(&r.path).unwrap();
        self.rooms.borrow_mut().push(r.clone());
        Ok(r)
    }
}

/// Answers by the first rule whose needle is in the state; counts calls.
struct FakeJev {
    rules: Vec<(&'static str, Option<&'static str>, f64)>,
    calls: Mutex<Vec<String>>,
    reject: bool,
}

impl Classifier for FakeJev {
    fn model(&self) -> &str { "jev-test" }
    fn ask(&self, state: &str, options: &[(String, String)]) -> Result<Reply, JevError> {
        self.calls.lock().unwrap().push(state.to_string());
        if self.reject { return Err(JevError::Unauthorized); }
        assert_eq!(options.last().unwrap().0, "none");
        let (_, choice, confidence) = self.rules.iter().find(|(n, _, _)| state.contains(n)).copied().unwrap_or(("", None, 0.9));
        Ok(Reply { answer: Answer { choice: choice.map(Into::into), confidence }, top: vec![], input_tokens: 100 })
    }
}

fn jev(rules: Vec<(&'static str, Option<&'static str>, f64)>) -> FakeJev { FakeJev { rules, calls: Mutex::new(vec![]), reject: false } }

struct Env {
    _d: tempfile::TempDir,
    home: PathBuf,
    code: PathBuf,
    api: FakeRooms,
    store: Store,
}

impl Env {
    fn new() -> Env {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("rooms");
        let code = d.path().join("code");
        std::fs::create_dir_all(home.join("inbox")).unwrap();
        std::fs::create_dir_all(home.join(".rooms/collect")).unwrap();
        let api = FakeRooms::default();
        api.rooms.borrow_mut().extend([room("inbox", "inbox", &home), room("r_alto", "alto rooms", &home), room("r_design", "디자인 리서치", &home)]);
        api.add("r_design", "old.html", "경쟁사 온보딩 분석", "k_old");
        Env { home, code, api, store: Store::memory().unwrap(), _d: d }
    }

    /// An original in `repo` (None: a plain folder), linked into the inbox by collect `age` ago.
    fn collected(&self, repo: Option<&str>, name: &str, body: &str, age: Duration) {
        let dir = match repo { Some(r) => { let p = self.code.join(r); std::fs::create_dir_all(p.join(".git")).unwrap(); p.join("notes") } None => self.code.join("Downloads") };
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join(name);
        std::fs::write(&real, format!("<html><title>{name}</title><body><p>{body}</p></body></html>")).unwrap();
        self.link(&real, name);
        let real = std::fs::canonicalize(&real).unwrap();
        let line = serde_json::json!({"real": real.to_string_lossy(), "link": "", "repo": "", "rel": "", "at": (Utc::now() - age).to_rfc3339()});
        let p = self.home.join(".rooms/collect/linked.jsonl");
        let mut s = std::fs::read_to_string(&p).unwrap_or_default();
        s.push_str(&format!("{line}\n"));
        std::fs::write(p, s).unwrap();
    }

    fn link(&self, real: &Path, name: &str) {
        std::os::unix::fs::symlink(real, self.home.join("inbox").join(name)).unwrap();
        self.api.add("inbox", name, name, &format!("k_{name}"));
    }

    fn run(&self, j: Option<&FakeJev>) -> Summary {
        let cfg = Config::default();
        run::run(&self.api, j.map(|j| j as &dyn Classifier), &self.store, &Opts { home: &self.home, cfg: &cfg, dry_run: false, now: Utc::now() })
    }
}

const OLD: Duration = Duration::minutes(5);

#[test]
fn r1_without_a_key_and_only_collected_settled_documents() {
    let e = Env::new();
    e.collected(Some("alto-rooms"), "spec.html", "spec", OLD);
    e.collected(Some("alto-rooms"), "fresh.html", "spec", Duration::seconds(10)); // T3
    e.collected(None, "loose.html", "x", OLD); // R5 no_key: not recorded
    let real = e.code.join("Downloads/mine.html");
    std::fs::write(&real, "x").unwrap();
    e.link(&real, "mine.html"); // T1: put in the inbox by hand
    let s = e.run(None);
    assert_eq!((s.considered, s.moved, s.kept), (2, 1, 0), "{:?}", s.lines);
    assert_eq!(e.api.in_room("r_alto"), ["k_spec.html"]);
    assert!(s.lines[0].contains("R1 repo \"alto-rooms\" = room \"alto rooms\""), "{:?}", s.lines);
    assert!(e.store.decision("k_loose.html").unwrap().is_none(), "N5: no_key is not recorded");

    // The key arrives: the loose document is asked now; the hand-placed one never is.
    let j = jev(vec![("loose.html", Some("r_design"), 0.8)]);
    let s = e.run(Some(&j));
    assert_eq!(s.moved, 1, "{:?}", s);
    assert_eq!(e.api.in_room("r_design"), ["k_loose.html", "k_old"]);
    assert_eq!(j.calls.lock().unwrap().len(), 1);
    assert!(e.api.in_room("inbox").contains(&"k_mine.html".to_string()));
}

#[test]
fn jev_sees_only_the_budgeted_input() {
    let e = Env::new();
    let body = format!("<script>secret()</script>{}", "본문 ".repeat(3000));
    e.collected(Some("excalidraw"), "perf.html", &body, OLD);
    let j = jev(vec![]);
    e.run(Some(&j));
    let calls = j.calls.lock().unwrap();
    let st = &calls[0];
    assert!(st.starts_with("제목: perf.html\n위치: excalidraw/notes/perf.html\n\n"), "{st}");
    assert!(!st.contains("secret") && !st.contains(&*e.home.to_string_lossy()) && !st.contains("code/"), "{st}");
    assert!(st.chars().count() < 2_100, "{}", st.chars().count());
}

#[test]
fn r3_r5_and_kept_documents_are_asked_again_when_rooms_change() {
    let e = Env::new();
    e.collected(None, "teardown.html", "onboarding", OLD);
    e.collected(None, "report.html", "misc", OLD);
    let j = jev(vec![("teardown", Some("r_design"), 0.91), ("report", Some("r_alto"), 0.52)]);
    let s = e.run(Some(&j));
    assert_eq!((s.moved, s.kept), (1, 1));
    assert!(s.lines.iter().any(|l| l.contains("R3 jev \"디자인 리서치\" 0.91 ≥ 0.7")), "{:?}", s.lines);
    assert!(s.lines.iter().any(|l| l.contains("R5 jev_low \"alto rooms\" 0.52 < 0.7")), "{:?}", s.lines);
    assert_eq!(e.run(Some(&j)).considered, 0, "decided documents are not asked again");
    e.api.rooms.borrow_mut().push(room("r_misc", "misc", &e.home));
    let j2 = jev(vec![("report", Some("r_misc"), 0.8)]);
    let s = e.run(Some(&j2));
    assert_eq!((s.considered, s.moved), (1, 1), "{:?}", s.lines);
}

#[test]
fn r4_third_vote_creates_the_room_then_r2_follows_a_rename() {
    let e = Env::new();
    let j = jev(vec![]); // none for everything
    e.collected(Some("excalidraw"), "a.html", "a", OLD);
    e.collected(Some("excalidraw"), "b.html", "b", OLD);
    let s = e.run(Some(&j));
    assert_eq!(s.kept, 2);
    assert!(s.lines[1].contains("R4 vote \"excalidraw\" 2/3"), "{:?}", s.lines);
    e.collected(Some("excalidraw"), "c.html", "c", OLD);
    let s = e.run(Some(&j));
    assert_eq!((s.rooms_created, s.moved, s.kept), (1, 3, 0), "{:?}", s.lines);
    assert_eq!(e.api.in_room("new_excalidraw"), ["k_a.html", "k_b.html", "k_c.html"]);

    e.api.rename("new_excalidraw", "Excalidraw 플러그인");
    e.collected(Some("excalidraw"), "d.html", "d", OLD);
    let calls_before = j.calls.lock().unwrap().len();
    let s = e.run(Some(&j));
    assert!(s.lines[0].contains("R2 repo \"excalidraw\" → room \"Excalidraw 플러그인\""), "{:?}", s.lines);
    assert_eq!(j.calls.lock().unwrap().len(), calls_before, "R2 needs no Jev call");
}

#[test]
fn votes_only_count_while_the_voter_is_in_the_inbox() {
    let e = Env::new();
    let j = jev(vec![]);
    e.collected(Some("excalidraw"), "a.html", "a", OLD);
    e.collected(Some("excalidraw"), "b.html", "b", OLD);
    e.run(Some(&j));
    let b = e.api.artifacts("inbox").unwrap().into_iter().find(|a| a.file_key == "k_b.html").unwrap();
    e.api.move_artifact("inbox", &b.id, "r_alto").unwrap(); // the user filed it
    e.collected(Some("excalidraw"), "c.html", "c", OLD);
    let s = e.run(Some(&j));
    assert_eq!(s.rooms_created, 0);
    assert!(s.lines[0].contains("vote \"excalidraw\" 2/3"), "{:?}", s.lines);
}

#[test]
fn undo_returns_documents_removes_the_empty_room_and_never_resorts() {
    let e = Env::new();
    let j = jev(vec![]);
    for n in ["a.html", "b.html", "c.html"] { e.collected(Some("excalidraw"), n, n, OLD); }
    e.run(Some(&j));
    assert_eq!(e.api.in_room("new_excalidraw").len(), 3);
    let out = run::undo(&e.api, &e.store, &e.home, None).unwrap();
    assert_eq!(out.iter().filter(|l| l.starts_with("back to inbox")).count(), 3, "{out:?}");
    assert!(out.iter().any(|l| l.contains("removed empty room")), "{out:?}");
    for n in ["a.html", "b.html", "c.html"] { assert!(e.home.join("inbox").join(n).symlink_metadata().is_ok(), "{n} is back"); }
    // What roomsd's watcher would report: the links are in the inbox again, same fileKey.
    let back = e.api.arts.borrow_mut().remove("new_excalidraw").unwrap();
    e.api.arts.borrow_mut().get_mut("inbox").unwrap().extend(back);
    assert_eq!(e.run(Some(&j)).considered, 0, "undone documents stay");
    // The repo is forgotten (N4): new documents from it are not voted into a new room.
    e.api.rooms.borrow_mut().retain(|r| r.id != "new_excalidraw");
    for n in ["d.html", "e.html", "f.html"] { e.collected(Some("excalidraw"), n, n, OLD); }
    let s = e.run(Some(&j));
    assert_eq!((s.rooms_created, s.kept), (0, 3), "{:?}", s.lines);
    assert!(s.lines.iter().all(|l| l.contains("R5 jev_none")), "{:?}", s.lines);
}

#[test]
fn a_rejected_key_still_runs_r1_and_leaves_the_rest() {
    let e = Env::new();
    e.collected(Some("alto-rooms"), "spec.html", "s", OLD);
    e.collected(None, "loose.html", "x", OLD);
    let j = FakeJev { rules: vec![], calls: Mutex::new(vec![]), reject: true };
    let s = e.run(Some(&j));
    assert!(s.unauthorized && s.error.is_some());
    assert_eq!((s.moved, s.kept), (1, 0));
    assert!(e.store.decision("k_loose.html").unwrap().is_none(), "asked again once the key works");
}
