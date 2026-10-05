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

pub fn scan_room(root: &Path, honor_gitignore: bool, in_journal: bool) -> Vec<ScanEntry> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .follow_links(false)
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
    for entry in walker.flatten() {
        let abs = entry.path().to_path_buf();
        let Ok(rel) = abs.strip_prefix(root) else { continue };
        if rel.as_os_str().is_empty() { continue; }
        let ft = match entry.file_type() { Some(t) => t, None => continue };
        // Directory symlinks inside rooms are never followed; file symlinks must point to a regular file.
        let target = if ft.is_symlink() {
            match std::fs::metadata(&abs) {
                Ok(m) if m.is_file() => match std::fs::canonicalize(&abs) { Ok(t) => t, Err(_) => continue },
                _ => continue,
            }
        } else if ft.is_file() {
            match std::fs::canonicalize(&abs) { Ok(t) => t, Err(_) => continue }
        } else {
            continue;
        };
        let class = classify_path(rel, in_journal);
        if class == PathClass::Ignored { continue; }
        if ft.is_symlink() && class != PathClass::Artifact { continue; }
        out.push(ScanEntry { rel_path: rel.to_string_lossy().replace('\\', "/"), abs_path: abs, target, class });
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
}
