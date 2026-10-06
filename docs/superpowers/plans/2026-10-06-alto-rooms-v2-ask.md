# Alto Rooms v2 Ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a doc tab, ⌘J opens a round ask bar; a question is sent to the agent CLI that made the doc (resume/fork of its session, or a new run that reads the file) and the CLI's plain stdout comes back as the answer.

**Architecture:** A new `rooms_core::asks` module (facade `Asks`) owns the whole turn lifecycle: it picks an argv template from the user's `.rooms/agents.toml` (built-in defaults for claude-code / codex / aside), builds one prompt, spawns the CLI without a shell, keeps turns in `.rooms/asks/<fileKey>.jsonl`, and emits `ask.started` / `ask.done` on the existing event stream. roomsd adds three routes. The desktop app adds an `AsksStore`, an `AskBar` rendered by `DocView`, and a ⌘J toggle (page key + native menu).

**Tech Stack:** Rust (tokio process, toml, libc), axum, ts-rs; React 19 + Tailwind 4 + react-markdown; vitest; Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-alto-rooms-v2-ask-spec.html` (read §2, §5, §6 before any task).

## Global Constraints

- Rooms never parses agent output: stdout is plain text; only lossy UTF-8 → strip ANSI escapes → trim.
- No shell: argv[0] is the program, `{prompt}` `{session}` `{file}` `{cwd}` are substituted inside elements in ONE pass (a value that contains `{session}` must not be substituted again).
- Meta is untrusted (R0): `agent`/`session` used only if they match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`; `cwd` only if absolute and an existing directory.
- R2: resume only when session is valid AND the chosen profile name == `source.agent` AND the profile has `resume`; otherwise `new`.
- R4 prompt: prior = `done` turns only, last 6, then drop oldest while total question+answer chars > 24,000.
- R7: one running turn per fileKey; at most 4 running turns overall.
- R8: timeout 600 s; stdout cap 1 MiB (1,048,576 bytes); stderr keeps last 4 KiB; cancel = `killpg(SIGTERM)`, then SIGKILL after 3 s (300 ms for shutdown).
- Question: trimmed, 1–8,000 chars.
- Storage: `<home>/.rooms/asks/<fileKey>.jsonl`, dir mode 0700, append-only, last line per id wins. Never write into room folders or linked folders. Rooms never writes `agents.toml`.
- Events: exactly one `ask.started` then exactly one `ask.done` per accepted turn; the final record is appended before `ask.done` is emitted.
- ⌘J (Ctrl+J off macOS): bar starts open on every launch (without taking focus), not persisted, global across doc tabs; works from inside text fields; ignored on non-doc tabs and in read-only.
- UI copy is English (labels, buttons, menu items, status text and roomsd error messages), as in the spec. Thread colour (`bg-primary`) only on the send button.
- Commit as the repo's configured identity (`jun-hash`), message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A question containing `{session}` or `{prompt}` text must reach the CLI verbatim (single-pass substitution) — test in Task 2.
- A doc whose `rooms:session` is `--dangerously-bypass-approvals-and-sandbox` must run in `new` mode with no trace of that value in argv — test in Task 6.
- `ask.done` arriving before the `startAsk` 202 (spawn failure path) must not be overwritten back to `running` in the app — test in Task 9.
- A CLI that prints UTF-8 split across reads, ANSI colour codes, or nothing at all must give a clean (possibly empty) answer — tests in Task 5.
- roomsd restarted while a turn was running: that turn must read back as `failed` with "Rooms가 다시 시작돼서 중단됐어요", and a new question on that doc must not be `ask_busy` — test in Task 6.

---

## File Map

| File | Responsibility |
|---|---|
| `crates/rooms-protocol/src/lib.rs` | `AskStatus`, `AskMode`, `AskTurn`, `StartAsk`, `EventKind::{AskStarted, AskDone}` |
| `crates/rooms-protocol/tests/shape.rs` | wire shape tests + TS export |
| `packages/protocol-ts/src/index.ts`, `src/generated/*` | re-export generated types |
| `crates/rooms-core/Cargo.toml` | add `toml = "0.8"`, `libc = "0.2"` |
| `crates/rooms-core/src/asks/mod.rs` | facade `Asks`, `AskError`, `login_path()` |
| `crates/rooms-core/src/asks/agents.rs` | `AgentProfiles`, `Profile`, `Plan`, `Vars`, built-in defaults |
| `crates/rooms-core/src/asks/prompt.rs` | `build_prompt`, `valid_ident`, `valid_file_key` |
| `crates/rooms-core/src/asks/log.rs` | `AskLog` |
| `crates/rooms-core/src/asks/run.rs` | `spawn_agent`, `Limits`, `Killer`, `Outcome`, `clean_output` |
| `crates/rooms-core/src/core.rs` | `RoomsCore::emit_ask` |
| `crates/rooms-core/tests/asks.rs` + `tests/fixtures/fake-agent.sh` | facade integration tests |
| `crates/roomsd/src/{lib.rs,routes.rs,main.rs}`, `tests/api.rs` | routes, AppState.asks, SIGTERM shutdown |
| `packages/protocol-ts/src/client.ts` | `startAsk`, `askThread`, `cancelAsk` |
| `apps/desktop/src/data/roomsStore.ts` | `onSignal` also passes the event; ignore `ask.*` in `apply` |
| `apps/desktop/src/ask/asksStore.ts` (+ test) | `AsksStore`, `upsert`, `mergeTurns` |
| `apps/desktop/src/data/hooks.ts` | build/start AsksStore; `useAsksStore`, `useAsks` |
| `apps/desktop/src/ask/AskBar.tsx` (+ test) | bar + sheet UI |
| `apps/desktop/src/views/DocView.tsx` | render `<AskBar artifact={artifact} />` |
| `apps/desktop/src/shell/shortcuts.ts`, `AppShell.tsx`, `lib/appEvents.ts`, `src-tauri/src/lib.rs` | ⌘J `toggle-ask` |
| `apps/desktop/src/test/fakes.tsx` | fake `startAsk` / `askThread` / `cancelAsk` |
| `apps/desktop/e2e/ask.spec.ts` | golden path against real roomsd with a fake agent |

---

### Task 1: Protocol types

**Files:**
- Modify: `crates/rooms-protocol/src/lib.rs` (after `ApiError`, and inside `EventKind`)
- Modify: `crates/rooms-protocol/tests/shape.rs`
- Modify: `packages/protocol-ts/src/index.ts`
- Generated: `packages/protocol-ts/src/generated/{AskTurn,AskStatus,AskMode,StartAsk,RoomsEvent,EventKind}.ts`

**Interfaces:**
- Produces (Rust): `AskStatus { Running, Done, Failed, Cancelled }` (lowercase on the wire), `AskMode { Resume, New }`, `AskTurn { id, file_key, question, answer, agent, mode, status, error: Option<String>, started_at: String, ended_at: Option<String> }`, `StartAsk { room_id, artifact_id, question }`, `EventKind::AskStarted { turn: AskTurn }` (`"ask.started"`), `EventKind::AskDone { turn: AskTurn }` (`"ask.done"`).
- Produces (TS): same names, camelCase fields (`fileKey`, `startedAt`, `endedAt`, `roomId`, `artifactId`).

- [ ] **Step 1: Write the failing test** — append to `crates/rooms-protocol/tests/shape.rs`:

```rust
#[test]
fn ask_events_are_camel_and_tagged() {
    let turn = AskTurn {
        id: "a1".into(), file_key: "0123456789abcdef".into(), question: "q".into(), answer: "".into(),
        agent: "claude-code".into(), mode: AskMode::Resume, status: AskStatus::Running,
        error: None, started_at: "2026-10-06T10:00:00+09:00".into(), ended_at: None,
    };
    let v = serde_json::to_value(&RoomsEvent { seq: 3, kind: EventKind::AskStarted { turn: turn.clone() } }).unwrap();
    assert_eq!(v["type"], "ask.started");
    assert_eq!(v["turn"]["fileKey"], "0123456789abcdef");
    assert_eq!(v["turn"]["mode"], "resume");
    assert_eq!(v["turn"]["status"], "running");
    assert_eq!(v["turn"]["endedAt"], serde_json::Value::Null);
    let d = serde_json::to_value(&RoomsEvent { seq: 4, kind: EventKind::AskDone { turn } }).unwrap();
    assert_eq!(d["type"], "ask.done");
    let s: StartAsk = serde_json::from_str(r#"{"roomId":"r","artifactId":"a","question":"hi"}"#).unwrap();
    assert_eq!((s.room_id.as_str(), s.artifact_id.as_str(), s.question.as_str()), ("r", "a", "hi"));
}
```

Also add to `export_typescript_bindings`: `AskTurn::export_all().unwrap(); StartAsk::export_all().unwrap();`

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p rooms-protocol`
Expected: compile error, `AskTurn` not found.

- [ ] **Step 3: Implement** — in `crates/rooms-protocol/src/lib.rs`, after `ApiError`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum AskStatus { Running, Done, Failed, Cancelled }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../packages/protocol-ts/src/generated/")]
pub enum AskMode { Resume, New }

wire!(
/// One question and its answer, asked from a doc to the agent that made it (spec v2 ask).
pub struct AskTurn {
    pub id: String,
    pub file_key: String,
    pub question: String,
    /// The agent's stdout (ANSI stripped, trimmed); empty while running.
    pub answer: String,
    pub agent: String,
    pub mode: AskMode,
    pub status: AskStatus,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
});

wire!(pub struct StartAsk {
    pub room_id: RoomId,
    pub artifact_id: ArtifactId,
    pub question: String,
});
```

In `EventKind`, before `Resync`:

```rust
    #[serde(rename = "ask.started")] AskStarted { turn: AskTurn },
    /// Exactly once per started turn; `turn.answer` is the whole answer.
    #[serde(rename = "ask.done")] AskDone { turn: AskTurn },
```

- [ ] **Step 4: Run tests and regenerate TS**

Run: `cargo test -p rooms-protocol`
Expected: PASS; new files appear in `packages/protocol-ts/src/generated/` (`AskTurn.ts`, `AskStatus.ts`, `AskMode.ts`, `StartAsk.ts`) and `EventKind.ts` changes.

Add to `packages/protocol-ts/src/index.ts` (same style as the existing lines):

```ts
export * from "./generated/AskMode";
export * from "./generated/AskStatus";
export * from "./generated/AskTurn";
export * from "./generated/StartAsk";
```

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: errors ONLY in `src/data/roomsStore.ts` if its `apply` switch is exhaustive; if so, add before the closing brace of the `switch` in `apply`:

```ts
      case "ask.started":
      case "ask.done":
        return; // asks live in AsksStore (onSignal)
```

and re-run until clean.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-protocol packages/protocol-ts apps/desktop/src/data/roomsStore.ts
git commit -m "Add ask turn types and ask.started/ask.done events to the protocol"
```

---

### Task 2: Agent profiles (`agents.toml` + defaults + argv rendering)

**Files:**
- Modify: `crates/rooms-core/Cargo.toml` — `[dependencies]` add `toml = "0.8"` and `libc = "0.2"`
- Modify: `crates/rooms-core/src/lib.rs` — add `pub mod asks;`
- Create: `crates/rooms-core/src/asks/mod.rs` (for now only `mod agents; mod prompt; mod log; mod run;` lines that exist — start with `pub(crate) mod agents;`)
- Create: `crates/rooms-core/src/asks/agents.rs`

**Interfaces:**
- Consumes: `rooms_protocol::AskMode`
- Produces:
  - `pub(crate) const DEFAULT_PREAMBLE: &str`
  - `pub(crate) struct AgentProfiles` with `pub fn load(path: &Path) -> Result<Self, String>`, `pub fn plan(&self, agent: Option<&str>, session: Option<&str>) -> Plan`, `pub fn preamble(&self) -> &str`
  - `pub(crate) struct Plan { pub agent: String, pub mode: AskMode, template: Vec<String> }` with `pub fn render(&self, v: &Vars) -> Vec<String>`
  - `pub(crate) struct Vars<'a> { pub prompt: &'a str, pub session: &'a str, pub file: &'a str, pub cwd: &'a str }`
  - Note: `plan` is infallible (spec S3 showed `Result`; `load` already validates every profile and the default, so there is nothing left to fail). Callers pass `agent`/`session` already filtered by `valid_ident` (Task 3).

- [ ] **Step 1: Write the failing tests** — `crates/rooms-core/src/asks/agents.rs` bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(text: Option<&str>) -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("agents.toml");
        if let Some(t) = text { std::fs::write(&p, t).unwrap(); }
        (d, p)
    }
    fn vars<'a>(prompt: &'a str) -> Vars<'a> { Vars { prompt, session: "S1", file: "/f.html", cwd: "/c" } }

    #[test]
    fn missing_file_gives_builtin_defaults() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        let plan = a.plan(Some("claude-code"), Some("S1"));
        assert_eq!(plan.mode, AskMode::Resume);
        assert_eq!(plan.render(&vars("Q")), vec!["claude", "-p", "--resume", "S1", "--fork-session", "--no-session-persistence", "--tools=Read,Grep,Glob", "Q"]);
        assert_eq!(a.preamble(), DEFAULT_PREAMBLE);
    }

    #[test]
    fn codex_and_aside_defaults() {
        let (_d, p) = tmp(None);
        let a = AgentProfiles::load(&p).unwrap();
        assert_eq!(a.plan(Some("codex"), Some("S1")).render(&vars("Q")),
            vec!["codex", "exec", "fork", "S1", "-c", "sandbox_mode=\"read-only\"", "--ephemeral", "--skip-git-repo-check", "Q"]);
        assert_eq!(a.plan(Some("codex"), None).render(&vars("Q")),
            vec!["codex", "exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "Q"]);
        assert_eq!(a.plan(Some("aside"), Some("S1")).render(&vars("Q")), vec!["aside", "session", "resume", "S1", "Q"]);
        assert_eq!(a.plan(Some("aside"), None).render(&vars("Q")), vec!["aside", "exec", "Q"]);
    }

    #[test]
    fn unknown_agent_falls_back_to_default_in_new_mode() {
        let (_d, p) = tmp(None);
        let plan = AgentProfiles::load(&p).unwrap().plan(Some("my-agent"), Some("S1"));
        assert_eq!((plan.agent.as_str(), plan.mode), ("claude-code", AskMode::New));
        assert!(!plan.render(&vars("Q")).contains(&"S1".to_string()));
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
        let out = plan.render(&Vars { prompt: "say {session} and {cwd} and {other}", session: "S1", file: "/f", cwd: "/c" });
        assert_eq!(out, vec!["aside", "exec", "say {session} and {cwd} and {other}"]);
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
        ] {
            let (_d, p) = tmp(Some(text));
            let e = AgentProfiles::load(&p).err().unwrap_or_else(|| panic!("accepted: {text}"));
            assert!(e.contains(needle), "{text} -> {e}");
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p rooms-core asks::agents`
Expected: compile errors (types missing).

- [ ] **Step 3: Implement** `crates/rooms-core/src/asks/agents.rs` (top of file):

```rust
//! The only place Rooms knows about agent CLIs: argv templates from `<home>/.rooms/agents.toml`,
//! over built-in defaults. Rooms reads this file and never writes it.
use rooms_protocol::AskMode;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) const DEFAULT_AGENT: &str = "claude-code";
pub(crate) const DEFAULT_PREAMBLE: &str =
    "[Rooms] 사용자가 Rooms 앱에서 위 HTML 문서를 보며 묻습니다. 마크다운으로 짧게 답하세요. 파일을 만들거나 고치지 마세요.";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    pub resume: Option<Vec<String>>,
    pub new: Vec<String>,
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
    template: Vec<String>,
}

pub(crate) struct Vars<'a> {
    pub prompt: &'a str,
    pub session: &'a str,
    pub file: &'a str,
    pub cwd: &'a str,
}

fn argv(parts: &[&str]) -> Vec<String> { parts.iter().map(|s| s.to_string()).collect() }

fn builtin() -> BTreeMap<String, Profile> {
    BTreeMap::from([
        ("claude-code".to_string(), Profile {
            resume: Some(argv(&["claude", "-p", "--resume", "{session}", "--fork-session", "--no-session-persistence", "--tools=Read,Grep,Glob", "{prompt}"])),
            new: argv(&["claude", "-p", "--no-session-persistence", "--tools=Read,Grep,Glob", "{prompt}"]),
        }),
        ("codex".to_string(), Profile {
            resume: Some(argv(&["codex", "exec", "fork", "{session}", "-c", "sandbox_mode=\"read-only\"", "--ephemeral", "--skip-git-repo-check", "{prompt}"])),
            new: argv(&["codex", "exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "{prompt}"]),
        }),
        ("aside".to_string(), Profile {
            resume: Some(argv(&["aside", "session", "resume", "{session}", "{prompt}"])),
            new: argv(&["aside", "exec", "{prompt}"]),
        }),
    ])
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
        match (named, session, &p.resume) {
            (Some(_), Some(_), Some(t)) => Plan { agent: name, mode: AskMode::Resume, template: t.clone() },
            _ => Plan { agent: name, mode: AskMode::New, template: p.new.clone() },
        }
    }

    pub fn preamble(&self) -> &str { self.preamble.as_deref().unwrap_or(DEFAULT_PREAMBLE) }
}

const PLACEHOLDERS: [&str; 4] = ["{prompt}", "{session}", "{file}", "{cwd}"];

/// One left-to-right pass: substituted text is never scanned again.
fn subst(arg: &str, v: &Vars) -> String {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        match PLACEHOLDERS.iter().find(|p| tail.starts_with(**p)) {
            Some(p) => {
                out.push_str(match *p { "{prompt}" => v.prompt, "{session}" => v.session, "{file}" => v.file, _ => v.cwd });
                rest = &tail[p.len()..];
            }
            None => { out.push('{'); rest = &tail[1..]; }
        }
    }
    out.push_str(rest);
    out
}

impl Plan {
    pub fn render(&self, v: &Vars) -> Vec<String> { self.template.iter().map(|a| subst(a, v)).collect() }
}
```

`crates/rooms-core/src/asks/mod.rs` for now:

```rust
//! v2 ask: send a question about a doc to the agent CLI that made it (spec 2026-10-06 v2 ask).
pub(crate) mod agents;
```

`crates/rooms-core/src/lib.rs`: add `pub mod asks;` next to the other `pub mod` lines.

- [ ] **Step 4: Run tests**

Run: `cargo test -p rooms-core asks::agents`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core Cargo.lock
git commit -m "Add ask agent profiles: agents.toml over claude-code/codex/aside defaults"
```

---

### Task 3: Prompt building and meta validation

**Files:**
- Create: `crates/rooms-core/src/asks/prompt.rs`
- Modify: `crates/rooms-core/src/asks/mod.rs` — add `pub(crate) mod prompt;`

**Interfaces:**
- Consumes: `rooms_protocol::{AskTurn, AskMode, AskStatus}`
- Produces:
  - `pub(crate) fn build_prompt(preamble: &str, mode: AskMode, file: &str, prior: &[AskTurn], question: &str) -> String`
  - `pub(crate) fn valid_ident(s: &str) -> bool` — R0 for agent and session
  - `pub(crate) fn valid_file_key(s: &str) -> bool` — 1..=64 chars, ASCII alphanumeric only
  - `pub(crate) const MAX_PRIOR_TURNS: usize = 6; pub(crate) const MAX_PRIOR_CHARS: usize = 24_000;`

- [ ] **Step 1: Write the failing tests** (bottom of `prompt.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rooms_protocol::AskStatus;

    fn turn(q: &str, a: &str, status: AskStatus) -> AskTurn {
        AskTurn { id: q.into(), file_key: "k".into(), question: q.into(), answer: a.into(), agent: "x".into(),
            mode: AskMode::New, status, error: None, started_at: "t".into(), ended_at: None }
    }

    #[test]
    fn resume_without_prior() {
        assert_eq!(build_prompt("P", AskMode::Resume, "/d/a.html", &[], "왜?"), "P\n\n문서: /d/a.html\n\n질문: 왜?");
    }

    #[test]
    fn new_mode_asks_to_read_and_includes_done_prior_only() {
        let prior = [turn("q1", "a1", AskStatus::Done), turn("q2", "", AskStatus::Failed), turn("q3", "a3", AskStatus::Done)];
        assert_eq!(
            build_prompt("P", AskMode::New, "/d/a.html", &prior, "q4"),
            "P\n\n문서: /d/a.html\n먼저 이 파일을 읽으세요.\n\n이전 문답:\nQ: q1\nA: a1\nQ: q3\nA: a3\n\n질문: q4"
        );
    }

    #[test]
    fn keeps_last_six_then_trims_oldest_over_char_budget() {
        let many: Vec<_> = (0..8).map(|i| turn(&format!("q{i}"), "a", AskStatus::Done)).collect();
        let p = build_prompt("P", AskMode::Resume, "/f", &many, "z");
        assert!(!p.contains("Q: q1\n") && p.contains("Q: q2\n") && p.contains("Q: q7\n"));
        let big = "가".repeat(15_000);
        let heavy = [turn("old", &big, AskStatus::Done), turn("new", &big, AskStatus::Done)];
        let p = build_prompt("P", AskMode::Resume, "/f", &heavy, "z");
        assert!(!p.contains("Q: old") && p.contains("Q: new"));
        let huge = [turn("only", &"x".repeat(30_000), AskStatus::Done)];
        assert!(!build_prompt("P", AskMode::Resume, "/f", &huge, "z").contains("이전 문답"));
    }

    #[test]
    fn ident_rules() {
        for ok in ["claude-code", "7f3a1c2e-0000-4000-8000-000000000000", "ses_01HQ7B", "a.b:c", "A"] { assert!(valid_ident(ok), "{ok}"); }
        let long = "a".repeat(129);
        for bad in ["", "-x", "--dangerously-bypass-approvals-and-sandbox", "a b", "a/b", "a;b", "ㄱ", long.as_str()] { assert!(!valid_ident(bad), "{bad}"); }
    }

    #[test]
    fn file_key_rules() {
        assert!(valid_file_key("0123456789abcdef"));
        for bad in ["", "../x", "a.b", &"a".repeat(65)] { assert!(!valid_file_key(bad), "{bad}"); }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p rooms-core asks::prompt`
Expected: compile errors.

- [ ] **Step 3: Implement** (top of `prompt.rs`):

```rust
//! The only text Rooms writes into a question (spec §6.3), plus the R0 checks on doc meta.
use rooms_protocol::{AskMode, AskStatus, AskTurn};

pub(crate) const MAX_PRIOR_TURNS: usize = 6;
pub(crate) const MAX_PRIOR_CHARS: usize = 24_000;

/// R0: meta from a doc is untrusted. A leading '-' would read as a CLI flag.
pub(crate) fn valid_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    s.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// fileKey names a file under .rooms/asks/.
pub(crate) fn valid_file_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

fn pick_prior(prior: &[AskTurn]) -> Vec<&AskTurn> {
    let done: Vec<&AskTurn> = prior.iter().filter(|t| t.status == AskStatus::Done).collect();
    let mut picked: Vec<&AskTurn> = done[done.len().saturating_sub(MAX_PRIOR_TURNS)..].to_vec();
    let size = |ts: &[&AskTurn]| ts.iter().map(|t| t.question.chars().count() + t.answer.chars().count()).sum::<usize>();
    while !picked.is_empty() && size(&picked) > MAX_PRIOR_CHARS { picked.remove(0); }
    picked
}

pub(crate) fn build_prompt(preamble: &str, mode: AskMode, file: &str, prior: &[AskTurn], question: &str) -> String {
    let mut out = format!("{preamble}\n\n문서: {file}\n");
    if mode == AskMode::New { out.push_str("먼저 이 파일을 읽으세요.\n"); }
    let picked = pick_prior(prior);
    if !picked.is_empty() {
        out.push_str("\n이전 문답:\n");
        for t in picked { out.push_str(&format!("Q: {}\nA: {}\n", t.question, t.answer)); }
    }
    out.push_str(&format!("\n질문: {question}"));
    out
}
```

Add `pub(crate) mod prompt;` to `asks/mod.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p rooms-core asks::prompt`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core/src/asks
git commit -m "Build the ask prompt and validate doc meta before it reaches argv"
```

---

### Task 4: Ask log (jsonl per fileKey)

**Files:**
- Create: `crates/rooms-core/src/asks/log.rs`
- Modify: `crates/rooms-core/src/asks/mod.rs` — add `pub(crate) mod log;`

**Interfaces:**
- Consumes: `rooms_protocol::AskTurn`
- Produces: `pub(crate) struct AskLog { dir: PathBuf }` with `pub fn new(dir: PathBuf) -> Self`, `pub fn append(&self, turn: &AskTurn) -> std::io::Result<()>`, `pub fn read(&self, file_key: &str) -> std::io::Result<Vec<AskTurn>>` (callers validate `file_key` first).

- [ ] **Step 1: Write the failing tests** (bottom of `log.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rooms_protocol::{AskMode, AskStatus};
    use std::os::unix::fs::PermissionsExt;

    fn t(id: &str, status: AskStatus, answer: &str) -> AskTurn {
        AskTurn { id: id.into(), file_key: "k1".into(), question: "q".into(), answer: answer.into(), agent: "a".into(),
            mode: AskMode::New, status, error: None, started_at: "s".into(), ended_at: None }
    }

    #[test]
    fn missing_file_is_empty() {
        let d = tempfile::tempdir().unwrap();
        assert!(AskLog::new(d.path().join("asks")).read("k1").unwrap().is_empty());
    }

    #[test]
    fn last_line_per_id_wins_in_start_order_and_bad_lines_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let log = AskLog::new(d.path().join("asks"));
        log.append(&t("a", AskStatus::Running, "")).unwrap();
        log.append(&t("b", AskStatus::Running, "")).unwrap();
        log.append(&t("a", AskStatus::Done, "A")).unwrap();
        std::fs::OpenOptions::new().append(true).open(d.path().join("asks/k1.jsonl")).unwrap()
            .write_all(b"{not json\n").unwrap();
        let got = log.read("k1").unwrap();
        assert_eq!(got.iter().map(|x| (x.id.as_str(), x.status)).collect::<Vec<_>>(),
            vec![("a", AskStatus::Done), ("b", AskStatus::Running)]);
        assert_eq!(got[0].answer, "A");
        let mode = std::fs::metadata(d.path().join("asks")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p rooms-core asks::log`
Expected: compile errors.

- [ ] **Step 3: Implement** (top of `log.rs`):

```rust
//! `.rooms/asks/<fileKey>.jsonl`: one line when a turn starts, one when it ends; last line per id wins.
use rooms_protocol::AskTurn;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

pub(crate) struct AskLog { dir: PathBuf }

impl AskLog {
    pub fn new(dir: PathBuf) -> Self { Self { dir } }

    fn path(&self, file_key: &str) -> PathBuf { self.dir.join(format!("{file_key}.jsonl")) }

    pub fn append(&self, turn: &AskTurn) -> std::io::Result<()> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir)?;
        let mut line = serde_json::to_vec(turn).map_err(std::io::Error::other)?;
        line.push(b'\n');
        let mut f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(self.path(&turn.file_key))?;
        f.write_all(&line) // one write per line (O_APPEND)
    }

    pub fn read(&self, file_key: &str) -> std::io::Result<Vec<AskTurn>> {
        let text = match std::fs::read_to_string(self.path(file_key)) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out: Vec<AskTurn> = Vec::new();
        for line in text.lines() {
            let Ok(t) = serde_json::from_str::<AskTurn>(line) else { continue };
            match out.iter_mut().find(|x| x.id == t.id) {
                Some(slot) => *slot = t,
                None => out.push(t),
            }
        }
        Ok(out)
    }
}
```

Add `pub(crate) mod log;` to `asks/mod.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p rooms-core asks::log`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core/src/asks
git commit -m "Keep ask turns in an append-only jsonl per file key"
```

---

### Task 5: Spawning the agent (no shell, limits, kill, clean output)

**Files:**
- Create: `crates/rooms-core/src/asks/run.rs`
- Modify: `crates/rooms-core/src/asks/mod.rs` — add `pub(crate) mod run; pub use run::Limits;`

**Interfaces:**
- Produces:
  - `pub struct Limits { pub timeout: Duration, pub max_stdout: usize, pub stderr_tail: usize, pub kill_grace: Duration }` + `impl Default` (600 s, 1_048_576, 4_096, 3 s)
  - `pub(crate) enum Reason { Cancelled, Timeout, TooLong, Shutdown }`
  - `pub(crate) enum Outcome { Exited { code: i32, stdout: String, stderr_tail: String }, Killed { reason: Reason, stdout: String } }`
  - `#[derive(Clone)] pub(crate) struct Killer` with `pub fn kill(&self, r: Reason)`
  - `pub(crate) struct Running { pub killer: Killer, pub done: tokio::task::JoinHandle<Outcome> }`
  - `pub(crate) struct SpawnSpec { pub argv: Vec<String>, pub cwd: PathBuf, pub path_env: Option<String>, pub limits: Limits }`
  - `pub(crate) fn spawn_agent(spec: SpawnSpec) -> std::io::Result<Running>` (Err = could not start; must be called inside a tokio runtime)
  - `pub(crate) fn clean_output(bytes: &[u8]) -> String` — lossy UTF-8, strip ANSI, trim

- [ ] **Step 1: Write the failing tests** (bottom of `run.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn spec(script: &str, limits: Limits) -> SpawnSpec {
        SpawnSpec { argv: vec!["/bin/sh".into(), "-c".into(), script.into()], cwd: std::env::temp_dir(), path_env: None, limits }
    }

    #[test]
    fn clean_output_strips_ansi_and_trims() {
        assert_eq!(clean_output(b"\x1b[2mdim\x1b[0m pong\x1b[0m\n"), "dim pong");
        assert_eq!(clean_output("한글".as_bytes()), "한글");
        assert_eq!(clean_output(b"\xff ok"), "\u{FFFD} ok");
        assert_eq!(clean_output(b""), "");
    }

    #[tokio::test]
    async fn exit_code_stdout_and_stderr_tail() {
        let r = spawn_agent(spec("printf '한'; printf '글\\n'; echo oops >&2; exit 3", Limits::default())).unwrap();
        match r.done.await.unwrap() {
            Outcome::Exited { code, stdout, stderr_tail } => {
                assert_eq!(code, 3);
                assert_eq!(clean_output(stdout.as_bytes()), "한글");
                assert_eq!(stderr_tail.trim(), "oops");
            }
            _ => panic!("expected exit"),
        }
    }

    #[tokio::test]
    async fn argv_is_not_a_shell() {
        let s = SpawnSpec { argv: vec!["/bin/echo".into(), "a; echo HACKED".into()], cwd: std::env::temp_dir(), path_env: None, limits: Limits::default() };
        match spawn_agent(s).unwrap().done.await.unwrap() {
            Outcome::Exited { stdout, .. } => assert_eq!(stdout.trim(), "a; echo HACKED"),
            _ => panic!(),
        }
    }

    #[tokio::test]
    async fn cancel_kills_the_whole_group_and_keeps_partial_stdout() {
        let r = spawn_agent(spec("echo part; sleep 30 & sleep 30", Limits::default())).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        r.killer.kill(Reason::Cancelled);
        let out = tokio::time::timeout(Duration::from_secs(5), r.done).await.expect("killed in time").unwrap();
        match out { Outcome::Killed { reason: Reason::Cancelled, stdout } => assert_eq!(stdout.trim(), "part"), _ => panic!() }
    }

    #[tokio::test]
    async fn timeout_and_too_long() {
        let quick = Limits { timeout: Duration::from_millis(300), ..Limits::default() };
        assert!(matches!(spawn_agent(spec("sleep 30", quick)).unwrap().done.await.unwrap(), Outcome::Killed { reason: Reason::Timeout, .. }));
        let small = Limits { max_stdout: 10, ..Limits::default() };
        match spawn_agent(spec("yes", small)).unwrap().done.await.unwrap() {
            Outcome::Killed { reason: Reason::TooLong, stdout } => assert!(stdout.len() <= 10),
            _ => panic!(),
        }
    }

    #[tokio::test]
    async fn missing_program_is_a_spawn_error() {
        let s = SpawnSpec { argv: vec!["definitely-not-a-cli-xyz".into()], cwd: std::env::temp_dir(), path_env: Some("/nonexistent".into()), limits: Limits::default() };
        assert_eq!(spawn_agent(s).err().unwrap().kind(), std::io::ErrorKind::NotFound);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p rooms-core asks::run`
Expected: compile errors.

- [ ] **Step 3: Implement** (top of `run.rs`):

```rust
//! Runs one agent CLI: no shell, its own process group, stdin /dev/null, with limits (spec R8, S6).
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy)]
pub struct Limits { pub timeout: Duration, pub max_stdout: usize, pub stderr_tail: usize, pub kill_grace: Duration }

impl Default for Limits {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(600), max_stdout: 1_048_576, stderr_tail: 4_096, kill_grace: Duration::from_secs(3) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason { Cancelled, Timeout, TooLong, Shutdown }

#[derive(Debug)]
pub(crate) enum Outcome {
    Exited { code: i32, stdout: String, stderr_tail: String },
    Killed { reason: Reason, stdout: String },
}

#[derive(Clone)]
pub(crate) struct Killer(mpsc::UnboundedSender<Reason>);
impl Killer { pub fn kill(&self, r: Reason) { let _ = self.0.send(r); } }

pub(crate) struct Running { pub killer: Killer, pub done: tokio::task::JoinHandle<Outcome> }

pub(crate) struct SpawnSpec { pub argv: Vec<String>, pub cwd: PathBuf, pub path_env: Option<String>, pub limits: Limits }

/// Lossy UTF-8, ANSI escapes (CSI `ESC [ … final` and two-char `ESC x`) removed, trimmed.
pub(crate) fn clean_output(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' { out.push(c); continue; }
        match it.next() {
            Some('[') => { for d in it.by_ref() { if ('\x40'..='\x7e').contains(&d) { break; } } }
            _ => {}
        }
    }
    out.trim().to_string()
}

fn signal_group(pid: i32, sig: i32) {
    // SAFETY: killpg(2) on the process group we created for this child (process_group(0)).
    unsafe { libc::killpg(pid, sig); }
}

pub(crate) fn spawn_agent(spec: SpawnSpec) -> std::io::Result<Running> {
    let mut cmd = tokio::process::Command::new(&spec.argv[0]);
    cmd.args(&spec.argv[1..]).current_dir(&spec.cwd)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .process_group(0).kill_on_drop(true);
    if let Some(p) = &spec.path_env { cmd.env("PATH", p); }
    let mut child = cmd.spawn()?;
    let pid = child.id().map(|p| p as i32);
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let (tx, mut rx) = mpsc::unbounded_channel::<Reason>();
    let limits = spec.limits;
    let done = tokio::spawn(async move {
        let tail_max = limits.stderr_tail;
        let err_task = tokio::spawn(async move {
            let (mut tail, mut buf) = (Vec::new(), [0u8; 4096]);
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 { break; }
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > tail_max * 2 { tail.drain(..tail.len() - tail_max); }
            }
            let start = tail.len().saturating_sub(tail_max);
            String::from_utf8_lossy(&tail[start..]).into_owned()
        });
        let (mut out, mut buf) = (Vec::new(), [0u8; 8192]);
        let deadline = tokio::time::sleep(limits.timeout);
        tokio::pin!(deadline);
        let reason = loop {
            tokio::select! {
                n = stdout.read(&mut buf) => match n {
                    Ok(0) | Err(_) => break None,
                    Ok(n) => {
                        out.extend_from_slice(&buf[..n]);
                        if out.len() > limits.max_stdout { out.truncate(limits.max_stdout); break Some(Reason::TooLong); }
                    }
                },
                _ = &mut deadline => break Some(Reason::Timeout),
                Some(r) = rx.recv() => break Some(r),
            }
        };
        let stdout_text = String::from_utf8_lossy(&out).into_owned();
        match reason {
            None => {
                let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
                let stderr_tail = err_task.await.unwrap_or_default();
                Outcome::Exited { code, stdout: stdout_text, stderr_tail }
            }
            Some(reason) => {
                if let Some(pid) = pid {
                    signal_group(pid, libc::SIGTERM);
                    let grace = if reason == Reason::Shutdown { Duration::from_millis(300) } else { limits.kill_grace };
                    if tokio::time::timeout(grace, child.wait()).await.is_err() { signal_group(pid, libc::SIGKILL); }
                }
                let _ = child.wait().await;
                err_task.abort();
                Outcome::Killed { reason, stdout: stdout_text }
            }
        }
    });
    Ok(Running { killer: Killer(tx), done })
}
```

Note: when the child's own PATH lookup must use `path_env`, `Command::new` resolves argv[0] with the PATH given via `cmd.env("PATH", …)` on Unix (tokio delegates to std, which honours the child env PATH). The `missing_program_is_a_spawn_error` test pins this.

Add to `asks/mod.rs`: `pub(crate) mod run;` and `pub use run::Limits;`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p rooms-core asks::run`
Expected: 6 passed. If `missing_program_is_a_spawn_error` fails because std resolved via the parent PATH, keep the test and resolve argv[0] yourself: when it contains no `/`, search each dir of `spec.path_env.as_deref().or(std::env::var("PATH").ok().as_deref())` for an executable file and use that absolute path; if none, return `Err(io::Error::from(io::ErrorKind::NotFound))`.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "Run ask agents without a shell, in their own process group, with limits"
```

---

### Task 6: `Asks` facade + `RoomsCore::emit_ask`

**Files:**
- Modify: `crates/rooms-core/src/core.rs` — add `emit_ask` after `current_seq` (l.~221)
- Modify: `crates/rooms-core/src/asks/mod.rs`
- Create: `crates/rooms-core/tests/fixtures/fake-agent.sh` (chmod 755)
- Create: `crates/rooms-core/tests/asks.rs`

**Interfaces:**
- Consumes: Tasks 2–5; `RoomsCore::{list_artifacts, resolve_file, home, subscribe}`.
- Produces:
  - `RoomsCore::emit_ask(&self, kind: EventKind)`
  - `#[derive(Clone)] pub struct Asks`
  - `Asks::new(core: RoomsCore, login_path: Option<String>) -> Asks`
  - `Asks::with_limits(core: RoomsCore, login_path: Option<String>, limits: Limits) -> Asks`
  - `Asks::start(&self, room: &str, artifact_id: &str, question: &str) -> Result<AskTurn, AskError>` (must run inside a tokio runtime)
  - `Asks::thread(&self, file_key: &str) -> Result<Vec<AskTurn>, AskError>`
  - `Asks::cancel(&self, ask_id: &str)`
  - `Asks::shutdown(&self) -> impl Future<Output = ()>` (async; waits ≤ 700 ms)
  - `pub enum AskError { BadRequest(String), NotFound, Busy, Capacity, AgentConfig(String), Io(String) }` + `impl Display`
  - `pub async fn login_path() -> Option<String>`
  - `pub const MAX_RUNNING: usize = 4;`
  - Note vs spec S2/S7: no `ReadOnly` variant and no `RoomsCore::read_only`/`artifact` — roomsd's write guard already 403s writes in read-only mode, and the artifact is found via `list_artifacts`. `shutdown` is async.

- [ ] **Step 1: Write the fixture and failing tests**

`crates/rooms-core/tests/fixtures/fake-agent.sh`:

```sh
#!/bin/sh
# Fake agent for ask tests. Behaviour comes from the question text (last argv element).
last=""; for a in "$@"; do last="$a"; done
case "$last" in
  *SLEEP*) echo "partial"; sleep 30 ;;
  *FAIL*) echo "bad thing happened" >&2; exit 7 ;;
  *) printf 'ARGV:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\nCWD: %s\n' "$(pwd)" ;;
esac
```

`crates/rooms-core/tests/asks.rs`:

```rust
use rooms_core::asks::{AskError, Asks, Limits};
use rooms_core::RoomsCore;
use rooms_protocol::{AskMode, AskStatus, AskTurn, EventKind};
use std::time::Duration;

const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-agent.sh");

/// A home with one owned room "r" holding `doc.html` with the given <head> meta, and an agents.toml
/// whose `default` and `claude-code` profiles both point at the fake agent.
fn setup(meta: &str) -> (tempfile::TempDir, RoomsCore, String, String) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let room = core.create_room("r").unwrap();
    let html = format!("<html><head><title>Doc</title>{meta}</head><body>x</body></html>");
    std::fs::write(std::path::Path::new(&room.path).join("doc.html"), html).unwrap();
    core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), format!(
        "[agents.claude-code]\nresume = [\"{FAKE}\", \"resume\", \"{{session}}\", \"{{prompt}}\"]\nnew = [\"{FAKE}\", \"new\", \"{{prompt}}\"]\n"
    )).unwrap();
    let a = core.list_artifacts(&room.id).unwrap().remove(0);
    (d, core, room.id, a.id)
}

async fn wait_done(rx: &mut tokio::sync::broadcast::Receiver<rooms_protocol::RoomsEvent>, id: &str) -> AskTurn {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("ask.done in time").unwrap();
        if let EventKind::AskDone { turn } = ev.kind { if turn.id == id { return turn; } }
    }
}

#[tokio::test]
async fn resume_turn_runs_template_and_records() {
    let (d, core, room, art) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "  왜?  ").unwrap();
    assert_eq!((t.status, t.mode, t.question.as_str(), t.agent.as_str()), (AskStatus::Running, AskMode::Resume, "왜?", "claude-code"));
    let started = rx.recv().await.unwrap();
    assert!(matches!(started.kind, EventKind::AskStarted { ref turn } if turn.id == t.id));
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!(done.status, AskStatus::Done);
    assert!(done.answer.starts_with("ARGV: [resume] [S-1] ["), "{}", done.answer);
    assert!(done.answer.contains("질문: 왜?"));
    assert!(done.ended_at.is_some());
    // thread reads it back from disk
    let th = asks.thread(&t.file_key).unwrap();
    assert_eq!(th.len(), 1);
    assert_eq!(th[0].status, AskStatus::Done);
    assert!(d.path().join(format!(".rooms/asks/{}.jsonl", t.file_key)).exists());
}

#[tokio::test]
async fn second_question_carries_the_first_and_still_resumes() {
    let (_d, core, room, art) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="S-1">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t1 = asks.start(&room, &art, "first").unwrap();
    wait_done(&mut rx, &t1.id).await;
    let t2 = asks.start(&room, &art, "second").unwrap();
    let d2 = wait_done(&mut rx, &t2.id).await;
    assert!(d2.answer.contains("[resume] [S-1]"));
    assert!(d2.answer.contains("이전 문답:\nQ: first\nA: ARGV:"));
}

#[tokio::test]
async fn no_session_or_flag_shaped_session_runs_new_mode() {
    let (_d, core, room, art) = setup(r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="--dangerously-bypass-approvals-and-sandbox">"#);
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    assert_eq!(t.mode, AskMode::New);
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.starts_with("ARGV: [new] ["));
    assert!(done.answer.contains("먼저 이 파일을 읽으세요"));
    assert!(!done.answer.contains("dangerously"));
}

#[tokio::test]
async fn cwd_meta_used_only_when_it_is_a_real_dir() {
    let other = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(other.path()).unwrap();
    let (_d, core, room, art) = setup(&format!(r#"<meta name="rooms:cwd" content="{}">"#, real.display()));
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert!(done.answer.contains(&format!("CWD: {}", real.display())), "{}", done.answer);
}

#[tokio::test]
async fn failure_busy_cancel_and_validation() {
    let (_d, core, room, art) = setup("");
    let asks = Asks::new(core.clone(), None);
    let mut rx = core.subscribe();
    // validation
    assert!(matches!(asks.start(&room, &art, "   "), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.start(&room, &art, &"x".repeat(8001)), Err(AskError::BadRequest(_))));
    assert!(matches!(asks.start(&room, "nope", "q"), Err(AskError::NotFound)));
    assert!(matches!(asks.thread("../etc"), Err(AskError::BadRequest(_))));
    // non-zero exit
    let f = asks.start(&room, &art, "FAIL").unwrap();
    let fd = wait_done(&mut rx, &f.id).await;
    assert_eq!(fd.status, AskStatus::Failed);
    assert!(fd.error.as_deref().unwrap().contains("code 7"));
    assert!(fd.error.as_deref().unwrap().contains("bad thing happened"));
    // busy, then cancel keeps partial
    let s = asks.start(&room, &art, "SLEEP").unwrap();
    assert!(matches!(asks.start(&room, &art, "again"), Err(AskError::Busy)));
    tokio::time::sleep(Duration::from_millis(300)).await;
    asks.cancel(&s.id);
    asks.cancel(&s.id); // idempotent
    let sd = wait_done(&mut rx, &s.id).await;
    assert_eq!(sd.status, AskStatus::Cancelled);
    assert_eq!(sd.answer, "partial");
    asks.cancel("unknown-id");
}

#[tokio::test]
async fn bad_config_and_missing_program() {
    let (d, core, room, art) = setup("");
    let asks = Asks::new(core.clone(), None);
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = []\n").unwrap();
    match asks.start(&room, &art, "q") { Err(AskError::AgentConfig(m)) => assert!(m.contains("agents.claude-code.new")), other => panic!("{other:?}") }
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = [\"no-such-cli-xyz\", \"{prompt}\"]\n").unwrap();
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "q").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!(done.status, AskStatus::Failed);
    assert!(done.error.as_deref().unwrap().contains("명령을 찾을 수 없어요: no-such-cli-xyz"));
}

#[tokio::test]
async fn timeout_is_failed() {
    let (_d, core, room, art) = setup("");
    let asks = Asks::with_limits(core.clone(), None, Limits { timeout: Duration::from_millis(300), ..Limits::default() });
    let mut rx = core.subscribe();
    let t = asks.start(&room, &art, "SLEEP").unwrap();
    let done = wait_done(&mut rx, &t.id).await;
    assert_eq!((done.status, done.error.as_deref()), (AskStatus::Failed, Some("시간이 너무 오래 걸려 멈췄어요")));
}

#[tokio::test]
async fn restart_turns_running_into_failed_and_unblocks() {
    let (_d, core, room, art) = setup("");
    let asks = Asks::new(core.clone(), None);
    let t = asks.start(&room, &art, "SLEEP").unwrap();
    // A new Asks over the same home = roomsd restarted while t was running.
    let fresh = Asks::new(core.clone(), None);
    let th = fresh.thread(&t.file_key).unwrap();
    assert_eq!((th[0].status, th[0].error.as_deref()), (AskStatus::Failed, Some("Rooms가 다시 시작돼서 중단됐어요")));
    assert!(fresh.start(&room, &art, "after restart").is_ok());
    asks.shutdown().await;
    fresh.shutdown().await;
}

#[tokio::test]
async fn capacity_is_four() {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let room = core.create_room("r").unwrap();
    for i in 0..5 { std::fs::write(std::path::Path::new(&room.path).join(format!("d{i}.html")), format!("<title>d{i}</title>")).unwrap(); }
    core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), format!("[agents.claude-code]\nnew = [\"{FAKE}\", \"{{prompt}}\"]\n")).unwrap();
    let asks = Asks::new(core.clone(), None);
    let arts = core.list_artifacts(&room.id).unwrap();
    for a in &arts[..4] { asks.start(&room.id, &a.id, "SLEEP").unwrap(); }
    assert!(matches!(asks.start(&room.id, &arts[4].id, "SLEEP"), Err(AskError::Capacity)));
    asks.shutdown().await;
}
```

Note: if `create_room` returns a `Room` whose `path` isn't the absolute folder, use `core.room_root(&room.id).unwrap().0` instead (check `core_flows.rs` for how other tests write files into a room).

- [ ] **Step 2: Run to verify it fails**

Run: `chmod 755 crates/rooms-core/tests/fixtures/fake-agent.sh && cargo test -p rooms-core --test asks`
Expected: compile errors (`Asks` missing).

- [ ] **Step 3: Implement**

`crates/rooms-core/src/core.rs`, after `current_seq`:

```rust
    /// `ask.started` / `ask.done` from `asks::Asks`: same seq and broadcast as every other event.
    pub fn emit_ask(&self, kind: EventKind) {
        debug_assert!(matches!(kind, EventKind::AskStarted { .. } | EventKind::AskDone { .. }));
        let mut inner = self.inner.lock().unwrap();
        self.emit(&mut inner, kind);
    }
```

(Lock order: `Asks.running` → `RoomsCore.inner`. Nothing in core calls into `Asks`, so there is no cycle.)

`crates/rooms-core/src/asks/mod.rs` (full file):

```rust
//! v2 ask: send a question about a doc to the agent CLI that made it (spec 2026-10-06 v2 ask).
//! `Asks` is the only entry point; templates, prompt, log and process stay inside this module.
pub(crate) mod agents;
pub(crate) mod log;
pub(crate) mod prompt;
pub(crate) mod run;

pub use run::Limits;

use crate::RoomsCore;
use agents::{AgentProfiles, Vars};
use log::AskLog;
use prompt::{build_prompt, valid_file_key, valid_ident};
use rooms_protocol::{AskStatus, AskTurn, EventKind};
use run::{spawn_agent, Killer, Outcome, Reason, Running, SpawnSpec};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MAX_RUNNING: usize = 4;
const MAX_QUESTION_CHARS: usize = 8_000;
const RESTARTED: &str = "Rooms가 다시 시작돼서 중단됐어요";

#[derive(Debug)]
pub enum AskError { BadRequest(String), NotFound, Busy, Capacity, AgentConfig(String), Io(String) }

impl std::fmt::Display for AskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AskError::BadRequest(m) => write!(f, "{m}"),
            AskError::NotFound => write!(f, "이 문서를 찾을 수 없어요"),
            AskError::Busy => write!(f, "답을 기다리는 중이에요"),
            AskError::Capacity => write!(f, "다른 질문이 끝나면 다시 보내 주세요"),
            AskError::AgentConfig(m) => write!(f, "에이전트 설정을 읽지 못했어요: {m}"),
            AskError::Io(m) => write!(f, "기록을 저장하지 못했어요: {m}"),
        }
    }
}

struct Entry { file_key: String, killer: Killer }

struct Inner { core: RoomsCore, log: AskLog, login_path: Option<String>, limits: Limits, running: Mutex<HashMap<String, Entry>> }

#[derive(Clone)]
pub struct Asks(Arc<Inner>);

fn now() -> String { chrono::Local::now().to_rfc3339() }

/// PATH from the user's login shell (R12): a GUI-launched roomsd doesn't have it. ≤ 2 s.
pub async fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.args(["-l", "-c", "printf %s \"$PATH\""]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(2), cmd.output()).await.ok()?.ok()?;
    let path = String::from_utf8(out.stdout).ok()?;
    (out.status.success() && !path.trim().is_empty()).then(|| path.trim().to_string())
}

impl Asks {
    pub fn new(core: RoomsCore, login_path: Option<String>) -> Self { Self::with_limits(core, login_path, Limits::default()) }

    pub fn with_limits(core: RoomsCore, login_path: Option<String>, limits: Limits) -> Self {
        let log = AskLog::new(core.home().join(".rooms/asks"));
        Self(Arc::new(Inner { core, log, login_path, limits, running: Mutex::new(HashMap::new()) }))
    }

    fn config_path(&self) -> PathBuf { self.0.core.home().join(".rooms/agents.toml") }

    pub fn start(&self, room: &str, artifact_id: &str, question: &str) -> Result<AskTurn, AskError> {
        let q = question.trim();
        if q.is_empty() || q.chars().count() > MAX_QUESTION_CHARS {
            return Err(AskError::BadRequest(format!("질문은 1–{MAX_QUESTION_CHARS}자여야 해요")));
        }
        let core = &self.0.core;
        let artifact = core.list_artifacts(&room.to_string()).map_err(|_| AskError::NotFound)?
            .into_iter().find(|a| a.id == artifact_id).ok_or(AskError::NotFound)?;
        if !valid_file_key(&artifact.file_key) { return Err(AskError::BadRequest("bad file key".into())); }
        let file_abs = core.resolve_file(&room.to_string(), &artifact.rel_path).map_err(|_| AskError::NotFound)?;
        let profiles = AgentProfiles::load(&self.config_path()).map_err(AskError::AgentConfig)?;
        let src = &artifact.source;
        let agent = src.agent.as_deref().filter(|a| valid_ident(a));
        let session = src.session.as_deref().filter(|s| valid_ident(s));
        let plan = profiles.plan(agent, session);
        let cwd = src.cwd.as_deref().map(PathBuf::from).filter(|p| p.is_absolute() && p.is_dir())
            .unwrap_or_else(|| file_abs.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| core.home().to_path_buf()));
        let (file_s, cwd_s) = (file_abs.to_string_lossy().into_owned(), cwd.to_string_lossy().into_owned());

        let mut running = self.0.running.lock().unwrap();
        if running.values().any(|e| e.file_key == artifact.file_key) { return Err(AskError::Busy); }
        if running.len() >= MAX_RUNNING { return Err(AskError::Capacity); }
        let prior = self.read_thread(&running, &artifact.file_key)?;
        let prompt = build_prompt(profiles.preamble(), plan.mode, &file_s, &prior, q);
        let argv = plan.render(&Vars { prompt: &prompt, session: session.unwrap_or(""), file: &file_s, cwd: &cwd_s });
        let turn = AskTurn {
            id: nanoid::nanoid!(16), file_key: artifact.file_key.clone(), question: q.to_string(), answer: String::new(),
            agent: plan.agent.clone(), mode: plan.mode, status: AskStatus::Running, error: None, started_at: now(), ended_at: None,
        };
        self.0.log.append(&turn).map_err(|e| AskError::Io(e.to_string()))?;
        core.emit_ask(EventKind::AskStarted { turn: turn.clone() });
        let spawned = spawn_agent(SpawnSpec { argv: argv.clone(), cwd, path_env: self.0.login_path.clone(), limits: self.0.limits });
        match spawned {
            Err(e) => {
                drop(running);
                let msg = if e.kind() == std::io::ErrorKind::NotFound {
                    format!("명령을 찾을 수 없어요: {} — 설정: {}", argv[0], self.config_path().display())
                } else {
                    format!("명령을 실행하지 못했어요: {} ({e})", argv[0])
                };
                self.finish(turn.clone(), AskStatus::Failed, String::new(), Some(msg));
            }
            Ok(Running { killer, done }) => {
                running.insert(turn.id.clone(), Entry { file_key: turn.file_key.clone(), killer });
                drop(running);
                let me = self.clone();
                let t = turn.clone();
                tokio::spawn(async move {
                    let (status, answer, error) = match done.await {
                        Ok(Outcome::Exited { code: 0, stdout, .. }) => (AskStatus::Done, run::clean_output(stdout.as_bytes()), None),
                        Ok(Outcome::Exited { code, stdout, stderr_tail }) => {
                            let last = run::clean_output(stderr_tail.as_bytes()).lines().rev().find(|l| !l.trim().is_empty()).map(str::to_string);
                            let mut m = format!("{}가 오류로 끝났어요 (code {code})", t.agent);
                            if let Some(l) = last { m.push('\n'); m.push_str(&l); }
                            (AskStatus::Failed, run::clean_output(stdout.as_bytes()), Some(m))
                        }
                        Ok(Outcome::Killed { reason, stdout }) => {
                            let a = run::clean_output(stdout.as_bytes());
                            match reason {
                                Reason::Cancelled | Reason::Shutdown => (AskStatus::Cancelled, a, None),
                                Reason::Timeout => (AskStatus::Failed, a, Some("시간이 너무 오래 걸려 멈췄어요".into())),
                                Reason::TooLong => (AskStatus::Failed, a, Some("답이 너무 길어요".into())),
                            }
                        }
                        Err(_) => (AskStatus::Failed, String::new(), Some("내부 오류".into())),
                    };
                    me.finish(t, status, answer, error);
                });
            }
        }
        Ok(turn)
    }

    /// Append the final record (I3), drop it from the running map, then emit `ask.done` (I2).
    fn finish(&self, mut turn: AskTurn, status: AskStatus, answer: String, error: Option<String>) {
        turn.status = status;
        turn.answer = answer;
        turn.error = error;
        turn.ended_at = Some(now());
        if let Err(e) = self.0.log.append(&turn) { eprintln!("roomsd: ask {}: could not record: {e}", turn.id); }
        self.0.running.lock().unwrap().remove(&turn.id);
        self.0.core.emit_ask(EventKind::AskDone { turn });
    }

    fn read_thread(&self, running: &HashMap<String, Entry>, file_key: &str) -> Result<Vec<AskTurn>, AskError> {
        let mut turns = self.0.log.read(file_key).map_err(|e| AskError::Io(e.to_string()))?;
        for t in &mut turns {
            if t.status == AskStatus::Running && !running.contains_key(&t.id) {
                t.status = AskStatus::Failed;
                t.error = Some(RESTARTED.into());
            }
        }
        Ok(turns)
    }

    pub fn thread(&self, file_key: &str) -> Result<Vec<AskTurn>, AskError> {
        if !valid_file_key(file_key) { return Err(AskError::BadRequest("bad file key".into())); }
        let running = self.0.running.lock().unwrap();
        self.read_thread(&running, file_key)
    }

    pub fn cancel(&self, ask_id: &str) {
        if let Some(e) = self.0.running.lock().unwrap().get(ask_id) { e.killer.kill(Reason::Cancelled); }
    }

    /// Kill everything still running (roomsd is stopping; the app gives it 1 s). Waits ≤ 700 ms
    /// for the cancelled records; anything unrecorded reads back as failed (RESTARTED) later.
    pub async fn shutdown(&self) {
        for e in self.0.running.lock().unwrap().values() { e.killer.kill(Reason::Shutdown); }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(700);
        while !self.0.running.lock().unwrap().is_empty() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
```

Important detail in `start`: the busy check, the running-record append and the map insert all happen under one `running` lock, so a concurrent `thread` (which takes the same lock) never sees a `running` record that isn't in the map.

- [ ] **Step 4: Run tests**

Run: `cargo test -p rooms-core`
Expected: all existing tests + `asks` (9) pass.

- [ ] **Step 5: Commit**

```bash
git add crates/rooms-core
git commit -m "Add the Asks facade: start, thread, cancel, shutdown over the event stream"
```

---

### Task 7: roomsd routes, AppState, SIGTERM shutdown

**Files:**
- Modify: `crates/roomsd/src/lib.rs` — `AppState` gains `pub asks: rooms_core::asks::Asks`; routes
- Modify: `crates/roomsd/src/routes.rs` — handlers + `AskErr`; update the test helper at l.~238
- Modify: `crates/roomsd/src/main.rs`
- Modify: `crates/roomsd/tests/api.rs` — `app()` helper + new tests

**Interfaces:**
- Consumes: `Asks::{new, start, thread, cancel, shutdown}`, `AskError`, `login_path`
- Produces: `POST /v1/asks` (202 AskTurn), `GET /v1/asks?fileKey=` (200 AskTurn[]), `DELETE /v1/asks/{askId}` (204). Error body `{error, message}` with codes `bad_request` 400, `not_found` 404, `ask_busy` 409, `ask_capacity` 409, `agent_config` 422, `io` 500. Read-only → existing guard 403 `read_only`.

- [ ] **Step 1: Write the failing tests** — in `crates/roomsd/tests/api.rs` change `app()` to:

```rust
fn app(read_only: bool, peer: &str) -> (tempfile::TempDir, axum::Router, AppState) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    core.backfill_all().unwrap();
    let asks = rooms_core::asks::Asks::new(core.clone(), None);
    let st = AppState { core, asks, token: "t0k".into(), read_only, files_origin: "http://127.0.0.1:4318".into(), net: NetConfig::default() };
    let addr: SocketAddr = peer.parse().unwrap();
    (d, build_api_router(st.clone()).layer(MockConnectInfo(addr)), st)
}
```

and append:

```rust
fn delete(uri: &str, token: Option<&str>, host: &str) -> Request<Body> {
    let mut b = Request::delete(uri).header("host", host);
    if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
    b.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn ask_routes() {
    let (d, app, st) = app(false, "127.0.0.1:5000");
    let room = st.core.create_room("r").unwrap();
    let root = st.core.room_root(&room.id).unwrap().0;
    std::fs::write(root.join("doc.html"), "<title>d</title>").unwrap();
    st.core.backfill_all().unwrap();
    std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
    std::fs::write(d.path().join(".rooms/agents.toml"), "[agents.claude-code]\nnew = [\"/bin/echo\", \"hi\"]\n").unwrap();
    let art = st.core.list_artifacts(&room.id).unwrap().remove(0);
    let mut rx = st.core.subscribe();

    let body = format!(r#"{{"roomId":"{}","artifactId":"{}","question":"q"}}"#, room.id, art.id);
    let r = app.clone().oneshot(post("/v1/asks", &body, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::ACCEPTED);
    let turn = body_json(r).await;
    assert_eq!(turn["status"], "running");
    loop {
        let ev = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        if let rooms_protocol::EventKind::AskDone { turn: t } = ev.kind { assert_eq!(t.answer, "hi"); break; }
    }
    let r = app.clone().oneshot(get(&format!("/v1/asks?fileKey={}", art.file_key), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body_json(r).await[0]["answer"], "hi");

    let r = app.clone().oneshot(post("/v1/asks", &body.replace("\"q\"", "\"  \""), Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(r).await["error"], "bad_request");
    let r = app.clone().oneshot(post("/v1/asks", &body.replace(&art.id, "nope"), Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    std::fs::write(d.path().join(".rooms/agents.toml"), "default = [").unwrap();
    let r = app.clone().oneshot(post("/v1/asks", &body, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(r).await["error"], "agent_config");
    let r = app.clone().oneshot(get("/v1/asks?fileKey=..%2Fx", API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = app.clone().oneshot(delete("/v1/asks/whatever", Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let r = app.clone().oneshot(post("/v1/asks", &body, None, API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ask_writes_are_forbidden_read_only() {
    let (_d, app, _) = app(true, "127.0.0.1:5000");
    let r = app.clone().oneshot(post("/v1/asks", r#"{"roomId":"r","artifactId":"a","question":"q"}"#, Some("t0k"), API_HOST)).await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p roomsd`
Expected: compile error (`AppState` has no field `asks`).

- [ ] **Step 3: Implement**

`crates/roomsd/src/lib.rs`: add `pub asks: rooms_core::asks::Asks,` to `AppState` (after `core`), and in `build_api_router` next to the other `/v1/...` routes:

```rust
        .route("/v1/asks", get(routes::ask_thread).post(routes::start_ask))
        .route("/v1/asks/{ask_id}", axum::routing::delete(routes::cancel_ask))
```

`crates/roomsd/src/routes.rs` (near `ApiErr`):

```rust
use rooms_core::asks::AskError;
use rooms_protocol::{AskTurn, StartAsk};

pub struct AskErr(AskError);
impl From<AskError> for AskErr { fn from(e: AskError) -> Self { AskErr(e) } }
impl IntoResponse for AskErr {
    fn into_response(self) -> Response {
        let (status, code) = match &self.0 {
            AskError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AskError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AskError::Busy => (StatusCode::CONFLICT, "ask_busy"),
            AskError::Capacity => (StatusCode::CONFLICT, "ask_capacity"),
            AskError::AgentConfig(_) => (StatusCode::UNPROCESSABLE_ENTITY, "agent_config"),
            AskError::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "io"),
        };
        (status, Json(ApiError { error: code.into(), message: self.0.to_string() })).into_response()
    }
}

pub async fn start_ask(State(st): State<AppState>, Json(b): Json<StartAsk>) -> Result<(StatusCode, Json<AskTurn>), AskErr> {
    Ok((StatusCode::ACCEPTED, Json(st.asks.start(&b.room_id, &b.artifact_id, &b.question)?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuery { file_key: String }

pub async fn ask_thread(State(st): State<AppState>, axum::extract::Query(q): axum::extract::Query<AskQuery>) -> Result<Json<Vec<AskTurn>>, AskErr> {
    Ok(Json(st.asks.thread(&q.file_key)?))
}

pub async fn cancel_ask(State(st): State<AppState>, Path(ask_id): Path<String>) -> StatusCode {
    st.asks.cancel(&ask_id);
    StatusCode::NO_CONTENT
}
```

(Use the imports already at the top of `routes.rs` for `StatusCode`, `Json`, `Path`, `State`, `Response`, `IntoResponse`, `ApiError`, `Deserialize`; add any that are missing.)

Update the test helper in `routes.rs` (l.~238) the same way: `let asks = rooms_core::asks::Asks::new(core.clone(), None);` and add `asks,` to the `AppState { … }` literal.

`crates/roomsd/src/main.rs`: after `let token = …`:

```rust
    let asks = rooms_core::asks::Asks::new(core.clone(), rooms_core::asks::login_path().await);
    let st = AppState { core, asks: asks.clone(), token, read_only: false, files_origin: format!("http://127.0.0.1:{fp}"), net };
```

and replace the `tokio::select!` with:

```rust
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    let (name, res) = tokio::select! {
        r = a => ("api", r),
        r = f => ("files", r),
        _ = term.recv() => { asks.shutdown().await; std::process::exit(0) }
        _ = tokio::signal::ctrl_c() => { asks.shutdown().await; std::process::exit(0) }
    };
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p roomsd && cargo build -p roomsd`
Expected: all pass, builds.

- [ ] **Step 5: Commit**

```bash
git add crates/roomsd
git commit -m "Serve asks over /v1/asks and stop running asks on SIGTERM"
```

---

### Task 8: TS client methods

**Files:**
- Modify: `packages/protocol-ts/src/client.ts`

**Interfaces:**
- Produces: `startAsk(req: StartAsk): Promise<AskTurn>`, `askThread(fileKey: string): Promise<AskTurn[]>`, `cancelAsk(askId: string): Promise<void>`

- [ ] **Step 1: Implement** (no standalone client tests exist in this package; Task 12's e2e covers the wire). Add imports `import type { AskTurn } from "./generated/AskTurn"; import type { StartAsk } from "./generated/StartAsk";` and inside the returned object, after `moveArtifact`:

```ts
    startAsk: (req: StartAsk) => write<AskTurn>("POST", "/v1/asks", JSON.stringify(req)),
    askThread: async (fileKey: string) => (await get<AskTurn[]>(`/v1/asks?fileKey=${encodeURIComponent(fileKey)}`)).data,
    cancelAsk: (askId: string) => write<void>("DELETE", `/v1/asks/${encodeURIComponent(askId)}`, ""),
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/protocol-ts
git commit -m "Add startAsk/askThread/cancelAsk to the protocol client"
```

---

### Task 9: `AsksStore` (+ event plumbing + fakes)

**Files:**
- Modify: `apps/desktop/src/data/roomsStore.ts` — `onSignal` passes the event too
- Create: `apps/desktop/src/ask/asksStore.ts`
- Create: `apps/desktop/src/ask/asksStore.test.ts`
- Modify: `apps/desktop/src/data/hooks.ts`
- Modify: `apps/desktop/src/test/fakes.tsx`

**Interfaces:**
- Consumes: `client.startAsk/askThread/cancelAsk`, `RoomsStore.onSignal`
- Produces:
  - `RoomsStore.onSignal(fn: (type: RoomsEvent["type"], e: RoomsEvent) => void)` (existing callers ignore the 2nd arg)
  - `export type Thread = { turns: AskTurn[]; loaded: boolean; error: boolean }`
  - `export type AsksState = { open: boolean; threads: Record<string, Thread> }`
  - `export function upsert(turns: AskTurn[], t: AskTurn): AskTurn[]`
  - `export class AsksStore { getState; subscribe; start(); stop(); toggle(); setOpen(open: boolean); load(fileKey: string): Promise<void>; ask(a: { roomId: string; artifactId: string }, question: string): Promise<void>; cancel(askId: string): void }`
  - hooks: `useAsksStore(): AsksStore`, `useAsks(): AsksState`

- [ ] **Step 1: Write the failing tests** — `apps/desktop/src/ask/asksStore.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { AskTurn, RoomsEvent } from "@alto-rooms/protocol-ts";
import { AsksStore, upsert } from "./asksStore";

const turn = (id: string, status: AskTurn["status"], extra: Partial<AskTurn> = {}): AskTurn => ({
  id, fileKey: "k1", question: "q", answer: "", agent: "claude-code", mode: "resume", status,
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, ...extra,
});

function setup(thread: AskTurn[] = []) {
  let signal: (type: RoomsEvent["type"], e: RoomsEvent) => void = () => {};
  const client = {
    startAsk: vi.fn(async () => turn("t1", "running")),
    askThread: vi.fn(async () => thread),
    cancelAsk: vi.fn(async () => {}),
  };
  const store = new AsksStore(client, { onSignal: (fn) => ((signal = fn), () => {}) });
  store.start();
  const emit = (e: Omit<RoomsEvent, "seq">) => signal(e.type, { ...e, seq: 1 } as RoomsEvent);
  return { store, client, emit };
}

describe("upsert", () => {
  it("adds, replaces, and never turns a finished turn back to running", () => {
    const a = upsert([], turn("a", "running"));
    const done = upsert(a, turn("a", "done", { answer: "x" }));
    expect(done).toEqual([turn("a", "done", { answer: "x" })]);
    expect(upsert(done, turn("a", "running"))).toBe(done);
  });
});

describe("AsksStore", () => {
  it("starts closed and toggles", () => {
    const { store } = setup();
    expect(store.getState().open).toBe(false);
    store.toggle();
    expect(store.getState().open).toBe(true);
  });

  it("loads a thread and applies ask events for that file key", async () => {
    const { store, emit } = setup([turn("t0", "done", { answer: "old" })]);
    await store.load("k1");
    emit({ type: "ask.started", turn: turn("t1", "running") });
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "new" }) });
    expect(store.getState().threads.k1.turns.map((t) => [t.id, t.status, t.answer])).toEqual([
      ["t0", "done", "old"],
      ["t1", "done", "new"],
    ]);
  });

  it("ask.done before the 202 stays done", async () => {
    const { store, client, emit } = setup();
    let resolve!: (t: AskTurn) => void;
    client.startAsk.mockImplementationOnce(() => new Promise<AskTurn>((r) => (resolve = r)));
    const p = store.ask({ roomId: "r", artifactId: "a" }, "q");
    emit({ type: "ask.done", turn: turn("t1", "failed", { error: "boom" }) });
    resolve(turn("t1", "running"));
    await p;
    expect(store.getState().threads.k1.turns[0].status).toBe("failed");
    expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r", artifactId: "a", question: "q" });
  });

  it("a load that races an event keeps the newer state", async () => {
    const { store, client, emit } = setup();
    let resolve!: (t: AskTurn[]) => void;
    client.askThread.mockImplementationOnce(() => new Promise<AskTurn[]>((r) => (resolve = r)));
    const p = store.load("k1");
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "a" }) });
    resolve([turn("t1", "running")]);
    await p;
    expect(store.getState().threads.k1.turns[0].status).toBe("done");
  });

  it("marks load errors and reloads loaded threads on resync", async () => {
    const { store, client, emit } = setup();
    client.askThread.mockRejectedValueOnce(new Error("x"));
    await store.load("k1");
    expect(store.getState().threads.k1.error).toBe(true);
    emit({ type: "resync", roomId: null });
    await vi.waitFor(() => expect(store.getState().threads.k1.error).toBe(false));
    expect(client.askThread).toHaveBeenCalledTimes(2);
  });

  it("ask() rethrows API errors for the bar to show", async () => {
    const { store, client } = setup();
    client.startAsk.mockRejectedValueOnce(new Error("busy"));
    await expect(store.ask({ roomId: "r", artifactId: "a" }, "q")).rejects.toThrow("busy");
  });

  it("cancel calls the client and swallows errors", () => {
    const { store, client } = setup();
    client.cancelAsk.mockRejectedValueOnce(new Error("gone"));
    store.cancel("t1");
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && bunx vitest run src/ask/asksStore.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`apps/desktop/src/data/roomsStore.ts`:

```ts
  private signalListeners = new Set<(type: RoomsEvent["type"], e: RoomsEvent) => void>();

  /** Hears every event as it arrives (before buffering): for state kept outside this store, e.g. plugins, asks. */
  onSignal = (fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): (() => void) => {
```

and in `onEvent`: `for (const l of [...this.signalListeners]) l(e.type, e);`. Update the `Signals` type in `src/plugins/pluginsStore.ts` to `onSignal(fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): () => void` (its listener keeps ignoring `e`).

`apps/desktop/src/ask/asksStore.ts`:

```ts
/*
 * Ask threads by file key, kept in step with roomsd by `ask.started` / `ask.done`
 * events, plus whether the ask bar is open (global, starts closed, not saved).
 */
import type { AskTurn, RoomsEvent, StartAsk } from "@alto-rooms/protocol-ts";

export type Thread = { turns: AskTurn[]; loaded: boolean; error: boolean };
export type AsksState = { open: boolean; threads: Record<string, Thread> };

type Client = {
  startAsk(req: StartAsk): Promise<AskTurn>;
  askThread(fileKey: string): Promise<AskTurn[]>;
  cancelAsk(askId: string): Promise<void>;
};
type Signals = { onSignal(fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): () => void };

const finished = (t: AskTurn) => t.status !== "running";

/** By id; a finished turn never goes back to running (a late 202 or stale load). */
export function upsert(turns: AskTurn[], t: AskTurn): AskTurn[] {
  const i = turns.findIndex((x) => x.id === t.id);
  if (i < 0) return [...turns, t];
  if (finished(turns[i]) && !finished(t)) return turns;
  const next = turns.slice();
  next[i] = t;
  return next;
}

const EMPTY: Thread = { turns: [], loaded: false, error: false };

export class AsksStore {
  private state: AsksState = { open: false, threads: {} };
  private listeners = new Set<() => void>();
  private stopSignals: (() => void) | null = null;

  constructor(
    private readonly client: Client | undefined,
    private readonly rooms: Signals,
  ) {}

  getState = (): AsksState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  start(): void {
    if (this.stopSignals) return;
    this.stopSignals = this.rooms.onSignal((type, e) => {
      if (e.type === "ask.started" || e.type === "ask.done") this.apply(e.turn);
      else if (type === "resync" && e.type === "resync" && e.roomId === null) {
        for (const [key, th] of Object.entries(this.state.threads)) if (th.loaded) void this.load(key);
      }
    });
  }

  stop(): void {
    this.stopSignals?.();
    this.stopSignals = null;
  }

  toggle(): void {
    this.setOpen(!this.state.open);
  }

  setOpen(open: boolean): void {
    if (open !== this.state.open) this.set({ ...this.state, open });
  }

  async load(fileKey: string): Promise<void> {
    if (!this.client) return;
    try {
      const loaded = await this.client.askThread(fileKey);
      const current = this.state.threads[fileKey]?.turns ?? [];
      const turns = current.reduce(upsert, loaded);
      this.setThread(fileKey, { turns, loaded: true, error: false });
    } catch (e) {
      console.warn("rooms: could not load ask thread", e);
      this.setThread(fileKey, { ...(this.state.threads[fileKey] ?? EMPTY), loaded: true, error: true });
    }
  }

  /** Throws the API error (e.g. ask_busy) for the bar to show. */
  async ask(a: { roomId: string; artifactId: string }, question: string): Promise<void> {
    if (!this.client) return;
    const t = await this.client.startAsk({ roomId: a.roomId, artifactId: a.artifactId, question });
    this.apply(t);
  }

  cancel(askId: string): void {
    void this.client?.cancelAsk(askId).catch((e) => console.warn("rooms: could not cancel ask", e));
  }

  private apply(t: AskTurn) {
    const th = this.state.threads[t.fileKey] ?? EMPTY;
    this.setThread(t.fileKey, { ...th, turns: upsert(th.turns, t) });
  }

  private setThread(key: string, th: Thread) {
    this.set({ ...this.state, threads: { ...this.state.threads, [key]: th } });
  }

  private set(next: AsksState) {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}
```

`apps/desktop/src/data/hooks.ts`: import `AsksStore`, `AsksState` from `@/ask/asksStore`; in `StoresProvider`:

```tsx
  const asks = useMemo(() => new AsksStore(client, rooms), [client, rooms]);
  useEffect(() => {
    asks.start();
    return () => asks.stop();
  }, [asks]);
  const value = useMemo(() => ({ rooms, viewer, client, plugins, asks }), [rooms, viewer, client, plugins, asks]);
```

widen the context type to `Stores & { plugins: PluginsStore; asks: AsksStore }` (both in `createContext` and `useStores`), and add:

```ts
export const useAsksStore = (): AsksStore => useStores().asks;

/** Whether the ask bar is open, and ask threads by file key. */
export function useAsks(): AsksState {
  const store = useAsksStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
```

`apps/desktop/src/test/fakes.tsx`: add option `asks?: Record<string, AskTurn[]>` (import `AskTurn`), state `asks: opts.asks ?? {}`, and client methods:

```ts
    startAsk: vi.fn(async (req: { roomId: string; artifactId: string; question: string }): Promise<AskTurn> => {
      const a = state.artifacts[req.roomId]?.find((x) => x.id === req.artifactId);
      if (!a) throw new RoomsApiError(404, "이 문서를 찾을 수 없어요", "not_found");
      return { id: `ask-${req.question}`, fileKey: a.fileKey, question: req.question, answer: "", agent: a.source.agent ?? "claude-code",
        mode: a.source.session ? "resume" : "new", status: "running", error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null };
    }),
    askThread: vi.fn(async (fileKey: string) => state.asks[fileKey] ?? []),
    cancelAsk: vi.fn(async () => {}),
```

- [ ] **Step 4: Run tests**

Run: `cd apps/desktop && bunx vitest run && bunx tsc --noEmit`
Expected: all pass (existing plugin tests still green with the widened `onSignal`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "Add AsksStore: ask threads by file key and the global bar toggle"
```

---

### Task 10: `AskBar` UI in the doc tab

**Files:**
- Modify: `apps/desktop/package.json` — `bun add react-markdown` (run in `apps/desktop`)
- Create: `apps/desktop/src/ask/AskBar.tsx`
- Create: `apps/desktop/src/ask/AskBar.test.tsx`
- Modify: `apps/desktop/src/views/DocView.tsx`
- Uses: `apps/desktop/src/assets/clew-sleep.svg` (already committed)

**Interfaces:**
- Consumes: `useAsks`, `useAsksStore`, `useReadOnly`, `RoomsApiError`, `GENERIC_ERROR` (`@/lib/errors`)
- Produces: `export function AskBar({ artifact }: { artifact: Artifact }): JSX.Element | null`

- [ ] **Step 1: Write the failing tests** — `apps/desktop/src/ask/AskBar.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Artifact, AskTurn } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { useAsksStore } from "@/data/hooks";
import { renderWithStores, room } from "@/test/fakes";
import { AskBar } from "./AskBar";

const doc: Artifact = {
  id: "a1", roomId: "r1", relPath: "doc.html", title: "Doc", createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent", fileKey: "k1",
  source: { agent: "claude-code", session: "S1", cwd: null, machine: null },
};
const turn = (extra: Partial<AskTurn>): AskTurn => ({
  id: "t1", fileKey: "k1", question: "왜?", answer: "", agent: "claude-code", mode: "resume", status: "running",
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, ...extra,
});

let store: ReturnType<typeof useAsksStore>;
function Grab() { store = useAsksStore(); return null; }

function setup(asks: Record<string, AskTurn[]> = {}, readOnly = false) {
  const r = renderWithStores(<><Grab /><AskBar artifact={doc} /></>, { rooms: [room("r1", "R")], artifacts: { r1: [doc] }, asks, readOnly });
  return r;
}

describe("AskBar", () => {
  it("renders nothing until toggled, then focuses the input", async () => {
    setup();
    expect(screen.queryByPlaceholderText("이 문서에 대해 묻기…")).toBeNull();
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("claude-code")).toBeTruthy();
  });

  it("renders nothing in read-only", () => {
    setup({}, true);
    act(() => store.toggle());
    expect(screen.queryByPlaceholderText("이 문서에 대해 묻기…")).toBeNull();
  });

  it("sends on Enter (not Shift+Enter, not while composing), shows waiting, then the markdown answer", async () => {
    const { client, emit } = setup();
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    fireEvent.change(input, { target: { value: "왜?" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.startAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r1", artifactId: "a1", question: "왜?" }));
    expect(await screen.findByText("claude-code가 답을 쓰고 있어요…")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    act(() => emit({ type: "ask.done", turn: turn({ id: "ask-왜?", status: "done", answer: "**굵게** 답", endedAt: "2026-10-06T10:00:12+09:00" }) }));
    expect((await screen.findByText("굵게")).tagName).toBe("STRONG");
    expect(screen.getByText(/12초/)).toBeTruthy();
    expect(screen.getByText("claude-code · 만든 대화에 이어서")).toBeTruthy();
  });

  it("shows a loaded thread, failed turns with retry, and cancelled turns", async () => {
    const { client } = setup({ k1: [
      turn({ id: "t0", question: "q0", status: "failed", error: "claude-code가 오류로 끝났어요 (code 1)", endedAt: "2026-10-06T10:00:01+09:00" }),
      turn({ id: "t1", question: "q1", status: "cancelled", answer: "부분", endedAt: "2026-10-06T10:00:02+09:00" }),
    ] });
    act(() => store.toggle());
    expect(await screen.findByText("claude-code가 오류로 끝났어요 (code 1)")).toBeTruthy();
    expect(screen.getByText("멈췄어요")).toBeTruthy();
    fireEvent.click(screen.getByText("다시 묻기"));
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r1", artifactId: "a1", question: "q0" }));
  });

  it("stop button cancels the running turn", async () => {
    const { client } = setup({ k1: [turn({})] });
    act(() => store.toggle());
    fireEvent.click(await screen.findByText("멈추기"));
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
  });

  it("shows the API error inline and keeps the draft", async () => {
    const { client } = setup();
    client.startAsk.mockRejectedValueOnce(new RoomsApiError(409, "답을 기다리는 중이에요", "ask_busy"));
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    fireEvent.change(input, { target: { value: "또" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("답을 기다리는 중이에요")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("또");
  });

  it("Escape folds the sheet, focusing the input unfolds it", async () => {
    setup({ k1: [turn({ status: "done", answer: "답", endedAt: "2026-10-06T10:00:03+09:00" })] });
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    expect(await screen.findByText("답")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("답")).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByText("답")).toBeTruthy();
  });
});
```

(If `renderWithStores` doesn't forward `asks` to `fakeClient`, it does once Task 9 added the option — `renderWithStores` passes its `opts` to `fakeClient`; check and pass it through if it destructures.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && bun add react-markdown && bunx vitest run src/ask/AskBar.test.tsx`
Expected: FAIL (module `./AskBar` not found).

- [ ] **Step 3: Implement** `apps/desktop/src/ask/AskBar.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import { ArrowUp } from "lucide-react";
import type { Artifact, AskTurn } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import clewSleep from "@/assets/clew-sleep.svg";
import { useAsks, useAsksStore, useReadOnly } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";

const PLACEHOLDER = "이 문서에 대해 묻기…";

function seconds(t: AskTurn): number | null {
  if (!t.endedAt) return null;
  return Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000));
}

function Turn({ t, onRetry, onStop }: { t: AskTurn; onRetry: () => void; onStop: () => void }) {
  const secs = seconds(t);
  return (
    <div className="space-y-2">
      <div className="ml-auto w-fit max-w-[80%] rounded-[10px] bg-[#f2f2f2] px-3 py-1.5 whitespace-pre-wrap">{t.question}</div>
      {t.status === "running" ? (
        <div className="flex items-center gap-3 text-[12.5px] text-ink-2">
          <img src={clewSleep} alt="" className="w-[120px]" />
          <span>{t.agent}가 답을 쓰고 있어요…</span>
          <button type="button" className="ml-auto underline" onClick={onStop}>멈추기</button>
        </div>
      ) : (
        <>
          {t.answer ? (
            <div className="text-[13.5px] leading-[1.55] [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5">
              <Markdown>{t.answer}</Markdown>
            </div>
          ) : null}
          {t.status === "cancelled" ? <div className="text-[12.5px] text-ink-2">멈췄어요</div> : null}
          {t.status === "failed" ? (
            <div className="text-[12.5px] whitespace-pre-wrap text-ink-2">
              {t.error}{" "}
              <button type="button" className="underline" onClick={onRetry}>다시 묻기</button>
            </div>
          ) : null}
          <div className="flex gap-2 text-[11.5px] text-ink-2">
            {secs !== null ? <span>{secs}초</span> : null}
            {t.answer ? (
              <button type="button" className="underline" onClick={() => void navigator.clipboard?.writeText(t.answer)}>복사</button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The round ask bar under a doc (⌘J), with this doc's thread above it. Hidden until toggled. */
export function AskBar({ artifact }: { artifact: Artifact }) {
  const store = useAsksStore();
  const { open, threads } = useAsks();
  const readOnly = useReadOnly();
  const thread = threads[artifact.fileKey];
  const [draft, setDraft] = useState("");
  const [sheet, setSheet] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const shown = open && !readOnly;

  useEffect(() => {
    if (shown && !thread) void store.load(artifact.fileKey);
  }, [shown, thread, store, artifact.fileKey]);
  useEffect(() => {
    if (shown) input.current?.focus();
  }, [shown]);
  const turns = thread?.turns ?? [];
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, turns.at(-1)?.status]);

  if (!shown) return null;
  const running = turns.find((t) => t.status === "running");
  const last = turns.at(-1);

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || running) return;
    setSendError(null);
    try {
      await store.ask({ roomId: artifact.roomId, artifactId: artifact.id }, q);
      if (q === draft.trim()) setDraft("");
      setSheet(true);
    } catch (e) {
      setSendError(e instanceof RoomsApiError ? e.message : GENERIC_ERROR);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSheet(false);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  const showSheet = sheet && (turns.length > 0 || thread?.error);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-4">
      {showSheet ? (
        <div className="pointer-events-auto max-h-[50vh] w-full max-w-[560px] overflow-y-auto rounded-[14px] border border-[#e3e3e3] bg-white px-4 py-3 text-[13.5px] shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
          {last ? (
            <div className="mb-2 text-[11.5px] text-ink-2">
              {last.agent} · {last.mode === "resume" ? "만든 대화에 이어서" : "새 대화"}
            </div>
          ) : null}
          {thread?.error ? (
            <div className="text-[12.5px] text-ink-2">
              대화를 불러오지 못했어요{" "}
              <button type="button" className="underline" onClick={() => void store.load(artifact.fileKey)}>다시 시도</button>
            </div>
          ) : null}
          <div className="space-y-4">
            {turns.map((t) => (
              <Turn key={t.id} t={t} onRetry={() => void send(t.question)} onStop={() => store.cancel(t.id)} />
            ))}
          </div>
          <div ref={bottom} />
        </div>
      ) : null}
      {sendError ? <div className="pointer-events-auto text-[12.5px] text-ink-2">{sendError}</div> : null}
      <div className="pointer-events-auto flex w-full max-w-[560px] items-center gap-2.5 rounded-full border border-[#dcdcdc] bg-white py-2 pr-2 pl-4 shadow-[0_4px_18px_rgba(0,0,0,0.08)]">
        <textarea
          ref={input}
          rows={1}
          value={draft}
          disabled={!!running}
          placeholder={PLACEHOLDER}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setSheet(true)}
          className="max-h-32 flex-1 resize-none bg-transparent text-[13.5px] outline-none placeholder:text-[#9a9a9a]"
        />
        <span className="rounded-full bg-[#f2f2f2] px-2 py-0.5 text-[11.5px] text-ink-2">{artifact.source.agent ?? "기본 에이전트"}</span>
        <button
          type="button"
          aria-label="보내기"
          disabled={!!running || !draft.trim()}
          onClick={() => void send(draft)}
          className={cn("flex size-[30px] items-center justify-center rounded-full bg-primary text-primary-foreground", (running || !draft.trim()) && "opacity-40")}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}
```

`apps/desktop/src/views/DocView.tsx`: `import { AskBar } from "@/ask/AskBar";` and inside the `<div className="relative min-w-0 flex-1">`, after `{loaded ? null : <DocSkeleton />}`:

```tsx
        <AskBar artifact={artifact} />
```

Note on the disabled textarea: the "renders nothing until toggled, then focuses" test focuses an enabled input; while a turn runs the textarea is disabled (cannot focus) — that's intended (bar locked).

- [ ] **Step 4: Run tests**

Run: `cd apps/desktop && bunx vitest run && bunx tsc --noEmit`
Expected: all pass. If the jsdom test can't import the `.svg`, check how `EmptyRoom.test.tsx` handles `clew-peek.svg` and do the same.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json ../../bun.lock apps/desktop/src
git commit -m "Add the ask bar to doc tabs: thread sheet, waiting otter, markdown answers"
```

(Use the lockfile path that `bun add` actually changed — the repo root `bun.lock`.)

---

### Task 11: ⌘J toggle (page key + native menu)

**Files:**
- Modify: `apps/desktop/src/shell/shortcuts.ts` (+ `shortcuts.test.ts`)
- Modify: `apps/desktop/src/shell/AppShell.tsx` (+ `AppShell.tauri.test.tsx`)
- Modify: `apps/desktop/src/lib/appEvents.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `useAsksStore().toggle()`, active tab from `useViewer()`, `useReadOnly()`
- Produces: `ShortcutAction` gains `"toggle-ask"`; `MENU_TOGGLE_ASK = "menu://toggle-ask"`; native View › "묻기 바" `CmdOrCtrl+J`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/shell/shortcuts.test.ts` — add:

```ts
  it("⌘J toggles the ask bar, also with a Korean layout, and works from text fields", () => {
    expect(keyAction(kd("j"))).toBe("toggle-ask");
    expect(keyAction(new KeyboardEvent("keydown", { key: "ㅓ", code: "KeyJ", metaKey: true }))).toBe("toggle-ask");
    const input = document.createElement("input");
    expect(allowedWithFocus("toggle-ask", input)).toBe(true);
  });
```

(`kd` is the helper already in that file.)

`apps/desktop/src/shell/AppShell.tauri.test.tsx` — add a test in the same style as `"menu://find and menu://toggle-sidebar …"`: open a doc tab via the viewer store (`viewer.open({ kind: "doc", roomId: "r1", artifactId: "a1" })` — use the exact shape the existing doc-tab tests use), fire `menu("menu://toggle-ask")`, expect `screen.findByPlaceholderText("이 문서에 대해 묻기…")`; fire it again, expect it gone; then open a `{ kind: "new" }` tab, fire it, and expect the asks store `open` unchanged (still false) — read it through a `Grab` component as in Task 10.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && bunx vitest run src/shell`
Expected: FAIL (`toggle-ask` unknown).

- [ ] **Step 3: Implement**

`shortcuts.ts`:

```ts
export type ShortcutAction = "toggle-sidebar" | "close-tab" | "new-tab" | "find" | "toggle-ask";
const LETTERS: Record<string, ShortcutAction> = { b: "toggle-sidebar", w: "close-tab", t: "new-tab", k: "find", j: "toggle-ask" };
```

and in `allowedWithFocus`: `if (action === "find" || action === "toggle-ask" || !isTextField(focused)) return true;` (update its doc comment: "⌘K and ⌘J always work").

`appEvents.ts`: `export const MENU_TOGGLE_ASK = "menu://toggle-ask";`

`AppShell.tsx`: `runAction` takes one more callback, `toggleAsk: () => void`, with `case "toggle-ask": toggleAsk(); break;`. In the component that calls `useShortcuts`, build it:

```tsx
  const asks = useAsksStore();
  const readOnly = useReadOnly();
  const { tabs, activeId } = useViewer();
  const activeKind = tabs.find((t) => t.id === activeId)?.kind;
  const toggleAsk = useCallback(() => {
    if (activeKind === "doc" && !readOnly) asks.toggle();
  }, [activeKind, readOnly, asks]);
```

pass `toggleAsk` into `useShortcuts(viewer, openFind, toggleAsk)` → `runAction(action, viewer, openFind, toggleAsk)`, add it to both effects' dependency arrays, and add `[MENU_TOGGLE_ASK]: fromMenu("toggle-ask"),` to `listenAll`. Update the doc comment above `useShortcuts` to list ⌘J.

`src-tauri/src/lib.rs`:

```rust
const MENU_TOGGLE_ASK: &str = "toggle-ask";
// in build_menu:
    let ask = MenuItemBuilder::with_id(MENU_TOGGLE_ASK, "묻기 바").accelerator("CmdOrCtrl+J").build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&find)
        .item(&sidebar)
        .item(&ask)
        .separator()
        .item(&back)
        .item(&forward)
        .build()?;
// in on_menu_event:
            MENU_TOGGLE_ASK => emit(app, "menu://toggle-ask"),
```

- [ ] **Step 4: Run tests**

Run: `cd apps/desktop && bunx vitest run && bunx tsc --noEmit && (cd src-tauri && cargo build)`
Expected: all pass, Tauri crate builds.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "Toggle the ask bar with ⌘J from the page and the View menu"
```

---

### Task 12: E2E golden path against real roomsd

**Files:**
- Create: `apps/desktop/e2e/ask.spec.ts`

**Interfaces:**
- Consumes: `e2e/fixtures.ts` (`test` with `daemon` fixture exposing `home`, `MOD`, `expect`); `ROOMS_HOME` layout.

- [ ] **Step 1: Write the test** (read `e2e/fixtures.ts` and one existing spec first to copy how a room + doc are created and how a doc tab is opened):

```ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, MOD, test } from "./fixtures";

test("ask a doc and get the fake agent's answer", async ({ page, daemon }) => {
  // A fake agent: prints its last argument's first line back.
  const bin = join(daemon.home, "fake-agent.sh");
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf "**답:** %s\\n" "$(printf %s "$last" | tail -n 1)"\n');
  chmodSync(bin, 0o755);
  mkdirSync(join(daemon.home, ".rooms"), { recursive: true });
  writeFileSync(join(daemon.home, ".rooms/agents.toml"), `[agents.claude-code]\nnew = ["${bin}", "{prompt}"]\n`);
  mkdirSync(join(daemon.home, "harness"), { recursive: true });
  writeFileSync(join(daemon.home, "harness/doc.html"), "<html><head><title>Doc</title></head><body>hello</body></html>");

  await page.goto("/");
  await page.getByRole("button", { name: "harness" }).click(); // adjust to how existing specs open a room
  await page.getByText("Doc").dblclick();                       // adjust to how existing specs open a doc tab
  await expect(page.getByPlaceholder("이 문서에 대해 묻기…")).toHaveCount(0);
  await page.keyboard.press(`${MOD}+j`);
  const input = page.getByPlaceholder("이 문서에 대해 묻기…");
  await input.fill("왜 이렇게 했어?");
  await input.press("Enter");
  await expect(page.getByText("질문: 왜 이렇게 했어?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("기본 에이전트 · 새 대화").or(page.getByText("claude-code · 새 대화"))).toBeVisible();

  // Survives a reload: the thread comes back from roomsd.
  await page.reload();
  await page.getByText("Doc").first().click();
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.getByText("질문: 왜 이렇게 했어?")).toBeVisible();
});
```

Before running, replace the two `// adjust` lines with the exact selectors the existing e2e specs use to open a room and a doc tab, and the reload step with however existing specs restore/open tabs after reload.

- [ ] **Step 2: Run**

Run: `cd apps/desktop && bun run e2e -- ask.spec.ts`
Expected: PASS. (The answer line is `**답:** 질문: 왜 이렇게 했어?` rendered as markdown; `getByText("질문: 왜 이렇게 했어?")` matches the text after the bold part.)

- [ ] **Step 3: Run the full suites**

Run: `cargo test && cd apps/desktop && bunx vitest run && bun run e2e`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/ask.spec.ts
git commit -m "Add an e2e for asking a doc against real roomsd"
```

---

## Spec sync (done at plan time)

Already updated in the spec: `docs/superpowers/specs/2026-10-06-alto-rooms-v2-ask-spec.html` §5 to match what this plan freezes: S3 `plan(...) -> Plan` (infallible); S2 `AskError` without `ReadOnly`, `shutdown` is `async`; S7 only `emit_ask` (no `artifact`, no `read_only`); S6 has no `on_output` callback and `Outcome` carries `stdout`.
