//! Which written files are documents, which repo they belong to, and what Rooms already holds.
//! The same rules as find_html.py (`not_a_document`, `repo_info`, `linked_rooms`).
use crate::pathutil::under;
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Agent scratch, tool state and Rooms' own `.rooms`: never documents.
pub fn not_a_document(p: &Path, user_home: &Path, rooms_home: &Path) -> bool {
    let s = p.to_string_lossy();
    let segs: Vec<&str> = s.split('/').collect();
    if segs.contains(&"scratchpad") || segs.contains(&"node_modules") || s.contains(".superpowers/brainstorm") { return true; }
    if under(p, &user_home.join(".claude")) || under(p, &user_home.join(".codex")) { return true; }
    if under(p, &rooms_home.join(".rooms")) { return true; }
    if under(p, &user_home.join(".aside")) && !segs.contains(&"artifacts") { return true; }
    let codex_docs = user_home.join("Documents/Codex");
    if let Ok(rest) = p.strip_prefix(&codex_docs) {
        let parts: Vec<_> = rest.components().collect();
        if parts.len() >= 2 && parts[1].as_os_str() == "work" { return true; }
    }
    if !under(p, user_home) {
        for t in ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"] {
            if under(p, Path::new(t)) { return true; }
        }
    }
    false
}

fn orca_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"/orca/workspaces/([^/]+)/([^/]+)(?:/|$)").unwrap())
}

/// (repo_key, repo_root). A worktree (`.git` is a file) is named after its main repo.
pub fn repo_info(real: &Path) -> (String, PathBuf) {
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut d = real.parent().map(Path::to_path_buf);
    while let Some(dir) = d {
        let g = dir.join(".git");
        if g.is_file() {
            let first = std::fs::read_to_string(&g).ok().and_then(|s| s.lines().next().map(|l| l.trim().to_string())).unwrap_or_default();
            let repo = first.strip_prefix("gitdir:").and_then(|r| r.trim().split("/.git/worktrees/").next().filter(|_| first.contains("/.git/worktrees/")))
                .map(|r| name(Path::new(r))).filter(|r| !r.is_empty());
            let fallback = dir.parent().map(name).filter(|n| !n.is_empty()).unwrap_or_else(|| name(&dir));
            return (repo.unwrap_or(fallback), dir);
        }
        if g.is_dir() { return (name(&dir), dir); }
        d = dir.parent().map(Path::to_path_buf);
    }
    let s = real.to_string_lossy();
    if let Some(c) = orca_re().captures(&s) {
        let root = format!("{}{}", &s[..c.get(2).unwrap().start()], &c[2]);
        return (c[1].to_string(), PathBuf::from(root));
    }
    let pd = real.parent().unwrap_or(Path::new("/"));
    (name(pd), pd.to_path_buf())
}

/// Realpaths of the linked-folder rooms in `<home>/.rooms/state.json` (missing/broken: none).
pub fn linked_roots(home: &Path) -> Vec<PathBuf> {
    let Ok(raw) = std::fs::read(home.join(".rooms/state.json")) else { return Vec::new() };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else { return Vec::new() };
    v.get("rooms").and_then(|r| r.as_array()).into_iter().flatten()
        .filter(|r| r.get("kind").and_then(|k| k.as_str()) == Some("linked"))
        .filter_map(|r| r.get("path").and_then(|p| p.as_str()))
        .map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p)))
        .collect()
}

/// Realpaths every symlink under home points to (folders not followed, `.rooms` skipped).
pub fn link_targets(home: &Path) -> HashSet<PathBuf> {
    fn go(dir: &Path, top: bool, out: &mut HashSet<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            if top && e.file_name() == ".rooms" { continue; }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                if let Ok(r) = std::fs::canonicalize(e.path()) { out.insert(r); }
            } else if ft.is_dir() {
                go(&e.path(), false, out);
            }
        }
    }
    let mut out = HashSet::new();
    go(home, true, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_rules() {
        let (u, r) = (Path::new("/Users/me"), Path::new("/Users/me/rooms"));
        for p in ["/Users/me/.claude/x.html", "/Users/me/p/node_modules/a.html", "/tmp/a.html", "/private/var/folders/x/a.html",
                  "/Users/me/rooms/.rooms/x.html", "/Users/me/.aside/s/tmp/a.html", "/Users/me/Documents/Codex/2026/work/a.html",
                  "/Users/me/p/scratchpad/a.html"] {
            assert!(not_a_document(Path::new(p), u, r), "{p}");
        }
        for p in ["/Users/me/p/a.html", "/Users/me/.aside/u/0/artifacts/a.html", "/Users/me/Documents/Codex/2026/out/a.html"] {
            assert!(!not_a_document(Path::new(p), u, r), "{p}");
        }
    }

    #[test]
    fn repo_and_worktree() {
        let d = tempfile::tempdir().unwrap();
        let repo = d.path().join("alto-rooms");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("docs")).unwrap();
        assert_eq!(repo_info(&repo.join("docs/a.html")).0, "alto-rooms");
        let wt = d.path().join("wt/feat");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}/.git/worktrees/feat\n", repo.display())).unwrap();
        assert_eq!(repo_info(&wt.join("a.html")), ("alto-rooms".to_string(), wt.clone()));
        assert_eq!(repo_info(Path::new("/x/orca/workspaces/proj/ws1/a/b.html")), ("proj".to_string(), PathBuf::from("/x/orca/workspaces/proj/ws1")));
    }
}
