//! Plugins: folders under `<home>/.rooms/plugins/<id>/` holding `manifest.json` (`manifest`), an
//! entry HTML file with its assets, and the plugin's own `data/` (`data`). This module finds the
//! folders and, on `RoomsCore`, combines them with the enable/grant state in `state.json`.

mod data;
mod manifest;

pub use data::{append_data, delete_data, list_data, read_data, resolve_asset, valid_path, write_data, MAX_DATA_BYTES};
pub use manifest::{load_manifest, rev, Manifest, ICONS, PERMISSIONS};

use crate::core::RoomsCore;
use crate::error::CoreError;
use crate::lock::lock;
use crate::state::PluginState;
use rooms_protocol::{EventKind, PluginInfo, PluginSlots, PluginStatus, ToolCall, ToolInfo, ToolResult};
use std::path::{Path, PathBuf};

/// The plugin's own storage folder, inside its plugin folder.
const DATA: &str = "data";

/// Marks a plugin folder the app installed; holds the version it installed.
const BUNDLED_MARK: &str = ".bundled";

pub fn plugins_dir(home: &Path) -> PathBuf {
    home.join(".rooms").join("plugins")
}

/// Every plugin folder, sorted by name, with its manifest or the reason it is invalid.
pub fn scan(home: &Path) -> Vec<(String, Result<Manifest, String>)> {
    let Ok(rd) = std::fs::read_dir(plugins_dir(home)) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs.into_iter()
        .map(|d| (d.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(), load_manifest(&d)))
        .collect()
}

/// The plugin folder named exactly `id` (as `scan` would list it), with its manifest or the reason
/// it is invalid; `None` if there is none. Reads only that folder's manifest.
pub fn find(home: &Path, id: &str) -> Option<Result<Manifest, String>> {
    let dir = plugins_dir(home);
    // Matched against the listing, not just joined: `..` or a case-folded spelling on a
    // case-insensitive volume must not reach a folder `scan` lists under another name.
    let listed = std::fs::read_dir(&dir).ok()?.flatten().any(|e| e.file_name() == id);
    let dir = dir.join(id);
    (listed && dir.is_dir()).then(|| load_manifest(&dir))
}

/// Copies a plugin the app ships (`src/<id>/`) into the plugins folder when it is new or its
/// version differs from the one the app installed before. Returns the manifest when it copied.
/// Never touches a folder without the app's mark (the user's own plugin) or anything in `data/`.
pub fn install_bundled(home: &Path, src: &Path) -> std::io::Result<Option<Manifest>> {
    let Ok(m) = load_manifest(src) else { return Ok(None) };
    let target = plugins_dir(home).join(&m.id);
    if target.exists() {
        match std::fs::read_to_string(target.join(BUNDLED_MARK)) {
            Err(_) => return Ok(None),
            Ok(v) if v == m.version => return Ok(None),
            Ok(_) => {}
        }
        for e in std::fs::read_dir(&target)?.flatten() {
            if e.file_name() == DATA { continue; }
            let p = e.path();
            if e.file_type()?.is_dir() { std::fs::remove_dir_all(&p)?; } else { std::fs::remove_file(&p)?; }
        }
    }
    std::fs::create_dir_all(&target)?;
    copy_code(src, &target, true)?;
    std::fs::write(target.join(BUNDLED_MARK), &m.version)?;
    Ok(Some(m))
}

/// Regular files and folders under `from`, except `data/` at the top and any symlink.
fn copy_code(from: &Path, to: &Path, top: bool) -> std::io::Result<()> {
    for e in std::fs::read_dir(from)?.flatten() {
        let t = e.file_type()?;
        let dest = to.join(e.file_name());
        if t.is_dir() {
            if top && e.file_name() == DATA { continue; }
            std::fs::create_dir_all(&dest)?;
            copy_code(&e.path(), &dest, false)?;
        } else if t.is_file() {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

/// A file of a valid, enabled plugin to serve, with the permissions its manifest declares.
pub struct PluginAsset { pub path: PathBuf, pub permissions: Vec<String> }

impl RoomsCore {
    fn plugin_info(&self, state: &PluginState, folder: String, loaded: Result<Manifest, String>) -> PluginInfo {
        match loaded {
            Ok(m) => {
                let rev = rev(&plugins_dir(&self.home).join(&folder), &m);
                let enabled = state.enabled.contains(&m.id);
                let granted = state.grants.get(&m.id).cloned();
                let needs_approval = granted.as_ref().is_none_or(|g| !m.permissions.iter().all(|p| g.contains(p)));
                PluginInfo {
                    id: m.id, name: m.name, version: m.version, min_app_version: m.min_app_version, description: m.description,
                    entry: m.entry, permissions: m.permissions, slots: m.slots, status: PluginStatus::Ok, reason: None,
                    enabled, granted, needs_approval, rev,
                }
            }
            Err(reason) => PluginInfo {
                id: folder.clone(), name: folder, version: String::new(), min_app_version: String::new(), description: None,
                entry: String::new(), permissions: Vec::new(), slots: PluginSlots::default(), status: PluginStatus::Invalid,
                reason: Some(reason), enabled: false, granted: None, needs_approval: false, rev: String::new(),
            },
        }
    }

    fn plugin_state(&self) -> PluginState { lock(&self.inner).state.plugins.clone() }

    /// Every plugin folder, sorted by id, with its enable state.
    pub fn plugins(&self) -> Vec<PluginInfo> {
        let state = self.plugin_state();
        scan(&self.home).into_iter().map(|(f, r)| self.plugin_info(&state, f, r)).collect()
    }

    fn plugin(&self, id: &str) -> Option<PluginInfo> {
        let loaded = find(&self.home, id)?;
        Some(self.plugin_info(&self.plugin_state(), id.to_string(), loaded))
    }

    /// Turns a valid plugin on or off. Turning on grants `shown` (the permissions the user saw)
    /// limited to what the manifest declares now; `None` grants what it declares now. Turning off
    /// keeps the approval.
    pub fn set_plugin_enabled(&self, id: &str, enabled: bool, shown: Option<Vec<String>>) -> Result<PluginInfo, CoreError> {
        let m = match find(&self.home, id).ok_or(CoreError::NotFound)? {
            Ok(m) => m,
            Err(reason) => return Err(CoreError::InvalidInput(reason)),
        };
        {
            let mut inner = lock(&self.inner);
            let st = &mut inner.state.plugins;
            st.enabled.retain(|x| x != id);
            if enabled {
                st.enabled.push(id.to_string());
                st.enabled.sort();
                let granted: Vec<String> = match shown {
                    Some(seen) => m.permissions.iter().filter(|x| seen.contains(x)).cloned().collect(),
                    None => m.permissions.clone(),
                };
                st.grants.insert(id.to_string(), granted);
            }
            inner.state.save()?;
            self.emit(&mut inner, EventKind::PluginsChanged {});
        }
        self.plugin(id).ok_or(CoreError::NotFound)
    }

    /// The folder and manifest of a valid plugin the user turned on; else `NotFound`. Storage comes
    /// with turning it on, so a plugin waiting to approve *new* permissions can still save (e.g.
    /// while closing).
    fn usable_plugin(&self, id: &str) -> Result<(PathBuf, Manifest), CoreError> {
        match find(&self.home, id) {
            Some(Ok(m)) if lock(&self.inner).state.plugins.enabled.contains(&m.id) => Ok((plugins_dir(&self.home).join(id), m)),
            _ => Err(CoreError::NotFound),
        }
    }

    fn usable_plugin_dir(&self, id: &str) -> Result<PathBuf, CoreError> {
        self.usable_plugin(id).map(|(dir, _)| dir)
    }

    /// The tools of valid, enabled plugins, in plugin-id then tool-name (alphabetical) order; the
    /// manifest's `tools` is a map, so its own order is not kept.
    ///
    /// Plugins should treat `appendTo` files as append-only: the bridge may rewrite them, which
    /// races with tool appends.
    pub fn list_tools(&self) -> Vec<ToolInfo> {
        let enabled = self.plugin_state().enabled;
        let mut out = Vec::new();
        for (_, r) in scan(&self.home) {
            let Ok(m) = r else { continue };
            if !enabled.contains(&m.id) { continue; }
            for t in &m.tools {
                out.push(ToolInfo { plugin_id: m.id.clone(), name: t.name.clone(), description: t.description.clone(), input: t.input.clone() });
            }
        }
        out
    }

    /// Appends the call's input, as one envelope line, to the plugin's data file the tool declares
    /// for the resolved document, then emits `plugin.data.changed`. See `crate::tools`.
    pub fn call_tool(&self, call: &ToolCall) -> Result<ToolResult, CoreError> {
        let (dir, m) = self.usable_plugin(&call.plugin_id)?;
        let tool = m.tools.into_iter().find(|t| t.name == call.name).ok_or(CoreError::NotFound)?;
        let doc = crate::tools::doc_of(&call.input)?;
        let file_key = crate::tools::resolve_doc(self, doc)?;
        let path = tool.append_to.replace("{doc}", &file_key);
        let line = crate::tools::envelope_line(&chrono::Local::now().to_rfc3339(), &call.name, &call.input);
        // On this route a refused data path has always answered `invalid_input`, not `invalid_path`.
        append_data(&dir, &path, &line).map_err(|e| match e { CoreError::InvalidPath => CoreError::InvalidInput("invalid_path".into()), e => e })?;
        let mut inner = lock(&self.inner);
        self.emit(&mut inner, EventKind::PluginDataChanged { plugin_id: call.plugin_id.clone(), path: path.clone() });
        Ok(ToolResult { path })
    }

    pub fn read_plugin_data(&self, id: &str, rel: &str) -> Result<Option<String>, CoreError> {
        read_data(&self.usable_plugin_dir(id)?, rel)
    }

    pub fn write_plugin_data(&self, id: &str, rel: &str, text: &str) -> Result<(), CoreError> {
        write_data(&self.usable_plugin_dir(id)?, rel, text)
    }

    pub fn list_plugin_data(&self, id: &str, prefix: &str) -> Result<Vec<String>, CoreError> {
        list_data(&self.usable_plugin_dir(id)?, prefix)
    }

    pub fn delete_plugin_data(&self, id: &str, rel: &str) -> Result<(), CoreError> {
        delete_data(&self.usable_plugin_dir(id)?, rel)
    }

    /// A file of a valid, enabled plugin to serve (never under data/). Any page on the files origin
    /// can load these, so an installed plugin the user has not turned on serves nothing.
    pub fn resolve_plugin_file(&self, id: &str, rel: &str) -> Result<PluginAsset, CoreError> {
        let (dir, m) = self.usable_plugin(id)?;
        Ok(PluginAsset { path: resolve_asset(&dir, rel)?, permissions: m.permissions })
    }

    /// Installs the plugins the app ships (`src/<id>/`). A plugin seen for the first time is turned
    /// on; every bundled version gets its declared permissions, since it comes with the app, except
    /// `artifact.content`. The user approves that one on the enable card as for any plugin, and the
    /// approval carries over to later versions. A user's "off" stays off. Returns the ids it copied.
    pub fn install_bundled_plugins(&self, src: &Path) -> Result<Vec<String>, CoreError> {
        let Ok(rd) = std::fs::read_dir(src) else { return Ok(Vec::new()) };
        let mut dirs: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        let mut copied = Vec::new();
        for dir in dirs {
            let Some(m) = install_bundled(&self.home, &dir)? else { continue };
            let mut inner = lock(&self.inner);
            let st = &mut inner.state.plugins;
            if !st.bundled.contains(&m.id) {
                st.bundled.push(m.id.clone());
                st.bundled.sort();
                if !st.enabled.contains(&m.id) {
                    st.enabled.push(m.id.clone());
                    st.enabled.sort();
                }
            }
            let content_approved = st.grants.get(&m.id).is_some_and(|g| g.iter().any(|p| p == "artifact.content"));
            let granted = m.permissions.iter().filter(|p| *p != "artifact.content" || content_approved).cloned().collect();
            st.grants.insert(m.id.clone(), granted);
            inner.state.save()?;
            copied.push(m.id);
        }
        if !copied.is_empty() {
            self.plugins_changed();
        }
        Ok(copied)
    }

    /// Tells clients the plugin list may have changed (the watcher calls this).
    pub fn plugins_changed(&self) {
        let mut inner = lock(&self.inner);
        self.emit(&mut inner, EventKind::PluginsChanged {});
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::plugins_dir;
    use std::path::{Path, PathBuf};

    /// A plugin folder `folder` with `manifest` and an `index.html`.
    pub(crate) fn plugin(home: &Path, folder: &str, manifest: &str) -> PathBuf {
        let dir = plugins_dir(home).join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
        std::fs::write(dir.join("index.html"), "<p>hi</p>").unwrap();
        dir
    }

    pub(crate) const OK: &str = r#"{"id":"echo","name":"Echo","version":"0.1.0","minAppVersion":"0.3.0",
        "permissions":["rooms.read"],"slots":{"artifact.sidePanel":{"title":"Echo"},"tab":{"title":"Echo","icon":"puzzle","sidebar":true}}}"#;
}

#[cfg(test)]
mod tests {
    use super::test_support::{plugin, OK};
    use super::*;

    #[test]
    fn scan_lists_folders_sorted_with_errors() {
        let d = tempfile::tempdir().unwrap();
        plugin(d.path(), "zed", &OK.replace(r#""id":"echo""#, r#""id":"zed""#));
        plugin(d.path(), "echo", OK);
        plugin(d.path(), "broken", "{");
        std::fs::write(plugins_dir(d.path()).join("stray.txt"), "").unwrap();
        let found: Vec<(String, bool)> = scan(d.path()).into_iter().map(|(f, r)| (f, r.is_ok())).collect();
        assert_eq!(found, vec![("broken".into(), false), ("echo".into(), true), ("zed".into(), true)]);
    }

    #[test]
    fn find_loads_only_the_folder_named_exactly_id() {
        let d = tempfile::tempdir().unwrap();
        plugin(d.path(), "echo", OK);
        plugin(d.path(), "broken", "{");
        assert_eq!(find(d.path(), "echo").unwrap().unwrap().id, "echo");
        assert!(find(d.path(), "broken").unwrap().is_err());
        for missing in ["nope", "ECHO", "..", ".", "echo/..", ""] {
            assert!(find(d.path(), missing).is_none(), "{missing}");
        }
    }
}
