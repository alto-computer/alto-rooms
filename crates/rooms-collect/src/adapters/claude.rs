//! Claude Code: `~/.claude/projects/<cwd>/<session>.jsonl`, one JSON record per line.
use super::{texts, tool_text, walk, Adapter, FileCtx, LogFile};
use crate::event::{parse_ts, Event, Kind, Role};
use crate::pathutil::{is_html, resolve};
use crate::shell::shell_writes;
use serde_json::Value;
use std::path::{Path, PathBuf};

const WRITE_TOOLS: [&str; 5] = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Artifact"];

pub struct Claude { pub root: PathBuf, pub user_home: PathBuf }

impl Adapter for Claude {
    fn agent(&self) -> &'static str { "claude-code" }

    fn discover(&self) -> Vec<LogFile> {
        let mut paths = Vec::new();
        walk(&self.root, &|p: &Path| p.extension().is_some_and(|e| e == "jsonl"), &mut paths);
        paths.into_iter().map(|path| {
            let key = path.strip_prefix(&self.root).unwrap_or(&path).to_string_lossy().into_owned();
            LogFile { path, key, compressed: false, session_hint: None }
        }).collect()
    }

    fn parse_line(&self, line: &[u8], at: u64, _file: &LogFile, ctx: &mut FileCtx, out: &mut Vec<Event>) {
        let Ok(rec) = serde_json::from_slice::<Value>(line) else { return };
        let len = line.len() as u64;
        let ty = rec.get("type").and_then(Value::as_str).unwrap_or("");
        let base = |kind: Kind, ctx: &FileCtx| {
            let mut e = Event::new(kind, at, len);
            e.session = ctx.session.clone();
            e.cwd = ctx.cwd.clone();
            e.ts = rec.get("timestamp").and_then(parse_ts);
            e
        };
        if ty == "summary" {
            if let Some(s) = rec.get("summary").and_then(Value::as_str) {
                ctx.title = Some(s.to_string());
                let mut e = base(Kind::SessionSeen, ctx);
                e.title = Some(s.to_string());
                out.push(e);
            }
            return;
        }
        if ty != "user" && ty != "assistant" { return; }
        if let Some(cwd) = rec.get("cwd").and_then(Value::as_str) { ctx.cwd = Some(cwd.to_string()); }
        if let Some(sid) = rec.get("sessionId").and_then(Value::as_str) {
            if ctx.session.as_deref() != Some(sid) {
                ctx.session = Some(sid.to_string());
                out.push(base(Kind::SessionSeen, ctx));
            }
        }
        let uuid = rec.get("uuid").and_then(Value::as_str).map(str::to_string);
        let start = out.len();
        let content = rec.pointer("/message/content").cloned().unwrap_or(Value::Null);
        let meta = rec.get("isMeta").and_then(Value::as_bool).unwrap_or(false);
        if !meta {
            if let Some(t) = texts(&content, &["text"]) {
                let mut e = base(Kind::Message, ctx);
                e.role = Some(if ty == "user" { Role::User } else { Role::Assistant });
                e.text = Some(t);
                out.push(e);
            }
        }
        if ty == "assistant" {
            for block in content.as_array().into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") { continue; }
                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                let mut e = base(Kind::ToolCall, ctx);
                e.text = Some(tool_text(name, &input));
                out.push(e);
                for (p, explicit) in self.writes(name, &input, ctx.cwd.as_deref()) {
                    let mut e = base(Kind::FileWritten, ctx);
                    e.path = Some(p);
                    e.explicit = explicit;
                    out.push(e);
                }
            }
        }
        for (i, e) in out[start..].iter_mut().enumerate() {
            e.native_id = uuid.clone();
            e.sub = i as u32;
        }
    }

    fn resume_command(&self, session: &str) -> String { format!("claude --resume {session}") }
}

impl Claude {
    /// (path, explicit) written by one tool_use block. Bash copies are loose guesses.
    fn writes(&self, name: &str, input: &Value, cwd: Option<&str>) -> Vec<(PathBuf, bool)> {
        let base = cwd.map(Path::new);
        if WRITE_TOOLS.contains(&name) {
            let p = input.get("file_path").or_else(|| input.get("notebook_path")).and_then(Value::as_str);
            return p.filter(|p| is_html(p)).and_then(|p| resolve(p, base, &self.user_home)).map(|p| vec![(p, true)]).unwrap_or_default();
        }
        if name == "Bash" {
            if let Some(cmd) = input.get("command").and_then(Value::as_str) {
                return shell_writes(cmd, base, &self.user_home).into_iter().map(|p| (p, false)).collect();
            }
        }
        Vec::new()
    }
}
