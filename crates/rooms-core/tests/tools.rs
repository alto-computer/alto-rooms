use rooms_core::{CoreError, RoomsCore};
use rooms_protocol::*;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

const MANIFEST: &str = r#"{"id":"pen","name":"Pen","version":"0.1.0","minAppVersion":"0.3.0",
    "permissions":[],"slots":{"tab":{"title":"Pen","sidebar":true}},
    "tools":{"draw":{"description":"Draw things","input":{"type":"object"},"appendTo":"notes/{doc}.jsonl"}}}"#;

fn install(home: &Path, id: &str, manifest: &str) {
    let dir = home.join(".rooms/plugins").join(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("manifest.json"), manifest).unwrap();
    fs::write(dir.join("index.html"), "<p>x</p>").unwrap();
}

/// Home with the enabled plugin `pen` and a room `a` holding doc.html; returns the doc's fileKey.
fn setup() -> (tempfile::TempDir, RoomsCore, String) {
    let d = tempfile::tempdir().unwrap();
    let core = RoomsCore::open(d.path()).unwrap();
    let room = core.create_room("a").unwrap().id;
    fs::write(d.path().join("a/doc.html"), "<p>d</p>").unwrap();
    core.backfill_all().unwrap();
    install(d.path(), "pen", MANIFEST);
    core.set_plugin_enabled("pen", true, None).unwrap();
    let key = core.list_artifacts(&room).unwrap()[0].file_key.clone();
    (d, core, key)
}

fn call(core: &RoomsCore, plugin: &str, tool: &str, input: Value) -> Result<ToolResult, CoreError> {
    core.call_tool(&ToolCall { plugin_id: plugin.into(), name: tool.into(), input })
}

fn bad(e: CoreError) -> String {
    match e { CoreError::BadRequest(s) => s, other => panic!("expected BadRequest, got {other:?}") }
}

#[test]
fn list_tools_only_valid_enabled_plugins() {
    let (d, core, _) = setup();
    let t = core.list_tools();
    assert_eq!(t.len(), 1);
    assert_eq!((t[0].plugin_id.as_str(), t[0].name.as_str(), t[0].description.as_str()), ("pen", "draw", "Draw things"));
    assert_eq!(t[0].input, json!({"type":"object"}));
    install(d.path(), "off", &MANIFEST.replace("\"pen\"", "\"off\""));
    install(d.path(), "broken", &MANIFEST.replace("\"pen\"", "\"broken\"").replace("\"appendTo\":\"notes/{doc}.jsonl\"", "\"appendTo\":\"../x\""));
    assert_eq!(core.list_tools().len(), 1, "disabled and invalid plugins are not listed");
    core.set_plugin_enabled("pen", false, None).unwrap();
    assert!(core.list_tools().is_empty());
}

#[test]
fn call_with_file_key_appends_one_envelope_line() {
    let (_d, core, key) = setup();
    let r = call(&core, "pen", "draw", json!({"doc": key, "ops": [1]})).unwrap();
    assert_eq!(r.path, format!("notes/{key}.jsonl"));
    call(&core, "pen", "draw", json!({"doc": key, "n": 2})).unwrap();
    let text = core.read_plugin_data("pen", &r.path).unwrap().unwrap();
    assert!(text.ends_with('\n'));
    let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["tool"], "draw");
    assert_eq!(lines[0]["input"], json!({"doc": key, "ops": [1]}));
    chrono::DateTime::parse_from_rfc3339(lines[0]["at"].as_str().unwrap()).unwrap();
    assert_eq!(lines[1]["input"]["n"], 2);
}

#[test]
fn call_with_absolute_path_of_symlinked_doc_uses_original_file_key() {
    let (d, core, _) = setup();
    let outside = tempfile::tempdir().unwrap();
    let orig = outside.path().join("o.html");
    fs::write(&orig, "<p>o</p>").unwrap();
    symlink(&orig, d.path().join("a/link.html")).unwrap();
    core.backfill_all().unwrap();
    let key = core.list_artifacts(&core.list_rooms().into_iter().find(|r| r.name == "a").unwrap().id).unwrap().into_iter().find(|a| a.rel_path == "link.html").unwrap().file_key;
    // the original path, the link path, and a non-canonical spelling all resolve to the same key
    for p in [orig.clone(), d.path().join("a/link.html"), outside.path().join("./o.html")] {
        let r = call(&core, "pen", "draw", json!({"doc": p.to_str().unwrap()})).unwrap();
        assert_eq!(r.path, format!("notes/{key}.jsonl"), "for {p:?}");
    }
}

#[test]
fn not_found_cases() {
    let (_d, core, key) = setup();
    assert!(matches!(call(&core, "nope", "draw", json!({"doc": key})), Err(CoreError::NotFound)));
    assert!(matches!(call(&core, "pen", "nope", json!({"doc": key})), Err(CoreError::NotFound)));
    assert!(matches!(call(&core, "pen", "draw", json!({"doc": "0000000000000000"})), Err(CoreError::NotFound)));
    assert!(matches!(call(&core, "pen", "draw", json!({"doc": "/no/such/file.html"})), Err(CoreError::NotFound)));
    core.set_plugin_enabled("pen", false, None).unwrap();
    assert!(matches!(call(&core, "pen", "draw", json!({"doc": key})), Err(CoreError::NotFound)));
}

#[test]
fn bad_requests() {
    let (_d, core, key) = setup();
    for input in [json!([1]), json!("s"), json!(null), json!({}), json!({"doc": 5}), json!({"doc": "relative/x.html"}), json!({"doc": ""})] {
        assert!(!bad(call(&core, "pen", "draw", input.clone()).unwrap_err()).is_empty(), "{input}");
    }
    let big = json!({"doc": key, "pad": "x".repeat(64 * 1024)});
    assert_eq!(bad(call(&core, "pen", "draw", big).unwrap_err()), "input too large");
    // nothing was written by the rejected calls
    assert!(core.list_plugin_data("pen", "").unwrap().is_empty());
}

#[test]
fn append_past_ten_mib_is_too_large_and_leaves_file_intact() {
    let (_d, core, key) = setup();
    let path = format!("notes/{key}.jsonl");
    let filler = "a".repeat(10 * 1024 * 1024 - 100);
    core.write_plugin_data("pen", &path, &filler).unwrap();
    assert!(matches!(call(&core, "pen", "draw", json!({"doc": key, "pad": "y".repeat(500)})), Err(CoreError::TooLarge)));
    assert_eq!(core.read_plugin_data("pen", &path).unwrap().unwrap(), filler);
}

#[test]
fn call_emits_data_changed_with_path() {
    let (_d, core, key) = setup();
    let mut rx = core.subscribe();
    let r = call(&core, "pen", "draw", json!({"doc": key})).unwrap();
    match rx.try_recv().unwrap().kind {
        EventKind::PluginDataChanged { plugin_id, path } => assert_eq!((plugin_id, path), ("pen".into(), r.path)),
        k => panic!("unexpected {k:?}"),
    }
    assert!(rx.try_recv().is_err());
    // rejected calls and bridge writes stay silent
    let _ = call(&core, "pen", "draw", json!({}));
    core.write_plugin_data("pen", "x.txt", "hi").unwrap();
    assert!(rx.try_recv().is_err());
}

#[test]
fn concurrent_calls_keep_every_line_intact() {
    let (_d, core, key) = setup();
    let pad = "z".repeat(20_000);
    let hs: Vec<_> = (0..8).map(|i| {
        let (c, k, p) = (core.clone(), key.clone(), pad.clone());
        std::thread::spawn(move || call(&c, "pen", "draw", json!({"doc": k, "i": i, "pad": p})).unwrap())
    }).collect();
    for h in hs { h.join().unwrap(); }
    let text = core.read_plugin_data("pen", &format!("notes/{key}.jsonl")).unwrap().unwrap();
    let mut seen: Vec<i64> = text.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["input"]["i"].as_i64().unwrap()).collect();
    seen.sort();
    assert_eq!(seen, (0..8).collect::<Vec<_>>());
}
