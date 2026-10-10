//! Aside: `~/.aside/u/<account>/sessions/<YYYY-MM-DD>_<session>/messages.jsonl`.
use super::{texts, tool_text, Adapter, FileCtx, LogFile};
use crate::event::{parse_ts, Event, Kind, Role};
use crate::js::js_writes;
use crate::pathutil::{is_html, resolve};
use crate::shell::shell_writes;
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub struct Aside { pub root: PathBuf, pub user_home: PathBuf }

fn write_tool_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)write|edit").unwrap())
}

fn dirs(p: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(p).into_iter().flatten().flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect();
    v.sort();
    v
}

/// The account a session log is under, as Aside names it (`u<n>`), from its path
/// `<root>/<n>/sessions/<day>_<session>/messages.jsonl`.
pub fn account_of(log: &Path) -> Option<String> {
    let sessions = log.parent()?.parent()?;
    if sessions.file_name()? != "sessions" { return None; }
    let n: u32 = sessions.parent()?.file_name()?.to_str()?.parse().ok()?;
    Some(format!("u{n}"))
}

impl Adapter for Aside {
    fn agent(&self) -> &'static str { "aside" }

    fn discover(&self) -> Vec<LogFile> {
        let mut out = Vec::new();
        for account in dirs(&self.root) {
            for s in dirs(&account.join("sessions")) {
                let name = s.file_name().unwrap().to_string_lossy().into_owned();
                let Some((day, sid)) = name.split_once('_') else { continue };
                if sid.is_empty() || chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_err() { continue; }
                let path = s.join("messages.jsonl");
                if path.is_file() {
                    out.push(LogFile { path, key: name.clone(), compressed: false, session_hint: Some(sid.to_string()) });
                }
            }
        }
        out
    }

    fn parse_line(&self, line: &[u8], at: u64, file: &LogFile, ctx: &mut FileCtx, out: &mut Vec<Event>) {
        let Ok(rec) = serde_json::from_slice::<Value>(line) else { return };
        let len = line.len() as u64;
        let ts = rec.get("timestamp").and_then(parse_ts);
        let start = out.len();
        if ctx.session.is_none() {
            ctx.session = file.session_hint.clone();
            let mut e = Event::new(Kind::SessionSeen, at, len);
            e.session = ctx.session.clone();
            e.ts = ts;
            out.push(e);
        }
        let role = match rec.get("role").and_then(Value::as_str) {
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            _ => { for (i, e) in out[start..].iter_mut().enumerate() { e.sub = i as u32; } return; }
        };
        let mk = |kind: Kind, ctx: &FileCtx| {
            let mut e = Event::new(kind, at, len);
            e.session = ctx.session.clone();
            e.ts = ts;
            e
        };
        let content = rec.get("content").cloned().unwrap_or(Value::Null);
        if let Some(t) = texts(&content, &["text"]) {
            let mut e = mk(Kind::Message, ctx);
            e.role = Some(role);
            e.text = Some(t);
            out.push(e);
        }
        if role == Role::Assistant {
            for call in content.as_array().into_iter().flatten() {
                if call.get("type").and_then(Value::as_str) != Some("toolCall") { continue; }
                let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                let args = call.get("arguments").cloned().unwrap_or(Value::Null);
                let mut e = mk(Kind::ToolCall, ctx);
                e.text = Some(tool_text(name, &args));
                out.push(e);
                for (p, explicit) in self.writes(name, &args, ctx) {
                    let mut e = mk(Kind::FileWritten, ctx);
                    e.cwd = p.parent().map(|d| d.to_string_lossy().into_owned());
                    e.path = Some(p);
                    e.explicit = explicit;
                    out.push(e);
                }
            }
        }
        for (i, e) in out[start..].iter_mut().enumerate() { e.sub = i as u32; }
    }
}

impl Aside {
    /// (path, explicit) for one toolCall: repl `writeFile` and write/edit tools' `path` are
    /// explicit; bash is a loose guess (find_html.py's `aside_call_writes`).
    fn writes(&self, name: &str, args: &Value, ctx: &mut FileCtx) -> Vec<(PathBuf, bool)> {
        let mut out = Vec::new();
        if !args.is_object() { return out; }
        if name == "repl" {
            if let Some(code) = args.get("code").and_then(Value::as_str) {
                out.extend(js_writes(code, &mut ctx.js, &self.user_home).into_iter().map(|p| (p, true)));
            }
        } else if name == "bash" {
            if let Some(cmd) = args.get("command").and_then(Value::as_str) {
                out.extend(shell_writes(cmd, None, &self.user_home).into_iter().map(|p| (p, false)));
            }
        }
        let target = args.get("path").or_else(|| args.get("file_path")).and_then(Value::as_str);
        if let Some(t) = target.filter(|t| is_html(t)) {
            if write_tool_re().is_match(name) {
                if let Some(p) = resolve(t, None, &self.user_home) { out.push((p, true)); }
            }
        }
        out
    }
}
