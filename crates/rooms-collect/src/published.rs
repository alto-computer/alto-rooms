//! Copies of published pages that live in temp folders: `<data>/artifacts/<id>/` holds the page
//! and the files published beside it, `<data>/artifacts/<id>.json` fixes the page's name. Rooms
//! links the copy, so the link outlives the scratchpad. Like the archive, never deleted here.
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct Manifest { url: String, page: String, source: PathBuf }

/// The folder name for an artifact: the last segment of its URL (`claude.ai/artifact/<id>`).
pub fn key(url: &str) -> Option<String> {
    let id = url.split(['?', '#']).next()?.trim_end_matches('/').rsplit('/').next()?;
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| id.to_string())
}

/// Copies `page` (and `files`) into the store and returns the page copy. The same URL always maps
/// to the same copy, overwritten in place, so a re-publish refreshes it without a new link.
pub fn keep(store: &Path, url: &str, page: &Path, files: &[(String, Option<PathBuf>)]) -> std::io::Result<PathBuf> {
    let id = key(url).ok_or_else(|| std::io::Error::other(format!("no artifact id in {url}")))?;
    let dir = store.join(&id);
    let manifest_path = store.join(format!("{id}.json"));
    let name = std::fs::read(&manifest_path).ok()
        .and_then(|b| serde_json::from_slice::<Manifest>(&b).ok()).map(|m| m.page)
        .or_else(|| page.file_name().map(|n| n.to_string_lossy().into_owned()))
        .ok_or_else(|| std::io::Error::other("page has no file name"))?;
    let copy = dir.join(&name);
    copy_atomic(page, &copy)?;
    for (published, source) in files {
        let Some(rel) = inside(published).filter(|r| r != Path::new(&name)) else { continue };
        let dst = dir.join(rel);
        match source {
            Some(src) if src.is_file() => { if let Err(e) = copy_atomic(src, &dst) { eprintln!("rooms-collect: could not copy {}: {e}", src.display()); } }
            Some(_) => {}
            None => { let _ = std::fs::remove_file(&dst); }
        }
    }
    let m = Manifest { url: url.to_string(), page: name, source: page.to_path_buf() };
    write_atomic(&manifest_path, &serde_json::to_vec_pretty(&m)?)?;
    Ok(copy)
}

/// A published path as a path inside the artifact's folder; `None` when it would leave it.
fn inside(published: &str) -> Option<PathBuf> {
    let p = Path::new(published);
    let ok = p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    let rel: PathBuf = p.components().filter(|c| matches!(c, Component::Normal(_))).collect();
    (ok && !rel.as_os_str().is_empty()).then_some(rel)
}

fn copy_atomic(src: &Path, dst: &Path) -> std::io::Result<()> {
    write_atomic(dst, &std::fs::read(src)?)
}

/// Writes through a temp file and rename, so the link never shows a half-written page.
fn write_atomic(dst: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = dst.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.{}.tmp", dst.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    let res = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, dst));
    if res.is_err() { let _ = std::fs::remove_file(&tmp); }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_inside_paths() {
        assert_eq!(key("https://claude.ai/artifact/DU8TsWQvmd23").as_deref(), Some("DU8TsWQvmd23"));
        assert_eq!(key("https://claude.ai/code/artifact/64f7585a-27da/").as_deref(), Some("64f7585a-27da"));
        assert_eq!(key("https://claude.ai/artifact/a%2Fb"), None);
        assert_eq!(inside("img/a.png"), Some(PathBuf::from("img/a.png")));
        assert_eq!(inside("./a.html"), Some(PathBuf::from("a.html")));
        for bad in ["../a.html", "/etc/passwd", "a/../../b", ""] { assert_eq!(inside(bad), None, "{bad}"); }
    }

    #[test]
    fn republish_refreshes_the_same_copy_and_files_follow() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("scratchpad");
        std::fs::create_dir_all(src.join("img")).unwrap();
        std::fs::write(src.join("page.html"), "v1").unwrap();
        std::fs::write(src.join("img/a.png"), "png").unwrap();
        let store = d.path().join("artifacts");
        let url = "https://claude.ai/artifact/ABC";
        let files = vec![("img/a.png".to_string(), Some(src.join("img/a.png"))), ("../escape.html".to_string(), Some(src.join("page.html")))];
        let copy = keep(&store, url, &src.join("page.html"), &files).unwrap();
        assert_eq!(copy, store.join("ABC/page.html"));
        assert_eq!(std::fs::read_to_string(store.join("ABC/img/a.png")).unwrap(), "png");
        assert!(!store.join("escape.html").exists());

        std::fs::write(src.join("renamed.html"), "v2").unwrap();
        let again = keep(&store, url, &src.join("renamed.html"), &[("img/a.png".to_string(), None)]).unwrap();
        assert_eq!(again, copy, "same URL, same copy");
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "v2");
        assert!(!store.join("ABC/img/a.png").exists(), "a removed file leaves the copy");
    }
}
