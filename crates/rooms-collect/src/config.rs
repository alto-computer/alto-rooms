//! `<home>/.rooms/collect.toml` (read-only to the collector) and where the collector keeps its data.
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// The data folder: `$ROOMS_COLLECT_DATA`, else the app's data folder
/// (`~/Library/Application Support/computer.alto.rooms` on macOS).
pub const DATA_ENV: &str = "ROOMS_COLLECT_DATA";
const APP_ID: &str = "computer.alto.rooms";

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Off: the collector reads nothing and links nothing.
    pub enabled: bool,
    /// Logs changed within this many days are indexed for search; 0 turns the index off.
    pub history_days: u32,
    /// Copy log bytes into the archive before an agent deletes them.
    pub archive: bool,
    pub agents: Agents,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Agents {
    #[serde(rename = "claude-code")]
    pub claude_code: bool,
    pub codex: bool,
    pub aside: bool,
}

impl Default for Config {
    fn default() -> Self { Config { enabled: true, history_days: 30, archive: true, agents: Agents::default() } }
}

impl Default for Agents {
    fn default() -> Self { Agents { claude_code: true, codex: true, aside: true } }
}

impl Agents {
    pub fn on(&self, agent: &str) -> bool {
        match agent { "claude-code" => self.claude_code, "codex" => self.codex, "aside" => self.aside, _ => false }
    }
}

impl Config {
    pub fn path(home: &Path) -> PathBuf { home.join(".rooms/collect.toml") }

    /// The file's settings; a missing file is the defaults, a broken one is reported and ignored.
    pub fn load(home: &Path) -> Config {
        match std::fs::read_to_string(Self::path(home)) {
            Ok(s) => toml::from_str(&s).unwrap_or_else(|e| {
                eprintln!("rooms-collect: ignoring {}: {e}", Self::path(home).display());
                Config::default()
            }),
            Err(_) => Config::default(),
        }
    }
}

pub fn data_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var(DATA_ENV) { return Some(PathBuf::from(d)); }
    dirs::data_dir().map(|d| d.join(APP_ID))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_partial_and_broken_files() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Config::load(d.path()), Config::default());
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        std::fs::write(Config::path(d.path()), "history_days = 0\n[agents]\ncodex = false\n").unwrap();
        let c = Config::load(d.path());
        assert!(c.enabled && c.archive && c.history_days == 0 && !c.agents.on("codex") && c.agents.on("aside"));
        std::fs::write(Config::path(d.path()), "enabled = 'yes'").unwrap();
        assert_eq!(Config::load(d.path()), Config::default());
    }
}
