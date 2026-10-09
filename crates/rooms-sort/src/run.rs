//! One run (spec §5): pick the documents (T1–T3), decide with `rules::decide`, apply through
//! roomsd, record. Also `undo` and the status file the app reads.
use crate::api::Rooms;
use crate::doc;
use crate::jev::{Classifier, JevError, Reply};
use crate::rules::{self, Action, Decision, Doc, Room};
use crate::store::{Move, Record, Store};
use chrono::{DateTime, SecondsFormat, Utc};
use rooms_protocol::{Artifact, RoomKind, RoomStatus, INBOX_ROOM_ID};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// T3: a link this young may still be written to.
pub const SETTLE_SECS: i64 = 60;
const JEV_THREADS: usize = 4;

pub struct Opts<'a> {
    pub home: &'a Path,
    pub cfg: &'a crate::config::Config,
    pub dry_run: bool,
    pub now: DateTime<Utc>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Summary {
    pub considered: u32,
    pub moved: u32,
    pub kept: u32,
    pub rooms_created: u32,
    pub input_tokens: u64,
    pub unauthorized: bool,
    pub error: Option<String>,
    /// One line per decision: what `run` prints.
    pub lines: Vec<String>,
}

/// A document that passed T1–T3.
struct Target {
    artifact: Artifact,
    doc: Doc,
    real: PathBuf,
    repo: Option<(String, PathBuf)>,
}

/// `.rooms/collect/linked.jsonl`: realpath → when rooms-collect linked it (T1, T3).
pub fn collected(home: &Path) -> HashMap<String, DateTime<Utc>> {
    let Ok(s) = std::fs::read_to_string(home.join(".rooms/collect/linked.jsonl")) else { return HashMap::new() };
    s.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).filter_map(|v| {
        let real = v.get("real")?.as_str()?.to_string();
        let at = DateTime::parse_from_rfc3339(v.get("at")?.as_str()?).ok()?.with_timezone(&Utc);
        Some((real, at))
    }).collect()
}

/// The rooms a document may move to: owned, available, not the inbox.
pub fn choices(rooms: &[rooms_protocol::Room]) -> Vec<Room> {
    rooms.iter().filter(|r| r.kind == RoomKind::Owned && r.status == RoomStatus::Ok && r.id != INBOX_ROOM_ID)
        .map(|r| Room { id: r.id.clone(), name: r.name.clone() }).collect()
}

/// T2: a kept document is asked again once this changes.
pub fn rooms_hash(rooms: &[Room]) -> String {
    let mut ids: Vec<&str> = rooms.iter().map(|r| r.id.as_str()).collect();
    ids.sort();
    hex::encode(&Sha256::digest(ids.join("\n").as_bytes())[..8])
}

fn ts(t: DateTime<Utc>) -> String { t.to_rfc3339_opts(SecondsFormat::Secs, true) }

pub fn run(api: &dyn Rooms, jev: Option<&dyn Classifier>, store: &Store, o: &Opts) -> Summary {
    let mut s = Summary::default();
    if let Err(e) = run_inner(api, jev, store, o, &mut s) { s.error = Some(e); }
    s
}

fn run_inner(api: &dyn Rooms, jev: Option<&dyn Classifier>, store: &Store, o: &Opts, s: &mut Summary) -> Result<(), String> {
    let db = |e: rusqlite::Error| e.to_string();
    let inbox = api.artifacts(INBOX_ROOM_ID)?;
    let linked = collected(o.home);
    let all_rooms = api.rooms()?;
    let mut rooms = choices(&all_rooms);
    let hash = rooms_hash(&rooms);
    let rcfg = o.cfg.rules();

    // Memory, with N3 (only votes from documents still in the inbox count) and N4 (a created room that is gone).
    let mut mem = store.load_memory().map_err(db)?;
    let in_inbox: HashSet<&str> = inbox.iter().map(|a| a.file_key.as_str()).collect();
    for v in mem.votes.values_mut() { v.retain(|k| in_inbox.contains(k.as_str())); }
    let gone: Vec<String> = mem.repo_rooms.iter().filter(|(_, id)| !rooms.iter().any(|r| &r.id == *id)).map(|(k, _)| k.clone()).collect();
    for repo in gone {
        if !o.dry_run { store.forget_repo(&repo).map_err(db)?; }
        mem.repo_rooms.remove(&repo);
        mem.forgotten.insert(repo);
    }

    // T1–T3, oldest link first.
    let mut targets: Vec<(DateTime<Utc>, Target)> = Vec::new();
    for a in &inbox {
        let link = o.home.join("inbox").join(&a.rel_path);
        let Ok(real) = std::fs::canonicalize(&link) else { continue };
        let Some(at) = linked.get(real.to_string_lossy().as_ref()) else { continue }; // T1
        if (o.now - *at).num_seconds() < SETTLE_SECS { continue; } // T3
        match store.decision(&a.file_key).map_err(db)? { // T2
            Some(r) if !(r.action == "kept" && r.rooms_hash != hash) => continue,
            _ => {}
        }
        let repo = doc::repo_of(&real);
        let d = Doc { file_key: a.file_key.clone(), repo: repo.as_ref().map(|r| r.0.clone()) };
        targets.push((*at, Target { artifact: a.clone(), doc: d, real, repo }));
    }
    targets.sort_by_key(|(at, _)| *at);
    targets.truncate(o.cfg.max_docs_per_run);
    let targets: Vec<Target> = targets.into_iter().map(|(_, t)| t).collect();
    s.considered = targets.len() as u32;
    if targets.is_empty() { return Ok(()); }

    // Ask Jev only for documents R1 and R2 leave open.
    let need: Vec<usize> = (0..targets.len()).filter(|&i| rules::deterministic(&targets[i].doc, &rooms, &mem).is_none()).collect();
    let mut replies: HashMap<usize, Reply> = HashMap::new();
    if let (Some(j), false) = (jev, need.is_empty()) {
        let options = doc::options(&room_options(api, &all_rooms, &rooms)?);
        let states: Vec<(usize, String)> = need.iter().map(|&i| (i, state_of(&targets[i]))).collect();
        let (got, err) = ask_all(j, &states, &options);
        replies = got;
        if let Some(e) = err {
            s.unauthorized = e == JevError::Unauthorized;
            s.error = Some(e.to_string());
        }
    }

    let at = ts(o.now);
    let run_id = format!("{}-{}", o.now.format("%Y%m%dT%H%M%S"), store.run_count().map_err(db)? + 1);
    if !o.dry_run { store.start_run(&run_id, &at).map_err(db)?; }
    let by_key: HashMap<&str, &Target> = targets.iter().map(|t| (t.doc.file_key.as_str(), t)).collect();
    let model = jev.map(|j| j.model().to_string());
    let mut kept_now: HashSet<String> = HashSet::new();

    for (i, t) in targets.iter().enumerate() {
        let reply = replies.get(&i);
        // A document Jev was meant to answer but did not (an error): leave it for the next run.
        if jev.is_some() && need.contains(&i) && reply.is_none() { continue; }
        let d = rules::decide(&t.doc, &rooms, &mem, reply.map(|r| &r.answer), &rcfg);
        let rec = |d: &Decision, action: &str, to: Option<&str>, file_key: &str, title: &str, repo: Option<&str>, reply: Option<&Reply>| {
            if o.dry_run { return Ok(()); }
            store.record(&Record { file_key, title, repo, run_id: &run_id, at: &at, decision: d, action, to_room: to, jev: reply,
                model: reply.and(model.as_deref()), rooms_hash: &hash })
        };
        let name_of = |id: &str, rooms: &[Room]| rooms.iter().find(|r| r.id == id).map(|r| r.name.clone()).unwrap_or_default();
        match &d.action {
            Action::Move { room_id } => {
                let to = name_of(room_id, &rooms);
                if !o.dry_run {
                    if let Err(e) = api.move_artifact(INBOX_ROOM_ID, &t.artifact.id, room_id) {
                        s.lines.push(format!("skipped {}: {e}", t.artifact.rel_path));
                        continue;
                    }
                    store.add_move(&run_id, &Move { file_key: t.doc.file_key.clone(), to_room: room_id.clone(), created_room: false }).map_err(db)?;
                    store.drop_votes(&t.doc.file_key).map_err(db)?;
                }
                rec(&d, "moved", Some(room_id), &t.doc.file_key, &t.artifact.title, t.doc.repo.as_deref(), reply).map_err(db)?;
                s.moved += 1;
                s.lines.push(format!("moved  {} → {}  {} {}", t.artifact.rel_path, to, d.rule.id(), d.why));
            }
            Action::Vote { repo, create: false, .. } => {
                if !o.dry_run { store.vote(repo, &t.doc.file_key).map_err(db)?; }
                mem.votes.entry(repo.clone()).or_default().insert(t.doc.file_key.clone());
                kept_now.insert(t.doc.file_key.clone());
                rec(&d, "kept", None, &t.doc.file_key, &t.artifact.title, Some(repo), reply).map_err(db)?;
                s.kept += 1;
                s.lines.push(format!("kept   {}  {} {}", t.artifact.rel_path, d.rule.id(), d.why));
            }
            Action::Vote { repo, create: true, .. } => {
                let voters: Vec<String> = mem.votes.get(repo).map(|v| v.iter().cloned().collect()).unwrap_or_default();
                if o.dry_run {
                    s.rooms_created += 1;
                    let others = voters.iter().filter(|k| **k != t.doc.file_key).count() as u32;
                    s.moved += 1 + others;
                    s.kept -= voters.iter().filter(|k| kept_now.contains(*k)).count() as u32;
                    s.lines.push(format!("create room \"{repo}\" and move {} documents  R4 {}", others + 1, d.why));
                    mem.repo_rooms.insert(repo.clone(), format!("dry-run:{repo}"));
                    rooms.push(Room { id: format!("dry-run:{repo}"), name: repo.clone() });
                    continue;
                }
                let room = match api.create_room(repo) {
                    Ok(r) => r,
                    Err(e) => {
                        store.vote(repo, &t.doc.file_key).map_err(db)?;
                        rec(&Decision { why: format!("{} (could not create: {e})", d.why), ..d.clone() }, "kept", None, &t.doc.file_key, &t.artifact.title, Some(repo), reply).map_err(db)?;
                        s.kept += 1;
                        s.lines.push(format!("kept   {}  R4 could not create room \"{repo}\": {e}", t.artifact.rel_path));
                        continue;
                    }
                };
                store.remember_room(repo, &room.id, &at).map_err(db)?;
                store.clear_votes(repo).map_err(db)?;
                mem.repo_rooms.insert(repo.clone(), room.id.clone());
                mem.votes.remove(repo);
                rooms.push(Room { id: room.id.clone(), name: room.name.clone() });
                s.rooms_created += 1;
                let mut keys: Vec<String> = voters.into_iter().filter(|k| *k != t.doc.file_key).collect();
                keys.push(t.doc.file_key.clone());
                for key in &keys {
                    let Some(a) = inbox.iter().find(|a| &a.file_key == key) else { continue };
                    if let Err(e) = api.move_artifact(INBOX_ROOM_ID, &a.id, &room.id) {
                        s.lines.push(format!("skipped {}: {e}", a.rel_path));
                        continue;
                    }
                    store.add_move(&run_id, &Move { file_key: key.clone(), to_room: room.id.clone(), created_room: true }).map_err(db)?;
                    let (repo_s, own_reply) = if key == &t.doc.file_key { (t.doc.repo.as_deref(), reply) } else { (by_key.get(key.as_str()).and_then(|x| x.doc.repo.as_deref()).or(Some(repo)), None) };
                    rec(&d, "moved", Some(&room.id), key, &a.title, repo_s, own_reply).map_err(db)?;
                    s.moved += 1;
                    if kept_now.remove(key) { s.kept -= 1; } // voted earlier in this run, moved now
                    s.lines.push(format!("moved  {} → {}  R4 {}", a.rel_path, room.name, d.why));
                }
            }
            Action::Keep => {
                if d.is_no_key() { continue; } // N5: not recorded
                rec(&d, "kept", None, &t.doc.file_key, &t.artifact.title, t.doc.repo.as_deref(), reply).map_err(db)?;
                s.kept += 1;
                s.lines.push(format!("kept   {}  {} {}", t.artifact.rel_path, d.rule.id(), d.why));
            }
        }
    }
    s.input_tokens = replies.values().map(|r| r.input_tokens).sum();
    if !o.dry_run { store.end_run(&run_id, &ts(Utc::now()), s).map_err(db)?; }
    Ok(())
}

/// Room options for Jev: most recently active rooms first, each with its latest titles.
fn room_options(api: &dyn Rooms, all: &[rooms_protocol::Room], rooms: &[Room]) -> Result<Vec<(String, String)>, String> {
    let mut ordered: Vec<&rooms_protocol::Room> = all.iter().filter(|r| rooms.iter().any(|c| c.id == r.id)).collect();
    ordered.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    ordered.truncate(doc::MAX_ROOMS);
    let mut out = Vec::new();
    for r in ordered {
        let mut arts = api.artifacts(&r.id).unwrap_or_default();
        arts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let titles: Vec<String> = arts.into_iter().map(|a| a.title).filter(|t| !t.trim().is_empty()).collect();
        out.push((r.id.clone(), doc::room_option(&r.name, &titles)));
    }
    Ok(out)
}

fn state_of(t: &Target) -> String {
    let html = std::fs::read(&t.real).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    doc::state(&t.artifact.title, &doc::location(&t.real, t.repo.as_ref()), &doc::visible_text(&html, doc::EXCERPT_CHARS))
}

/// Asks Jev for each state, JEV_THREADS at a time. A 401 stops the rest.
fn ask_all(j: &dyn Classifier, states: &[(usize, String)], options: &[(String, String)]) -> (HashMap<usize, Reply>, Option<JevError>) {
    let mut got = HashMap::new();
    let mut err = None;
    for chunk in states.chunks(JEV_THREADS) {
        let results: Vec<(usize, Result<Reply, JevError>)> = std::thread::scope(|sc| {
            let hs: Vec<_> = chunk.iter().map(|(i, st)| (i, sc.spawn(move || j.ask(st, options)))).collect();
            hs.into_iter().map(|(i, h)| (*i, h.join().unwrap_or_else(|_| Err(JevError::Other("panic".into()))))).collect()
        });
        for (i, r) in results {
            match r {
                Ok(rep) => { got.insert(i, rep); }
                Err(e) => { if err.as_ref() != Some(&JevError::Unauthorized) { err = Some(e); } }
            }
        }
        if err == Some(JevError::Unauthorized) { break; }
    }
    (got, err)
}

/// Puts the given run's documents (default: the last run that moved any) back in the inbox if
/// they are still where it put them; they are never sorted again. roomsd does not move into the
/// inbox, so the link itself is renamed back (its fileKey, from the original's path, stays the
/// same). A room that run created is removed once empty, and its repo is forgotten (N4).
pub fn undo(api: &dyn Rooms, store: &Store, home: &Path, run_id: Option<&str>) -> Result<Vec<String>, String> {
    let db = |e: rusqlite::Error| e.to_string();
    let run_id = match run_id { Some(r) => r.to_string(), None => store.last_moving_run().map_err(db)?.ok_or("nothing to undo")? };
    let moves = store.moves(&run_id).map_err(db)?;
    if moves.is_empty() { return Err(format!("run {run_id} moved nothing")); }
    let rooms = api.rooms()?;
    let mut out = Vec::new();
    for m in &moves {
        store.set_action(&m.file_key, "undone").map_err(db)?;
        let found = rooms.iter().find(|r| r.id == m.to_room)
            .and_then(|r| api.artifacts(&r.id).ok()?.into_iter().find(|a| a.file_key == m.file_key).map(|a| (PathBuf::from(&r.path), a)));
        let Some((root, a)) = found else { out.push(format!("left alone (moved since): {}", m.file_key)); continue };
        let src = root.join(&a.rel_path);
        if !src.symlink_metadata().map(|md| md.file_type().is_symlink()).unwrap_or(false) {
            out.push(format!("left alone (not a link): {}", a.rel_path));
            continue;
        }
        match free_name(&home.join("inbox"), &a.rel_path).and_then(|dst| std::fs::rename(&src, &dst).ok()) {
            Some(()) => out.push(format!("back to inbox: {}", a.rel_path)),
            None => out.push(format!("could not move {} back", a.rel_path)),
        }
    }
    for room_id in moves.iter().filter(|m| m.created_room).map(|m| &m.to_room).collect::<HashSet<_>>() {
        if let Some(repo) = store.repo_for_room(room_id).map_err(db)? { store.forget_repo(&repo).map_err(db)?; }
        let Some(r) = rooms.iter().find(|r| &r.id == room_id) else { continue };
        let path = PathBuf::from(&r.path);
        // Only an empty folder directly under the home is removed; roomsd notices it is gone.
        if path.parent() == Some(home) && std::fs::remove_dir(&path).is_ok() { out.push(format!("removed empty room \"{}\"", r.name)); }
    }
    Ok(out)
}

/// `dir/name`, or `name (2).ext`, `(3)` … when taken (the rooms skill's rule).
fn free_name(dir: &Path, rel: &str) -> Option<PathBuf> {
    let name = Path::new(rel).file_name()?.to_string_lossy().into_owned();
    let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i..]), _ => (name.as_str(), "") };
    (1..1000).map(|n| if n == 1 { dir.join(&name) } else { dir.join(format!("{stem} ({n}){ext}")) }).find(|p| p.symlink_metadata().is_err())
}

/// `<data>/sort-status.json`: what the app shows in the inbox header.
pub fn write_status(data: &Path, store: &Store, s: &Summary, now: DateTime<Utc>) -> std::io::Result<()> {
    let local_midnight = chrono::Local::now().date_naive().and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(chrono::Local).single()).map(|t| ts(t.with_timezone(&Utc))).unwrap_or_default();
    let (moved_today, kept_today) = store.counts_since(&local_midnight).unwrap_or((0, 0));
    let v = json!({
        "lastRunAt": ts(now), "movedToday": moved_today, "keptToday": kept_today,
        "lastRun": { "considered": s.considered, "moved": s.moved, "kept": s.kept, "roomsCreated": s.rooms_created },
        "keyRejected": s.unauthorized, "error": s.error,
    });
    std::fs::create_dir_all(data)?;
    let tmp = data.join(format!(".sort-status.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(&v)?)?;
    std::fs::rename(tmp, data.join("sort-status.json"))
}
