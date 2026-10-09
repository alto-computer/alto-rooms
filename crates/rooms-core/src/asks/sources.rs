//! `<home>/.rooms/sources.json`: which agent conversation last wrote a doc (written by rooms-collect
//! and by find_html.py). rooms-core never parses agent logs; it only reads this file, fresh on every ask.
use rooms_protocol::Source;
use std::path::Path;

/// The entry for `file_realpath`, or `None` when the file is missing, invalid, or has no such key.
///
/// Keys from find_html.py come from Python's `os.path.realpath`, which keeps the typed case and Unicode form,
/// while `file_realpath` is canonicalized (on-disk name). On an exact miss, the first key
/// that canonicalizes to `file_realpath` is used instead.
pub(crate) fn lookup(home: &Path, file_realpath: &Path) -> Option<Source> {
    let raw = std::fs::read_to_string(home.join(".rooms/sources.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let sources = v.get("sources")?.as_object()?;
    let e = sources.get(file_realpath.to_str()?).or_else(|| {
        sources.iter().find(|(k, _)| std::fs::canonicalize(k).is_ok_and(|c| c == file_realpath)).map(|(_, e)| e)
    })?;
    let s = |k: &str| e.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(Source { agent: s("agent"), session: s("session"), cwd: s("cwd"), machine: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home_with(body: Option<&str>) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        if let Some(b) = body {
            std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
            std::fs::write(d.path().join(".rooms/sources.json"), b).unwrap();
        }
        d
    }

    const OK: &str = r#"{"version":1,"sources":{"/a/doc.html":{"agent":"claude-code","session":"S-9","cwd":"/work","writtenAt":"2026-10-06T00:00:00Z"}}}"#;

    #[test]
    fn valid_file_gives_entry() {
        let d = home_with(Some(OK));
        let s = lookup(d.path(), Path::new("/a/doc.html")).unwrap();
        assert_eq!((s.agent.as_deref(), s.session.as_deref(), s.cwd.as_deref(), s.machine), (Some("claude-code"), Some("S-9"), Some("/work"), None));
    }

    #[test]
    fn missing_invalid_or_other_path_is_none() {
        assert!(lookup(home_with(None).path(), Path::new("/a/doc.html")).is_none());
        assert!(lookup(home_with(Some("{")).path(), Path::new("/a/doc.html")).is_none());
        assert!(lookup(home_with(Some(OK)).path(), Path::new("/a/other.html")).is_none());
    }

    #[test]
    fn key_in_other_case_matches_on_case_insensitive_fs() {
        let docs = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(docs.path()).unwrap().join("Doc.html");
        std::fs::write(&real, "").unwrap();
        let typed = real.with_file_name("DOC.html");
        if std::fs::canonicalize(&typed).ok().as_ref() != Some(&real) {
            return; // case-sensitive file system: nothing to fall back to
        }
        let body = serde_json::json!({"version": 1, "sources": {typed.to_str().unwrap(): {
            "agent": "codex", "session": "S-1", "cwd": "/w", "writtenAt": "2026-10-06T00:00:00Z"}}});
        let d = home_with(Some(&body.to_string()));
        assert_eq!(lookup(d.path(), &real).unwrap().session.as_deref(), Some("S-1"));
    }
}
