use roomsd::{resolve_mcp_bin, write_mcp_config};

#[test]
fn writes_mcp_json_with_command_and_env() {
    let home = tempfile::tempdir().unwrap();
    let bin = home.path().join("rooms-mcp");
    std::fs::write(&bin, "").unwrap();
    let p = write_mcp_config(home.path(), Some(&bin), 4317).unwrap().unwrap();
    assert_eq!(p, home.path().join(".rooms/mcp.json"));
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    let s = &v["mcpServers"]["rooms"];
    assert_eq!(s["command"], bin.to_str().unwrap());
    assert_eq!(s["env"]["ROOMS_HOME"], home.path().to_str().unwrap());
    assert!(s["env"].get("ROOMS_API_PORT").is_none(), "default port is not written");
    write_mcp_config(home.path(), Some(&bin), 5000).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    assert_eq!(v["mcpServers"]["rooms"]["env"]["ROOMS_API_PORT"], "5000");
}

#[test]
fn no_binary_means_no_file_and_a_stale_one_is_removed() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".rooms")).unwrap();
    let stale = home.path().join(".rooms/mcp.json");
    std::fs::write(&stale, "{}").unwrap();
    assert_eq!(write_mcp_config(home.path(), None, 4317).unwrap(), None);
    assert!(!stale.exists());
    let missing = home.path().join("nope");
    assert_eq!(write_mcp_config(home.path(), Some(&missing), 4317).unwrap(), None);
}

#[test]
fn env_override_then_sibling_of_the_executable() {
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("custom-mcp");
    std::fs::write(&a, "").unwrap();
    let a = std::fs::canonicalize(&a).unwrap();
    let exe = d.path().join("roomsd");
    assert_eq!(resolve_mcp_bin(Some(a.to_str().unwrap()), Some(&exe)), Some(a.clone()));
    assert_eq!(resolve_mcp_bin(None, Some(&exe)), None);
    let sib = d.path().join("rooms-mcp");
    std::fs::write(&sib, "").unwrap();
    assert_eq!(resolve_mcp_bin(None, Some(&exe)), Some(sib));
    // a relative override becomes absolute, since agents run elsewhere
    let rel = format!("rel-mcp-{}", std::process::id());
    std::fs::write(&rel, "").unwrap();
    let got = resolve_mcp_bin(Some(&rel), Some(&exe));
    std::fs::remove_file(&rel).unwrap();
    assert!(got.is_some_and(|p| p.is_absolute() && p.ends_with(&rel)));
    // an override pointing nowhere does not fall back silently
    assert_eq!(resolve_mcp_bin(Some("/no/such/file"), Some(&exe)), None);
}
