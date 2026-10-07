//! The daemon's files under `<home>/.rooms`: the single-daemon lock, the bearer token and mcp.json.
use rooms_protocol::layout::{self, DEFAULT_API_PORT};
use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Takes an exclusive, non-blocking lock on `<home>/.rooms/lock` (one daemon per home).
/// Keep the returned file alive for the daemon's lifetime; the OS releases the lock on exit.
/// Touches nothing else in `.rooms` (no state.json, no token).
pub fn acquire_home_lock(home: &Path) -> io::Result<File> {
    fs::create_dir_all(layout::daemon_dir(home))?;
    let f = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(layout::lock_path(home))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(fs::TryLockError::WouldBlock) => Err(io::Error::new(io::ErrorKind::WouldBlock, "another roomsd holds the lock")),
        Err(fs::TryLockError::Error(e)) => Err(e),
    }
}

/// `ROOMS_MCP_BIN` if set (made absolute, and the file must exist), else `rooms-mcp` next to the roomsd executable.
pub fn resolve_mcp_bin(env_override: Option<&str>, current_exe: Option<&Path>) -> Option<PathBuf> {
    let found = match env_override.filter(|s| !s.is_empty()) {
        Some(p) => fs::canonicalize(p).ok()?,
        None => current_exe?.parent()?.join("rooms-mcp"),
    };
    found.is_file().then_some(found)
}

/// Writes `<home>/.rooms/mcp.json` so agents can launch rooms-mcp (`--mcp-config`). Without a
/// binary no file is written and a stale one is removed, so asks drop the flag. Returns the path written.
pub fn write_mcp_config(home: &Path, bin: Option<&Path>, api_port: u16) -> io::Result<Option<PathBuf>> {
    let path = layout::mcp_config_path(home);
    let Some(bin) = bin.filter(|b| b.is_file()) else {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(None),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        };
    };
    let mut env = serde_json::json!({ layout::HOME_ENV: home });
    if api_port != DEFAULT_API_PORT { env["ROOMS_API_PORT"] = api_port.to_string().into(); }
    let doc = serde_json::json!({ "mcpServers": { "rooms": { "command": bin, "env": env } } });
    fs::create_dir_all(layout::daemon_dir(home))?;
    fs::write(&path, serde_json::to_vec_pretty(&doc)?)?;
    Ok(Some(path))
}

/// Writes a fresh 32-char token to `<home>/.rooms/token` (file 0600, dir 0700).
pub fn write_token(home: &Path) -> io::Result<String> {
    let dir = layout::daemon_dir(home);
    fs::create_dir_all(&dir)?;
    fs::set_permissions(&dir, Permissions::from_mode(0o700))?;
    let token = nanoid::nanoid!(32);
    let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(layout::token_path(home))?;
    // `mode` only applies on create; tighten a file that already existed.
    f.set_permissions(Permissions::from_mode(0o600))?;
    f.write_all(token.as_bytes())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::{acquire_home_lock, write_token};
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &std::path::Path) -> u32 { std::fs::metadata(p).unwrap().permissions().mode() & 0o777 }

    #[test]
    fn second_home_lock_fails_until_first_is_dropped() {
        let d = tempfile::tempdir().unwrap();
        let first = acquire_home_lock(d.path()).unwrap();
        assert!(d.path().join(".rooms/lock").is_file());
        assert!(acquire_home_lock(d.path()).is_err(), "second daemon must not get the lock");
        assert!(!d.path().join(".rooms/token").exists() && !d.path().join(".rooms/state.json").exists());
        drop(first);
        assert!(acquire_home_lock(d.path()).is_ok());
    }

    #[test]
    fn write_token_sets_modes_and_length() {
        let d = tempfile::tempdir().unwrap();
        let t = write_token(d.path()).unwrap();
        assert_eq!(t.len(), 32);
        let f = d.path().join(".rooms/token");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), t);
        assert_eq!(mode(&f), 0o600);
        assert_eq!(mode(&d.path().join(".rooms")), 0o700);
    }

    #[test]
    fn write_token_tightens_existing_file_and_regenerates() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        let f = d.path().join(".rooms/token");
        std::fs::write(&f, "old-old-old-old-old-old-old-old-old-old").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        let t = write_token(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), t);
        assert_eq!(t.len(), 32);
        assert_eq!(mode(&f), 0o600);
    }
}
