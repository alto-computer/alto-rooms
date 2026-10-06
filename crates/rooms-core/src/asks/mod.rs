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
