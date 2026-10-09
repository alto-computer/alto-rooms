//! The only place Rooms knows about agent CLIs: argv templates from `<home>/.rooms/agents.toml`,
//! over built-in defaults. Rooms reads this file and never writes it. A template with `{prompt}`
//! gets the prompt there; one without gets it on stdin (the built-in claude-code and codex do).
//!
//! A profile may also say how to read its stdout as JSON lines while it streams, with
//! `[[agents.X.events]]` rules (`match` pointers, then `delta` / `answer` / `activity` / `clear`;
//! see `stream.rs`). The built-in claude-code and codex profiles carry theirs; a file's profile
//! replaces the built-in one whole, rules included.
use super::stream::EventRule;
use rooms_protocol::AskMode;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) const DEFAULT_AGENT: &str = "claude-code";
pub(crate) const DEFAULT_PREAMBLE: &str =
    "[Rooms] The user is reading the HTML document below in the Rooms app and asking about it. Answer briefly in Markdown, in the language of the question. Don't create or edit files.";
/// For a room or a Journal day. The `preamble` key in agents.toml replaces only the doc preamble.
/// The built-in claude-code profile also enforces the list (`claude_read_scope`); other agents
/// get only these words.
pub(crate) const SCOPE_PREAMBLE: &str =
    "[Rooms] The user is looking at the room or Journal day below in the Rooms app and asking about its documents. Read only the files listed below; each line gives a quoted path, then the quoted document title. Give Read and Grep one listed file path per call; never pass a folder, not even the folder a listed file is in, and never search without a path. Answer briefly in Markdown, in the language of the question. Don't create or edit files.";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    pub resume: Option<Vec<String>>,
    pub new: Vec<String>,
    /// Models the user can pick; offered only for a template with an element that is exactly `{model}`.
    #[serde(default)]
    pub models: Vec<String>,
    /// How to read JSON-lines stdout as it streams; none = stdout is the answer as plain text.
    #[serde(default)]
    pub events: Vec<EventRule>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    default: Option<String>,
    preamble: Option<String>,
    #[serde(default)]
    agents: BTreeMap<String, Profile>,
}

pub(crate) struct AgentProfiles {
    default: String,
    agents: BTreeMap<String, Profile>,
    preamble: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Plan {
    pub agent: String,
    pub mode: AskMode,
    /// The profile's models, or none when this template takes no `{model}`.
    pub models: Vec<String>,
    pub events: Vec<EventRule>,
    template: Vec<String>,
}

pub(crate) struct Vars<'a> {
    pub prompt: &'a str,
    pub session: &'a str,
    pub file: &'a str,
    pub cwd: &'a str,
    /// Path of `<home>/.rooms/mcp.json`, or "" when it does not exist.
    pub mcp_config: &'a str,
    /// One of `Plan::models`, or "" for the agent's own default.
    pub model: &'a str,
    /// Absolute paths of the attached images: an element that is exactly `{image}` repeats with
    /// the element before it (its flag) once per image, and goes away when there are none.
    pub images: &'a [String],
    /// The folder the images are in, or "" when there are none.
    pub image_dir: &'a str,
    /// `claude_read_scope` of a room's or day's listed files, or "" for a doc ask.
    pub scope_settings: &'a str,
}

fn argv(parts: &[&str]) -> Vec<String> { parts.iter().map(|s| s.to_string()).collect() }

/// Built-in event rules, written as a user would write them in agents.toml (`[[agents.X.events]]`).
fn rules(toml_text: &str) -> Vec<EventRule> {
    #[derive(Deserialize)]
    struct Rules { events: Vec<EventRule> }
    toml::from_str::<Rules>(toml_text).expect("built-in event rules parse").events
}

/// `claude -p --output-format stream-json --verbose --include-partial-messages`: text deltas of the
/// current model message, each tool call as activity ("Read · AskBar.tsx"), and `result` (the
/// last message's text) as the answer.
const CLAUDE_EVENTS: &str = r#"
[[events]]
match = { "/type" = "stream_event", "/event/type" = "message_start" }
clear = true

[[events]]
match = { "/type" = "stream_event", "/event/type" = "content_block_delta", "/event/delta/type" = "text_delta" }
delta = "/event/delta/text"

[[events]]
match = { "/type" = "stream_event", "/event/type" = "content_block_start", "/event/content_block/type" = "thinking" }
label = "Thinking"

[[events]]
match = { "/type" = "assistant" }
activity = ["/message/content/*/name", "/message/content/*/input/file_path", "/message/content/*/input/pattern"]

[[events]]
match = { "/type" = "result" }
answer = "/result"
"#;

/// `codex exec --json`: each agent message replaces the answer (the last is the final one);
/// commands, tool calls and searches show as activity.
const CODEX_EVENTS: &str = r#"
[[events]]
match = { "/type" = "item.started", "/item/type" = "reasoning" }
label = "Thinking"

[[events]]
match = { "/type" = "item.started", "/item/type" = "command_execution" }
label = "Running"
activity = ["/item/command"]

[[events]]
match = { "/type" = "item.started", "/item/type" = "mcp_tool_call" }
activity = ["/item/tool"]

[[events]]
match = { "/type" = "item.started", "/item/type" = "web_search" }
label = "Searching"
activity = ["/item/query"]

[[events]]
match = { "/type" = "item.completed", "/item/type" = "agent_message" }
answer = "/item/text"
"#;

fn builtin() -> BTreeMap<String, Profile> {
    BTreeMap::from([
        ("claude-code".to_string(), Profile {
            resume: Some(argv(&["claude", "-p", "--model", "{model}", "--resume", "{session}", "--fork-session", "--no-session-persistence", "--setting-sources=user", "--tools=Read,Grep,Glob", "--strict-mcp-config", "--mcp-config", "{mcp_config}", "--allowedTools=mcp__rooms", "--add-dir", "{image_dir}", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])),
            new: argv(&["claude", "-p", "--model", "{model}", "--no-session-persistence", "--setting-sources=user", "--tools=Read,Grep,Glob", "--strict-mcp-config", "--mcp-config", "{mcp_config}", "--allowedTools=mcp__rooms", "--add-dir", "{image_dir}", "--settings", "{scope_settings}", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]),
            models: argv(&["opus", "sonnet", "haiku"]),
            events: rules(CLAUDE_EVENTS),
        }),
        ("codex".to_string(), Profile {
            resume: Some(argv(&["codex", "exec", "fork", "{session}", "-m", "{model}", "-c", "sandbox_mode=\"read-only\"", "--ephemeral", "--skip-git-repo-check", "-i", "{image}", "--json", "-"])),
            new: argv(&["codex", "exec", "-m", "{model}", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "-i", "{image}", "--json", "-"]),
            models: argv(&["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol"]),
            events: rules(CODEX_EVENTS),
        }),
        // `aside session resume` takes no model flag: resumed asks keep the session's model.
        ("aside".to_string(), Profile {
            resume: Some(argv(&["aside", "session", "resume", "{session}", "{prompt}"])),
            new: argv(&["aside", "exec", "-m", "{model}", "{prompt}"]),
            models: argv(&["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]),
            events: Vec::new(),
        }),
    ])
}

/// Claude Code `--settings` for a room or day ask: `dontAsk` denies every tool call that no rule
/// allows, and one `Read(//<path>)` rule per listed file allows that file. Claude applies Read rules
/// to Grep and Glob too, so a search of the folder a listed file is in is denied (measured on
/// claude 2.1.295). Its own spill files under `~/.claude/projects/` and the `--add-dir` image folder
/// stay readable. A rule path is a gitignore pattern: `\`, `*`, `?`, `[` and `]` are escaped, and a
/// name holding `?` or `\` then matches nothing, so that file is denied, never a wider set. An allow
/// rule in the user's own settings (`--setting-sources=user`) still adds to this.
pub(crate) fn claude_read_scope<'a>(paths: impl IntoIterator<Item = &'a Path>) -> String {
    let allow: Vec<String> = paths.into_iter().map(|p| {
        let mut rule = String::from("Read(/");
        for c in p.to_string_lossy().chars() {
            if matches!(c, '\\' | '*' | '?' | '[' | ']') { rule.push('\\'); }
            rule.push(c);
        }
        rule.push(')');
        rule
    }).collect();
    serde_json::json!({ "permissions": { "defaultMode": "dontAsk", "allow": allow } }).to_string()
}

/// `[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}`: never flag-shaped, so it is safe as an argv element.
pub(crate) fn valid_model(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && s.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-'))
}

fn check(name: &str, which: &str, t: &[String]) -> Result<(), String> {
    match t.first() {
        None => Err(format!("agents.{name}.{which}: empty")),
        Some(p) if p.contains('{') => Err(format!("agents.{name}.{which}: the program (first element) can't be a placeholder")),
        Some(_) => Ok(()),
    }
}

impl AgentProfiles {
    /// No file = built-in defaults. A file's `[agents.X]` replaces built-in X whole.
    pub fn load(path: &Path) -> Result<Self, String> {
        let cfg: FileConfig = match std::fs::read_to_string(path) {
            Ok(text) => toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileConfig::default(),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let mut agents = builtin();
        agents.extend(cfg.agents);
        for (name, p) in &agents {
            check(name, "new", &p.new)?;
            if let Some(r) = &p.resume { check(name, "resume", r)?; }
            if let Some(m) = p.models.iter().find(|m| !valid_model(m)) {
                return Err(format!("agents.{name}.models: \"{m}\" is not a valid model name"));
            }
            // Only an element that is exactly {model} can be dropped for "Default"; "--model={model}" would send "--model=".
            let partial = std::iter::once(&p.new).chain(p.resume.as_ref()).flatten().any(|a| a.contains("{model}") && a != "{model}");
            for (i, r) in p.events.iter().enumerate() {
                r.check().map_err(|e| format!("agents.{name}.events[{i}]: {e}"))?;
            }
            if !p.models.is_empty() && partial {
                return Err(format!("agents.{name}: with models, {{model}} must be a whole element (e.g. \"--model\", \"{{model}}\")"));
            }
        }
        let default = cfg.default.unwrap_or_else(|| DEFAULT_AGENT.to_string());
        if !agents.contains_key(&default) {
            return Err(format!("{}: default = \"{default}\" but there is no [agents.{default}]", path.display()));
        }
        Ok(Self { default, agents, preamble: cfg.preamble })
    }

    /// R1 + R2. `agent`/`session` must already be filtered by `valid_ident`.
    pub fn plan(&self, agent: Option<&str>, session: Option<&str>) -> Plan {
        let named = agent.filter(|a| self.agents.contains_key(*a));
        let name = named.unwrap_or(&self.default).to_string();
        let p = &self.agents[&name];
        let (mode, template) = match (named, session, &p.resume) {
            (Some(_), Some(_), Some(t)) => (AskMode::Resume, t.clone()),
            _ => (AskMode::New, p.new.clone()),
        };
        let models = if template.iter().any(|a| a == "{model}") { p.models.clone() } else { Vec::new() };
        Plan { agent: name, mode, models, events: p.events.clone(), template }
    }

    pub fn preamble(&self) -> &str { self.preamble.as_deref().unwrap_or(DEFAULT_PREAMBLE) }
}

const PLACEHOLDERS: [&str; 8] = ["{prompt}", "{session}", "{file}", "{cwd}", "{mcp_config}", "{model}", "{image_dir}", "{scope_settings}"];

/// One left-to-right pass: substituted text is never scanned again.
fn subst(arg: &str, v: &Vars) -> String {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        match PLACEHOLDERS.iter().find(|p| tail.starts_with(**p)) {
            Some(p) => {
                out.push_str(match *p { "{prompt}" => v.prompt, "{session}" => v.session, "{file}" => v.file, "{cwd}" => v.cwd, "{model}" => v.model, "{image_dir}" => v.image_dir, "{scope_settings}" => v.scope_settings, _ => v.mcp_config });
                rest = &tail[p.len()..];
            }
            None => { out.push('{'); rest = &tail[1..]; }
        }
    }
    out.push_str(rest);
    out
}

impl Plan {
    /// A template without `{prompt}` gets the prompt on stdin, which has no size limit; with it,
    /// the prompt is that argv element, as for a CLI that reads no stdin.
    pub fn prompt_on_stdin(&self) -> bool { !self.template.iter().any(|a| a.contains("{prompt}")) }

    /// An element that is exactly `{mcp_config}`, `{model}`, `{image_dir}` or `{scope_settings}` with an empty value is
    /// dropped together with the element before it (its flag, e.g. `--mcp-config` or `--model`).
    /// `{image}` repeats with its flag once per image (`-i a -i b`).
    pub fn render(&self, v: &Vars) -> Vec<String> {
        let mut out: Vec<String> = Vec::with_capacity(self.template.len());
        for a in &self.template {
            if a == "{image}" {
                let flag = out.pop();
                for img in v.images { out.extend(flag.iter().cloned()); out.push(img.clone()); }
                continue;
            }
            let empty = (a == "{mcp_config}" && v.mcp_config.is_empty()) || (a == "{model}" && v.model.is_empty()) || (a == "{image_dir}" && v.image_dir.is_empty())
                || (a == "{scope_settings}" && v.scope_settings.is_empty());
            if empty { out.pop(); continue; }
            out.push(subst(a, v));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(text: Option<&str>) -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("agents.toml");
        if let Some(t) = text { std::fs::write(&p, t).unwrap(); }
        (d, p)
    }
    fn vars<'a>(prompt: &'a str) -> Vars<'a> { Vars { prompt, session: "S1", file: "/f.html", cwd: "/c", mcp_config: "", model: "", images: &[], image_dir: "", scope_settings: "" } }

    #[test]
    fn missing_file_gives_builtin_defaults() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        let plan = a.plan(Some("claude-code"), Some("S1"));
        assert_eq!(plan.mode, AskMode::Resume);
        assert_eq!(plan.render(&vars("Q")), vec!["claude", "-p", "--resume", "S1", "--fork-session", "--no-session-persistence", "--setting-sources=user", "--tools=Read,Grep,Glob", "--strict-mcp-config", "--allowedTools=mcp__rooms", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
        assert_eq!(a.preamble(), DEFAULT_PREAMBLE);
    }

    #[test]
    fn a_template_without_prompt_takes_it_on_stdin() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        for (agent, session) in [("claude-code", None), ("claude-code", Some("S1")), ("codex", None), ("codex", Some("S1"))] {
            assert!(a.plan(Some(agent), session).prompt_on_stdin(), "{agent} {session:?}");
        }
        assert!(!a.plan(Some("aside"), None).prompt_on_stdin());
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"--ask={prompt}\"]\n"));
        assert!(!AgentProfiles::load(&p).unwrap().plan(Some("x"), None).prompt_on_stdin());
    }

    #[test]
    fn codex_and_aside_defaults() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        assert_eq!(a.plan(Some("codex"), Some("S1")).render(&vars("Q")),
            vec!["codex", "exec", "fork", "S1", "-c", "sandbox_mode=\"read-only\"", "--ephemeral", "--skip-git-repo-check", "--json", "-"]);
        assert_eq!(a.plan(Some("codex"), None).render(&vars("Q")),
            vec!["codex", "exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "--json", "-"]);
        assert_eq!(a.plan(Some("aside"), Some("S1")).render(&vars("Q")), vec!["aside", "session", "resume", "S1", "Q"]);
        assert_eq!(a.plan(Some("aside"), None).render(&vars("Q")), vec!["aside", "exec", "Q"]);
    }

    #[test]
    fn unknown_agent_falls_back_to_default_in_new_mode() {
        let (_d, p) = tmp(None);
        let plan = AgentProfiles::load(&p).unwrap().plan(Some("my-agent"), Some("S1"));
        assert_eq!((plan.agent.as_str(), plan.mode), ("claude-code", AskMode::New));
        assert_eq!(plan.render(&vars("Q")), vec!["claude", "-p", "--no-session-persistence", "--setting-sources=user", "--tools=Read,Grep,Glob", "--strict-mcp-config", "--allowedTools=mcp__rooms", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    }

    #[test]
    fn no_agent_uses_default_new() {
        let (_d, p) = tmp(None);
        let plan = AgentProfiles::load(&p).unwrap().plan(None, Some("S1"));
        assert_eq!((plan.agent.as_str(), plan.mode), ("claude-code", AskMode::New));
    }

    #[test]
    fn file_overrides_and_adds_profiles() {
        let (_d, p) = tmp(Some(r#"
default = "mine"
preamble = "hi"
[agents.mine]
new = ["my-cli", "--ask", "{prompt}", "{file}", "{cwd}"]
[agents.codex]
new = ["codex2", "{prompt}"]
"#));
        let a = AgentProfiles::load(&p).unwrap();
        assert_eq!(a.preamble(), "hi");
        assert_eq!(a.plan(None, None).render(&vars("Q")), vec!["my-cli", "--ask", "Q", "/f.html", "/c"]);
        // [agents.codex] replaces the built-in profile whole: no resume left → new
        let c = a.plan(Some("codex"), Some("S1"));
        assert_eq!(c.mode, AskMode::New);
        assert_eq!(c.render(&vars("Q")), vec!["codex2", "Q"]);
        // built-ins the file doesn't name are still there
        assert_eq!(a.plan(Some("aside"), None).render(&vars("Q")), vec!["aside", "exec", "Q"]);
    }

    #[test]
    fn substitution_is_single_pass() {
        let (_d, p) = tmp(None);
        let plan = AgentProfiles::load(&p).unwrap().plan(Some("aside"), None);
        let out = plan.render(&Vars { prompt: "say {session} and {cwd} and {other}", session: "S1", file: "/f", cwd: "/c", mcp_config: "", model: "", images: &[], image_dir: "", scope_settings: "" });
        assert_eq!(out, vec!["aside", "exec", "say {session} and {cwd} and {other}"]);
    }

    /// A room or day ask: the built-in claude template carries the read scope; a doc ask drops the flag.
    #[test]
    fn claude_new_takes_the_read_scope_as_settings() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        let settings = claude_read_scope([Path::new("/d/a.html"), Path::new("/d/x?y [1] *.html"), Path::new("/d/b\\c.html")]);
        assert_eq!(settings, r#"{"permissions":{"allow":["Read(//d/a.html)","Read(//d/x\\?y \\[1\\] \\*.html)","Read(//d/b\\\\c.html)"],"defaultMode":"dontAsk"}}"#);
        let v = Vars { scope_settings: &settings, ..vars("Q") };
        let out = a.plan(Some("claude-code"), None).render(&v);
        assert!(out.windows(2).any(|w| w == ["--settings", settings.as_str()]), "{out:?}");
        assert!(!a.plan(Some("claude-code"), None).render(&vars("Q")).contains(&"--settings".to_string()));
        assert_eq!(a.plan(Some("codex"), None).render(&v), a.plan(Some("codex"), None).render(&vars("Q")), "codex has no such flag");
    }

    #[test]
    fn mcp_config_is_substituted_into_claude_templates() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        let v = Vars { prompt: "Q", session: "S1", file: "/f", cwd: "/c", mcp_config: "/h/.rooms/mcp.json", model: "", images: &[], image_dir: "", scope_settings: "" };
        assert_eq!(a.plan(Some("claude-code"), None).render(&v),
            vec!["claude", "-p", "--no-session-persistence", "--setting-sources=user", "--tools=Read,Grep,Glob", "--strict-mcp-config", "--mcp-config", "/h/.rooms/mcp.json", "--allowedTools=mcp__rooms", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
        let resumed = a.plan(Some("claude-code"), Some("S1")).render(&v);
        assert!(resumed.windows(4).any(|w| w == ["--strict-mcp-config", "--mcp-config", "/h/.rooms/mcp.json", "--allowedTools=mcp__rooms"]));
        // without a config the pair is dropped but strict stays: the ask gets no MCP at all
        for (name, sess) in [("claude-code", None), ("claude-code", Some("S1"))] {
            let out = a.plan(Some(name), sess).render(&vars("Q"));
            assert!(out.contains(&"--strict-mcp-config".to_string()) && !out.contains(&"--mcp-config".to_string()), "{out:?}");
        }
    }

    #[test]
    fn empty_mcp_config_drops_the_element_and_the_one_before() {
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"--mcp-config\", \"{mcp_config}\", \"{prompt}\"]\n"));
        let a = AgentProfiles::load(&p).unwrap();
        assert_eq!(a.plan(Some("x"), None).render(&vars("Q")), vec!["x", "Q"]);
        // only an element that is exactly {mcp_config} is dropped
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"--c={mcp_config}\", \"{prompt}\"]\n"));
        assert_eq!(AgentProfiles::load(&p).unwrap().plan(Some("x"), None).render(&vars("Q")), vec!["x", "--c=", "Q"]);
    }

    #[test]
    fn images_repeat_with_their_flag_and_vanish_without_any() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        let imgs = ["/h/i/a.png".to_string(), "/h/i/b.jpg".to_string()];
        let v = Vars { images: &imgs, image_dir: "/h/i", ..vars("Q") };
        let codex = a.plan(Some("codex"), None).render(&v);
        assert!(codex.ends_with(&["-i".into(), "/h/i/a.png".into(), "-i".into(), "/h/i/b.jpg".into(), "--json".into(), "-".into()]), "{codex:?}");
        let claude = a.plan(Some("claude-code"), Some("S1")).render(&v);
        assert!(claude.windows(2).any(|w| w == ["--add-dir", "/h/i"]), "{claude:?}");
        for out in [a.plan(Some("codex"), Some("S1")).render(&vars("Q")), a.plan(Some("claude-code"), None).render(&vars("Q"))] {
            assert!(!out.iter().any(|x| x == "-i" || x == "--add-dir" || x.contains("{image")), "{out:?}");
        }
    }

    #[test]
    fn builtin_event_rules_and_custom_ones() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        assert!(!a.plan(Some("claude-code"), Some("S1")).events.is_empty());
        assert!(!a.plan(Some("codex"), None).events.is_empty());
        assert!(a.plan(Some("aside"), None).events.is_empty());
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"{prompt}\"]\n[[agents.x.events]]\nmatch = { \"/kind\" = \"say\" }\ndelta = \"/text\"\n"));
        let events = AgentProfiles::load(&p).unwrap().plan(Some("x"), None).events;
        assert_eq!((events.len(), events[0].delta.as_deref()), (1, Some("/text")));
    }

    #[test]
    fn invalid_configs_are_errors() {
        for (text, needle) in [
            ("default = [", "agents.toml"),
            ("[agents.x]\nresume = [\"a\"]", "new"),
            ("[agents.x]\nnew = []", "agents.x.new"),
            ("[agents.x]\nnew = [\"{prompt}\"]", "agents.x.new"),
            ("[agents.x]\nnew = [\"a\"]\nresume = []", "agents.x.resume"),
            ("default = \"nope\"", "nope"),
            ("[agents.x]\nnew = [\"a\"]\nmodels = [\"--evil\"]", "agents.x.models"),
            ("[agents.x]\nnew = [\"a\"]\nmodels = [\"\"]", "agents.x.models"),
            ("[agents.x]\nnew = [\"a\"]\nmodels = [\"a b\"]", "agents.x.models"),
            ("[agents.x]\nnew = [\"a\", \"--model={model}\"]\nmodels = [\"m\"]", "whole element"),
            ("[agents.x]\nnew = [\"a\"]\n[[agents.x.events]]\ndelta = \"text\"", "agents.x.events[0]"),
            ("[agents.x]\nnew = [\"a\"]\n[[agents.x.events]]\nmatch = { \"/t\" = \"x\" }", "agents.x.events[0]"),
            ("[agents.x]\nnew = [\"a\", \"-m\", \"{model}\"]\nresume = [\"a\", \"-m{model}\"]\nmodels = [\"m\"]", "whole element"),
        ] {
            let (_d, p) = tmp(Some(text));
            let e = AgentProfiles::load(&p).err().unwrap_or_else(|| panic!("accepted: {text}"));
            assert!(e.contains(needle), "{text} -> {e}");
        }
    }

    fn with_model<'a>(model: &'a str) -> Vars<'a> { Vars { model, ..vars("Q") } }

    #[test]
    fn models_parse_and_validate() {
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"-m\", \"{model}\", \"{prompt}\"]\nmodels = [\"a1\", \"openai/gpt-5.6-sol\", \"m:v_2.1\"]\n"));
        let a = AgentProfiles::load(&p).unwrap();
        assert_eq!(a.plan(Some("x"), None).models, vec!["a1", "openai/gpt-5.6-sol", "m:v_2.1"]);
        // optional: a profile without models offers none
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"{prompt}\"]\n"));
        assert!(AgentProfiles::load(&p).unwrap().plan(Some("x"), None).models.is_empty());
        assert!(valid_model(&"a".repeat(128)) && !valid_model(&"a".repeat(129)));
        assert!(!valid_model("-m") && !valid_model("/x") && !valid_model("a b"));
    }

    #[test]
    fn empty_model_drops_the_element_and_the_one_before() {
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"-m\", \"{model}\", \"{prompt}\"]\nmodels = [\"m1\"]\n"));
        let plan = AgentProfiles::load(&p).unwrap().plan(Some("x"), None);
        assert_eq!(plan.render(&vars("Q")), vec!["x", "Q"]);
        assert_eq!(plan.render(&with_model("m1")), vec!["x", "-m", "m1", "Q"]);
        // a prompt that mentions {model} is not substituted
        assert_eq!(plan.render(&Vars { prompt: "{model}", model: "m1", ..vars("") }), vec!["x", "-m", "m1", "{model}"]);
    }

    #[test]
    fn a_template_without_model_offers_no_models() {
        let (_d, p) = tmp(Some("[agents.x]\nresume = [\"x\", \"{session}\", \"{prompt}\"]\nnew = [\"x\", \"-m\", \"{model}\", \"{prompt}\"]\nmodels = [\"m1\"]\n"));
        let a = AgentProfiles::load(&p).unwrap();
        assert!(a.plan(Some("x"), Some("S1")).models.is_empty());
        assert_eq!(a.plan(Some("x"), None).models, vec!["m1"]);
        // without models, a partial {model} is allowed but offers nothing (it renders as "")
        let (_d, p) = tmp(Some("[agents.x]\nnew = [\"x\", \"--model={model}\", \"{prompt}\"]\n"));
        let plan = AgentProfiles::load(&p).unwrap().plan(Some("x"), None);
        assert!(plan.models.is_empty());
    }

    #[test]
    fn builtin_models_and_argv_with_a_model() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        let claude = a.plan(Some("claude-code"), Some("S1"));
        assert_eq!(claude.models, vec!["opus", "sonnet", "haiku"]);
        assert_eq!(claude.render(&with_model("sonnet"))[..6], ["claude", "-p", "--model", "sonnet", "--resume", "S1"]);
        assert_eq!(a.plan(Some("claude-code"), None).render(&with_model("haiku"))[..4], ["claude", "-p", "--model", "haiku"]);
        let codex = a.plan(Some("codex"), Some("S1"));
        assert_eq!(codex.models, vec!["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol"]);
        assert_eq!(codex.render(&with_model("gpt-6-sol")),
            vec!["codex", "exec", "fork", "S1", "-m", "gpt-6-sol", "-c", "sandbox_mode=\"read-only\"", "--ephemeral", "--skip-git-repo-check", "--json", "-"]);
        assert_eq!(a.plan(Some("codex"), None).render(&with_model("gpt-6-luna")),
            vec!["codex", "exec", "-m", "gpt-6-luna", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "--json", "-"]);
        let aside_new = a.plan(Some("aside"), None);
        assert_eq!(aside_new.models, vec!["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]);
        assert_eq!(aside_new.render(&with_model("claude-haiku-4-5")), vec!["aside", "exec", "-m", "claude-haiku-4-5", "Q"]);
        // aside resume takes no model flag
        assert!(a.plan(Some("aside"), Some("S1")).models.is_empty());
    }
}
