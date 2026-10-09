//! `manifest.json`: reading and validating a plugin's manifest, and the rev that changes with it.

use super::data::{valid_code_path, valid_path};
use rooms_protocol::{PluginSlots, SidePanelSlot, TabSlot};
use serde_json::Value;
use std::path::Path;

pub const PERMISSIONS: [&str; 4] = ["rooms.read", "clipboard", "downloads", "artifact.content"];
pub const ICONS: [&str; 13] = [
    "target", "pencil", "list-checks", "calendar", "star", "book", "flag", "layout-grid", "sparkles", "notebook", "lightbulb", "puzzle", "palette",
];

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
    pub(crate) tools: Vec<ManifestTool>,
    pub content_scripts: Vec<String>,
}

/// A tool declared in `manifest.json`: `input` is a JSON Schema for the agent (stored, not enforced);
/// `append_to` is a data path template where `{doc}` stands for a document's fileKey.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ManifestTool {
    pub name: String,
    pub description: String,
    pub input: Value,
    pub append_to: String,
}

const MAX_TOOLS: usize = 16;
const MAX_CONTENT_SCRIPTS: usize = 4;
const MAX_TOOL_INPUT_BYTES: usize = 16 * 1024;

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

fn valid_tool_name(n: &str) -> bool {
    let b = n.as_bytes();
    (1..=40).contains(&b.len()) && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn tools(v: Option<&Value>) -> Result<Vec<ManifestTool>, String> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let obj = v.as_object().ok_or("tools must be an object")?;
    if obj.len() > MAX_TOOLS { return Err(format!("at most {MAX_TOOLS} tools")); }
    let mut out = Vec::new();
    for (name, t) in obj {
        if !valid_tool_name(name) { return Err(format!("invalid tool name: {name}")); }
        let description = t.get("description").and_then(Value::as_str).unwrap_or("");
        if !(1..=500).contains(&description.chars().count()) { return Err(format!("tool {name}: description must be 1–500 characters")); }
        let input = t.get("input").filter(|i| i.is_object()).ok_or_else(|| format!("tool {name}: input must be a JSON object"))?;
        if input.get("type") != Some(&Value::from("object")) { return Err(format!("tool {name}: input must be a JSON Schema with \"type\": \"object\"")); }
        if input.to_string().len() > MAX_TOOL_INPUT_BYTES { return Err(format!("tool {name}: input must be at most 16 KiB")); }
        let append_to = t.get("appendTo").and_then(Value::as_str).unwrap_or("");
        if !valid_path(&append_to.replace("{doc}", "0123456789abcdef")) {
            return Err(format!("tool {name}: appendTo must be a data path, with only {{doc}} as placeholder"));
        }
        out.push(ManifestTool { name: name.clone(), description: description.to_string(), input: input.clone(), append_to: append_to.to_string() });
    }
    Ok(out)
}

fn content_scripts(v: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(v) = v else { return Ok(Vec::new()) };
    let list = v.as_array().ok_or("contentScripts must be an array")?;
    if list.len() > MAX_CONTENT_SCRIPTS { return Err(format!("at most {MAX_CONTENT_SCRIPTS} content scripts")); }
    let mut out: Vec<String> = Vec::new();
    for p in list {
        match p.as_str() {
            Some(s) if out.iter().any(|o| o == s) => return Err(format!("duplicate content script: {s}")),
            Some(s) if valid_code_path(s) && s.ends_with(".js") => out.push(s.to_string()),
            _ => return Err(format!("content script must be a .js file in the plugin folder, outside data/: {p}")),
        }
    }
    Ok(out)
}

fn title(v: &Value) -> Result<String, String> {
    let t = v.get("title").and_then(Value::as_str).unwrap_or("").trim();
    if t.is_empty() || t.chars().count() > 24 { return Err("slot title must be 1–24 characters".into()); }
    Ok(t.to_string())
}

fn icon(v: &Value) -> Result<Option<String>, String> {
    let icon = v.get("icon").and_then(Value::as_str).map(str::to_string);
    if let Some(i) = icon.as_deref().filter(|i| !ICONS.contains(i)) { return Err(format!("unknown icon: {i}")); }
    Ok(icon)
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
    if !valid_code_path(&entry) { return Err("entry must be a file in the plugin folder, outside data/".into()); }
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
                "artifact.sidePanel" => slots.artifact_side_panel = Some(SidePanelSlot { title: title(sv)?, icon: icon(sv)? }),
                "tab" => slots.tab = Some(TabSlot { title: title(sv)?, icon: icon(sv)?, sidebar: sv.get("sidebar").and_then(Value::as_bool).unwrap_or(false) }),
                other => eprintln!("rooms-core: plugin {id}: ignoring unknown slot {other}"),
            }
        }
    }
    let content_scripts = content_scripts(v.get("contentScripts"))?;
    match (content_scripts.is_empty(), permissions.iter().any(|p| p == "artifact.content")) {
        (false, false) => return Err("contentScripts needs the artifact.content permission".into()),
        (true, true) => return Err("artifact.content needs contentScripts".into()),
        _ => {}
    }
    if slots.artifact_side_panel.is_none() && slots.tab.is_none() && content_scripts.is_empty() {
        return Err("declare at least one slot or content script".into());
    }
    let tools = tools(v.get("tools"))?;
    Ok(Manifest { id, name, version, min_app_version, description, entry, permissions, slots, tools, content_scripts })
}

/// Changes when the manifest, the entry file or a content script changes (first 12 hex of a sha256).
pub fn rev(dir: &Path, m: &Manifest) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(std::fs::read(dir.join("manifest.json")).unwrap_or_default());
    for file in std::iter::once(&m.entry).chain(&m.content_scripts) {
        let Ok(meta) = std::fs::metadata(dir.join(file)) else { continue };
        h.update(meta.len().to_le_bytes());
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        h.update(mtime.to_le_bytes());
    }
    hex::encode(h.finalize())[..12].to_string()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{plugin, OK};
    use super::*;
    use std::fs;

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
        let panel = m.slots.artifact_side_panel.unwrap();
        assert_eq!(panel.title, "Echo");
        assert_eq!(panel.icon, None);
        let tab = m.slots.tab.unwrap();
        assert!(tab.sidebar);
        assert_eq!(tab.icon.as_deref(), Some("puzzle"));
    }

    fn with_tools(folder: &str, tools: &str) -> String {
        OK.replacen(r#""id":"echo""#, &format!(r#""id":"{folder}""#), 1).replacen(r#""permissions""#, &format!(r#""tools":{tools},"permissions""#), 1)
    }

    #[test]
    fn a_manifest_without_tools_has_none() {
        let d = tempfile::tempdir().unwrap();
        assert!(load_manifest(&plugin(d.path(), "echo", OK)).unwrap().tools.is_empty());
    }

    #[test]
    fn tools_are_parsed() {
        let d = tempfile::tempdir().unwrap();
        let m = with_tools("echo", r#"{"draw":{"description":"Draw things","input":{"type":"object"},"appendTo":"notes/{doc}.ops.jsonl"},"log":{"description":"x","input":{"type":"object"},"appendTo":"log.jsonl"}}"#);
        let t = load_manifest(&plugin(d.path(), "echo", &m)).unwrap().tools;
        assert_eq!(t.len(), 2);
        let draw = t.iter().find(|t| t.name == "draw").unwrap();
        assert_eq!(draw.description, "Draw things");
        assert_eq!(draw.input, serde_json::json!({"type":"object"}));
        assert_eq!(draw.append_to, "notes/{doc}.ops.jsonl");
    }

    #[test]
    fn invalid_tools_invalidate_the_manifest() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        let one = |name: &str, body: &str| format!(r#"{{"{name}":{body}}}"#);
        let ok = r#"{"description":"d","input":{"type":"object"},"appendTo":"a/{doc}.jsonl"}"#;
        let bad = |i: usize, tools: String| reason(h, &format!("t{i}"), &with_tools(&format!("t{i}"), &tools));
        assert!(bad(0, one("Draw", ok)).contains("tool"));
        assert!(bad(1, one("1draw", ok)).contains("tool"));
        assert!(bad(2, one(&format!("a{}", "b".repeat(40)), ok)).contains("tool"));
        assert!(bad(3, one("t", r#"{"input":{"type":"object"},"appendTo":"a.jsonl"}"#)).contains("description"));
        assert!(bad(4, one("t", r#"{"description":"","input":{"type":"object"},"appendTo":"a.jsonl"}"#)).contains("description"));
        let long = "x".repeat(501);
        assert!(bad(5, one("t", &format!(r#"{{"description":"{long}","input":{{"type":"object"}},"appendTo":"a.jsonl"}}"#))).contains("description"));
        assert!(bad(6, one("t", r#"{"description":"d","input":[],"appendTo":"a.jsonl"}"#)).contains("input"));
        assert!(bad(16, one("t", r#"{"description":"d","input":{},"appendTo":"a.jsonl"}"#)).contains("type"));
        assert!(bad(17, one("t", r#"{"description":"d","input":{"type":"string"},"appendTo":"a.jsonl"}"#)).contains("type"));
        assert!(bad(7, one("t", r#"{"description":"d","appendTo":"a.jsonl"}"#)).contains("input"));
        let big = "x".repeat(16 * 1024);
        assert!(bad(8, one("t", &format!(r#"{{"description":"d","input":{{"k":"{big}"}},"appendTo":"a.jsonl"}}"#))).contains("input"));
        assert!(bad(9, one("t", r#"{"description":"d","input":{"type":"object"},"appendTo":"a/{x}.jsonl"}"#)).contains("appendTo"));
        assert!(bad(10, one("t", r#"{"description":"d","input":{"type":"object"},"appendTo":"/abs/{doc}.jsonl"}"#)).contains("appendTo"));
        assert!(bad(11, one("t", r#"{"description":"d","input":{"type":"object"},"appendTo":"../{doc}.jsonl"}"#)).contains("appendTo"));
        assert!(bad(12, one("t", r#"{"description":"d","input":{"type":"object"},"appendTo":"a/{doc"}"#)).contains("appendTo"));
        assert!(bad(13, one("t", r#"{"description":"d","input":{"type":"object"}}"#)).contains("appendTo"));
        assert!(bad(14, "[]".into()).contains("tools"));
        let many: Vec<String> = (0..17).map(|i| format!(r#""t{i}":{ok}"#)).collect();
        assert!(bad(15, format!("{{{}}}", many.join(","))).contains("16"));
        let sixteen: Vec<String> = (0..16).map(|i| format!(r#""t{i}":{ok}"#)).collect();
        assert_eq!(load_manifest(&plugin(h, "t16", &with_tools("t16", &format!("{{{}}}", sixteen.join(","))))).unwrap().tools.len(), 16);
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
    fn a_side_panel_icon_is_checked_against_the_same_icons_as_a_tab() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        let panel = |f: &str, icon: &str| OK.replacen(r#""id":"echo""#, &format!(r#""id":"{f}""#), 1).replace(r#"{"title":"Echo"}"#, &format!(r#"{{"title":"Echo","icon":"{icon}"}}"#));
        let m = load_manifest(&plugin(h, "canvas", &panel("canvas", "palette"))).unwrap();
        assert_eq!(m.slots.artifact_side_panel.unwrap().icon.as_deref(), Some("palette"));
        assert_eq!(reason(h, "rocket", &panel("rocket", "rocket-ship")), "unknown icon: rocket-ship");
    }

    #[test]
    fn unknown_slots_are_ignored() {
        let d = tempfile::tempdir().unwrap();
        let m = OK.replace(r#""tab":"#, r#""journal.widget":{"title":"Later"},"tab":"#);
        assert!(load_manifest(&plugin(d.path(), "echo", &m)).is_ok());
    }


    fn content(folder: &str, permissions: &str, scripts: &str, slots: &str) -> String {
        format!(r#"{{"id":"{folder}","name":"Marker","version":"0.1.0","minAppVersion":"0.3.0","permissions":{permissions},"contentScripts":{scripts},"slots":{slots}}}"#)
    }

    #[test]
    fn content_scripts_are_parsed() {
        let d = tempfile::tempdir().unwrap();
        let m = content("marker", r#"["artifact.content"]"#, r#"["content.js","lib/more.js"]"#, r#"{"tab":{"title":"Marker"}}"#);
        let m = load_manifest(&plugin(d.path(), "marker", &m)).unwrap();
        assert_eq!(m.content_scripts, vec!["content.js".to_string(), "lib/more.js".to_string()]);
        assert_eq!(m.permissions, vec!["artifact.content".to_string()]);
        assert!(load_manifest(&plugin(d.path(), "echo", OK)).unwrap().content_scripts.is_empty());
    }

    #[test]
    fn content_scripts_need_the_permission_and_back() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        let tab = r#"{"tab":{"title":"Marker"}}"#;
        assert!(reason(h, "aa", &content("aa", r#"["rooms.read"]"#, r#"["content.js"]"#, tab)).contains("artifact.content"));
        assert!(reason(h, "bb", &content("bb", r#"["artifact.content"]"#, "[]", tab)).contains("contentScripts"));
        let without = OK.replacen(r#""id":"echo""#, r#""id":"cc""#, 1).replace(r#"["rooms.read"]"#, r#"["artifact.content"]"#);
        assert!(reason(h, "cc", &without).contains("contentScripts"));
    }

    #[test]
    fn content_script_paths_are_checked() {
        let d = tempfile::tempdir().unwrap();
        let h = d.path();
        let perm = r#"["artifact.content"]"#;
        assert_eq!(reason(h, "str", &content("str", perm, r#""x.js""#, "{}")), "contentScripts must be an array");
        for (i, bad) in [r#"["../x.js"]"#, r#"["data/x.js"]"#, r#"["x.css"]"#, r#"["/x.js"]"#, "[3]"].iter().enumerate() {
            let f = format!("p{i}");
            assert!(reason(h, &f, &content(&f, perm, bad, "{}")).contains("content script must be"), "{bad}");
        }
        assert_eq!(reason(h, "dup", &content("dup", perm, r#"["a.js","lib/b.js","a.js"]"#, "{}")), "duplicate content script: a.js");
        assert!(reason(h, "five", &content("five", perm, r#"["a.js","b.js","c.js","d.js","e.js"]"#, "{}")).contains("at most 4"));
        assert_eq!(load_manifest(&plugin(h, "four", &content("four", perm, r#"["a.js","b.js","c.js","d.js"]"#, "{}"))).unwrap().content_scripts.len(), 4);
    }

    #[test]
    fn a_content_script_only_manifest_is_valid() {
        let d = tempfile::tempdir().unwrap();
        let m = load_manifest(&plugin(d.path(), "marker", &content("marker", r#"["artifact.content"]"#, r#"["content.js"]"#, "{}"))).unwrap();
        assert_eq!(m.slots, PluginSlots::default());
        assert_eq!(m.content_scripts, vec!["content.js".to_string()]);
        let none = content("none", r#"["artifact.content"]"#, r#"["content.js"]"#, "{}").replace(r#""permissions":["artifact.content"],"contentScripts":["content.js"],"#, "");
        assert!(reason(d.path(), "none", &none).contains("slot or content script"));
    }

    #[test]
    fn rev_changes_with_a_content_script() {
        let d = tempfile::tempdir().unwrap();
        let dir = plugin(d.path(), "marker", &content("marker", r#"["artifact.content"]"#, r#"["content.js"]"#, "{}"));
        fs::write(dir.join("content.js"), "mark()").unwrap();
        let m = load_manifest(&dir).unwrap();
        let r1 = rev(&dir, &m);
        assert_eq!(r1, rev(&dir, &m));
        fs::write(dir.join("content.js"), "mark(); mark()").unwrap();
        assert_ne!(rev(&dir, &m), r1);
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
}
