//! Plugins: folders under `<home>/.rooms/plugins/<id>/` holding `manifest.json`, an entry HTML
//! file with its assets, and the plugin's own `data/`. Pure file functions; `RoomsCore` combines
//! them with the enable/grant state in `state.json`.

use crate::error::CoreError;
use rooms_protocol::{PluginSlots, SidePanelSlot, TabSlot};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Largest text a plugin may store in one data file (UTF-8 bytes).
pub const MAX_DATA_BYTES: usize = 10 * 1024 * 1024;
pub const PERMISSIONS: [&str; 3] = ["rooms.read", "clipboard", "downloads"];
pub const ICONS: [&str; 12] = [
    "target", "pencil", "list-checks", "calendar", "star", "book", "flag", "layout-grid", "sparkles", "notebook", "lightbulb", "puzzle",
];
const DATA: &str = "data";

#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub min_app_version: String,
    pub description: Option<String>,
    pub entry: String,
    pub permissions: Vec<String>,
    pub slots: PluginSlots,
}

pub fn plugins_dir(home: &Path) -> PathBuf {
    home.join(".rooms").join("plugins")
}

fn invalid_path() -> CoreError { CoreError::InvalidInput("invalid_path".into()) }

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (2..=40).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn semver(v: &str) -> bool {
    let core = v.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}

/// A data or asset path: 1–200 chars, `/`-joined segments of `[A-Za-z0-9._-]`, no `.`/`..`/empty
/// segment, no leading `/`, at most 8 deep.
pub fn valid_path(rel: &str) -> bool {
    if rel.is_empty() || rel.len() > 200 { return false; }
    let segs: Vec<&str> = rel.split('/').collect();
    segs.len() <= 8
        && segs.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)))
}

fn title(v: &Value) -> Result<String, String> {
    let t = v.get("title").and_then(Value::as_str).unwrap_or("").trim();
    if t.is_empty() || t.chars().count() > 24 { return Err("slot title must be 1–24 characters".into()); }
    Ok(t.to_string())
}

/// Reads and validates `<dir>/manifest.json`; the error is a short reason for `PluginInfo.reason`.
pub fn load_manifest(dir: &Path) -> Result<Manifest, String> {
    let folder = dir.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    let raw = std::fs::read(dir.join("manifest.json")).map_err(|_| "manifest.json is missing".to_string())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|_| "manifest.json is not valid JSON".to_string())?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let id = s("id").filter(|i| valid_id(i)).ok_or("invalid id")?;
    if id != folder { return Err(format!("id \"{id}\" must equal the folder name \"{folder}\"")); }
    let name = s("name").map(|n| n.trim().to_string()).filter(|n| (1..=40).contains(&n.chars().count())).ok_or("name must be 1–40 characters")?;
    let version = s("version").filter(|x| semver(x)).ok_or("version must be semver")?;
    let min_app_version = s("minAppVersion").filter(|x| semver(x)).ok_or("minAppVersion must be a semver version")?;
    let description = s("description");
    if description.as_ref().is_some_and(|d| d.chars().count() > 200) { return Err("description must be at most 200 characters".into()); }
    let entry = s("entry").unwrap_or_else(|| "index.html".into());
    if !valid_path(&entry) || entry.split('/').next() == Some(DATA) { return Err("entry must be a file in the plugin folder, outside data/".into()); }
    let mut permissions: Vec<String> = Vec::new();
    for p in v.get("permissions").and_then(Value::as_array).cloned().unwrap_or_default() {
        let p = p.as_str().unwrap_or("").to_string();
        if !PERMISSIONS.contains(&p.as_str()) { return Err(format!("unknown permission: {p}")); }
        if !permissions.contains(&p) { permissions.push(p); }
    }
    let mut slots = PluginSlots::default();
    if let Some(obj) = v.get("slots").and_then(Value::as_object) {
        for (k, sv) in obj {
            match k.as_str() {
                "artifact.sidePanel" => slots.artifact_side_panel = Some(SidePanelSlot { title: title(sv)? }),
                "tab" => {
                    let icon = sv.get("icon").and_then(Value::as_str).map(str::to_string);
                    if icon.as_deref().is_some_and(|i| !ICONS.contains(&i)) { return Err(format!("unknown icon: {}", icon.unwrap())); }
                    slots.tab = Some(TabSlot { title: title(sv)?, icon, sidebar: sv.get("sidebar").and_then(Value::as_bool).unwrap_or(false) });
                }
                other => eprintln!("rooms-core: plugin {id}: ignoring unknown slot {other}"),
            }
        }
    }
    if slots.artifact_side_panel.is_none() && slots.tab.is_none() { return Err("declare at least one slot".into()); }
    Ok(Manifest { id, name, version, min_app_version, description, entry, permissions, slots })
}

/// Changes when the manifest or the entry file changes (first 12 hex of a sha256).
pub fn rev(dir: &Path, m: &Manifest) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(std::fs::read(dir.join("manifest.json")).unwrap_or_default());
    if let Ok(meta) = std::fs::metadata(dir.join(&m.entry)) {
        h.update(meta.len().to_le_bytes());
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        h.update(mtime.to_le_bytes());
    }
    hex::encode(h.finalize())[..12].to_string()
}

/// Every plugin folder, sorted by name, with its manifest and rev or the reason it is invalid.
pub fn scan(home: &Path) -> Vec<(String, Result<(Manifest, String), String>)> {
    let Ok(rd) = std::fs::read_dir(plugins_dir(home)) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs.into_iter()
        .map(|d| {
            let folder = d.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            let r = load_manifest(&d).map(|m| { let r = rev(&d, &m); (m, r) });
            (folder, r)
        })
        .collect()
}

/// `<dir>/data/<rel>` after the path rule, refusing any symlink on the way (no escape from data/).
fn data_file(dir: &Path, rel: &str) -> Result<PathBuf, CoreError> {
    if !valid_path(rel) { return Err(invalid_path()); }
    let root = dir.join(DATA);
    let mut p = root.clone();
    if std::fs::symlink_metadata(&root).is_ok_and(|m| m.file_type().is_symlink()) { return Err(invalid_path()); }
    for seg in rel.split('/') {
        p.push(seg);
        if std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) { return Err(invalid_path()); }
    }
    Ok(p)
}

pub fn read_data(dir: &Path, rel: &str) -> Result<Option<String>, CoreError> {
    let p = data_file(dir, rel)?;
    match std::fs::read(&p) {
        Ok(b) => String::from_utf8(b).map(Some).map_err(|_| CoreError::InvalidInput("not_text".into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if p.is_dir() => Err(CoreError::InvalidInput(format!("is a folder: {e}"))),
        Err(e) => Err(e.into()),
    }
}

/// Writes atomically (a hidden temp file in the same folder, then rename).
pub fn write_data(dir: &Path, rel: &str, text: &str) -> Result<(), CoreError> {
    let p = data_file(dir, rel)?;
    if text.len() > MAX_DATA_BYTES { return Err(CoreError::InvalidInput("too_large".into())); }
    let parent = p.parent().ok_or_else(invalid_path)?;
    std::fs::create_dir_all(parent)?;
    let name = p.file_name().ok_or_else(invalid_path)?.to_string_lossy().to_string();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = parent.join(format!(".{name}.{}-{nanos}.part", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &p).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
    Ok(())
}

/// Files under data/ (relative, `/`-joined, sorted) whose path starts with `prefix`. Skips hidden
/// temp files and never follows symlinks.
pub fn list_data(dir: &Path, prefix: &str) -> Result<Vec<String>, CoreError> {
    let root = dir.join(DATA);
    let mut out = Vec::new();
    let mut stack = vec![(root.clone(), String::new())];
    while let Some((d, rel)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push((e.path(), r)),
                Ok(t) if t.is_file() => { if r.starts_with(prefix) { out.push(r); } }
                _ => {}
            }
        }
    }
    out.sort();
    Ok(out)
}

pub fn delete_data(dir: &Path, rel: &str) -> Result<(), CoreError> {
    let p = data_file(dir, rel)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// An asset of the plugin to serve: a file inside `<dir>` (after resolving symlinks), never under data/.
pub fn resolve_asset(dir: &Path, rel: &str) -> Result<PathBuf, CoreError> {
    if !valid_path(rel) || rel.split('/').next() == Some(DATA) { return Err(invalid_path()); }
    let root = std::fs::canonicalize(dir).map_err(|_| CoreError::NotFound)?;
    let p = std::fs::canonicalize(dir.join(rel)).map_err(|_| CoreError::NotFound)?;
    let inside = p.strip_prefix(&root).ok().filter(|r| r.components().next() != Some(Component::Normal(DATA.as_ref())));
    if inside.is_none() || !p.is_file() { return Err(CoreError::NotFound); }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn plugin(home: &Path, folder: &str, manifest: &str) -> PathBuf {
        let dir = plugins_dir(home).join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest).unwrap();
        fs::write(dir.join("index.html"), "<p>hi</p>").unwrap();
        dir
    }

    const OK: &str = r#"{"id":"echo","name":"Echo","version":"0.1.0","minAppVersion":"0.3.0",
        "permissions":["rooms.read"],"slots":{"artifact.sidePanel":{"title":"Echo"},"tab":{"title":"Echo","icon":"puzzle","sidebar":true}}}"#;

    fn reason(home: &Path, folder: &str, manifest: &str) -> String {
        let dir = plugin(home, folder, manifest);
        load_manifest(&dir).unwrap_err()
    }

    #[test]
    fn a_valid_manifest_loads_with_defaults() {
        let d = tempfile::tempdir().unwrap();
        let m = load_manifest(&plugin(d.path(), "echo", OK)).unwrap();
        assert_eq!(m.id, "echo");
        assert_eq!(m.entry, "index.html");
        assert_eq!(m.permissions, vec!["rooms.read".to_string()]);
        assert_eq!(m.slots.artifact_side_panel.unwrap().title, "Echo");
        let tab = m.slots.tab.unwrap();
        assert!(tab.sidebar);
        assert_eq!(tab.icon.as_deref(), Some("puzzle"));
    }

    #[test]
    fn manifest_rules_reject_bad_input() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        let base = |f: &str| OK.replacen(r#""id":"echo""#, &format!(r#""id":"{f}""#), 1);
        assert!(reason(h, "other", OK).contains("folder"));
        assert!(reason(h, "Bad_Id", &base("Bad_Id")).contains("id"));
        assert!(reason(h, "noname", &base("noname").replace(r#""name":"Echo","#, "")).contains("name"));
        assert!(reason(h, "perm", &base("perm").replace("rooms.read", "network")).contains("permission"));
        assert!(reason(h, "noslot", &base("noslot").replace(r#""slots":{"artifact.sidePanel":{"title":"Echo"},"tab":{"title":"Echo","icon":"puzzle","sidebar":true}}"#, r#""slots":{}"#)).contains("slot"));
        assert!(reason(h, "icon", &base("icon").replace("puzzle", "rocket-ship")).contains("icon"));
        assert!(reason(h, "ver", &base("ver").replace(r#""version":"0.1.0""#, r#""version":"one""#)).contains("version"));
        assert!(reason(h, "entry", &base("entry").replace(r#""minAppVersion""#, r#""entry":"data/x.html","minAppVersion""#)).contains("entry"));
        assert!(reason(h, "json", "{not json").contains("manifest"));
        let long = "x".repeat(25);
        assert!(reason(h, "title", &base("title").replace(r#"{"title":"Echo"}"#, &format!(r#"{{"title":"{long}"}}"#))).contains("title"));
    }

    #[test]
    fn unknown_slots_are_ignored() {
        let d = tempfile::tempdir().unwrap();
        let m = OK.replace(r#""tab":"#, r#""journal.widget":{"title":"Later"},"tab":"#);
        assert!(load_manifest(&plugin(d.path(), "echo", &m)).is_ok());
    }

    #[test]
    fn path_rule() {
        for ok in ["a", "notes/a.excalidraw", "goals.json", "a-b_c.d/e", "1/2/3/4/5/6/7/8"] {
            assert!(valid_path(ok), "{ok}");
        }
        let long = "a".repeat(201);
        for bad in ["", "/x", "../x", "a/../b", "a/./b", "a//b", "a/", "a b", "1/2/3/4/5/6/7/8/9", long.as_str(), "é"] {
            assert!(!valid_path(bad), "{bad}");
        }
    }

    #[test]
    fn data_round_trip_atomic_listed_and_deleted() {
        let d = tempfile::tempdir().unwrap();
        let dir = plugin(d.path(), "echo", OK);
        assert_eq!(read_data(&dir, "notes/a.txt").unwrap(), None);
        write_data(&dir, "notes/b.txt", "B").unwrap();
        write_data(&dir, "notes/a.txt", "A").unwrap();
        write_data(&dir, "top.json", "{}").unwrap();
        assert_eq!(read_data(&dir, "notes/a.txt").unwrap().as_deref(), Some("A"));
        assert_eq!(list_data(&dir, "").unwrap(), vec!["notes/a.txt", "notes/b.txt", "top.json"]);
        assert_eq!(list_data(&dir, "notes/").unwrap(), vec!["notes/a.txt", "notes/b.txt"]);
        let leftovers: Vec<_> = fs::read_dir(dir.join("data/notes")).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("tmp")).collect();
        assert!(leftovers.is_empty());
        delete_data(&dir, "notes/a.txt").unwrap();
        delete_data(&dir, "notes/a.txt").unwrap();
        assert_eq!(read_data(&dir, "notes/a.txt").unwrap(), None);
    }

    #[test]
    fn data_rejects_bad_paths_size_and_symlink_escape() {
        let d = tempfile::tempdir().unwrap();
        let dir = plugin(d.path(), "echo", OK);
        assert_eq!(write_data(&dir, "../token", "x").unwrap_err(), CoreError::InvalidInput("invalid_path".into()));
        let big = "x".repeat(MAX_DATA_BYTES + 1);
        assert_eq!(write_data(&dir, "big.txt", &big).unwrap_err(), CoreError::InvalidInput("too_large".into()));
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(d.path().join("secret.txt"), "s").unwrap();
        symlink(d.path().join("secret.txt"), dir.join("data/leak.txt")).unwrap();
        symlink(d.path(), dir.join("data/out")).unwrap();
        assert_eq!(read_data(&dir, "leak.txt").unwrap_err(), CoreError::InvalidInput("invalid_path".into()));
        assert_eq!(write_data(&dir, "out/new.txt", "x").unwrap_err(), CoreError::InvalidInput("invalid_path".into()));
        assert!(!d.path().join("new.txt").exists());
    }

    #[test]
    fn assets_resolve_inside_the_folder_but_never_data() {
        let d = tempfile::tempdir().unwrap();
        let dir = plugin(d.path(), "echo", OK);
        write_data(&dir, "x.txt", "x").unwrap();
        assert_eq!(resolve_asset(&dir, "index.html").unwrap(), fs::canonicalize(dir.join("index.html")).unwrap());
        assert!(resolve_asset(&dir, "data/x.txt").is_err());
        assert!(resolve_asset(&dir, "../echo/index.html").is_err());
        assert!(resolve_asset(&dir, "missing.js").is_err());
        symlink(d.path().join(".rooms"), dir.join("up")).unwrap();
        assert!(resolve_asset(&dir, "up/state.json").is_err());
    }

    #[test]
    fn rev_changes_with_manifest_or_entry() {
        let d = tempfile::tempdir().unwrap();
        let dir = plugin(d.path(), "echo", OK);
        let m = load_manifest(&dir).unwrap();
        let r1 = rev(&dir, &m);
        assert_eq!(r1, rev(&dir, &m));
        fs::write(dir.join("index.html"), "<p>changed, longer</p>").unwrap();
        assert_ne!(rev(&dir, &m), r1);
    }

    #[test]
    fn scan_lists_folders_sorted_with_errors() {
        let d = tempfile::tempdir().unwrap();
        plugin(d.path(), "zed", &OK.replace(r#""id":"echo""#, r#""id":"zed""#));
        plugin(d.path(), "echo", OK);
        plugin(d.path(), "broken", "{");
        fs::write(plugins_dir(d.path()).join("stray.txt"), "").unwrap();
        let found: Vec<(String, bool)> = scan(d.path()).into_iter().map(|(f, r)| (f, r.is_ok())).collect();
        assert_eq!(found, vec![("broken".into(), false), ("echo".into(), true), ("zed".into(), true)]);
    }
}
