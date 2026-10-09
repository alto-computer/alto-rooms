//! `.rooms/asks/<fileKey>.jsonl`: one line when a turn starts, one when it ends; last line per id wins.
use rooms_protocol::AskTurn;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

pub(crate) struct AskLog { dir: PathBuf }

impl AskLog {
    pub fn new(dir: PathBuf) -> Self { Self { dir } }

    fn path(&self, file_key: &str) -> PathBuf { self.dir.join(format!("{file_key}.jsonl")) }

    pub fn append(&self, turn: &AskTurn) -> std::io::Result<()> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir)?;
        let mut line = serde_json::to_vec(turn).map_err(std::io::Error::other)?;
        line.push(b'\n');
        let mut f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(self.path(&turn.file_key))?;
        f.write_all(&line) // one write per line (O_APPEND)
    }

    pub fn read(&self, file_key: &str) -> std::io::Result<Vec<AskTurn>> {
        // Bytes, not a String: one torn line with invalid UTF-8 must not make the whole file unreadable.
        let bytes = match std::fs::read(self.path(file_key)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out: Vec<AskTurn> = Vec::new();
        for line in bytes.split(|b| *b == b'\n') {
            let Ok(t) = serde_json::from_str::<AskTurn>(&String::from_utf8_lossy(line)) else { continue };
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
    use rooms_protocol::{AskMode, AskStatus};
    use std::os::unix::fs::PermissionsExt;

    fn t(id: &str, status: AskStatus, answer: &str) -> AskTurn {
        AskTurn { id: id.into(), file_key: "k1".into(), question: "q".into(), answer: answer.into(), agent: "a".into(), model: None,
            mode: AskMode::New, status, error: None, started_at: "s".into(), ended_at: None, images: vec![], kind: Default::default(), left_out: 0 }
    }

    #[test]
    fn missing_file_is_empty() {
        let d = tempfile::tempdir().unwrap();
        assert!(AskLog::new(d.path().join("asks")).read("k1").unwrap().is_empty());
    }

    #[test]
    fn last_line_per_id_wins_in_start_order_and_bad_lines_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let log = AskLog::new(d.path().join("asks"));
        log.append(&t("a", AskStatus::Running, "")).unwrap();
        log.append(&t("b", AskStatus::Running, "")).unwrap();
        log.append(&t("a", AskStatus::Done, "A")).unwrap();
        std::fs::OpenOptions::new().append(true).open(d.path().join("asks/k1.jsonl")).unwrap()
            .write_all(b"{not json\n").unwrap();
        let got = log.read("k1").unwrap();
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
        std::fs::OpenOptions::new().append(true).open(d.path().join("asks/k1.jsonl")).unwrap()
            .write_all(b"{\"id\":\"x\xff\xfe torn\n").unwrap();
        log.append(&t("b", AskStatus::Done, "B")).unwrap();
        let got = log.read("k1").unwrap();
        assert_eq!(got.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    }
}
