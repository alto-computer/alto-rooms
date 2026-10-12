//! One JSON-lines file per scope under `.rooms/asks/`: a line when a turn starts, one when it ends;
//! last line per id wins.
use rooms_protocol::{AskKind, AskMode, AskScope, AskStatus, AskTurn};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub(crate) struct AskLog { dir: PathBuf }

/// A line of the file: the turn as the API shows it, less the scope the file name already says,
/// plus `fileKey` on artifact lines so a roomsd from before scopes reads them. Lines from before scopes
/// have exactly this shape.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_key: Option<String>,
    question: String,
    answer: String,
    agent: String,
    model: Option<String>,
    mode: AskMode,
    status: AskStatus,
    error: Option<String>,
    started_at: String,
    ended_at: Option<String>,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    kind: AskKind,
    #[serde(default)]
    left_out: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<String>,
}

impl Stored {
    fn of(turn: &AskTurn) -> Self {
        let AskTurn { id, scope, question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out, session } = turn.clone();
        let file_key = match scope { AskScope::Artifact { file_key } => Some(file_key), AskScope::Room { .. } | AskScope::Day { .. } | AskScope::Session(_) => None };
        Self { id, file_key, question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out, session }
    }

    fn into_turn(self, scope: &AskScope) -> AskTurn {
        let Stored { id, file_key: _, question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out, session } = self;
        AskTurn { id, scope: scope.clone(), question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out, session }
    }
}

/// Session logs were named `conversation-<agent>-<id>.jsonl` before sessions had their name.
const LEGACY_SESSION_PREFIX: &str = "conversation-";

impl AskLog {
    pub fn new(dir: PathBuf) -> Self {
        let log = Self { dir };
        log.migrate_legacy_names();
        log
    }

    /// Renames session logs from before the rename to `session-<agent>-<id>.jsonl`. When a log is
    /// already under the new name, as after running an older app again, the old log's lines go on
    /// the end of it and the old file is removed. A crash in between only repeats lines, and the
    /// last line per id wins, so running this again is safe.
    fn migrate_legacy_names(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix(LEGACY_SESSION_PREFIX).filter(|r| r.ends_with(".jsonl")) else { continue };
            let to = self.dir.join(format!("session-{rest}"));
            let moved = if to.exists() {
                append_lines(&e.path(), &to).and_then(|()| std::fs::remove_file(e.path()))
            } else {
                std::fs::rename(e.path(), &to)
            };
            if let Err(err) = moved { eprintln!("rooms-core: {name} not moved to {}: {err}", to.display()); }
        }
    }

    /// File keys are 16 alphanumerics, so a `room-`, `day-` or `session-` name never names an artifact's file.
    fn path(&self, scope: &AskScope) -> PathBuf {
        let name = match scope {
            AskScope::Artifact { file_key } => format!("{file_key}.jsonl"),
            AskScope::Room { room_id } => format!("room-{room_id}.jsonl"),
            AskScope::Day { date } => format!("day-{date}.jsonl"),
            AskScope::Session(r) => format!("session-{}-{}.jsonl", r.agent.as_str(), r.id),
        };
        self.dir.join(name)
    }

    pub fn append(&self, turn: &AskTurn) -> std::io::Result<()> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir)?;
        let mut line = serde_json::to_vec(&Stored::of(turn)).map_err(std::io::Error::other)?;
        line.push(b'\n');
        let mut f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(self.path(&turn.scope))?;
        f.write_all(&line) // one write per line (O_APPEND)
    }

    pub fn read(&self, scope: &AskScope) -> std::io::Result<Vec<AskTurn>> {
        // Bytes, not a String: one torn line with invalid UTF-8 must not make the whole file unreadable.
        let bytes = match std::fs::read(self.path(scope)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out: Vec<AskTurn> = Vec::new();
        for line in bytes.split(|b| *b == b'\n') {
            let Ok(t) = serde_json::from_str::<Stored>(&String::from_utf8_lossy(line)) else { continue };
            let t = t.into_turn(scope);
            match out.iter_mut().find(|x| x.id == t.id) {
                Some(slot) => *slot = t,
                None => out.push(t),
            }
        }
        Ok(out)
    }
}

/// Adds `from`'s lines to the end of `to`, each on a line of its own even when either file's last
/// line was cut short.
fn append_lines(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut lines = std::fs::read(from)?;
    if lines.last().is_some_and(|b| *b != b'\n') { lines.push(b'\n'); }
    if std::fs::read(to)?.last().is_some_and(|b| *b != b'\n') { lines.insert(0, b'\n'); }
    std::fs::OpenOptions::new().append(true).open(to)?.write_all(&lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const K1: &str = "0123456789abcdef";

    fn artifact() -> AskScope { AskScope::Artifact { file_key: K1.into() } }

    fn t(id: &str, status: AskStatus, answer: &str) -> AskTurn {
        AskTurn { id: id.into(), scope: artifact(), question: "q".into(), answer: answer.into(), agent: "a".into(), model: None,
            mode: AskMode::New, status, error: None, started_at: "s".into(), ended_at: None, images: vec![], kind: Default::default(), left_out: 0, session: None }
    }

    #[test]
    fn missing_file_is_empty() {
        let d = tempfile::tempdir().unwrap();
        assert!(AskLog::new(d.path().join("asks")).read(&artifact()).unwrap().is_empty());
    }

    #[test]
    fn last_line_per_id_wins_in_start_order_and_bad_lines_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let log = AskLog::new(d.path().join("asks"));
        log.append(&t("a", AskStatus::Running, "")).unwrap();
        log.append(&t("b", AskStatus::Running, "")).unwrap();
        log.append(&t("a", AskStatus::Done, "A")).unwrap();
        std::fs::OpenOptions::new().append(true).open(d.path().join(format!("asks/{K1}.jsonl"))).unwrap()
            .write_all(b"{not json\n").unwrap();
        let got = log.read(&artifact()).unwrap();
        assert_eq!(got.iter().map(|x| (x.id.as_str(), x.status)).collect::<Vec<_>>(),
            vec![("a", AskStatus::Done), ("b", AskStatus::Running)]);
        assert_eq!(got[0].answer, "A");
        let mode = std::fs::metadata(d.path().join("asks")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn a_line_with_invalid_utf8_is_skipped_not_fatal() {
        let d = tempfile::tempdir().unwrap();
        let log = AskLog::new(d.path().join("asks"));
        log.append(&t("a", AskStatus::Done, "A")).unwrap();
        std::fs::OpenOptions::new().append(true).open(d.path().join(format!("asks/{K1}.jsonl"))).unwrap()
            .write_all(b"{\"id\":\"x\xff\xfe torn\n").unwrap();
        log.append(&t("b", AskStatus::Done, "B")).unwrap();
        let got = log.read(&artifact()).unwrap();
        assert_eq!(got.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    }

    /// Lines as roomsd wrote them before scopes (`fileKey` on every line, no `scope`): a question
    /// with images, `/new`, `/compact` with its summary, and a question with `leftOut`.
    const LEGACY: &str = concat!(
        r#"{"id":"q1","fileKey":"0123456789abcdef","question":"이 화면 뭐야?","answer":"","agent":"claude-code","model":"opus","mode":"resume","status":"running","error":null,"startedAt":"2026-10-08T10:00:00+09:00","endedAt":null,"images":["aa.png","bb.jpg"],"kind":"question","leftOut":0}"#, "\n",
        r#"{"id":"q1","fileKey":"0123456789abcdef","question":"이 화면 뭐야?","answer":"**표**예요","agent":"claude-code","model":"opus","mode":"resume","status":"done","error":null,"startedAt":"2026-10-08T10:00:00+09:00","endedAt":"2026-10-08T10:00:09+09:00","images":["aa.png","bb.jpg"],"kind":"question","leftOut":0}"#, "\n",
        r#"{"id":"n1","fileKey":"0123456789abcdef","question":"/new","answer":"","agent":"claude-code","model":null,"mode":"resume","status":"done","error":null,"startedAt":"2026-10-08T10:01:00+09:00","endedAt":"2026-10-08T10:01:00+09:00","images":[],"kind":"clear","leftOut":0}"#, "\n",
        r#"{"id":"c1","fileKey":"0123456789abcdef","question":"/compact","answer":"","agent":"claude-code","model":null,"mode":"resume","status":"running","error":null,"startedAt":"2026-10-08T10:02:00+09:00","endedAt":null,"images":[],"kind":"compact","leftOut":0}"#, "\n",
        r#"{"id":"c1","fileKey":"0123456789abcdef","question":"/compact","answer":"요약","agent":"claude-code","model":null,"mode":"resume","status":"done","error":null,"startedAt":"2026-10-08T10:02:00+09:00","endedAt":"2026-10-08T10:02:05+09:00","images":[],"kind":"compact","leftOut":0}"#, "\n",
        r#"{"id":"q2","fileKey":"0123456789abcdef","question":"그래서?","answer":"","agent":"claude-code","model":null,"mode":"new","status":"failed","error":"Stopped because Rooms restarted","startedAt":"2026-10-08T10:03:00+09:00","endedAt":null,"images":[],"kind":"question","leftOut":2}"#, "\n",
    );

    #[test]
    fn legacy_artifact_lines_read_back_under_artifact_scope() {
        let d = tempfile::tempdir().unwrap();
        let log = AskLog::new(d.path().join("asks"));
        std::fs::create_dir_all(d.path().join("asks")).unwrap();
        std::fs::write(d.path().join(format!("asks/{K1}.jsonl")), LEGACY).unwrap();
        let got = log.read(&artifact()).unwrap();
        assert_eq!(got.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["q1", "n1", "c1", "q2"]);
        assert!(got.iter().all(|t| t.scope == artifact()));
        let q1 = &got[0];
        assert_eq!((q1.status, q1.answer.as_str(), q1.model.as_deref(), q1.mode), (AskStatus::Done, "**표**예요", Some("opus"), AskMode::Resume));
        assert_eq!(q1.images, ["aa.png", "bb.jpg"]);
        assert_eq!(q1.ended_at.as_deref(), Some("2026-10-08T10:00:09+09:00"));
        assert_eq!((got[1].kind, got[1].question.as_str()), (AskKind::Clear, "/new"));
        assert_eq!((got[2].kind, got[2].answer.as_str(), got[2].status), (AskKind::Compact, "요약", AskStatus::Done));
        assert_eq!((got[3].left_out, got[3].error.as_deref()), (2, Some("Stopped because Rooms restarted")));
        // an artifact line written now has the same shape, so the base roomsd reads it after a downgrade
        log.append(&t("q3", AskStatus::Done, "A")).unwrap();
        let last = std::fs::read_to_string(d.path().join(format!("asks/{K1}.jsonl"))).unwrap().lines().last().unwrap().to_string();
        assert!(last.starts_with(r#"{"id":"q3","fileKey":"0123456789abcdef","question":"q","answer":"A","agent":"a","model":null,"mode":"new","status":"done","error":null,"startedAt":"s","endedAt":null,"images":[],"kind":"question","leftOut":0}"#), "{last}");
        assert!(!last.contains("scope"));
    }

    #[test]
    fn each_scope_writes_its_own_file() {
        let d = tempfile::tempdir().unwrap();
        let log = AskLog::new(d.path().join("asks"));
        let room = AskScope::Room { room_id: K1.into() };
        let day = AskScope::Day { date: "2026-10-09".into() };
        log.append(&AskTurn { scope: room.clone(), ..t("r", AskStatus::Done, "R") }).unwrap();
        log.append(&AskTurn { scope: day.clone(), ..t("d", AskStatus::Done, "D") }).unwrap();
        let talk = AskScope::Session(rooms_protocol::SessionRef::parse_key("codex:s-1").unwrap());
        log.append(&AskTurn { scope: talk.clone(), ..t("c", AskStatus::Done, "C") }).unwrap();
        log.append(&t("a", AskStatus::Done, "A")).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(d.path().join("asks")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, [format!("{K1}.jsonl"), "day-2026-10-09.jsonl".to_string(), format!("room-{K1}.jsonl"), "session-codex-s-1.jsonl".to_string()]);
        assert_eq!(log.read(&artifact()).unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a"]);
        let r = log.read(&room).unwrap();
        assert_eq!((r.len(), r[0].id.as_str(), &r[0].scope), (1, "r", &room));
        assert_eq!(log.read(&day).unwrap()[0].scope, day);
        assert_eq!(log.read(&talk).unwrap()[0].scope, talk);
        let line = std::fs::read_to_string(d.path().join(format!("asks/room-{K1}.jsonl"))).unwrap();
        assert!(!line.contains("fileKey") && !line.contains("scope"), "{line}");
    }

    #[test]
    fn session_logs_from_before_the_rename_are_renamed_once() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("asks");
        let scope = AskScope::Session(rooms_protocol::SessionRef::parse_key("claude-code:s-1").unwrap());
        AskLog::new(dir.clone()).append(&AskTurn { scope: scope.clone(), ..t("old", AskStatus::Done, "A") }).unwrap();
        std::fs::rename(dir.join("session-claude-code-s-1.jsonl"), dir.join("conversation-claude-code-s-1.jsonl")).unwrap();

        let log = AskLog::new(dir.clone());
        assert_eq!(log.read(&scope).unwrap().iter().map(|t| (t.id.as_str(), &t.scope)).collect::<Vec<_>>(), [("old", &scope)]);
        assert!(!dir.join("conversation-claude-code-s-1.jsonl").exists());
        AskLog::new(dir.clone());
        assert_eq!(log.read(&scope).unwrap().len(), 1, "a second run changes nothing");
    }

    #[test]
    fn an_old_log_written_after_the_rename_is_added_to_the_new_one() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("asks");
        let scope = AskScope::Session(rooms_protocol::SessionRef::parse_key("claude-code:s-1").unwrap());
        let ids = |log: &AskLog| log.read(&scope).unwrap().into_iter().map(|t| (t.id, t.answer)).collect::<Vec<_>>();
        let log = AskLog::new(dir.clone());
        log.append(&AskTurn { scope: scope.clone(), ..t("new", AskStatus::Done, "N") }).unwrap();
        // An older app ran in between and kept this session's thread under the old name, its last line unterminated.
        log.append(&AskTurn { scope: scope.clone(), ..t("old", AskStatus::Done, "O") }).unwrap();
        let new_path = dir.join("session-claude-code-s-1.jsonl");
        let text = std::fs::read_to_string(&new_path).unwrap();
        let (first, second) = text.split_once('\n').unwrap();
        std::fs::write(&new_path, format!("{first}\n")).unwrap();
        std::fs::write(dir.join("conversation-claude-code-s-1.jsonl"), second.trim_end()).unwrap();

        let log = AskLog::new(dir.clone());
        assert_eq!(ids(&log), [("new".into(), "N".into()), ("old".into(), "O".into())]);
        assert!(!dir.join("conversation-claude-code-s-1.jsonl").exists());
        log.append(&AskTurn { scope: scope.clone(), ..t("next", AskStatus::Done, "X") }).unwrap();
        assert_eq!(ids(&AskLog::new(dir.clone())).len(), 3, "the next turn starts on a line of its own, and a second run changes nothing");
    }
}
