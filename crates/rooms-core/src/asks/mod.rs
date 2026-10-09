//! v2 ask: send a question about a doc to the agent CLI that made it (spec 2026-10-06 v2 ask).
//! Every thread belongs to an `AskScope`: a doc, a room or a Journal day.
//! `Asks` is the only entry point; templates, prompt, log and process stay inside this module.
pub(crate) mod agents;
pub mod images;
pub(crate) mod log;
pub(crate) mod prompt;
pub(crate) mod run;
pub(crate) mod sources;
pub(crate) mod stream;

pub use run::Limits;

use crate::error::CoreError;
use crate::lock::lock;
use crate::rules::{slug_key, valid_room_id, validate_iso_date};
use crate::RoomsCore;
use agents::{claude_read_scope, AgentProfiles, Plan, Vars};
use log::AskLog;
use prompt::{build_prompt, build_scope_prompt, context, listed, valid_file_key, valid_ident, with_image_paths, ContextEntry, Listing, COMPACT_ASK, PRIOR_CHARS_ARGV, PRIOR_CHARS_STDIN};
use rooms_protocol::{AskKind, AskScope, AskStatus, AskTarget, AskTurn, EventKind, JOURNAL_ROOM_ID};
use run::{spawn_agent, Killer, Outcome, Reason, Running, SpawnSpec};
use stream::{EventRule, Reader};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

pub const MAX_RUNNING: usize = 4;
const MAX_QUESTION_CHARS: usize = 8_000;
const RESTARTED: &str = "Stopped because Rooms restarted";
/// JSON-lines output carries every streamed chunk and tool result around the answer, so a profile
/// with event rules may print this many times `Limits::max_stdout` (16 MB by default).
const JSON_STDOUT_FACTOR: usize = 16;
/// `ask.progress` goes out at most this often per turn.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// The answer in `stdout`: what the profile's event rules read from it, or the plain text when the
/// profile has no rules or the output holds no JSON line (a template without its JSON flag).
fn read_answer(rules: &[EventRule], stdout: &[u8]) -> String {
    if rules.is_empty() { return run::clean_output(stdout); }
    let mut r = Reader::new(rules);
    r.push(stdout);
    r.finish();
    if r.saw_json() { run::clean_output(r.text().as_bytes()) } else { run::clean_output(stdout) }
}

/// A scope as one string, `doc:<fileKey>`, `room:<roomId>` or `day:<YYYY-MM-DD>`: what
/// `GET /v1/asks?scope=` takes and what the app keys its threads by.
pub trait ScopeKey: Sized {
    fn key(&self) -> String;
    /// The only parser; routes call it at the boundary. A scope that arrives as JSON gets `validate`.
    fn parse_key(key: &str) -> Result<Self, AskError>;
    fn validate(&self) -> Result<(), AskError>;
}

impl ScopeKey for AskScope {
    fn key(&self) -> String {
        match self {
            AskScope::Doc { file_key } => format!("doc:{file_key}"),
            AskScope::Room { room_id } => format!("room:{room_id}"),
            AskScope::Day { date } => format!("day:{date}"),
        }
    }

    fn parse_key(key: &str) -> Result<Self, AskError> {
        let scope = match key.split_once(':') {
            Some(("doc", k)) => AskScope::Doc { file_key: k.into() },
            Some(("room", r)) => AskScope::Room { room_id: r.into() },
            Some(("day", d)) => AskScope::Day { date: d.into() },
            _ => return Err(AskError::BadRequest("bad scope key".into())),
        };
        scope.validate()?;
        Ok(scope)
    }

    fn validate(&self) -> Result<(), AskError> {
        let ok = match self {
            AskScope::Doc { file_key } => valid_file_key(file_key),
            AskScope::Room { room_id } => valid_room_id(room_id) && slug_key(room_id) != JOURNAL_ROOM_ID,
            AskScope::Day { date } => validate_iso_date(date).is_ok(),
        };
        if ok { Ok(()) } else { Err(AskError::BadRequest("bad scope key".into())) }
    }
}

/// Why an ask call failed, with the wire `code()` and HTTP `status()` roomsd answers with (the
/// message is the `Display` text, shown to the user as is).
#[derive(Debug, thiserror::Error)]
pub enum AskError {
    #[error("{0}")] BadRequest(String),
    #[error("Can't find this doc")] NotFound,
    #[error("Can't find this room")] RoomNotFound,
    #[error("Waiting for an answer")] Busy,
    #[error("Too many questions running — try again when one finishes")] Capacity,
    #[error("Couldn't read agent settings: {0}")] AgentConfig(String),
    #[error("Couldn't save the conversation: {0}")] Io(String),
    #[error("Couldn't list the documents: {0}")] Listing(String),
}

impl AskError {
    pub fn code(&self) -> &'static str {
        match self {
            AskError::BadRequest(_) => "bad_request",
            AskError::NotFound | AskError::RoomNotFound => "not_found",
            AskError::Busy => "ask_busy",
            AskError::Capacity => "ask_capacity",
            AskError::AgentConfig(_) => "agent_config",
            AskError::Io(_) | AskError::Listing(_) => "io",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            AskError::BadRequest(_) => 400,
            AskError::NotFound | AskError::RoomNotFound => 404,
            AskError::Busy | AskError::Capacity => 409,
            AskError::AgentConfig(_) => 422,
            AskError::Io(_) | AskError::Listing(_) => 500,
        }
    }
}

/// What the ask bar sends: a question, with its images and model, or a command (`kind`).
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    pub question: &'a str,
    /// One of the target's models; `None` or "" leaves the agent's default.
    pub model: Option<&'a str>,
    /// Ids from `save_image`.
    pub images: &'a [String],
    pub kind: AskKind,
}

impl<'a> Request<'a> {
    pub fn question(question: &'a str) -> Self { Self { question, model: None, images: &[], kind: AskKind::Question } }

    pub fn command(kind: AskKind) -> Self { Self { kind, ..Self::question("") } }

    /// The turn's question: what was asked, trimmed and within bounds, or the command as typed.
    fn text(&self) -> Result<&'a str, AskError> {
        match self.kind {
            AskKind::Clear => Ok("/new"),
            AskKind::Compact => Ok("/compact"),
            AskKind::Question => {
                let q = self.question.trim();
                if q.is_empty() || q.chars().count() > MAX_QUESTION_CHARS {
                    return Err(AskError::BadRequest(format!("A question must be 1–{MAX_QUESTION_CHARS} characters")));
                }
                Ok(q)
            }
        }
    }

    /// A command carries no images.
    fn images(&self) -> &'a [String] { if self.kind == AskKind::Question { self.images } else { &[] } }
}

struct Entry { scope: AskScope, killer: Killer }

/// What a question is about: one doc, or the documents of a room or a Journal day.
enum Subject {
    Doc { file_key: String, file_abs: PathBuf },
    Listing { listing: Listing, entries: Vec<ContextEntry> },
}

/// Where an ask in a scope goes: the one answer both `target` and `start` use.
struct Resolved {
    subject: Subject,
    profiles: AgentProfiles,
    plan: Plan,
    session: Option<String>,
    cwd: PathBuf,
}

struct Inner {
    core: RoomsCore,
    log: AskLog,
    images: images::Images,
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
/// answer is read from stdout by `rules`, and kept even when the run failed or was stopped.
fn turn_end(agent: &str, rules: &[EventRule], outcome: Outcome) -> (AskStatus, String, Option<String>) {
    let answer = |stdout: String| read_answer(rules, stdout.as_bytes());
    match outcome {
        Outcome::Exited { code: 0, stdout, .. } => (AskStatus::Done, answer(stdout), None),
        Outcome::Exited { code, stdout, stderr_tail } => {
            let last = run::clean_output(stderr_tail.as_bytes()).lines().rev().find(|l| !l.trim().is_empty()).map(str::to_string);
            let mut m = format!("{agent} exited with an error (code {code})");
            if let Some(l) = last { m.push('\n'); m.push_str(&l); }
            (AskStatus::Failed, answer(stdout), Some(m))
        }
        Outcome::Killed { reason, stdout } => {
            let a = answer(stdout);
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
        let images = images::Images::new(core.home().join(".rooms/asks/images"));
        let cell = OnceLock::new();
        if let Some(p) = login_path { let _ = cell.set(p); }
        Self(Arc::new(Inner {
            core, log, images, login_path: cell, limits, running: Mutex::new(HashMap::new()),
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

    /// Which subject, agent, template, session and cwd an ask in `scope` would use. A room or a day
    /// has no source session: the default agent starts a new conversation in an empty folder, so a
    /// search without a path finds nothing. `start` creates that folder; `target` writes nothing.
    fn resolve(&self, scope: &AskScope) -> Result<Resolved, AskError> {
        scope.validate()?;
        let core = &self.0.core;
        let (listing, entries) = match scope {
            AskScope::Doc { file_key } => return self.resolve_doc(file_key),
            AskScope::Room { room_id } => {
                let (name, entries) = core.room_context(room_id).map_err(listing_error)?;
                (Listing::Room(name), entries)
            }
            AskScope::Day { date } => (Listing::Day(date.clone()), core.day_context(date).map_err(listing_error)?),
        };
        let profiles = AgentProfiles::load(&self.config_path()).map_err(AskError::AgentConfig)?;
        let plan = profiles.plan(None, None);
        let cwd = self.0.core.home().join(".rooms/asks/cwd");
        Ok(Resolved { subject: Subject::Listing { listing, entries }, profiles, plan, session: None, cwd })
    }

    /// A doc scope goes through the first artifact holding its file whose link still resolves
    /// (rooms linking one original share the file key, the realpath and the source meta).
    fn resolve_doc(&self, file_key: &str) -> Result<Resolved, AskError> {
        let core = &self.0.core;
        let (artifact, file_abs) = core.artifacts_by_file_key(file_key).into_iter()
            .find_map(|a| core.resolve_file(&a.room_id, &a.rel_path).ok().map(|p| (a, p)))
            .ok_or(AskError::NotFound)?;
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
        Ok(Resolved { subject: Subject::Doc { file_key: artifact.file_key, file_abs }, profiles, plan, session, cwd })
    }

    /// Blocking, like `start`: what the ask bar shows before the first question.
    pub fn target(&self, scope: &AskScope) -> Result<AskTarget, AskError> {
        let r = self.resolve(scope)?;
        Ok(AskTarget { agent: r.plan.agent, mode: r.plan.mode, models: r.plan.models })
    }

    /// Blocking (SQLite, files, std Mutex): async callers run it on the blocking pool.
    /// `model` must be one of the target's models; `None` or "" leaves the agent's default.
    pub fn start(&self, scope: &AskScope, question: &str, model: Option<&str>) -> Result<AskTurn, AskError> {
        self.start_with(scope, Request { model, ..Request::question(question) })
    }

    /// Stores an attached image; the id goes in `Request::images`. Blocking (file IO).
    pub fn save_image(&self, bytes: &[u8]) -> Result<String, AskError> {
        self.0.images.save(bytes).map_err(AskError::BadRequest)
    }

    /// The stored image `id`, for serving it back.
    pub fn image_path(&self, id: &str) -> Option<PathBuf> { self.0.images.path(id) }

    /// Starts a turn: a question goes to the agent; `/new` is recorded at once (nothing runs);
    /// `/compact` asks the agent to summarize the conversation so far. Blocking, like `start`.
    pub fn start_with(&self, scope: &AskScope, req: Request) -> Result<AskTurn, AskError> {
        let _rt = self.0.rt.as_ref().map(|h| h.enter());
        let question = req.text()?;
        let image_paths = self.image_paths(req.images())?;
        let Resolved { subject, profiles, plan, session, cwd } = self.resolve(scope)?;
        let model = req.model.filter(|m| !m.is_empty());
        if let Some(m) = model.filter(|m| !plan.models.iter().any(|x| x == m)) {
            return Err(AskError::BadRequest(format!("{} can't use the model \"{m}\" here", plan.agent)));
        }

        let running = self.reserve(scope)?;
        let prior = self.read_thread(&running, scope)?;
        let ctx = context(&prior, if plan.prompt_on_stdin() { PRIOR_CHARS_STDIN } else { PRIOR_CHARS_ARGV });
        if req.kind != AskKind::Question && ctx.is_empty() {
            return Err(AskError::BadRequest(if req.kind == AskKind::Clear { "Nothing to clear yet" } else { "Nothing to summarize yet" }.into()));
        }
        let turn = AskTurn {
            id: nanoid::nanoid!(16), scope: scope.clone(), question: question.to_string(), answer: String::new(),
            agent: plan.agent.clone(), model: model.map(str::to_string), mode: plan.mode, status: AskStatus::Running, error: None,
            started_at: now(), ended_at: None, images: req.images().to_vec(), kind: req.kind, left_out: ctx.left_out as u32,
        };
        if req.kind == AskKind::Clear { return self.record_clear(running, turn); }

        let asked = if req.kind == AskKind::Compact { COMPACT_ASK.to_string() } else { with_image_paths(question, &image_paths) };
        let (file_s, prompt, scope_settings) = match &subject {
            Subject::Doc { file_key, file_abs } => {
                let file_s = file_abs.to_string_lossy().into_owned();
                let prompt = build_prompt(profiles.preamble(), plan.mode, &file_s, file_key, &ctx, &asked);
                (file_s, prompt, String::new())
            }
            Subject::Listing { listing, entries } => {
                private_dir(&cwd).map_err(|e| AskError::Io(e.to_string()))?;
                let settings = claude_read_scope(listed(entries).iter().map(|e| e.path.as_path()));
                (String::new(), build_scope_prompt(listing, entries, &ctx, &asked), settings)
            }
        };
        let cwd_s = cwd.to_string_lossy().into_owned();
        let image_dir = if image_paths.is_empty() { String::new() } else { self.0.images.dir().to_string_lossy().into_owned() };
        // roomsd writes mcp.json only when it can find rooms-mcp; without it the flag is dropped.
        let mcp = self.0.core.home().join(".rooms/mcp.json");
        let mcp_s = if mcp.is_file() { mcp.to_string_lossy().into_owned() } else { String::new() };
        let stdin = plan.prompt_on_stdin();
        let argv = plan.render(&Vars {
            prompt: if stdin { "" } else { &prompt }, session: session.as_deref().unwrap_or(""), file: &file_s, cwd: &cwd_s, mcp_config: &mcp_s,
            model: model.unwrap_or(""), images: &image_paths, image_dir: &image_dir, scope_settings: &scope_settings,
        });
        self.launch(running, turn, argv, stdin.then_some(prompt), cwd, plan.events)
    }

    /// The stored files for `ids`; an unknown id is the user's to fix.
    fn image_paths(&self, ids: &[String]) -> Result<Vec<String>, AskError> {
        if ids.len() > images::MAX_IMAGES {
            return Err(AskError::BadRequest(format!("At most {} images per question", images::MAX_IMAGES)));
        }
        ids.iter()
            .map(|id| self.0.images.path(id).map(|p| p.to_string_lossy().into_owned()))
            .collect::<Option<_>>()
            .ok_or_else(|| AskError::BadRequest("An attached image is missing — attach it again".into()))
    }

    /// The running map, locked, once there's room for one more turn in `scope`.
    fn reserve(&self, scope: &AskScope) -> Result<MutexGuard<'_, HashMap<String, Entry>>, AskError> {
        let running = lock(&self.0.running);
        if self.0.shutting_down.load(Ordering::SeqCst) { return Err(AskError::Capacity); }
        if running.values().any(|e| e.scope == *scope) { return Err(AskError::Busy); }
        if running.len() >= MAX_RUNNING { return Err(AskError::Capacity); }
        Ok(running)
    }

    /// `/new`: nothing runs; the turn is recorded done, and the next question starts over.
    fn record_clear(&self, running: MutexGuard<'_, HashMap<String, Entry>>, mut turn: AskTurn) -> Result<AskTurn, AskError> {
        turn.status = AskStatus::Done;
        turn.ended_at = Some(now());
        self.0.log.append(&turn).map_err(|e| AskError::Io(e.to_string()))?;
        drop(running);
        self.0.core.emit_ask(EventKind::AskDone { turn: turn.clone() });
        Ok(turn)
    }

    /// Records `turn`, runs `argv` (with `stdin` as its input, if any), relays its progress, and
    /// finishes the turn when it ends.
    fn launch(&self, mut running: MutexGuard<'_, HashMap<String, Entry>>, turn: AskTurn, argv: Vec<String>, stdin: Option<String>, cwd: PathBuf, rules: Vec<EventRule>) -> Result<AskTurn, AskError> {
        self.0.log.append(&turn).map_err(|e| AskError::Io(e.to_string()))?;
        self.0.core.emit_ask(EventKind::AskStarted { turn: turn.clone() });
        let (tap, chunks) = tokio::sync::mpsc::unbounded_channel();
        let mut limits = self.0.limits;
        if !rules.is_empty() { limits.max_stdout = limits.max_stdout.saturating_mul(JSON_STDOUT_FACTOR); }
        match spawn_agent(SpawnSpec { argv: argv.clone(), stdin, cwd, path_env: self.0.login_path.get().cloned(), limits, tap: Some(tap) }) {
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
                running.insert(turn.id.clone(), Entry { scope: turn.scope.clone(), killer });
                drop(running);
                self.relay_progress(&turn, rules.clone(), chunks);
                let (me, t) = (self.clone(), turn.clone());
                tokio::spawn(async move {
                    let (status, answer, error) = match done.await {
                        Ok(outcome) => turn_end(&t.agent, &rules, outcome),
                        Err(_) => (AskStatus::Failed, String::new(), Some("Internal error".into())),
                    };
                    me.finish(t, status, answer, error);
                });
            }
        }
        Ok(turn)
    }

    /// Reads stdout chunks as they come and emits `ask.progress` with the answer so far, at most
    /// once per PROGRESS_EVERY and only on change. Ends when the run's stdout tap closes.
    fn relay_progress(&self, turn: &AskTurn, rules: Vec<EventRule>, mut chunks: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
        let me = self.clone();
        let (id, scope) = (turn.id.clone(), turn.scope.clone());
        tokio::spawn(async move {
            let mut reader = Reader::new(&rules);
            let mut raw: Vec<u8> = Vec::new();
            let mut sent: (String, Option<String>) = (String::new(), None);
            let mut tick = tokio::time::interval(PROGRESS_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut dirty = false;
            loop {
                tokio::select! {
                    chunk = chunks.recv() => match chunk {
                        Some(b) => {
                            if rules.is_empty() { raw.extend_from_slice(&b) } else { reader.push(&b) }
                            dirty = true;
                        }
                        None => break,
                    },
                    _ = tick.tick(), if dirty => {
                        dirty = false;
                        let now = if rules.is_empty() {
                            (run::clean_output(&raw), None)
                        } else if reader.saw_json() {
                            (reader.text().trim().to_string(), reader.activity().map(str::to_string))
                        } else {
                            continue;
                        };
                        if now == sent { continue; }
                        // Under the running lock: `finish` removes the turn under it before `ask.done`,
                        // so no progress can follow the done event.
                        let running = lock(&me.0.running);
                        if !running.contains_key(&id) { break; }
                        me.0.core.emit_ask(EventKind::AskProgress { id: id.clone(), scope: scope.clone(), answer: now.0.clone(), activity: now.1.clone() });
                        drop(running);
                        sent = now;
                    }
                }
            }
        });
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

    fn read_thread(&self, running: &HashMap<String, Entry>, scope: &AskScope) -> Result<Vec<AskTurn>, AskError> {
        let mut turns = self.0.log.read(scope).map_err(|e| AskError::Io(e.to_string()))?;
        for t in &mut turns {
            if t.status == AskStatus::Running && !running.contains_key(&t.id) {
                t.status = AskStatus::Failed;
                t.error = Some(RESTARTED.into());
            }
        }
        Ok(turns)
    }

    pub fn thread(&self, scope: &AskScope) -> Result<Vec<AskTurn>, AskError> {
        scope.validate()?;
        let running = lock(&self.0.running);
        self.read_thread(&running, scope)
    }

    /// Stops a running turn; false when it isn't running here (it already ended, or roomsd restarted).
    pub fn cancel(&self, ask_id: &str) -> bool {
        match lock(&self.0.running).get(ask_id) {
            Some(e) => { e.killer.kill(Reason::Cancelled); true }
            None => false,
        }
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

/// A room or day listing that failed: a missing room is the user's to see, a bad scope theirs to
/// fix, and anything else (the index, the disk) is reported as what it is.
fn listing_error(e: CoreError) -> AskError {
    match e {
        CoreError::RoomNotFound => AskError::RoomNotFound,
        CoreError::InvalidInput(m) | CoreError::BadRequest(m) => AskError::BadRequest(m),
        // Their own text says "write failed", which a listing never does.
        CoreError::Io(e) => AskError::Listing(e.to_string()),
        CoreError::Db(e) => AskError::Listing(e.to_string()),
        e => AskError::Listing(e.to_string()),
    }
}

/// Creates `dir` if needed and makes it private to the user, an existing one included.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_errors_wire_codes_and_statuses() {
        let wire = |e: AskError| (e.status(), e.code(), e.to_string());
        assert_eq!(wire(AskError::BadRequest("why".into())), (400, "bad_request", "why".into()));
        assert_eq!(wire(AskError::NotFound), (404, "not_found", "Can't find this doc".into()));
        assert_eq!(wire(AskError::RoomNotFound), (404, "not_found", "Can't find this room".into()));
        assert_eq!(wire(AskError::Busy), (409, "ask_busy", "Waiting for an answer".into()));
        assert_eq!(wire(AskError::Capacity), (409, "ask_capacity", "Too many questions running — try again when one finishes".into()));
        assert_eq!(wire(AskError::AgentConfig("x".into())), (422, "agent_config", "Couldn't read agent settings: x".into()));
        assert_eq!(wire(AskError::Io("x".into())), (500, "io", "Couldn't save the conversation: x".into()));
        assert_eq!(wire(AskError::Listing("x".into())), (500, "io", "Couldn't list the documents: x".into()));
    }

    fn exited(code: i32, stdout: &str, stderr_tail: &str) -> Outcome {
        Outcome::Exited { code, stdout: stdout.into(), stderr_tail: stderr_tail.into() }
    }

    fn killed(reason: Reason, stdout: &str) -> Outcome { Outcome::Killed { reason, stdout: stdout.into() } }

    #[test]
    fn turn_end_maps_every_outcome() {
        let t = |agent: &str, o: Outcome| turn_end(agent, &[], o);
        assert_eq!(t("codex", exited(0, "\x1b[1mhi\x1b[0m\n", "noise")), (AskStatus::Done, "hi".into(), None));
        assert_eq!(t("codex", exited(2, "partial", "warn\nboom: bad flag\n\n")),
            (AskStatus::Failed, "partial".into(), Some("codex exited with an error (code 2)\nboom: bad flag".into())));
        assert_eq!(t("codex", exited(1, "", "  \n")), (AskStatus::Failed, String::new(), Some("codex exited with an error (code 1)".into())));
        assert_eq!(t("codex", killed(Reason::Cancelled, "so far")), (AskStatus::Cancelled, "so far".into(), None));
        assert_eq!(t("codex", killed(Reason::Shutdown, "")), (AskStatus::Cancelled, String::new(), None));
        assert_eq!(t("codex", killed(Reason::Timeout, "a")), (AskStatus::Failed, "a".into(), Some("Stopped: took too long".into())));
        assert_eq!(t("codex", killed(Reason::TooLong, "a")), (AskStatus::Failed, "a".into(), Some("Stopped: the answer was too long".into())));
    }

    #[test]
    fn answers_come_from_event_rules_or_plain_stdout() {
        let rules: Vec<EventRule> = vec![toml::from_str("match = { \"/type\" = \"result\" }\nanswer = \"/result\"").unwrap()];
        let json = "{\"type\":\"system\"}\n{\"type\":\"result\",\"result\":\"  **Done**\\n\"}\n";
        assert_eq!(read_answer(&rules, json.as_bytes()), "**Done**");
        // no JSON line: the template has no JSON flag, so stdout is the answer
        assert_eq!(read_answer(&rules, b"\x1b[1mplain\x1b[0m\n"), "plain");
        assert_eq!(read_answer(&[], json.as_bytes()), json.trim());
        assert_eq!(turn_end("claude-code", &rules, exited(0, json, "")), (AskStatus::Done, "**Done**".into(), None));
        assert_eq!(turn_end("claude-code", &rules, killed(Reason::Cancelled, "{\"type\":\"x\"}")), (AskStatus::Cancelled, String::new(), None));
    }

    #[test]
    fn scope_keys_round_trip_and_reject_bad_input() {
        let good = [
            (AskScope::Doc { file_key: "0123456789abcdef".into() }, "doc:0123456789abcdef"),
            (AskScope::Room { room_id: "my-room_2".into() }, "room:my-room_2"),
            // nanoid ids can start with either
            (AskScope::Room { room_id: "-abc".into() }, "room:-abc"),
            (AskScope::Room { room_id: "_abc".into() }, "room:_abc"),
            (AskScope::Day { date: "2026-10-09".into() }, "day:2026-10-09"),
        ];
        for (scope, key) in good {
            assert_eq!(scope.key(), key);
            assert_eq!(AskScope::parse_key(key).unwrap(), scope);
        }
        let long_doc = format!("doc:{}", "a".repeat(65));
        let long_room = format!("room:{}", "a".repeat(65));
        for bad in ["../x", "doc:../x", "room:journal", "room:Journal", "room:JOURNAL", "room:a b", "room:a.b", "room:a/b", "day:2026-13-01", "day:2026-1-1", long_doc.as_str(), long_room.as_str(), "doc:", "room:", "0123456789abcdef", "week:2026-10-09", ""] {
            assert!(matches!(AskScope::parse_key(bad), Err(AskError::BadRequest(_))), "{bad}");
        }
        assert!(AskScope::Room { room_id: JOURNAL_ROOM_ID.into() }.validate().is_err());
        assert!(AskScope::Doc { file_key: "a.b".into() }.validate().is_err());
    }

    #[tokio::test]
    async fn busy_is_per_scope() {
        let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-agent.sh");
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let room = core.create_room("r").unwrap();
        std::fs::write(core.room_root(&room.id).unwrap().0.join("doc.html"), "<title>d</title>").unwrap();
        core.backfill_all().unwrap();
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        std::fs::write(d.path().join(".rooms/agents.toml"), format!("[agents.claude-code]\nnew = [\"{fake}\", \"{{prompt}}\"]\n")).unwrap();
        let asks = Asks::new(core.clone(), None);
        let file_key = core.list_artifacts(&room.id).unwrap().remove(0).file_key;
        let doc = AskScope::Doc { file_key: file_key.clone() };
        let t = asks.start(&doc, "SLEEP", None).unwrap();
        assert!(matches!(asks.reserve(&doc), Err(AskError::Busy)));
        let room_like = AskScope::Room { room_id: file_key.clone() };
        assert!(asks.reserve(&room_like).is_ok());
        assert!(asks.reserve(&AskScope::Day { date: "2026-10-09".into() }).is_ok());
        assert_eq!(asks.thread(&room_like).unwrap().len(), 0);
        assert_eq!(asks.thread(&doc).unwrap()[0].id, t.id);
        assert!(matches!(asks.start(&room_like, "q", None), Err(AskError::RoomNotFound)));
        assert!(matches!(asks.target(&room_like), Err(AskError::RoomNotFound)));
        asks.shutdown().await;
    }

    #[tokio::test]
    async fn room_ask_uses_default_agent_new_mode_and_empty_cwd() {
        use rooms_protocol::AskMode;
        let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-agent.sh");
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let room = core.create_room("Research").unwrap();
        let meta = r#"<meta name="rooms:agent" content="claude-code"><meta name="rooms:session" content="s1">"#;
        std::fs::write(core.room_root(&room.id).unwrap().0.join("doc.html"), format!("<title>d</title>{meta}")).unwrap();
        core.backfill_all().unwrap();
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        std::fs::write(d.path().join(".rooms/agents.toml"), format!(concat!(
            "default = \"mine\"\npreamble = \"DOC ONLY\"\n",
            "[agents.mine]\nresume = [\"{f}\", \"resume\", \"{{session}}\", \"{{prompt}}\"]\nnew = [\"{f}\", \"new\", \"{{file}}\", \"{{cwd}}\", \"{{prompt}}\"]\n",
            "[agents.claude-code]\nresume = [\"{f}\", \"cc-resume\", \"{{session}}\", \"{{prompt}}\"]\nnew = [\"{f}\", \"cc\", \"{{prompt}}\"]\n",
        ), f = fake)).unwrap();
        let asks = Asks::new(core.clone(), None);
        let scope = AskScope::Room { room_id: room.id.clone() };
        assert_eq!(asks.target(&scope).unwrap(), AskTarget { agent: "mine".into(), mode: AskMode::New, models: vec![] });
        assert_eq!(asks.target(&AskScope::Day { date: "2026-10-09".into() }).unwrap().agent, "mine");
        assert!(!d.path().join(".rooms/asks").exists(), "target writes nothing");
        let mut rx = core.subscribe();
        let t = asks.start(&scope, "q", None).unwrap();
        assert_eq!((t.agent.as_str(), t.mode), ("mine", AskMode::New));
        let answer = loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
            if let EventKind::AskDone { turn } = ev.kind { break turn.answer; }
        };
        let cwd = std::fs::canonicalize(d.path().join(".rooms/asks/cwd")).unwrap();
        assert!(answer.starts_with(&format!("ARGV: [new] [] [{}] [[Rooms] The user is looking at the room", core.home().join(".rooms/asks/cwd").display())), "{answer}");
        assert!(answer.ends_with(&format!("CWD: {}", cwd.display())), "{answer}");
        assert!(!answer.contains("resume") && !answer.contains("DOC ONLY"), "{answer}");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&cwd).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read_dir(&cwd).unwrap().count(), 0);
    }

    #[test]
    fn private_dir_creates_and_tightens() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let fresh = d.path().join("a/b/cwd");
        private_dir(&fresh).unwrap();
        assert_eq!(mode(&fresh), 0o700);
        let open = d.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        private_dir(&open).unwrap();
        assert_eq!(mode(&open), 0o700, "a folder left open by an earlier run is made private");
    }

    #[test]
    fn listing_errors_say_what_failed() {
        assert!(matches!(listing_error(CoreError::RoomNotFound), AskError::RoomNotFound));
        assert!(matches!(listing_error(CoreError::InvalidInput("journal".into())), AskError::BadRequest(m) if m == "journal"));
        let db = listing_error(CoreError::Db(rusqlite::Error::InvalidQuery));
        assert!(matches!(db, AskError::Listing(_)), "{db:?}");
        assert!(db.to_string().starts_with("Couldn't list the documents: "), "{db}");
        let io = listing_error(CoreError::Io(std::io::Error::other("disk")));
        assert_eq!(io.to_string(), "Couldn't list the documents: disk");
    }

    /// `cargo test -p rooms-core --release context_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn context_timing() {
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let originals = tempfile::tempdir().unwrap();
        let today = crate::rules::local_day(&chrono::Local::now().to_rfc3339()).unwrap();
        let pct = |mut v: Vec<f64>, p: f64| { v.sort_by(f64::total_cmp); v[((v.len() - 1) as f64 * p).round() as usize] };
        let ctx = prompt::Context::default();
        for n in [10, 100, 450] {
            let room = core.create_room(&format!("r{n}")).unwrap();
            let root = core.room_root(&room.id).unwrap().0;
            for i in 0..n {
                let o = originals.path().join(format!("r{n}-{i}.html"));
                std::fs::write(&o, format!("<title>Doc {i} of room {n}</title>")).unwrap();
                std::os::unix::fs::symlink(&o, root.join(format!("{i}.html"))).unwrap();
            }
            core.backfill_all().unwrap();
            let mut ms = Vec::new();
            let mut bytes = 0;
            for _ in 0..30 {
                let t = std::time::Instant::now();
                let (name, entries) = core.room_context(&room.id).unwrap();
                bytes = build_scope_prompt(&Listing::Room(name), &entries, &ctx, "q").len();
                ms.push(t.elapsed().as_secs_f64() * 1e3);
            }
            println!("room {n:>3} docs: p50 {:.2} ms  p95 {:.2} ms  prompt {bytes} bytes", pct(ms.clone(), 0.5), pct(ms, 0.95));
        }
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        let room = core.create_room("day").unwrap();
        let root = core.room_root(&room.id).unwrap().0;
        for i in 0..40 {
            let o = originals.path().join(format!("day-{i}.html"));
            std::fs::write(&o, format!("<title>Day doc {i}</title>")).unwrap();
            std::os::unix::fs::symlink(&o, root.join(format!("{i}.html"))).unwrap();
        }
        core.backfill_all().unwrap();
        for i in 0..20 { core.save_note(&today, &format!("n{i}.md"), "x").unwrap(); }
        let mut ms = Vec::new();
        let mut count = 0;
        for _ in 0..30 {
            let t = std::time::Instant::now();
            let entries = core.day_context(&today).unwrap();
            count = entries.len();
            build_scope_prompt(&Listing::Day(today.clone()), &entries, &ctx, "q");
            ms.push(t.elapsed().as_secs_f64() * 1e3);
        }
        println!("day of {count} items: p50 {:.2} ms  p95 {:.2} ms", pct(ms.clone(), 0.5), pct(ms, 0.95));
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
