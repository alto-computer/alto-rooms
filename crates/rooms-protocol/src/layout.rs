//! Where a rooms home keeps its daemon files, and the default loopback ports.
//! Shared by roomsd (which writes these files) and rooms-mcp (which reads them).
use std::path::{Path, PathBuf};

/// The variable that overrides the rooms home.
pub const HOME_ENV: &str = "ROOMS_HOME";
pub const DEFAULT_API_PORT: u16 = 4317;
pub const DEFAULT_FILES_PORT: u16 = 4318;

/// `$ROOMS_HOME` if set, else `~/rooms`. `None` only when neither is available.
pub fn home_from_env() -> Option<PathBuf> {
    match std::env::var(HOME_ENV) {
        Ok(h) => Some(PathBuf::from(h)),
        Err(_) => dirs::home_dir().map(|d| d.join("rooms")),
    }
}

/// `<home>/.rooms`: the daemon's private folder.
pub fn daemon_dir(home: &Path) -> PathBuf { home.join(".rooms") }

/// `<home>/.rooms/token`: the bearer token for writes and private reads.
pub fn token_path(home: &Path) -> PathBuf { daemon_dir(home).join("token") }

/// `<home>/.rooms/lock`: held by the one daemon serving this home.
pub fn lock_path(home: &Path) -> PathBuf { daemon_dir(home).join("lock") }

/// `<home>/.rooms/mcp.json`: how agents launch rooms-mcp.
pub fn mcp_config_path(home: &Path) -> PathBuf { daemon_dir(home).join("mcp.json") }

/// `None` (unset) gives `default`; otherwise a nonzero u16 or an error naming the variable.
pub fn parse_port(var: &str, raw: Option<&str>, default: u16) -> Result<u16, String> {
    match raw {
        None => Ok(default),
        Some(v) => match v.trim().parse::<u16>() {
            Ok(p) if p != 0 => Ok(p),
            _ => Err(format!("{var}={v:?} is not a valid port (1-65535)")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_live_under_dot_rooms() {
        let h = Path::new("/h");
        assert_eq!(token_path(h), Path::new("/h/.rooms/token"));
        assert_eq!(lock_path(h), Path::new("/h/.rooms/lock"));
        assert_eq!(mcp_config_path(h), Path::new("/h/.rooms/mcp.json"));
    }

    #[test]
    fn port_validation() {
        assert_eq!(parse_port("X", None, 4317), Ok(4317));
        assert_eq!(parse_port("X", Some(" 9000 "), 4317), Ok(9000));
        for bad in ["abc", "0", "", "70000", "-1"] {
            let e = parse_port("ROOMS_API_PORT", Some(bad), 4317).unwrap_err();
            assert!(e.contains("ROOMS_API_PORT"), "{e}");
        }
    }
}
