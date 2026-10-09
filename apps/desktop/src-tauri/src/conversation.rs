//! "Continue in <Agent>": resume a conversation's real session in Terminal. The webview names
//! the conversation; this side writes a `.command` script and has Terminal open it. The agent
//! picks a fixed command line and the session id is a checked token, so the folder is the only
//! free text in the script, and it is single-quoted.

use std::fmt;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use rooms_protocol::{Agent, ConversationId, SessionId};
use tauri::{AppHandle, Manager};

/// An Aside account, `~/.aside/u/<n>`, which Aside names `u<n>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AsideAccount(u32);

impl fmt::Display for AsideAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "u{}", self.0)
    }
}

fn single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The script Terminal runs: go to the folder the conversation started in (Claude Code keys its
/// sessions by project folder), then resume in the user's login shell so their PATH applies.
/// `account` only means something for Aside.
pub fn resume_script(agent: Agent, session: &SessionId, cwd: Option<&str>, account: Option<AsideAccount>) -> String {
    let mut argv = agent.resume_argv(session);
    if let (Agent::Aside, Some(account)) = (agent, account) {
        // Before the id: everything after it is Aside's follow-up prompt.
        let at = argv.len() - 1;
        argv.splice(at..at, ["--account".to_string(), account.to_string()]);
    }
    let cd = match cwd {
        Some(dir) => format!("cd -- {} || cd ~", single_quote(dir)),
        None => "cd ~".to_string(),
    };
    format!("#!/bin/sh\n{cd}\nexec \"${{SHELL:-/bin/zsh}}\" -lic {}\n", single_quote(&argv.join(" ")))
}

/// The account whose sessions hold `session`, from `<accounts>/<n>/sessions/<YYYY-MM-DD>_<session>`.
fn aside_account(accounts: &Path, session: &SessionId) -> Option<AsideAccount> {
    std::fs::read_dir(accounts).ok()?.flatten().find_map(|account| {
        let n = account.file_name().to_str()?.parse().ok()?;
        let mut sessions = std::fs::read_dir(account.path().join("sessions")).ok()?.flatten();
        sessions
            .any(|s| s.file_name().to_str().and_then(|name| name.split_once('_')).is_some_and(|(_, id)| id == session.as_str()))
            .then_some(AsideAccount(n))
    })
}

/// Writes `<dir>/<agent>-<session>.command` (owner-only, executable) and returns its path.
fn write_script(dir: &Path, home: &Path, id: &ConversationId, cwd: Option<&str>) -> Result<PathBuf, String> {
    // The id is the only argument after `--resume`/`resume`; a leading dash would read as a flag.
    if id.session.as_str().starts_with('-') {
        return Err(format!("invalid session id {:?}", id.session.as_str()));
    }
    let account = match id.agent {
        Agent::Aside => aside_account(&home.join(".aside/u"), &id.session),
        Agent::ClaudeCode | Agent::Codex => None,
    };
    let script = resume_script(id.agent, &id.session, cwd, account);
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{}-{}.command", id.agent.as_str(), id.session));
    let fail = |e: std::io::Error| format!("{}: {e}", path.display());
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o700).open(&path).map_err(fail)?;
    // `mode` only applies when the file is created; a script left by an earlier continue keeps its own.
    file.set_permissions(std::fs::Permissions::from_mode(0o700)).map_err(fail)?;
    file.write_all(script.as_bytes()).map_err(fail)?;
    Ok(path)
}

#[tauri::command(async)]
pub fn continue_conversation(app: AppHandle, id: ConversationId, cwd: Option<String>) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| format!("no app cache dir: {e}"))?.join("continue");
    let home = app.path().home_dir().map_err(|e| format!("no home dir: {e}"))?;
    let script = write_script(&dir, &home, &id, cwd.as_deref())?;
    let status = Command::new("open").arg("-a").arg("Terminal").arg(&script).status().map_err(|e| format!("open: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open -a Terminal {}: {status}", script.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn session(s: &str) -> SessionId {
        SessionId::parse(s).unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rooms-continue-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Runs `script` with a stand-in login shell; returns the folder it ran in and the shell's arguments.
    fn run(script: &str, home: &Path) -> (String, Vec<String>) {
        let file = home.join("run.command");
        fs::write(&file, script).unwrap();
        let shell = home.join("shell");
        fs::write(&shell, "#!/bin/sh\npwd -P\nfor a; do echo \"$a\"; done\n").unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        let out = Command::new("/bin/sh").arg(&file).env("HOME", home).env("SHELL", &shell).output().unwrap();
        assert!(out.status.success(), "{script}: {}", String::from_utf8_lossy(&out.stderr));
        let mut lines = String::from_utf8(out.stdout).unwrap().lines().map(String::from).collect::<Vec<_>>();
        (lines.remove(0), lines)
    }

    #[test]
    fn each_agent_resumes_its_session_in_the_login_shell() {
        let s = session("abc-123_X");
        let shell = |agent| resume_script(agent, &s, Some("/p"), None).lines().nth(2).unwrap().to_string();
        assert_eq!(shell(Agent::ClaudeCode), r#"exec "${SHELL:-/bin/zsh}" -lic 'claude --resume abc-123_X'"#);
        assert_eq!(shell(Agent::Codex), r#"exec "${SHELL:-/bin/zsh}" -lic 'codex resume abc-123_X'"#);
        assert_eq!(shell(Agent::Aside), r#"exec "${SHELL:-/bin/zsh}" -lic 'aside session resume abc-123_X'"#);
    }

    #[test]
    fn aside_names_the_account_when_known_and_others_ignore_it() {
        let s = session("dvgVNACYa87tj5WH");
        let shell = |agent, account| resume_script(agent, &s, None, account).lines().nth(2).unwrap().to_string();
        assert_eq!(
            shell(Agent::Aside, Some(AsideAccount(1))),
            r#"exec "${SHELL:-/bin/zsh}" -lic 'aside session resume --account u1 dvgVNACYa87tj5WH'"#
        );
        assert_eq!(shell(Agent::Aside, None), r#"exec "${SHELL:-/bin/zsh}" -lic 'aside session resume dvgVNACYa87tj5WH'"#);
        assert_eq!(shell(Agent::Codex, Some(AsideAccount(1))), r#"exec "${SHELL:-/bin/zsh}" -lic 'codex resume dvgVNACYa87tj5WH'"#);
    }

    #[test]
    fn the_folder_is_taken_literally() {
        let d = fs::canonicalize(temp_dir("cwd")).unwrap();
        let dir = d.join("it's a $(touch pwned) `id` \"dir\"");
        fs::create_dir_all(&dir).unwrap();
        let script = resume_script(Agent::ClaudeCode, &session("s1"), Some(dir.to_str().unwrap()), None);
        assert_eq!(script.lines().nth(1).unwrap(), format!(r#"cd -- '{}/it'\''s a $(touch pwned) `id` "dir"' || cd ~"#, d.display()));
        let (ran_in, args) = run(&script, &d);
        assert_eq!(ran_in, dir.to_str().unwrap());
        assert_eq!(args, ["-lic", "claude --resume s1"]);
        assert!(!d.join("pwned").exists() && !dir.join("pwned").exists(), "the folder name ran as a command");
    }

    #[test]
    fn a_missing_or_unknown_folder_falls_back_to_home() {
        let home = fs::canonicalize(temp_dir("home")).unwrap();
        for cwd in [Some("/no/such/folder"), None] {
            let (ran_in, args) = run(&resume_script(Agent::Codex, &session("s1"), cwd, None), &home);
            assert_eq!(ran_in, home.to_str().unwrap(), "{cwd:?}");
            assert_eq!(args, ["-lic", "codex resume s1"]);
        }
    }

    #[test]
    fn bad_session_ids_are_refused_at_the_boundary() {
        for bad in ["x; rm -rf ~", "a'b", "$(id)", "", "a b"] {
            let wire = serde_json::json!({ "agent": "codex", "session": bad });
            assert!(serde_json::from_value::<ConversationId>(wire).is_err(), "{bad:?} must be refused");
        }
        let d = temp_dir("dash");
        let flag = ConversationId { agent: Agent::ClaudeCode, session: session("-dangerously-skip-permissions") };
        assert!(write_script(&d.join("continue"), &d, &flag, Some("/p")).is_err());
        assert!(!d.join("continue").exists(), "nothing written for a refused id");
    }

    #[test]
    fn the_script_is_written_owner_only_and_executable() {
        let d = temp_dir("write");
        let id = ConversationId { agent: Agent::Codex, session: session("019a-b2") };
        let path = d.join("continue/codex-019a-b2.command");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "stale").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        assert_eq!(write_script(&d.join("continue"), &d, &id, Some("/p")).unwrap(), path);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::read_to_string(&path).unwrap(), resume_script(Agent::Codex, &id.session, Some("/p"), None));
    }

    #[test]
    fn aside_scripts_find_the_account_holding_the_session() {
        let d = temp_dir("aside");
        fs::create_dir_all(d.join(".aside/u/0/sessions/2026-06-24_other")).unwrap();
        fs::create_dir_all(d.join(".aside/u/1/sessions/2026-09-28_Mall9b7xWM1Ry5sv")).unwrap();
        fs::create_dir_all(d.join(".aside/u/notes/sessions/2026-09-28_Stray")).unwrap();
        let script = |s: &str| {
            let id = ConversationId { agent: Agent::Aside, session: session(s) };
            fs::read_to_string(write_script(&d.join("continue"), &d, &id, None).unwrap()).unwrap()
        };
        assert!(script("Mall9b7xWM1Ry5sv").contains("'aside session resume --account u1 Mall9b7xWM1Ry5sv'"));
        assert!(script("Mall9b7x").contains("'aside session resume Mall9b7x'"), "a prefix is not a match");
        assert!(script("Stray").contains("'aside session resume Stray'"), "only numbered accounts count");
    }
}
