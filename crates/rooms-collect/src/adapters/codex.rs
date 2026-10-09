//! Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (cold ones compressed to `.jsonl.zst`)
//! and `~/.codex/archived_sessions/rollout-*`, plus `~/.codex/session_index.jsonl` for thread names.
use super::{texts, tool_text, walk, Adapter, FileCtx, LogFile};
use crate::event::{parse_ts, Event, Kind, Role};
use crate::pathutil::{is_html, resolve};
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub struct Codex { pub root: PathBuf, pub user_home: PathBuf }

/// The key of `~/.codex/session_index.jsonl`: `{"id", "thread_name", "updated_at"}` per line.
const INDEX_KEY: &str = "session_index.jsonl";

fn patch_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\*\*\* (?:Add|Update) File: (\S+\.html?)\b").unwrap())
}
fn loose_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)[\w@%+=:,./~\-]+\.html?\b").unwrap())
}
fn write_hint_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(>|write_text|write_file|writeFile|writeFileSync|\.write\(|open\(|\btee\b|\bcp\b|\bmv\b|sed\s+-i)").unwrap())
}

/// Text Codex injects into the user turn; not something the user said.
const INJECTED: [&str; 3] = ["<environment_context>", "<user_instructions>", "# AGENTS.md instructions"];

fn is_rollout(p: &Path) -> bool {
    let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    n.starts_with("rollout-") && (n.ends_with(".jsonl") || n.ends_with(".jsonl.zst"))
}

impl Adapter for Codex {
    fn agent(&self) -> &'static str { "codex" }

    fn discover(&self) -> Vec<LogFile> {
        let mut paths = Vec::new();
        walk(&self.root, &is_rollout, &mut paths);
        if let Some(parent) = self.root.parent() {
            walk(&parent.join("archived_sessions"), &is_rollout, &mut paths);
            let index = parent.join(INDEX_KEY);
            if index.is_file() { paths.push(index); }
        }
        paths.into_iter().map(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            let compressed = name.ends_with(".zst");
            let key = name.trim_end_matches(".zst").to_string();
            LogFile { path, key, compressed, session_hint: None }
        }).collect()
    }

    fn parse_line(&self, line: &[u8], at: u64, file: &LogFile, ctx: &mut FileCtx, out: &mut Vec<Event>) {
        let Ok(rec) = serde_json::from_slice::<Value>(line) else { return };
        let len = line.len() as u64;
        if file.key == INDEX_KEY {
            let id = rec.get("id").and_then(Value::as_str);
            let name = rec.get("thread_name").and_then(Value::as_str).filter(|t| !t.trim().is_empty());
            if let (Some(id), Some(name)) = (id, name) {
                let mut e = Event::new(Kind::SessionSeen, at, len);
                e.session = Some(id.to_string());
                e.ts = rec.get("updated_at").and_then(parse_ts);
                e.title = Some(name.to_string());
                out.push(e);
            }
            return;
        }
        let payload = rec.get("payload").cloned().unwrap_or(Value::Null);
        let ts = rec.get("timestamp").and_then(parse_ts);
        let start = out.len();
        let mut push = |kind: Kind, ctx: &FileCtx, f: &mut dyn FnMut(&mut Event)| {
            let mut e = Event::new(kind, at, len);
            e.session = ctx.session.clone();
            e.cwd = ctx.cwd.clone();
            e.ts = ts;
            f(&mut e);
            out.push(e);
        };
        match rec.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(c) = payload.get("cwd").and_then(Value::as_str) { ctx.cwd = Some(c.to_string()); }
                if let Some(id) = payload.get("id").and_then(Value::as_str) { ctx.session = Some(id.to_string()); }
                push(Kind::SessionSeen, ctx, &mut |_| {});
            }
            Some("turn_context") => {
                if let Some(c) = payload.get("cwd").and_then(Value::as_str) { ctx.cwd = Some(c.to_string()); }
            }
            Some("response_item") => match payload.get("type").and_then(Value::as_str) {
                Some("message") => {
                    let role = match payload.get("role").and_then(Value::as_str) {
                        Some("user") => Role::User,
                        Some("assistant") => Role::Assistant,
                        _ => return,
                    };
                    let content = payload.get("content").cloned().unwrap_or(Value::Null);
                    if let Some(t) = texts(&content, &["input_text", "output_text", "text"]) {
                        if INJECTED.iter().any(|p| t.trim_start().starts_with(p)) { return; }
                        push(Kind::Message, ctx, &mut |e| { e.role = Some(role); e.text = Some(t.clone()); });
                    }
                }
                Some("function_call") | Some("custom_tool_call") => {
                    let name = payload.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    let input = payload.get("arguments").filter(|v| !v.is_null()).or_else(|| payload.get("input")).cloned().unwrap_or(Value::Null);
                    push(Kind::ToolCall, ctx, &mut |e| e.text = Some(tool_text(&name, &input)));
                    for (p, explicit) in self.writes(&payload, ctx.cwd.as_deref()) {
                        push(Kind::FileWritten, ctx, &mut |e| { e.path = Some(p.clone()); e.explicit = explicit; });
                    }
                }
                _ => {}
            },
            _ => {}
        }
        for (i, e) in out[start..].iter_mut().enumerate() { e.sub = i as u32; }
    }
}

impl Codex {
    /// (path, explicit): `apply_patch` file headers are explicit; other mentions in a command
    /// with a write hint are loose guesses (find_html.py's rules).
    fn writes(&self, payload: &Value, cwd: Option<&str>) -> Vec<(PathBuf, bool)> {
        let t = payload.get("type").and_then(Value::as_str);
        let v = match t {
            Some("custom_tool_call") if payload.get("name").and_then(Value::as_str) == Some("exec") => payload.get("input"),
            Some("function_call") => payload.get("arguments").filter(|v| !v.is_null()).or_else(|| payload.get("input")),
            _ => None,
        };
        let Some(v) = v else { return Vec::new() };
        let text = match v.as_str() { Some(s) => s.to_string(), None if v.is_object() || v.is_array() => v.to_string(), None => return Vec::new() };
        if !text.to_ascii_lowercase().contains(".htm") { return Vec::new(); }
        let text = text.replace("\\\\n", "\n").replace("\\n", "\n");
        let base = cwd.map(Path::new);
        let found: Vec<_> = patch_re().captures_iter(&text).map(|c| c[1].to_string()).collect();
        if !found.is_empty() {
            return found.iter().filter_map(|p| resolve(p, base, &self.user_home)).map(|p| (p, true)).collect();
        }
        if !write_hint_re().is_match(&text) { return Vec::new(); }
        loose_re().find_iter(&text).map(|m| m.as_str())
            .filter(|p| !p.starts_with('-') && !p.starts_with("http") && is_html(p))
            .filter_map(|p| resolve(p, base, &self.user_home)).map(|p| (p, false)).collect()
    }
}
