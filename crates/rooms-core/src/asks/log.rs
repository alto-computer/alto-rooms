//! One JSON-lines file per scope under `.rooms/asks/`: a line when a turn starts, one when it ends;
//! last line per id wins.
use rooms_protocol::{AskKind, AskMode, AskScope, AskStatus, AskTurn};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

pub(crate) struct AskLog { dir: PathBuf }

/// A line of the file: the turn as the API shows it, less the scope the file name already says,
/// plus `fileKey` on doc lines so a roomsd from before scopes reads them. Lines from before scopes
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
}

impl Stored {
    fn of(turn: &AskTurn) -> Self {
        let AskTurn { id, scope, question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out } = turn.clone();
        let file_key = match scope { AskScope::Doc { file_key } => Some(file_key), AskScope::Room { .. } | AskScope::Day { .. } => None };
        Self { id, file_key, question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out }
    }

    fn into_turn(self, scope: &AskScope) -> AskTurn {
        let Stored { id, file_key: _, question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out } = self;
        AskTurn { id, scope: scope.clone(), question, answer, agent, model, mode, status, error, started_at, ended_at, images, kind, left_out }
    }
}

impl AskLog {
    pub fn new(dir: PathBuf) -> Self { Self { dir } }

    /// File keys are 16 alphanumerics, so a `room-` or `day-` name never names a doc file.
    fn path(&self, scope: &AskScope) -> PathBuf {
        let name = match scope {
            AskScope::Doc { file_key } => format!("{file_key}.jsonl"),
            AskScope::Room { room_id } => format!("room-{room_id}.jsonl"),
            AskScope::Day { date } => format!("day-{date}.jsonl"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const K1: &str = "0123456789abcdef";

    fn doc() -> AskScope { AskScope::Doc { file_key: K1.into() } }

    fn t(id: &str, status: AskStatus, answer: &str) -> AskTurn {
        AskTurn { id: id.into(), scope: doc(), question: "q".into(), answer: answer.into(), agent: "a".into(), model: None,
            mode: AskMode::New, status, error: None, started_at: "s".into(), ended_at: None, images: vec![], kind: Default::default(), left_out: 0 }
    }

    #[test]
    fn missing_file_is_empty() {
        let d = tempfile::tempdir().unwrap();
        assert!(AskLog::new(d.path().join("asks")).read(&doc()).unwrap().is_empty());
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
        let got = log.read(&doc()).unwrap();
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
        let got = log.read(&doc()).unwrap();
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
    fn legacy_doc_lines_read_back_under_doc_scope() {
        let d = tempfile::tempdir().unwrap();
        let log = AskLog::new(d.path().join("asks"));
        std::fs::create_dir_all(d.path().join("asks")).unwrap();
        std::fs::write(d.path().join(format!("asks/{K1}.jsonl")), LEGACY).unwrap();
        let got = log.read(&doc()).unwrap();
        assert_eq!(got.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["q1", "n1", "c1", "q2"]);
        assert!(got.iter().all(|t| t.scope == doc()));
        let q1 = &got[0];
        assert_eq!((q1.status, q1.answer.as_str(), q1.model.as_deref(), q1.mode), (AskStatus::Done, "**표**예요", Some("opus"), AskMode::Resume));
        assert_eq!(q1.images, ["aa.png", "bb.jpg"]);
        assert_eq!(q1.ended_at.as_deref(), Some("2026-10-08T10:00:09+09:00"));
        assert_eq!((got[1].kind, got[1].question.as_str()), (AskKind::Clear, "/new"));
        assert_eq!((got[2].kind, got[2].answer.as_str(), got[2].status), (AskKind::Compact, "요약", AskStatus::Done));
        assert_eq!((got[3].left_out, got[3].error.as_deref()), (2, Some("Stopped because Rooms restarted")));
        // a doc line written now has the same shape, so the base roomsd reads it after a downgrade
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
        log.append(&t("a", AskStatus::Done, "A")).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(d.path().join("asks")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, [format!("{K1}.jsonl"), format!("day-2026-10-09.jsonl"), format!("room-{K1}.jsonl")]);
        assert_eq!(log.read(&doc()).unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a"]);
        let r = log.read(&room).unwrap();
        assert_eq!((r.len(), r[0].id.as_str(), &r[0].scope), (1, "r", &room));
        assert_eq!(log.read(&day).unwrap()[0].scope, day);
        // room and day lines carry no fileKey
        let line = std::fs::read_to_string(d.path().join(format!("asks/room-{K1}.jsonl"))).unwrap();
        assert!(!line.contains("fileKey") && !line.contains("scope"), "{line}");
    }
}
