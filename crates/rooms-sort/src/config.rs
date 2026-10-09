//! `<home>/.rooms/sort.toml` (spec §6) and the data folder. The key is never in this file.
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const DATA_ENV: &str = "ROOMS_SORT_DATA";
const APP_ID: &str = "computer.alto.rooms";

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Off: nothing moves, not even by R1 and R2.
    pub enabled: bool,
    pub min_confidence: f64,
    pub new_room_min_docs: usize,
    pub model: String,
    pub max_docs_per_run: usize,
    pub ignore_names: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: true, min_confidence: 0.7, new_room_min_docs: 3, model: "jev-1.13.0".into(), max_docs_per_run: 50, ignore_names: Vec::new() }
    }
}

impl Config {
    pub fn path(home: &Path) -> PathBuf { home.join(".rooms/sort.toml") }

    /// Missing file: the defaults. A broken one is reported and ignored.
    pub fn load(home: &Path) -> Config {
        match std::fs::read_to_string(Self::path(home)) {
            Ok(s) => toml::from_str(&s).unwrap_or_else(|e| {
                eprintln!("rooms-sort: ignoring {}: {e}", Self::path(home).display());
                Config::default()
            }),
            Err(_) => Config::default(),
        }
    }

    pub fn rules(&self) -> crate::rules::Config {
        crate::rules::Config {
            min_confidence: self.min_confidence,
            new_room_min_docs: self.new_room_min_docs.max(1),
            ignore_names: self.ignore_names.clone(),
        }
    }
}

/// `$ROOMS_SORT_DATA`, else the app's data folder (shared with rooms-collect; separate files).
pub fn data_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var(DATA_ENV) { if !d.is_empty() { return Some(PathBuf::from(d)); } }
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
        std::fs::write(Config::path(d.path()), "min_confidence = 0.8\nignore_names = ['sandbox']\n").unwrap();
        let c = Config::load(d.path());
        assert!(c.enabled && c.min_confidence == 0.8 && c.ignore_names == ["sandbox"] && c.new_room_min_docs == 3);
        std::fs::write(Config::path(d.path()), "api_key = 'x'").unwrap();
        assert_eq!(Config::load(d.path()), Config::default(), "unknown keys (a key, say) are refused");
    }
}
