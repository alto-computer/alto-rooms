use crate::rules::{classify_path, PathClass, DEFAULT_IGNORED_DIRS};
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct ScanEntry {
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub target: PathBuf,
    pub class: PathClass,
}

fn is_html_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
        .unwrap_or(false)
}

/// Canonical target of a file symlink that resolves to a regular `.html`/`.htm` file. Directory
/// symlinks inside rooms are never followed.
pub fn symlink_html_target(link: &Path) -> Option<PathBuf> {
    let m = std::fs::metadata(link).ok()?;
    if !m.is_file() { return None; }
    std::fs::canonicalize(link).ok().filter(|t| is_html_ext(t))
}

pub fn scan_room(root: &Path, honor_gitignore: bool, in_journal: bool) -> Vec<ScanEntry> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .follow_links(false)
        .ignore(false)
        .parents(false)
        .git_ignore(honor_gitignore)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .add_custom_ignore_filename(".roomsignore")
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().map(|t| t.is_dir()).unwrap_or(false) && DEFAULT_IGNORED_DIRS.contains(&name.as_ref()))
        })
        .build();
    // Regular files are reached through real directories only (links are never followed), so
    // their canonical path is the canonical root joined with the relative path: no per-file syscall.
    let Ok(canonical_root) = std::fs::canonicalize(root) else { return out };
    for entry in walker.flatten() {
        let abs = entry.path();
        let Ok(rel) = abs.strip_prefix(root) else { continue };
        if rel.as_os_str().is_empty() { continue; }
        let Some(ft) = entry.file_type() else { continue };
        let class = classify_path(rel, in_journal);
        if class == PathClass::Ignored { continue; }
        let target = if ft.is_file() {
            canonical_root.join(rel)
        } else if ft.is_symlink() && class == PathClass::Artifact {
            match symlink_html_target(abs) { Some(t) => t, None => continue }
        } else {
            continue;
        };
        out.push(ScanEntry { rel_path: rel.to_string_lossy().replace('\\', "/"), abs_path: abs.to_path_buf(), target, class });
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn rels(v: &[ScanEntry]) -> Vec<String> { v.iter().map(|e| e.rel_path.clone()).collect() }

    #[test]
    fn finds_nested_html_and_skips_noise() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join("harness")).unwrap();
        fs::create_dir_all(r.join("node_modules/x")).unwrap();
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::write(r.join("a.html"), "<title>A</title>").unwrap();
        fs::write(r.join("harness/b.htm"), "").unwrap();
        fs::write(r.join("node_modules/x/c.html"), "").unwrap();
        fs::write(r.join(".git/d.html"), "").unwrap();
        fs::write(r.join("e.md"), "").unwrap();
        assert_eq!(rels(&scan_room(r, false, false)), vec!["a.html", "harness/b.htm"]);
    }

    #[test]
    fn honors_roomsignore_always_and_gitignore_only_when_asked() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::write(r.join("keep.html"), "").unwrap();
        fs::write(r.join("drop.html"), "").unwrap();
        fs::write(r.join("git.html"), "").unwrap();
        fs::write(r.join(".roomsignore"), "drop.html\n").unwrap();
        fs::write(r.join(".gitignore"), "git.html\n").unwrap();
        assert_eq!(rels(&scan_room(r, false, false)), vec!["git.html", "keep.html"]);
        assert_eq!(rels(&scan_room(r, true, false)), vec!["keep.html"]);
    }

    #[test]
    fn follows_file_symlink_to_html_and_records_target() {
        let d = tempfile::tempdir().unwrap();
        let orig = d.path().join("elsewhere");
        fs::create_dir_all(&orig).unwrap();
        fs::write(orig.join("spec.html"), "").unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        symlink(orig.join("spec.html"), room.join("spec.html")).unwrap();
        let v = scan_room(&room, false, false);
        assert_eq!(rels(&v), vec!["spec.html"]);
        assert_eq!(v[0].target, fs::canonicalize(orig.join("spec.html")).unwrap());
    }

    #[test]
    fn regular_file_target_is_its_canonical_path() {
        let d = tempfile::tempdir().unwrap(); // under /var, itself a symlink on macOS
        fs::create_dir_all(d.path().join("room/sub")).unwrap();
        fs::write(d.path().join("room/sub/a.html"), "").unwrap();
        let v = scan_room(&d.path().join("room"), false, false);
        assert_eq!(v[0].target, fs::canonicalize(d.path().join("room/sub/a.html")).unwrap());
    }

    #[test]
    fn skips_broken_and_directory_symlinks() {
        let d = tempfile::tempdir().unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        symlink(d.path().join("missing.html"), room.join("broken.html")).unwrap();
        symlink(&room, room.join("loop")).unwrap();
        fs::write(room.join("ok.html"), "").unwrap();
        assert_eq!(rels(&scan_room(&room, false, false)), vec!["ok.html"]);
    }

    #[test]
    fn journal_scan_returns_notes_and_artifacts() {
        let d = tempfile::tempdir().unwrap();
        let j = d.path();
        fs::create_dir_all(j.join("2026-10-05")).unwrap();
        fs::write(j.join("2026-10-05/dream.html"), "").unwrap();
        fs::write(j.join("2026-10-05/회고.md"), "").unwrap();
        let v = scan_room(j, false, true);
        assert_eq!(rels(&v), vec!["2026-10-05/dream.html", "2026-10-05/회고.md"]);
        assert!(matches!(v[1].class, PathClass::Note { .. }));
    }

    #[test]
    fn symlink_target_must_be_html_and_link_name_must_be_html() {
        let d = tempfile::tempdir().unwrap();
        let orig = d.path().join("elsewhere");
        fs::create_dir_all(&orig).unwrap();
        fs::write(orig.join("y.txt"), "").unwrap();
        fs::write(orig.join("y.md"), "").unwrap();
        fs::write(orig.join("y.html"), "").unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        symlink(orig.join("y.txt"), room.join("x.html")).unwrap();
        symlink(orig.join("y.md"), room.join("m.html")).unwrap();
        symlink(orig.join("y.html"), room.join("x.txt")).unwrap();
        symlink(orig.join("y.html"), room.join("spec.html")).unwrap();
        assert_eq!(rels(&scan_room(&room, false, false)), vec!["spec.html"]);
    }

    #[test]
    fn ignores_dot_ignore_and_parent_ignore_files() {
        let d = tempfile::tempdir().unwrap();
        let room = d.path().join("room");
        fs::create_dir_all(&room).unwrap();
        fs::write(room.join("a.html"), "").unwrap();
        fs::write(room.join(".ignore"), "a.html\n").unwrap();
        fs::write(d.path().join(".roomsignore"), "a.html\n").unwrap();
        fs::write(d.path().join(".gitignore"), "a.html\n").unwrap();
        assert_eq!(rels(&scan_room(&room, true, false)), vec!["a.html"]);
    }
}
