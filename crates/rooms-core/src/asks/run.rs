//! Runs one agent CLI: no shell, its own process group, stdin /dev/null, with limits (spec R8, S6).
use crate::lock::lock;
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

/// `tap`, when set, gets a copy of every stdout chunk as it is read (for live progress).
pub(crate) struct SpawnSpec { pub argv: Vec<String>, pub cwd: PathBuf, pub path_env: Option<String>, pub limits: Limits, pub tap: Option<mpsc::UnboundedSender<Vec<u8>>> }

/// Lossy UTF-8, ANSI escapes (CSI `ESC [ … final` and two-char `ESC x`) removed, trimmed.
pub(crate) fn clean_output(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' { out.push(c); continue; }
        if let Some('[') = it.next() {
            for d in it.by_ref() { if ('\x40'..='\x7e').contains(&d) { break; } }
        }
    }
    out.trim().to_string()
}

fn signal_group(pid: i32, sig: i32) {
    // SAFETY: killpg(2) on the process group we created for this child (process_group(0)).
    unsafe { libc::killpg(pid, sig); }
}

/// The leader has exited; end whatever it left in its group (spec S6: no orphans). An empty
/// group costs nothing; otherwise SIGTERM, ≤ 300 ms to go, then SIGKILL.
async fn end_leftovers(pid: Option<i32>) {
    let Some(pid) = pid else { return };
    // SAFETY: signal 0 only checks whether the group still has members.
    let alive = || unsafe { libc::killpg(pid, 0) } == 0;
    if !alive() { return; }
    signal_group(pid, libc::SIGTERM);
    let until = tokio::time::Instant::now() + Duration::from_millis(300);
    while alive() && tokio::time::Instant::now() < until { tokio::time::sleep(Duration::from_millis(20)).await; }
    if alive() { signal_group(pid, libc::SIGKILL); }
}

/// SIGTERM the child's process group, SIGKILL after the grace period, then reap the child.
async fn terminate(child: &mut tokio::process::Child, pid: Option<i32>, reason: Reason, kill_grace: Duration) {
    if let Some(pid) = pid {
        signal_group(pid, libc::SIGTERM);
        let grace = if reason == Reason::Shutdown { Duration::from_millis(300) } else { kill_grace };
        if tokio::time::timeout(grace, child.wait()).await.is_err() { signal_group(pid, libc::SIGKILL); }
    }
    let _ = child.wait().await;
}

pub(crate) fn spawn_agent(spec: SpawnSpec) -> std::io::Result<Running> {
    let mut cmd = tokio::process::Command::new(&spec.argv[0]);
    cmd.args(&spec.argv[1..]).current_dir(&spec.cwd)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .process_group(0).kill_on_drop(true);
    if let Some(p) = &spec.path_env { cmd.env("PATH", p); }
    // macOS has no pipe2: std makes each pipe, then marks it close-on-exec. Two concurrent spawns
    // could leak one child's pipe ends into the other (and its long-lived descendants), so spawn one at a time.
    static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let mut child = { let _g = lock(&SPAWN); cmd.spawn()? };
    let pid = child.id().map(|p| p as i32);
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let (tx, mut rx) = mpsc::unbounded_channel::<Reason>();
    let limits = spec.limits;
    let tap = spec.tap;
    let send_tap = move |bytes: &[u8]| if let Some(t) = &tap { let _ = t.send(bytes.to_vec()); };
    let done = tokio::spawn(async move {
        let tail_max = limits.stderr_tail;
        let mut err_task = tokio::spawn(async move {
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
        // The leader can exit while a descendant still holds stdout, so its exit is raced too.
        enum Next { Eof, Exit(i32), Stop(Reason) }
        let code_of = |s: std::io::Result<std::process::ExitStatus>| s.ok().and_then(|s| s.code()).unwrap_or(-1);
        let next = loop {
            tokio::select! {
                n = stdout.read(&mut buf) => match n {
                    Ok(0) | Err(_) => break Next::Eof,
                    Ok(n) => {
                        send_tap(&buf[..n]);
                        out.extend_from_slice(&buf[..n]);
                        if out.len() > limits.max_stdout { out.truncate(limits.max_stdout); break Next::Stop(Reason::TooLong); }
                    }
                },
                status = child.wait() => break Next::Exit(code_of(status)),
                _ = &mut deadline => break Next::Stop(Reason::Timeout),
                Some(r) = rx.recv() => break Next::Stop(r),
            }
        };
        // Leader gone: take what stdout still has for ≤ 200 ms, never waiting on a descendant.
        let next = match next {
            Next::Exit(code) => {
                let drain_until = tokio::time::Instant::now() + Duration::from_millis(200);
                loop {
                    match tokio::time::timeout_at(drain_until, stdout.read(&mut buf)).await {
                        Ok(Ok(n)) if n > 0 => {
                            send_tap(&buf[..n]);
                            out.extend_from_slice(&buf[..n]);
                            if out.len() > limits.max_stdout { out.truncate(limits.max_stdout); break Next::Stop(Reason::TooLong); }
                        }
                        _ => break Next::Exit(code),
                    }
                }
            }
            n => n,
        };
        let stdout_text = String::from_utf8_lossy(&out).into_owned();
        // A descendant may still hold stderr open; do not wait for it.
        async fn stderr_tail(err_task: &mut tokio::task::JoinHandle<String>) -> String {
            match tokio::time::timeout(Duration::from_millis(200), &mut *err_task).await {
                Ok(t) => t.unwrap_or_default(),
                Err(_) => { err_task.abort(); String::new() }
            }
        }
        // After stdout EOF the child may still run (or hold descendants): keep racing
        // its exit against the deadline and kill requests.
        let reason = match next {
            Next::Stop(r) => r,
            Next::Exit(code) => {
                end_leftovers(pid).await;
                return Outcome::Exited { code, stdout: stdout_text, stderr_tail: stderr_tail(&mut err_task).await };
            }
            Next::Eof => tokio::select! {
                status = child.wait() => {
                    let code = code_of(status);
                    end_leftovers(pid).await;
                    return Outcome::Exited { code, stdout: stdout_text, stderr_tail: stderr_tail(&mut err_task).await };
                }
                _ = &mut deadline => Reason::Timeout,
                Some(r) = rx.recv() => r,
            },
        };
        terminate(&mut child, pid, reason, limits.kill_grace).await;
        err_task.abort();
        Outcome::Killed { reason, stdout: stdout_text }
    });
    Ok(Running { killer: Killer(tx), done })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(script: &str, limits: Limits) -> SpawnSpec {
        SpawnSpec { argv: vec!["/bin/sh".into(), "-c".into(), script.into()], cwd: std::env::temp_dir(), path_env: None, limits, tap: None }
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
        let s = SpawnSpec { argv: vec!["/bin/echo".into(), "a; echo HACKED".into()], cwd: std::env::temp_dir(), path_env: None, limits: Limits::default(), tap: None };
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
        let s = SpawnSpec { argv: vec!["definitely-not-a-cli-xyz".into()], cwd: std::env::temp_dir(), path_env: Some("/nonexistent".into()), limits: Limits::default(), tap: None };
        assert_eq!(spawn_agent(s).err().unwrap().kind(), std::io::ErrorKind::NotFound);
    }

    async fn within_5s<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), f).await.expect("must not hang")
    }

    #[tokio::test]
    async fn timeout_applies_after_stdout_closes() {
        let l = Limits { timeout: Duration::from_millis(300), ..Limits::default() };
        let r = spawn_agent(spec("exec 1>&-; sleep 30", l)).unwrap();
        let out = within_5s(r.done).await.unwrap();
        assert!(matches!(out, Outcome::Killed { reason: Reason::Timeout, .. }), "{out:?}");
    }

    #[tokio::test]
    async fn cancel_applies_after_stdout_closes() {
        let r = spawn_agent(spec("exec 1>&-; sleep 30", Limits::default())).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        r.killer.kill(Reason::Cancelled);
        let out = within_5s(r.done).await.unwrap();
        assert!(matches!(out, Outcome::Killed { reason: Reason::Cancelled, .. }), "{out:?}");
    }

    #[tokio::test]
    async fn exit_does_not_wait_for_a_descendant_holding_stderr() {
        let r = spawn_agent(spec("sleep 30 >/dev/null & exit 0", Limits::default())).unwrap();
        let out = within_5s(r.done).await.unwrap();
        assert!(matches!(out, Outcome::Exited { code: 0, .. }), "{out:?}");
    }

    /// Polls `kill(pid, 0)` for up to 1 s: true once the process is gone.
    async fn gone_within_1s(pid: i32) -> bool {
        for _ in 0..50 {
            // SAFETY: signal 0 only checks that the pid exists.
            if unsafe { libc::kill(pid, 0) } != 0 { return true; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    async fn exits_and_leaves_no_descendant(script: &str, want_stdout: &str) {
        let d = tempfile::tempdir().unwrap();
        let pidfile = d.path().join("bg.pid");
        let script = script.replace("PIDFILE", &pidfile.display().to_string());
        let r = spawn_agent(spec(&script, Limits::default())).unwrap();
        match within_5s(r.done).await.unwrap() {
            Outcome::Exited { code: 0, stdout, .. } => assert_eq!(stdout, want_stdout),
            other => panic!("{other:?}"),
        }
        let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        assert!(gone_within_1s(pid).await, "descendant {pid} outlived the turn");
    }

    #[tokio::test]
    async fn exit_does_not_wait_for_a_descendant_holding_stdout() {
        exits_and_leaves_no_descendant("printf done; sleep 30 & echo $! > PIDFILE; exit 0", "done").await;
    }

    #[tokio::test]
    async fn exit_does_not_leave_a_descendant_holding_stderr() {
        exits_and_leaves_no_descendant("printf done; sleep 30 >/dev/null & echo $! > PIDFILE; exit 0", "done").await;
    }
}
