//! `<home>/.rooms/sources.json`: which agent conversation last wrote a doc (written by find_html.py).
//! Rooms never parses agent logs; it only reads this file, fresh on every ask.
use rooms_protocol::Source;
use std::path::Path;

/// The entry for exactly `file_realpath`, or `None` when the file is missing, invalid, or has no such key.
pub(crate) fn lookup(home: &Path, file_realpath: &Path) -> Option<Source> {
    let raw = std::fs::read_to_string(home.join(".rooms/sources.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let e = v.get("sources")?.get(file_realpath.to_str()?)?;
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
}
