//! Claude Code: `~/.claude/projects/<cwd>/<session>.jsonl`, one JSON record per line.
use super::{texts, tool_text, walk, Adapter, FileCtx, LogFile};
use crate::event::{parse_ts, Event, Kind, Publish, Role};
use crate::pathutil::{is_html, resolve};
use crate::shell::shell_writes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const WRITE_TOOLS: [&str; 5] = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Artifact"];
/// Most publishes remembered while their results are outstanding (a result lands a line or two later).
const MAX_PENDING: usize = 16;

/// An Artifact publish call whose result has not been read yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pending {
    pub id: String,
    pub page: PathBuf,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<(String, Option<PathBuf>)>,
}

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
        let named = match ty { "ai-title" => rec.get("aiTitle"), "custom-title" => rec.get("customTitle"), _ => None };
        if let Some(t) = named.and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
            let mut e = base(Kind::SessionSeen, ctx);
            if let Some(sid) = rec.get("sessionId").and_then(Value::as_str) { e.session = Some(sid.to_string()); }
            e.title = Some(t.to_string());
            // A title the user typed outranks the agent's (sessions::title).
            e.role = (ty == "custom-title").then_some(Role::User);
            out.push(e);
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
                if let Some(p) = self.publish_call(block, &input, ctx.cwd.as_deref()) {
                    if ctx.publishing.len() >= MAX_PENDING { ctx.publishing.remove(0); }
                    ctx.publishing.push(p);
                }
            }
        }
        if ty == "user" && !ctx.publishing.is_empty() {
            for block in content.as_array().into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") { continue; }
                let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else { continue };
                let Some(i) = ctx.publishing.iter().position(|p| p.id == id) else { continue };
                let pending = ctx.publishing.remove(i);
                let url = rec.pointer("/toolUseResult/url").and_then(Value::as_str);
                let Some(url) = url.filter(|_| block.get("is_error").and_then(Value::as_bool) != Some(true)) else { continue };
                let mut e = base(Kind::ArtifactPublished, ctx);
                e.path = Some(pending.page);
                e.explicit = true;
                e.publish = Some(Publish { url: url.to_string(), files: pending.files });
                out.push(e);
            }
        }
        for (i, e) in out[start..].iter_mut().enumerate() {
            e.native_id = uuid.clone();
            e.sub = i as u32;
        }
    }
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

    /// An Artifact call that publishes an HTML page (not a read, list or asset upload). Supporting
    /// files resolve against `root` (itself against the working directory), else the working directory.
    fn publish_call(&self, block: &Value, input: &Value, cwd: Option<&str>) -> Option<Pending> {
        if block.get("name").and_then(Value::as_str) != Some("Artifact") { return None; }
        if input.get("action").and_then(Value::as_str).is_some_and(|a| a != "publish") { return None; }
        if input.get("asset").and_then(Value::as_bool) == Some(true) { return None; }
        let cwd = cwd.map(Path::new);
        let page = input.get("file_path").and_then(Value::as_str).filter(|p| is_html(p)).and_then(|p| resolve(p, cwd, &self.user_home))?;
        let root = input.get("root").and_then(Value::as_str).and_then(|r| resolve(r, cwd, &self.user_home));
        let base = root.as_deref().or(cwd);
        let src = |p: Option<&str>| p.and_then(|p| resolve(p, base, &self.user_home));
        let files = match input.get("files") {
            Some(Value::Object(m)) => m.iter().map(|(published, from)| {
                let from = match from { Value::Object(o) => o.get("from"), v => Some(v) };
                (published.clone(), src(from.and_then(Value::as_str)))
            }).collect(),
            Some(Value::Array(a)) => a.iter().filter_map(|f| f.get("path").and_then(Value::as_str))
                .map(|p| (p.to_string(), src(Some(p)))).collect(),
            _ => Vec::new(),
        };
        Some(Pending { id: block.get("id").and_then(Value::as_str)?.to_string(), page, files })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(lines: &[Value]) -> Vec<Event> {
        let c = Claude { root: PathBuf::from("/logs"), user_home: PathBuf::from("/Users/me") };
        let file = LogFile { path: "/logs/s.jsonl".into(), key: "s.jsonl".into(), compressed: false, session_hint: None };
        let (mut ctx, mut out) = (FileCtx::default(), Vec::new());
        for l in lines { c.parse_line(l.to_string().as_bytes(), 0, &file, &mut ctx, &mut out); }
        out.into_iter().filter(|e| e.kind == Kind::ArtifactPublished).collect()
    }

    fn call(id: &str, input: Value) -> Value {
        json!({"type": "assistant", "cwd": "/w", "sessionId": "s", "uuid": format!("a{id}"), "message": {"content": [{"type": "tool_use", "id": id, "name": "Artifact", "input": input}]}})
    }

    fn result(id: &str, tur: Value, is_error: bool) -> Value {
        json!({"type": "user", "cwd": "/w", "sessionId": "s", "uuid": format!("r{id}"), "toolUseResult": tur,
               "message": {"content": [{"type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": "x"}]}})
    }

    #[test]
    fn a_publish_becomes_an_event_only_with_its_successful_result() {
        let url = json!({"url": "https://claude.ai/artifact/A1"});
        let ev = parse(&[
            call("1", json!({"file_path": "pad/p.html", "root": "pad", "files": {"a.png": "img/a.png", "gone.html": null, "b.css": {"from": "/abs/b.css"}}})),
            result("1", url.clone(), false),
        ]);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].path.as_deref(), Some(Path::new("/w/pad/p.html")));
        let mut files = ev[0].publish.clone().unwrap().files;
        files.sort();
        assert_eq!(files, vec![("a.png".into(), Some("/w/pad/img/a.png".into())), ("b.css".into(), Some("/abs/b.css".into())), ("gone.html".into(), None)]);
        let list = parse(&[call("2", json!({"file_path": "/t/p.html", "files": [{"path": "shots/1.jpg"}]})), result("2", url.clone(), false)]);
        assert_eq!(list[0].publish.as_ref().unwrap().files, vec![("shots/1.jpg".into(), Some("/w/shots/1.jpg".into()))]);

        assert!(parse(&[call("3", json!({"file_path": "/t/p.html"})), result("3", json!("Error: denied"), true)]).is_empty());
        assert!(parse(&[call("4", json!({"file_path": "/t/p.html", "asset": true, "url": "u"})), result("4", url.clone(), false)]).is_empty());
        assert!(parse(&[call("5", json!({"action": "read", "url": "u"})), result("5", url.clone(), false)]).is_empty());
        assert!(parse(&[call("6", json!({"file_path": "/t/p.html"})), result("other", url, false)]).is_empty());
    }
}
