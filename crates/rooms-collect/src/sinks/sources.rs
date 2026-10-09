//! `<home>/.rooms/sources.json`: which agent conversation last wrote each file. The same file
//! and format find_html.py `--record-sources` writes; rooms-core reads it for asks.
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub agent: String,
    pub session: String,
    pub cwd: String,
    /// `YYYY-MM-DDTHH:MM:SSZ`, so string order is time order.
    pub written_at: String,
    /// A real write (tool call, patch). A loose one (a shell line naming the path) only fills
    /// a file that has no entry yet.
    pub explicit: bool,
}

/// Keeps the better of two entries for one file: explicit over loose, then the later.
pub fn better(old: Option<&Entry>, new: Entry) -> Entry {
    match old {
        Some(o) if (o.explicit, &o.written_at) > (new.explicit, &new.written_at) => o.clone(),
        _ => new,
    }
}

/// Merges `entries` (keyed by realpath) into sources.json, re-reading it first; writes through a
/// temp file and rename. Nothing is written when `<home>/.rooms` is missing. Returns the number
/// of entries changed.
pub fn merge(home: &Path, entries: &BTreeMap<String, Entry>) -> std::io::Result<usize> {
    let dir = home.join(".rooms");
    if entries.is_empty() || !dir.is_dir() { return Ok(0); }
    let target = dir.join("sources.json");
    let mut sources: Map<String, Value> = std::fs::read(&target).ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("sources").and_then(|s| s.as_object()).cloned())
        .unwrap_or_default();
    sources.retain(|_, v| v.is_object());
    let mut n = 0;
    for (path, e) in entries {
        let stored = sources.get(path).and_then(|v| v.get("writtenAt")).and_then(|w| w.as_str());
        let take = match stored {
            None => true,
            Some(w) => e.explicit && e.written_at.as_str() >= w,
        };
        if !take { continue; }
        let v = json!({"agent": e.agent, "session": e.session, "cwd": e.cwd, "writtenAt": e.written_at});
        if sources.get(path) != Some(&v) { sources.insert(path.clone(), v); n += 1; }
    }
    if n == 0 { return Ok(0); }
    let tmp = dir.join(format!(".sources.{}.tmp", std::process::id()));
    let body = serde_json::to_vec_pretty(&json!({"version": 1, "sources": sources}))?;
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
        std::fs::rename(&tmp, &target)
    })();
    if res.is_err() { let _ = std::fs::remove_file(&tmp); }
    res.map(|_| n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(at: &str, explicit: bool, s: &str) -> Entry {
        Entry { agent: "codex".into(), session: s.into(), cwd: "/p".into(), written_at: at.into(), explicit }
    }

    #[test]
    fn explicit_replaces_older_and_loose_only_fills() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        std::fs::write(d.path().join(".rooms/sources.json"),
            r#"{"version":1,"sources":{"/a.html":{"agent":"claude-code","session":"old","cwd":"/p","writtenAt":"2026-10-01T00:00:00Z"},"/keep.html":{"session":"k","writtenAt":"2026-10-09T00:00:00Z"}}}"#).unwrap();
        let mut m = BTreeMap::new();
        m.insert("/a.html".to_string(), e("2026-10-02T00:00:00Z", false, "loose"));
        m.insert("/b.html".to_string(), e("2026-10-02T00:00:00Z", false, "new"));
        m.insert("/keep.html".to_string(), e("2026-10-02T00:00:00Z", true, "older"));
        assert_eq!(merge(d.path(), &m).unwrap(), 1);
        m.insert("/a.html".to_string(), e("2026-10-03T00:00:00Z", true, "newer"));
        assert_eq!(merge(d.path(), &m).unwrap(), 1);
        let v: Value = serde_json::from_slice(&std::fs::read(d.path().join(".rooms/sources.json")).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["sources"]["/a.html"]["session"], "newer");
        assert_eq!(v["sources"]["/b.html"]["session"], "new");
        assert_eq!(v["sources"]["/keep.html"]["session"], "k");
    }

    #[test]
    fn no_rooms_folder_no_file() {
        let d = tempfile::tempdir().unwrap();
        let mut m = BTreeMap::new();
        m.insert("/a.html".to_string(), e("2026-10-02T00:00:00Z", true, "s"));
        assert_eq!(merge(d.path(), &m).unwrap(), 0);
        assert!(!d.path().join(".rooms").exists());
    }

    #[test]
    fn better_prefers_explicit_then_later() {
        let l = e("2026-10-05T00:00:00Z", false, "l");
        let x = e("2026-10-01T00:00:00Z", true, "x");
        assert_eq!(better(Some(&x), l.clone()).session, "x");
        assert_eq!(better(Some(&l), x.clone()).session, "x");
        assert_eq!(better(Some(&x), e("2026-10-02T00:00:00Z", true, "y")).session, "y");
    }
}
