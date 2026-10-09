//! The normalized events adapters produce. Everything after the adapters works on these only.
use chrono::{DateTime, TimeZone, Utc};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const PREVIEW_CHARS: usize = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind { SessionSeen, Message, ToolCall, FileWritten }

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::SessionSeen => "session.seen",
            Kind::Message => "message",
            Kind::ToolCall => "tool.call",
            Kind::FileWritten => "file.written",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role { User, Assistant }

/// One event from one log line. `line_offset`/`line_len` locate the line in the log (byte
/// offsets of the uncompressed stream); `sub` numbers the events of one line.
#[derive(Debug, Clone)]
pub struct Event {
    pub kind: Kind,
    pub session: Option<String>,
    pub ts: Option<DateTime<Utc>>,
    pub cwd: Option<String>,
    /// The log's own id for the record (Claude Code `uuid`), when it has one.
    pub native_id: Option<String>,
    pub line_offset: u64,
    pub line_len: u64,
    pub sub: u32,
    pub role: Option<Role>,
    /// Message or tool-call text (indexed, never stored).
    pub text: Option<String>,
    /// file.written: absolute path; session.seen: title.
    pub path: Option<PathBuf>,
    pub title: Option<String>,
    pub explicit: bool,
}

impl Event {
    pub fn new(kind: Kind, line_offset: u64, line_len: u64) -> Self {
        Event { kind, session: None, ts: None, cwd: None, native_id: None, line_offset, line_len, sub: 0,
            role: None, text: None, path: None, title: None, explicit: false }
    }

    /// Deterministic id: the same line read twice (or from Codex's `.zst` copy) gives the same id.
    pub fn id(&self, agent: &str, file_key: &str) -> String {
        let mut h = Sha256::new();
        h.update(agent.as_bytes());
        h.update([0]);
        match &self.native_id {
            Some(n) => { h.update(b"n:"); h.update(n.as_bytes()); }
            None => { h.update(b"o:"); h.update(file_key.as_bytes()); h.update([0]); h.update(self.line_offset.to_le_bytes()); }
        }
        h.update([0]);
        h.update(self.sub.to_le_bytes());
        hex::encode(&h.finalize()[..16])
    }

    /// At most `PREVIEW_CHARS` characters of the text, whitespace collapsed.
    pub fn preview(&self) -> Option<String> {
        let t = self.text.as_deref().or(self.title.as_deref())?;
        let flat = t.split_whitespace().collect::<Vec<_>>().join(" ");
        Some(flat.chars().take(PREVIEW_CHARS).collect())
    }
}

/// An ISO-8601 timestamp (zone optional, UTC assumed), or epoch milliseconds.
pub fn parse_ts(v: &serde_json::Value) -> Option<DateTime<Utc>> {
    if let Some(ms) = v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)) {
        return Utc.timestamp_millis_opt(ms).single();
    }
    let s = v.as_str()?;
    if let Ok(d) = DateTime::parse_from_rfc3339(s) { return Some(d.with_timezone(&Utc)); }
    let head: String = s.chars().take(19).collect::<String>().replace(' ', "T");
    chrono::NaiveDateTime::parse_from_str(&head, "%Y-%m-%dT%H:%M:%S").ok().map(|n| n.and_utc())
}

pub fn fmt_ts(t: &DateTime<Utc>) -> String { t.format("%Y-%m-%dT%H:%M:%SZ").to_string() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_distinct() {
        let mut a = Event::new(Kind::Message, 10, 5);
        assert_eq!(a.id("codex", "rollout-x"), a.id("codex", "rollout-x"));
        assert_ne!(a.id("codex", "rollout-x"), a.id("codex", "rollout-y"));
        let b = { let mut b = a.clone(); b.sub = 1; b };
        assert_ne!(a.id("codex", "k"), b.id("codex", "k"));
        a.native_id = Some("u1".into());
        assert_eq!(a.id("claude-code", "k1"), a.id("claude-code", "k2"));
    }

    #[test]
    fn timestamps() {
        use serde_json::json;
        assert_eq!(fmt_ts(&parse_ts(&json!("2026-10-01T00:22:51.123Z")).unwrap()), "2026-10-01T00:22:51Z");
        assert_eq!(fmt_ts(&parse_ts(&json!("2026-10-01T09:22:51+09:00")).unwrap()), "2026-10-01T00:22:51Z");
        assert_eq!(fmt_ts(&parse_ts(&json!("2026-10-01 00:22:51")).unwrap()), "2026-10-01T00:22:51Z");
        assert_eq!(fmt_ts(&parse_ts(&json!(1790000000000i64)).unwrap()), "2026-09-21T14:13:20Z");
        assert!(parse_ts(&json!("nope")).is_none());
    }
}
