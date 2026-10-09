//! One adapter per agent: where its logs are, and how one log line becomes events. The only
//! code in Rooms that knows an agent's log format.
use crate::event::Event;
use crate::js::Syms;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub mod aside;
pub mod claude;
pub mod codex;

/// One log file an adapter found.
#[derive(Debug, Clone)]
pub struct LogFile {
    pub path: PathBuf,
    /// Stable across Codex's `.jsonl` → `.jsonl.zst`; part of event ids when a line has no id of its own.
    pub key: String,
    pub compressed: bool,
    /// Session id known from the path alone (Aside's folder name).
    pub session_hint: Option<String>,
}

/// What an adapter remembers between reads of one file (kept with the file's cursor).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileCtx {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Aside repl string constants.
    #[serde(default, skip_serializing_if = "Syms::is_empty")]
    pub js: Syms,
}

pub trait Adapter: Send + Sync {
    fn agent(&self) -> &'static str;
    /// Every log file under this adapter's roots (missing roots give nothing).
    fn discover(&self) -> Vec<LogFile>;
    /// Events of one complete line starting at byte `at`.
    fn parse_line(&self, line: &[u8], at: u64, file: &LogFile, ctx: &mut FileCtx, out: &mut Vec<Event>);
    /// How to continue a session from a terminal.
    fn resume_command(&self, session: &str) -> String;
}

/// Where each agent keeps its logs. Defaults are under the user's home; tests override them.
#[derive(Debug, Clone)]
pub struct Roots {
    pub user_home: PathBuf,
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub aside: PathBuf,
}

impl Roots {
    pub fn for_home(user_home: &Path) -> Self {
        Roots {
            user_home: user_home.to_path_buf(),
            claude: user_home.join(".claude/projects"),
            codex: user_home.join(".codex/sessions"),
            aside: user_home.join(".aside/u"),
        }
    }
}

/// The adapters for the agents turned on in `agents` (claude-code, codex, aside).
pub fn enabled(roots: &Roots, on: impl Fn(&str) -> bool) -> Vec<Box<dyn Adapter>> {
    let mut v: Vec<Box<dyn Adapter>> = Vec::new();
    if on("claude-code") { v.push(Box::new(claude::Claude { root: roots.claude.clone(), user_home: roots.user_home.clone() })); }
    if on("codex") { v.push(Box::new(codex::Codex { root: roots.codex.clone(), user_home: roots.user_home.clone() })); }
    if on("aside") { v.push(Box::new(aside::Aside { root: roots.aside.clone(), user_home: roots.user_home.clone() })); }
    v
}

/// Every file under `root` (recursively, not following symlinked dirs) for which `keep` holds.
pub(crate) fn walk(root: &Path, keep: &dyn Fn(&Path) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() { walk(&p, keep, out); } else if ft.is_file() && keep(&p) { out.push(p); }
    }
}

/// The text parts of a content value: a string, or a list of `{type: <one of kinds>, text}`.
pub(crate) fn texts(content: &serde_json::Value, kinds: &[&str]) -> Option<String> {
    if let Some(s) = content.as_str() { return (!s.trim().is_empty()).then(|| s.to_string()); }
    let parts: Vec<&str> = content.as_array()?.iter()
        .filter(|it| it.get("type").and_then(|t| t.as_str()).is_some_and(|t| kinds.contains(&t)))
        .filter_map(|it| it.get("text").and_then(|t| t.as_str()))
        .filter(|t| !t.trim().is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// Tool-call text for the index: name plus its input, at most 4 KiB.
pub(crate) fn tool_text(name: &str, input: &serde_json::Value) -> String {
    let body = match input.as_str() { Some(s) => s.to_string(), None => input.to_string() };
    let mut s = format!("{name} {body}");
    if s.len() > 4096 {
        let mut cut = 4096;
        while !s.is_char_boundary(cut) { cut -= 1; }
        s.truncate(cut);
    }
    s
}
