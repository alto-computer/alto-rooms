//! v2 ask: send a question about a doc to the agent CLI that made it (spec 2026-10-06 v2 ask).
//! `Asks` is the only entry point; templates, prompt, log and process stay inside this module.
pub(crate) mod agents;
pub(crate) mod log;
pub(crate) mod prompt;
pub(crate) mod run;
pub(crate) mod sources;

pub use run::Limits;

use crate::lock::lock;
use crate::RoomsCore;
use agents::{AgentProfiles, Plan, Vars};
use log::AskLog;
use prompt::{build_prompt, valid_file_key, valid_ident};
use rooms_protocol::{Artifact, AskStatus, AskTarget, AskTurn, EventKind};
use run::{spawn_agent, Killer, Outcome, Reason, Running, SpawnSpec};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const MAX_RUNNING: usize = 4;
const MAX_QUESTION_CHARS: usize = 8_000;
const RESTARTED: &str = "Stopped because Rooms restarted";

/// Why an ask call failed, with the wire `code()` and HTTP `status()` roomsd answers with (the
/// message is the `Display` text, shown to the user as is).
#[derive(Debug, thiserror::Error)]
pub enum AskError {
    #[error("{0}")] BadRequest(String),
    #[error("Can't find this doc")] NotFound,
    #[error("Waiting for an answer")] Busy,
    #[error("Too many questions running — try again when one finishes")] Capacity,
    #[error("Couldn't read agent settings: {0}")] AgentConfig(String),
    #[error("Couldn't save the conversation: {0}")] Io(String),
}

impl AskError {
    pub fn code(&self) -> &'static str {
        match self {
            AskError::BadRequest(_) => "bad_request",
            AskError::NotFound => "not_found",
            AskError::Busy => "ask_busy",
            AskError::Capacity => "ask_capacity",
            AskError::AgentConfig(_) => "agent_config",
            AskError::Io(_) => "io",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            AskError::BadRequest(_) => 400,
            AskError::NotFound => 404,
            AskError::Busy | AskError::Capacity => 409,
            AskError::AgentConfig(_) => 422,
            AskError::Io(_) => 500,
        }
    }
}

struct Entry { file_key: String, killer: Killer }

/// Where an ask from a doc goes: the one answer both `target` and `start` use.
struct Resolved {
    artifact: Artifact,
    file_abs: PathBuf,
    profiles: AgentProfiles,
    plan: Plan,
    session: Option<String>,
    cwd: PathBuf,
}

struct Inner {
    core: RoomsCore,
    log: AskLog,
    /// Filled once the login shell answers; until then agents get roomsd's own PATH.
    login_path: OnceLock<String>,
    limits: Limits,
    running: Mutex<HashMap<String, Entry>>,
    /// Set under the `running` lock by `shutdown`; `start` checks it under the same lock.
    shutting_down: AtomicBool,
    /// `start` may run on the blocking pool (routes), where it still needs a runtime to spawn on.
    rt: Option<tokio::runtime::Handle>,
}

#[derive(Clone)]
pub struct Asks(Arc<Inner>);

fn now() -> String { chrono::Local::now().to_rfc3339() }

const PATH_SENTINEL: &str = "__ROOMS_PATH__";

/// PATH from the user's login shell (R12): a GUI-launched roomsd doesn't have it. ≤ 2 s.
pub async fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = tokio::process::Command::new(shell);
    let script = format!("printf '{PATH_SENTINEL}%s' \"$PATH\"");
    cmd.args(["-l", "-c", &script]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(2), cmd.output()).await.ok()?.ok()?;
    if !out.status.success() { return None; }
    parse_login_path(&out.stdout)
}

/// How a finished run of `agent` ends its turn: (status, answer, error shown to the user). The
/// answer is the cleaned stdout, kept even when the run failed or was stopped.
fn turn_end(agent: &str, outcome: Outcome) -> (AskStatus, String, Option<String>) {
    match outcome {
        Outcome::Exited { code: 0, stdout, .. } => (AskStatus::Done, run::clean_output(stdout.as_bytes()), None),
        Outcome::Exited { code, stdout, stderr_tail } => {
            let last = run::clean_output(stderr_tail.as_bytes()).lines().rev().find(|l| !l.trim().is_empty()).map(str::to_string);
            let mut m = format!("{agent} exited with an error (code {code})");
            if let Some(l) = last { m.push('\n'); m.push_str(&l); }
            (AskStatus::Failed, run::clean_output(stdout.as_bytes()), Some(m))
        }
        Outcome::Killed { reason, stdout } => {
            let a = run::clean_output(stdout.as_bytes());
            match reason {
                Reason::Cancelled | Reason::Shutdown => (AskStatus::Cancelled, a, None),
                Reason::Timeout => (AskStatus::Failed, a, Some("Stopped: took too long".into())),
                Reason::TooLong => (AskStatus::Failed, a, Some("Stopped: the answer was too long".into())),
            }
        }
    }
}

/// The first line after the LAST sentinel: whatever `.zprofile` prints before it, or `.zlogout`
/// after it, is ignored.
fn parse_login_path(stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let path = text.rsplit_once(PATH_SENTINEL)?.1.lines().next().unwrap_or("").trim();
    (!path.is_empty()).then(|| path.to_string())
}

impl Asks {
    pub fn new(core: RoomsCore, login_path: Option<String>) -> Self { Self::with_limits(core, login_path, Limits::default()) }

    pub fn with_limits(core: RoomsCore, login_path: Option<String>, limits: Limits) -> Self {
        let log = AskLog::new(core.home().join(".rooms/asks"));
        let cell = OnceLock::new();
        if let Some(p) = login_path { let _ = cell.set(p); }
        Self(Arc::new(Inner {
            core, log, login_path: cell, limits, running: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false), rt: tokio::runtime::Handle::try_current().ok(),
        }))
    }

    /// Ask the login shell for PATH in the background so startup never waits on it (≤ 2 s).
    pub fn resolve_login_path(&self) {
        let me = self.clone();
        tokio::spawn(async move {
            if let Some(p) = login_path().await { let _ = me.0.login_path.set(p); }
        });
    }

    fn config_path(&self) -> PathBuf { self.0.core.home().join(".rooms/agents.toml") }

    /// Which doc, agent, template, session and cwd an ask from `artifact_id` would use.
    fn resolve(&self, room: &str, artifact_id: &str) -> Result<Resolved, AskError> {
        let core = &self.0.core;
        let artifact = core.artifact(&room.to_string(), artifact_id).ok().flatten().ok_or(AskError::NotFound)?;
        if !valid_file_key(&artifact.file_key) { return Err(AskError::BadRequest("bad file key".into())); }
        let file_abs = core.resolve_file(&room.to_string(), &artifact.rel_path).map_err(|_| AskError::NotFound)?;
        let profiles = AgentProfiles::load(&self.config_path()).map_err(AskError::AgentConfig)?;
        // Meta wins. Otherwise the sidecar entry (agent, session, cwd) is used WHOLE: mixing the doc's
        // agent with another conversation's session would resume the wrong agent's thread.
        let meta = &artifact.source;
        let meta_has_session = meta.session.as_deref().is_some_and(valid_ident);
        let sidecar = if meta_has_session { None } else { sources::lookup(core.home(), &file_abs) };
        let src = sidecar.as_ref().unwrap_or(meta);
        let agent = src.agent.as_deref().filter(|a| valid_ident(a));
        let session = src.session.clone().filter(|s| valid_ident(s));
        let plan = profiles.plan(agent, session.as_deref());
        let cwd = src.cwd.as_deref().map(PathBuf::from).filter(|p| p.is_absolute() && p.is_dir())
            .unwrap_or_else(|| file_abs.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| core.home().to_path_buf()));
        Ok(Resolved { artifact, file_abs, profiles, plan, session, cwd })
    }

    /// Blocking, like `start`: what the ask bar shows before the first question.
    pub fn target(&self, room: &str, artifact_id: &str) -> Result<AskTarget, AskError> {
        let r = self.resolve(room, artifact_id)?;
        Ok(AskTarget { agent: r.plan.agent, mode: r.plan.mode, models: r.plan.models })
    }

    /// Blocking (SQLite, files, std Mutex): async callers run it on the blocking pool.
    /// `model` must be one of the target's models; `None` or "" leaves the agent's default.
    pub fn start(&self, room: &str, artifact_id: &str, question: &str, model: Option<&str>) -> Result<AskTurn, AskError> {
        let _rt = self.0.rt.as_ref().map(|h| h.enter());
        let q = question.trim();
        if q.is_empty() || q.chars().count() > MAX_QUESTION_CHARS {
            return Err(AskError::BadRequest(format!("A question must be 1–{MAX_QUESTION_CHARS} characters")));
        }
        let core = &self.0.core;
        let Resolved { artifact, file_abs, profiles, plan, session, cwd } = self.resolve(room, artifact_id)?;
        let model = model.filter(|m| !m.is_empty());
        if let Some(m) = model {
            if !plan.models.iter().any(|x| x == m) {
                return Err(AskError::BadRequest(format!("{} can't use the model \"{m}\" here", plan.agent)));
            }
        }
        let (file_s, cwd_s) = (file_abs.to_string_lossy().into_owned(), cwd.to_string_lossy().into_owned());

        let mut running = lock(&self.0.running);
        if self.0.shutting_down.load(Ordering::SeqCst) { return Err(AskError::Capacity); }
        if running.values().any(|e| e.file_key == artifact.file_key) { return Err(AskError::Busy); }
        if running.len() >= MAX_RUNNING { return Err(AskError::Capacity); }
        let prior = self.read_thread(&running, &artifact.file_key)?;
        let prompt = build_prompt(profiles.preamble(), plan.mode, &file_s, &artifact.file_key, &prior, q);
        // roomsd writes mcp.json only when it can find rooms-mcp; without it the flag is dropped.
        let mcp = core.home().join(".rooms/mcp.json");
        let mcp_s = if mcp.is_file() { mcp.to_string_lossy().into_owned() } else { String::new() };
        let argv = plan.render(&Vars { prompt: &prompt, session: session.as_deref().unwrap_or(""), file: &file_s, cwd: &cwd_s, mcp_config: &mcp_s, model: model.unwrap_or("") });
        let turn = AskTurn {
            id: nanoid::nanoid!(16), file_key: artifact.file_key.clone(), question: q.to_string(), answer: String::new(),
            agent: plan.agent.clone(), model: model.map(str::to_string), mode: plan.mode, status: AskStatus::Running, error: None, started_at: now(), ended_at: None,
        };
        self.0.log.append(&turn).map_err(|e| AskError::Io(e.to_string()))?;
        core.emit_ask(EventKind::AskStarted { turn: turn.clone() });
        let spawned = spawn_agent(SpawnSpec { argv: argv.clone(), cwd, path_env: self.0.login_path.get().cloned(), limits: self.0.limits });
        match spawned {
            Err(e) => {
                drop(running);
                let msg = if e.kind() == std::io::ErrorKind::NotFound {
                    format!("Command not found: {} — settings: {}", argv[0], self.config_path().display())
                } else {
                    format!("Couldn't run {} ({e})", argv[0])
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
                        Ok(outcome) => turn_end(&t.agent, outcome),
                        Err(_) => (AskStatus::Failed, String::new(), Some("Internal error".into())),
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
        lock(&self.0.running).remove(&turn.id);
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
        let running = lock(&self.0.running);
        self.read_thread(&running, file_key)
    }

    pub fn cancel(&self, ask_id: &str) {
        if let Some(e) = lock(&self.0.running).get(ask_id) { e.killer.kill(Reason::Cancelled); }
    }

    /// Kill everything still running (roomsd is stopping; the app gives it 1 s). Waits ≤ 700 ms
    /// for the cancelled records; anything unrecorded reads back as failed (RESTARTED) later.
    /// New asks are refused from here on, so nothing is spawned that nobody would kill.
    pub async fn shutdown(&self) {
        {
            let running = lock(&self.0.running);
            self.0.shutting_down.store(true, Ordering::SeqCst);
            for e in running.values() { e.killer.kill(Reason::Shutdown); }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(700);
        while !lock(&self.0.running).is_empty() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_errors_wire_codes_and_statuses() {
        let wire = |e: AskError| (e.status(), e.code(), e.to_string());
        assert_eq!(wire(AskError::BadRequest("why".into())), (400, "bad_request", "why".into()));
        assert_eq!(wire(AskError::NotFound), (404, "not_found", "Can't find this doc".into()));
        assert_eq!(wire(AskError::Busy), (409, "ask_busy", "Waiting for an answer".into()));
        assert_eq!(wire(AskError::Capacity), (409, "ask_capacity", "Too many questions running — try again when one finishes".into()));
        assert_eq!(wire(AskError::AgentConfig("x".into())), (422, "agent_config", "Couldn't read agent settings: x".into()));
        assert_eq!(wire(AskError::Io("x".into())), (500, "io", "Couldn't save the conversation: x".into()));
    }

    fn exited(code: i32, stdout: &str, stderr_tail: &str) -> Outcome {
        Outcome::Exited { code, stdout: stdout.into(), stderr_tail: stderr_tail.into() }
    }

    fn killed(reason: Reason, stdout: &str) -> Outcome { Outcome::Killed { reason, stdout: stdout.into() } }

    #[test]
    fn turn_end_maps_every_outcome() {
        assert_eq!(turn_end("codex", exited(0, "\x1b[1mhi\x1b[0m\n", "noise")), (AskStatus::Done, "hi".into(), None));
        assert_eq!(turn_end("codex", exited(2, "partial", "warn\nboom: bad flag\n\n")),
            (AskStatus::Failed, "partial".into(), Some("codex exited with an error (code 2)\nboom: bad flag".into())));
        assert_eq!(turn_end("codex", exited(1, "", "  \n")), (AskStatus::Failed, String::new(), Some("codex exited with an error (code 1)".into())));
        assert_eq!(turn_end("codex", killed(Reason::Cancelled, "so far")), (AskStatus::Cancelled, "so far".into(), None));
        assert_eq!(turn_end("codex", killed(Reason::Shutdown, "")), (AskStatus::Cancelled, String::new(), None));
        assert_eq!(turn_end("codex", killed(Reason::Timeout, "a")), (AskStatus::Failed, "a".into(), Some("Stopped: took too long".into())));
        assert_eq!(turn_end("codex", killed(Reason::TooLong, "a")), (AskStatus::Failed, "a".into(), Some("Stopped: the answer was too long".into())));
    }

    #[test]
    fn login_path_is_the_text_after_the_last_sentinel() {
        assert_eq!(parse_login_path(b"__ROOMS_PATH__/usr/bin:/bin").as_deref(), Some("/usr/bin:/bin"));
        let noisy = b"Welcome!\nfake __ROOMS_PATH__/evil\n\x1b[0m__ROOMS_PATH__/opt/homebrew/bin:/usr/bin\n";
        assert_eq!(parse_login_path(noisy).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(parse_login_path(b"no sentinel here"), None);
        assert_eq!(parse_login_path(b"__ROOMS_PATH__  "), None);
        // a login zsh may print `.zlogout` output after PATH
        assert_eq!(parse_login_path(b"__ROOMS_PATH__/usr/bin:/bin\nbye\n").as_deref(), Some("/usr/bin:/bin"));
    }
}
