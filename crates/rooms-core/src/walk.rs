use crate::rules::{classify_path, is_html, PathClass, DEFAULT_IGNORED_DIRS};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct ScanEntry {
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub target: PathBuf,
    pub class: PathClass,
}

/// Canonical target of a file symlink that resolves to a regular `.html`/`.htm` file. Directory
/// symlinks inside rooms are never followed.
pub fn symlink_html_target(link: &Path) -> Option<PathBuf> {
    let m = std::fs::metadata(link).ok()?;
    if !m.is_file() { return None; }
    std::fs::canonicalize(link).ok().filter(|t| is_html(t))
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

/// The entry `scan_room(root, ..)` would list at `rel`, found without walking the room: `None`
/// if nothing is there or the scan would skip it (ignored name or folder, ignore rules, a link
/// that is not to an html file, or reached through a linked folder, which scans never follow).
pub fn entry_at(root: &Path, rel: &Path, honor_gitignore: bool, in_journal: bool) -> Option<ScanEntry> {
    let class = classify_path(rel, in_journal);
    if class == PathClass::Ignored { return None; }
    let abs = root.join(rel);
    let ft = std::fs::symlink_metadata(&abs).ok()?.file_type();
    if !named_exactly(&abs) { return None; }
    let canonical_root = std::fs::canonicalize(root).ok()?;
    let parent = rel.parent()?;
    if std::fs::canonicalize(abs.parent()?).ok()? != canonical_root.join(parent) { return None; }
    let target = if ft.is_file() {
        canonical_root.join(rel)
    } else if ft.is_symlink() && class == PathClass::Artifact {
        symlink_html_target(&abs)?
    } else {
        return None;
    };
    if is_ignored(root, rel, honor_gitignore) { return None; }
    Some(ScanEntry { rel_path: rel.to_string_lossy().replace('\\', "/"), abs_path: abs, target, class })
}

/// Whether the folder holds an entry named exactly like `abs`'s last component. APFS finds
/// `x.html` when only `X.html` (or an NFD spelling of an NFC name) exists, so after a case- or
/// normalization-only rename a stat alone would keep the old row next to the new one.
fn named_exactly(abs: &Path) -> bool {
    let (Some(dir), Some(name)) = (abs.parent(), abs.file_name()) else { return false };
    std::fs::read_dir(dir).is_ok_and(|rd| rd.flatten().any(|e| e.file_name() == name))
}

/// The ignore files `scan_room` honors in one folder.
struct FolderRules { rooms: Option<Gitignore>, git: Option<Gitignore> }

impl FolderRules {
    fn load(dir: &Path, honor_gitignore: bool) -> FolderRules {
        let read = |name: &str| {
            let file = dir.join(name);
            if !file.is_file() { return None; }
            let mut b = GitignoreBuilder::new(dir);
            if b.add(&file).is_some() { return None; }
            b.build().ok()
        };
        FolderRules { rooms: read(".roomsignore"), git: if honor_gitignore { read(".gitignore") } else { None } }
    }
}

/// Whether the ignore files `scan_room` honors exclude `rel`, decided as the walk does: each
/// folder on the way down is checked first (the walk never enters an ignored folder, so nothing
/// below it can be re-included), with the rules from the folders above it. For one path, the
/// deepest `.roomsignore` rule that matches decides; only if none does, the deepest `.gitignore`.
fn is_ignored(root: &Path, rel: &Path, honor_gitignore: bool) -> bool {
    let names: Vec<_> = rel.components().collect();
    let mut levels: Vec<FolderRules> = Vec::new();
    let mut dir = root.to_path_buf();
    for (i, name) in names.iter().enumerate() {
        levels.push(FolderRules::load(&dir, honor_gitignore));
        let path = dir.join(name);
        let is_dir = i + 1 < names.len();
        let deepest = |pick: fn(&FolderRules) -> Option<&Gitignore>| {
            levels.iter().rev().filter_map(pick).map(|g| g.matched(&path, is_dir)).find(|m| !m.is_none())
        };
        if deepest(|l| l.rooms.as_ref()).or_else(|| deepest(|l| l.git.as_ref())).is_some_and(|m| m.is_ignore()) { return true; }
        dir = path;
    }
    false
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

    /// Every path under `root`, files and links (not folders), relative.
    fn all_paths(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for e in fs::read_dir(&dir).unwrap().flatten() {
                let ft = e.file_type().unwrap();
                if ft.is_dir() { stack.push(e.path()); } else { out.push(e.path().strip_prefix(root).unwrap().to_path_buf()); }
            }
        }
        out
    }

    #[test]
    fn entry_at_agrees_with_the_walk_for_every_path() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("room");
        let orig = d.path().join("elsewhere");
        for dir in ["sub/deep", "node_modules/x", ".git", "gen", "keep/gen", "linked"] { fs::create_dir_all(r.join(dir)).unwrap(); }
        fs::create_dir_all(&orig).unwrap();
        fs::write(orig.join("o.html"), "").unwrap();
        fs::write(orig.join("o.txt"), "").unwrap();
        fs::write(orig.join("in-linked-dir.html"), "").unwrap();
        for f in ["a.html", "b.htm", "c.md", "x.png", "sub/s.html", "sub/deep/d.html", "sub/deep/drop.html",
                  "node_modules/x/n.html", ".git/g.html", ".hidden.html", "gen/g.html", "keep/gen/k.html",
                  "git.html", "sub/git2.html", "sub/back.html"] {
            fs::write(r.join(f), "").unwrap();
        }
        fs::write(r.join(".roomsignore"), "gen/\n*.png\nsub/back.html\n").unwrap();
        fs::write(r.join("sub/.roomsignore"), "deep/drop.html\n!back.html\n").unwrap();
        fs::write(r.join(".gitignore"), "git.html\n").unwrap();
        fs::write(r.join("sub/.gitignore"), "git2.html\n").unwrap();
        symlink(orig.join("o.html"), r.join("link.html")).unwrap();
        symlink(orig.join("o.txt"), r.join("bad.html")).unwrap();
        symlink(orig.join("o.html"), r.join("gen/ign.html")).unwrap();
        symlink(&orig, r.join("linked/dir")).unwrap();
        let in_linked_dir = Path::new("linked/dir/in-linked-dir.html");
        for honor in [false, true] {
            let walked = scan_room(&r, honor, false);
            let expected = ["a.html", "b.htm", "link.html", "sub/back.html", "sub/deep/d.html", "sub/s.html"];
            let extra: &[&str] = if honor { &[] } else { &["git.html", "sub/git2.html"] };
            let mut expected: Vec<&str> = expected.iter().chain(extra).copied().collect();
            expected.sort();
            assert_eq!(rels(&walked), expected, "gitignore: {honor}");
            assert_agrees(&r, honor, &[in_linked_dir]);
        }
    }

    /// `entry_at` finds exactly what `scan_room` lists, for every path under `r` plus `extra`.
    fn assert_agrees(r: &Path, honor: bool, extra: &[&Path]) {
        let walked = scan_room(r, honor, false);
        let mut paths = all_paths(r);
        paths.extend(extra.iter().map(|p| p.to_path_buf()));
        for rel in paths {
            let want = walked.iter().find(|e| Path::new(&e.rel_path) == rel);
            let got = entry_at(r, &rel, honor, false);
            assert_eq!(got.as_ref().map(|e| (&e.target, &e.class)), want.map(|e| (&e.target, &e.class)), "{rel:?} (gitignore: {honor})");
        }
    }

    #[test]
    fn entry_at_follows_the_walks_ignore_precedence() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for dir in ["gen", "sub", "deep/x"] { fs::create_dir_all(r.join(dir)).unwrap(); }
        for f in ["gen/k.html", "sub/a.html", "deep/x/y.html", "deep/z.html"] { fs::write(r.join(f), "").unwrap(); }
        // A file under an ignored folder can't be re-included; .roomsignore at any depth beats .gitignore.
        fs::write(r.join(".roomsignore"), "gen/\n!gen/k.html\nsub/a.html\n").unwrap();
        fs::write(r.join("sub/.gitignore"), "!a.html\n").unwrap();
        fs::write(r.join(".gitignore"), "deep/\n").unwrap();
        fs::write(r.join("deep/.roomsignore"), "!x/\n").unwrap();
        for honor in [false, true] { assert_agrees(r, honor, &[]); }
    }

    #[test]
    fn entry_at_misses_a_name_that_only_matches_case_or_unicode_insensitively() {
        use unicode_normalization::UnicodeNormalization;
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let (nfc, nfd): (String, String) = ("회의.html".nfc().collect(), "회의.html".nfd().collect());
        fs::write(r.join("X.html"), "").unwrap();
        fs::write(r.join(&nfc), "").unwrap();
        assert!(entry_at(r, Path::new("X.html"), false, false).is_some());
        assert!(entry_at(r, Path::new("x.html"), false, false).is_none(), "after a case-only rename x.html is gone");
        assert!(entry_at(r, Path::new(&nfc), false, false).is_some());
        assert!(entry_at(r, Path::new(&nfd), false, false).is_none(), "after an NFD→NFC rename the NFD name is gone");
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
