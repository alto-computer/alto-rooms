//! End-to-end: synthetic agent logs in a temp home, run the collector's passes, look at the
//! store, the links, sources.json and the archive.
use chrono::{Duration, Utc};
use rooms_collect::adapters::Roots;
use rooms_collect::daemon::{now_ms, Collector, Opts};
use rooms_collect::search::{search, Query};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

fn iso(days_ago: f64) -> String {
    (Utc::now() - Duration::milliseconds((days_ago * 86_400_000.0) as i64)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

struct Env { _tmp: tempfile::TempDir, root: PathBuf, home: PathBuf, roots: Roots, data: PathBuf }

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let home = root.join("rooms");
        std::fs::create_dir_all(home.join(".rooms")).unwrap();
        std::fs::create_dir_all(home.join("inbox")).unwrap();
        let roots = Roots::for_home(&root);
        std::fs::create_dir_all(&roots.claude).unwrap();
        let data = root.join("data");
        Env { _tmp: tmp, root, home, roots, data }
    }

    /// The linker takes writes from `days_ago` on (as if it had first run then).
    fn since(&self, days_ago: f64) {
        std::fs::create_dir_all(self.home.join(".rooms/collect")).unwrap();
        std::fs::write(self.home.join(".rooms/collect/state.json"),
            json!({"linkerSince": (Utc::now() - Duration::milliseconds((days_ago * 86_400_000.0) as i64)).to_rfc3339()}).to_string()).unwrap();
    }

    fn collector(&self) -> Collector {
        Collector::open(Opts { home: self.home.clone(), roots: self.roots.clone(), data: self.data.clone() }).unwrap()
    }

    fn html(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, format!("<html><head><title>T {rel}</title></head></html>")).unwrap();
        p
    }

    fn write_lines(p: &Path, lines: &[Value], append: bool) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut f = std::fs::OpenOptions::new().create(true).append(append).write(true).truncate(!append).open(p).unwrap();
        for l in lines { writeln!(f, "{l}").unwrap(); }
    }

    fn claude_log(&self, name: &str, lines: &[Value]) -> PathBuf {
        let p = self.roots.claude.join("-proj").join(name);
        Self::write_lines(&p, lines, false);
        p
    }

    fn codex_log(&self, name: &str, lines: &[Value]) -> PathBuf {
        let p = self.roots.codex.join("2026/10/09").join(name);
        Self::write_lines(&p, lines, false);
        p
    }

    fn aside_log(&self, sid: &str, lines: &[Value]) -> PathBuf {
        let day = Utc::now().format("%Y-%m-%d");
        let p = self.roots.aside.join("0/sessions").join(format!("{day}_{sid}")).join("messages.jsonl");
        Self::write_lines(&p, lines, false);
        p
    }

    fn links(&self) -> Vec<(String, PathBuf)> {
        let mut v = Vec::new();
        for d in std::fs::read_dir(&self.home).unwrap().flatten() {
            if d.file_name() == ".rooms" || !d.file_type().unwrap().is_dir() { continue; }
            for f in std::fs::read_dir(d.path()).unwrap().flatten() {
                if f.file_type().unwrap().is_symlink() {
                    v.push((format!("{}/{}", d.file_name().to_string_lossy(), f.file_name().to_string_lossy()), std::fs::read_link(f.path()).unwrap()));
                }
            }
        }
        v.sort();
        v
    }

    fn sources(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.home.join(".rooms/sources.json")).unwrap_or_else(|_| b"{}".to_vec())).unwrap()
    }
}

fn count(c: &Collector, sql: &str) -> i64 { c.conn.query_row(sql, [], |r| r.get(0)).unwrap() }

fn cc(name: &str, path: &Path, days_ago: f64) -> Value {
    json!({"type": "assistant", "timestamp": iso(days_ago), "cwd": "/x", "sessionId": "sess-cc", "uuid": format!("u-{name}-{}", path.display()),
           "message": {"content": [{"type": "tool_use", "name": name, "input": {"file_path": path}}]}})
}

fn cc_bash(cmd: &str, days_ago: f64) -> Value {
    json!({"type": "assistant", "timestamp": iso(days_ago), "cwd": "/x", "sessionId": "sess-cc",
           "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": cmd}}]}})
}

fn cc_user(text: &str, sid: &str) -> Value {
    json!({"type": "user", "timestamp": iso(0.0), "cwd": "/work/proj", "sessionId": sid, "uuid": format!("u-{sid}-{text}"),
           "message": {"role": "user", "content": text}})
}

#[test]
fn claude_writes_are_linked_reads_are_not() {
    let e = Env::new();
    e.since(5.0);
    let w = e.html("proj/w.html");
    let ed = e.html("proj/e.html");
    let rd = e.html("proj/r.html");
    e.claude_log("s1.jsonl", &[cc("Write", &w, 1.0), cc("Edit", &ed, 1.0), cc("Read", &rd, 1.0)]);
    let t = e.collector().drain().unwrap();
    assert_eq!(t.link.linked.len(), 2);
    assert_eq!(e.links(), vec![("inbox/e.html".into(), ed.clone()), ("inbox/w.html".into(), w.clone())]);
    let s = e.sources();
    assert_eq!(s["sources"][w.to_str().unwrap()]["agent"], "claude-code");
    assert_eq!(s["sources"][w.to_str().unwrap()]["session"], "sess-cc");
}

#[test]
fn writes_before_linker_since_are_recorded_not_linked() {
    let e = Env::new();
    let old = e.html("proj/old.html");
    e.claude_log("s1.jsonl", &[cc("Write", &old, 2.0)]);
    let t = e.collector().drain().unwrap(); // first run: linkerSince = now
    assert!(t.link.linked.is_empty());
    assert!(e.home.join(".rooms/collect/state.json").is_file());
    assert_eq!(e.sources()["sources"][old.to_str().unwrap()]["session"], "sess-cc");
    let new = e.html("proj/new.html");
    let log = e.roots.claude.join("-proj/s1.jsonl");
    Env::write_lines(&log, &[cc("Write", &new, -0.0001)], true);
    let t = e.collector().drain().unwrap();
    assert_eq!(t.link.linked, vec![e.home.join("inbox/new.html")]);
}

#[test]
fn repeated_passes_and_a_rebuilt_store_change_nothing() {
    let e = Env::new();
    e.since(5.0);
    let w = e.html("proj/w.html");
    e.claude_log("s1.jsonl", &[cc_user("hello pricing", "sess-cc"), cc("Write", &w, 1.0)]);
    let mut c = e.collector();
    let first = c.drain().unwrap();
    assert_eq!(first.ingest.events, 4, "session seen, message, tool call, file written");
    let second = c.drain().unwrap();
    assert_eq!((second.ingest.files_read, second.ingest.events, second.link.linked.len()), (0, 0, 0));
    drop(c);
    rooms_collect::store::remove(&e.data.join("collect.db"));
    let mut c = e.collector();
    let again = c.drain().unwrap();
    assert_eq!(again.ingest.events, 4);
    assert!(again.link.linked.is_empty(), "already linked: no second link");
    assert_eq!(e.links().len(), 1);
}

#[test]
fn removed_links_stay_removed_and_names_do_not_collide() {
    let e = Env::new();
    e.since(5.0);
    let a = e.html("p1/report.html");
    let b = e.html("p2/report.html");
    e.claude_log("s1.jsonl", &[cc("Write", &a, 1.0), cc("Write", &b, 1.0)]);
    e.collector().drain().unwrap();
    assert_eq!(e.links().iter().map(|l| l.0.clone()).collect::<Vec<_>>(), vec!["inbox/report (2).html", "inbox/report.html"]);
    std::fs::remove_file(e.home.join("inbox/report.html")).unwrap();
    // the same file written again later
    Env::write_lines(&e.roots.claude.join("-proj/s1.jsonl"), &[cc("Edit", &a, 0.5)], true);
    rooms_collect::store::remove(&e.data.join("collect.db"));
    e.collector().drain().unwrap();
    assert_eq!(e.links().len(), 1, "the user removed it; it is not linked again");
}

#[test]
fn repo_named_room_gets_the_link() {
    let e = Env::new();
    e.since(5.0);
    std::fs::create_dir_all(e.root.join("code/Alto Rooms/.git")).unwrap();
    std::fs::create_dir_all(e.home.join("alto rooms")).unwrap(); // the room's folder, named like the repo
    let doc = e.html("code/Alto Rooms/docs/plan.html");
    let other = e.html("code/other/x.html");
    e.claude_log("s1.jsonl", &[cc("Write", &doc, 1.0), cc("Write", &other, 1.0)]);
    e.collector().drain().unwrap();
    assert_eq!(e.links(), vec![("alto rooms/plan.html".into(), doc), ("inbox/x.html".into(), other)]);
}

#[test]
fn rooms_files_linked_rooms_worktrees_and_noise_are_skipped() {
    let e = Env::new();
    e.since(5.0);
    let inside = e.html("rooms/notes/in.html");
    let linked_room = e.root.join("linked");
    let in_linked = e.html("linked/l.html");
    std::fs::write(e.home.join(".rooms/state.json"), json!({"rooms": [{"id": "r1", "name": "L", "kind": "linked", "path": linked_room}]}).to_string()).unwrap();
    let scratch = e.html("proj/scratchpad/s.html");
    std::fs::create_dir_all(e.root.join("repo/.git")).unwrap();
    let main = e.html("repo/docs/a.html");
    let wt = e.root.join("wt/feat");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}/.git/worktrees/feat\n", e.root.join("repo").display())).unwrap();
    let wt_doc = e.html("wt/feat/docs/a.html");
    e.claude_log("s1.jsonl", &[cc("Write", &inside, 1.0), cc("Write", &in_linked, 1.0), cc("Write", &scratch, 1.0),
        cc("Write", &main, 1.0), cc("Write", &wt_doc, 1.0)]);
    e.collector().drain().unwrap();
    assert_eq!(e.links(), vec![("inbox/a.html".into(), main)]);
    let s = e.sources();
    assert!(s["sources"].get(inside.to_str().unwrap()).is_some(), "files in Rooms still get their source");
    assert!(s["sources"].get(scratch.to_str().unwrap()).is_none(), "scratch is never recorded");
}

#[test]
fn loose_shell_writes_need_a_fresh_mtime() {
    let e = Env::new();
    e.since(5.0);
    let fresh = e.html("proj/out/fresh.html");
    let stale = e.html("proj/out/stale.html");
    let f = std::fs::File::options().write(true).open(&stale).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 86_400)).unwrap();
    let dir = e.root.join("proj/out");
    e.claude_log("s1.jsonl", &[cc_bash(&format!("cd {} && echo hi > fresh.html && cp x stale.html", dir.display()), 1.0)]);
    e.collector().drain().unwrap();
    assert_eq!(e.links(), vec![("inbox/fresh.html".into(), fresh)]);
}

#[test]
fn a_file_written_after_its_log_line_is_linked_on_retry() {
    let e = Env::new();
    e.since(5.0);
    let p = e.root.join("proj/later.html");
    e.claude_log("s1.jsonl", &[cc("Write", &p, 0.0)]);
    let mut c = e.collector();
    let t = c.tick(now_ms()).unwrap();
    assert!(t.link.linked.is_empty());
    let due = t.link.retry_at.expect("a retry is scheduled");
    e.html("proj/later.html");
    let t = c.tick(due).unwrap();
    assert_eq!(t.link.linked, vec![e.home.join("inbox/later.html")]);
    assert_eq!(count(&c, "SELECT count(*) FROM link_retry"), 0);
}

#[test]
fn unfinished_lines_wait_and_replaced_logs_are_read_again() {
    let e = Env::new();
    let log = e.claude_log("s1.jsonl", &[cc_user("first", "s")]);
    let mut half = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
    let line = cc_user("second", "s").to_string();
    half.write_all(&line.as_bytes()[..10]).unwrap();
    let mut c = e.collector();
    c.drain().unwrap();
    assert_eq!(count(&c, "SELECT count(*) FROM events WHERE kind='message'"), 1);
    half.write_all(&line.as_bytes()[10..]).unwrap();
    half.write_all(b"\n").unwrap();
    assert_eq!(c.drain().unwrap().ingest.events, 1, "the finished line is read once");
    assert_eq!(c.drain().unwrap().ingest.events, 0);
    // a new file under the same name (new inode, shorter)
    std::fs::remove_file(&log).unwrap();
    e.claude_log("s1.jsonl", &[cc_user("third", "s")]);
    c.drain().unwrap();
    assert_eq!(count(&c, "SELECT count(*) FROM events WHERE kind='message'"), 3);
}

#[test]
fn archive_survives_log_deletion_and_drops_a_crash_tail() {
    let e = Env::new();
    let log = e.claude_log("s1.jsonl", &[cc_user("the quarterly pricing plan", "s-arch")]);
    let mut c = e.collector();
    c.drain().unwrap();
    let copy: String = c.conn.query_row("SELECT path FROM archives", [], |r| r.get(0)).unwrap();
    // a crash after writing the copy but before committing leaves extra bytes
    std::fs::OpenOptions::new().append(true).open(&copy).unwrap().write_all(b"GARBAGE").unwrap();
    Env::write_lines(&log, &[cc_user("second message", "s-arch")], true);
    c.drain().unwrap();
    assert_eq!(std::fs::read(&copy).unwrap(), std::fs::read(&log).unwrap(), "the copy matches the log byte for byte");
    std::fs::remove_file(&log).unwrap();
    let hits = search(&c.conn, &Query { text: "quarterly".into(), limit: 10, ..Default::default() }).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].excerpt.contains("quarterly pricing plan"), "excerpt from the archive: {}", hits[0].excerpt);
    assert_eq!(hits[0].resume, "claude --resume s-arch");
}

#[test]
fn old_logs_are_archived_but_not_indexed() {
    let e = Env::new();
    let log = e.claude_log("old.jsonl", &[cc_user("ancient words", "s-old")]);
    let f = std::fs::File::options().write(true).open(&log).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(40 * 86_400)).unwrap();
    let mut c = e.collector();
    c.drain().unwrap();
    assert_eq!(count(&c, "SELECT count(*) FROM events"), 0);
    let len: i64 = c.conn.query_row("SELECT len FROM archives", [], |r| r.get(0)).unwrap();
    assert_eq!(len as u64, std::fs::metadata(&log).unwrap().len());
}

#[test]
fn search_groups_by_session_and_filters() {
    let e = Env::new();
    e.claude_log("a.jsonl", &[cc_user("deploy the pricing page", "s-a"), cc_user("pricing again", "s-a")]);
    e.claude_log("b.jsonl", &[cc_user("pricing table colors", "s-b")]);
    e.codex_log("rollout-2026-10-09T00-00-00-x.jsonl", &[
        json!({"timestamp": iso(0.0), "type": "session_meta", "payload": {"id": "s-cx", "cwd": "/work/other"}}),
        json!({"timestamp": iso(0.0), "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "pricing in codex"}]}}),
    ]);
    let mut c = e.collector();
    c.drain().unwrap();
    let all = search(&c.conn, &Query { text: "pricing".into(), limit: 10, ..Default::default() }).unwrap();
    assert_eq!(all.len(), 3);
    let a = all.iter().find(|h| h.session == "s-a").unwrap();
    assert_eq!((a.matches, a.title.as_deref()), (2, Some("deploy the pricing page")));
    let cx = search(&c.conn, &Query { text: "pric".into(), agent: Some("codex".into()), limit: 10, ..Default::default() }).unwrap();
    assert_eq!(cx.len(), 1);
    assert_eq!(cx[0].resume, "codex resume s-cx");
    let by_cwd = search(&c.conn, &Query { text: "pricing".into(), cwd: Some("/work/proj".into()), limit: 10, ..Default::default() }).unwrap();
    assert_eq!(by_cwd.len(), 2);
}

#[test]
fn codex_patch_and_compressed_log_are_not_counted_twice() {
    let e = Env::new();
    e.since(5.0);
    let a = e.html("proj/patched.html");
    let patch = format!("tools.apply_patch(\"*** Begin Patch\\n*** Add File: {}\\n+<html>\\n*** End Patch\")", a.display());
    let name = "rollout-2026-10-09T00-00-00-abc.jsonl";
    let log = e.codex_log(name, &[
        json!({"timestamp": iso(1.0), "type": "session_meta", "payload": {"id": "sess-cx", "cwd": e.root.join("proj")}}),
        json!({"timestamp": iso(1.0), "type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "input": patch}}),
    ]);
    let mut c = e.collector();
    c.drain().unwrap();
    assert_eq!(e.links(), vec![("inbox/patched.html".into(), a.clone())]);
    assert_eq!(e.sources()["sources"][a.to_str().unwrap()]["session"], "sess-cx");
    let events = count(&c, "SELECT count(*) FROM events");
    // Codex compresses a cold log in place
    let z = log.with_file_name(format!("{name}.zst"));
    std::fs::write(&z, zstd::encode_all(&std::fs::read(&log).unwrap()[..], 3).unwrap()).unwrap();
    std::fs::remove_file(&log).unwrap();
    c.drain().unwrap();
    assert_eq!(count(&c, "SELECT count(*) FROM events"), events, "same lines, same ids");
    assert_eq!(count(&c, "SELECT count(*) FROM archives"), 1, "the plain copy is reused");
}

#[test]
fn aside_repl_writes_into_artifacts() {
    let e = Env::new();
    e.since(5.0);
    let dir = e.roots.aside.join("0/artifacts/q1");
    std::fs::create_dir_all(&dir).unwrap();
    let t = e.html(&format!("{}/00-지도.html", dir.strip_prefix(&e.root).unwrap().display()));
    let ms = (Utc::now() - Duration::hours(1)).timestamp_millis();
    let call = |code: String| json!({"role": "assistant", "timestamp": ms, "content": [
        {"type": "text", "text": "ok"}, {"type": "toolCall", "name": "repl", "arguments": {"code": code}}]});
    e.aside_log("ses0Aside1", &[call(format!("const qdir = '{}';", dir.display())), call("await fs.writeFile(qdir + '/00-지도.html', html);".into())]);
    e.collector().drain().unwrap();
    assert_eq!(e.links(), vec![("inbox/00-지도.html".into(), t.clone())]);
    assert_eq!(e.sources()["sources"][t.to_str().unwrap()]["agent"], "aside");
}

#[test]
fn turned_off_reads_nothing() {
    let e = Env::new();
    e.since(5.0);
    std::fs::write(e.home.join(".rooms/collect.toml"), "enabled = false\n").unwrap();
    let w = e.html("proj/w.html");
    e.claude_log("s1.jsonl", &[cc("Write", &w, 1.0)]);
    let mut c = e.collector();
    let t = c.drain().unwrap();
    assert!(!t.enabled);
    assert_eq!(count(&c, "SELECT count(*) FROM files"), 0);
    std::fs::write(e.home.join(".rooms/collect.toml"), "[agents]\nclaude-code = false\n").unwrap();
    c.drain().unwrap();
    assert_eq!(count(&c, "SELECT count(*) FROM files"), 0);
    std::fs::remove_file(e.home.join(".rooms/collect.toml")).unwrap();
    c.drain().unwrap();
    assert_eq!(e.links().len(), 1);
}

#[test]
fn idle_archives_are_compressed_and_still_searchable() {
    let e = Env::new();
    let log = e.claude_log("s1.jsonl", &[cc_user("compressed needle words", "s-z")]);
    let f = std::fs::File::options().write(true).open(&log).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 86_400)).unwrap();
    let mut c = e.collector();
    c.drain().unwrap();
    c.compress();
    let (path, z): (String, i64) = c.conn.query_row("SELECT path, compressed FROM archives", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(z, 1);
    assert!(path.ends_with(".jsonl.zst"));
    std::fs::remove_file(&log).unwrap();
    let hits = search(&c.conn, &Query { text: "needle".into(), limit: 5, ..Default::default() }).unwrap();
    assert!(hits[0].excerpt.contains("compressed needle"), "{}", hits[0].excerpt);
}
