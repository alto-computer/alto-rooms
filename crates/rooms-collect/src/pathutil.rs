//! Lexical path helpers shared by the adapters and sinks (find_html.py's `resolve`, `under`).
use std::path::{Component, Path, PathBuf};

/// `.html` or `.htm`, any case.
pub fn is_html(p: &str) -> bool {
    let l = p.to_ascii_lowercase();
    l.ends_with(".html") || l.ends_with(".htm")
}

/// `~` and `~/…` expanded against `user_home`; anything else unchanged.
pub fn expand_tilde(p: &str, user_home: &Path) -> PathBuf {
    if p == "~" { return user_home.to_path_buf(); }
    match p.strip_prefix("~/") {
        Some(rest) => user_home.join(rest),
        None => PathBuf::from(p),
    }
}

/// `.` and `..` removed without touching the disk (Python's `os.path.normpath`).
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => { if !out.pop() { out.push(".."); } }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() { PathBuf::from(".") } else { out }
}

/// `p` made absolute against `base` (with `~` expanded) and normalized; `None` when it is
/// relative and there is no base.
pub fn resolve(p: &str, base: Option<&Path>, user_home: &Path) -> Option<PathBuf> {
    let p = expand_tilde(p, user_home);
    let p = if p.is_absolute() { p } else { base?.join(p) };
    Some(normalize(&p))
}

/// `path` is `prefix` or inside it (string-wise, like find_html.py's `under`).
pub fn under(path: &Path, prefix: &Path) -> bool {
    path.starts_with(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_find_html() {
        let h = Path::new("/Users/me");
        assert_eq!(resolve("a/../b.html", Some(Path::new("/x")), h), Some(PathBuf::from("/x/b.html")));
        assert_eq!(resolve("~/d/a.html", None, h), Some(PathBuf::from("/Users/me/d/a.html")));
        assert_eq!(resolve("a.html", None, h), None);
        assert_eq!(resolve("/a/./b/../c.htm", None, h), Some(PathBuf::from("/a/c.htm")));
        assert!(is_html("X.HTML") && is_html("a.htm") && !is_html("a.html.txt"));
    }
}
