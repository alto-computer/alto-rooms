//! A plugin's own storage under `data/`, and the assets it serves from its folder. Pure file
//! functions over a plugin folder; `RoomsCore` checks the plugin may use them first.

use crate::lock::lock;
use super::DATA;
use crate::error::CoreError;
use std::path::{Component, Path, PathBuf};

/// Largest text a plugin may store in one data file (UTF-8 bytes).
pub const MAX_DATA_BYTES: usize = 10 * 1024 * 1024;

/// A data or asset path: 1–200 chars, `/`-joined segments of `[A-Za-z0-9._-]`, no `.`/`..`/empty
/// segment, no leading `/`, at most 8 deep.
pub fn valid_path(rel: &str) -> bool {
    if rel.is_empty() || rel.len() > 200 { return false; }
    let segs: Vec<&str> = rel.split('/').collect();
    segs.len() <= 8
        && segs.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)))
}

/// `<dir>/data/<rel>` after the path rule, refusing any symlink on the way (no escape from data/).
fn data_file(dir: &Path, rel: &str) -> Result<PathBuf, CoreError> {
    if !valid_path(rel) { return Err(CoreError::InvalidPath); }
    let root = dir.join(DATA);
    let mut p = root.clone();
    if std::fs::symlink_metadata(&root).is_ok_and(|m| m.file_type().is_symlink()) { return Err(CoreError::InvalidPath); }
    for seg in rel.split('/') {
        p.push(seg);
        if std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) { return Err(CoreError::InvalidPath); }
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
    if text.len() > MAX_DATA_BYTES { return Err(CoreError::TooLarge); }
    let parent = p.parent().ok_or(CoreError::InvalidPath)?;
    std::fs::create_dir_all(parent)?;
    let name = p.file_name().ok_or(CoreError::InvalidPath)?.to_string_lossy().to_string();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = parent.join(format!(".{name}.{}-{nanos}.part", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &p).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })?;
    Ok(())
}

/// Appends `line` (which carries its own newline) to a data file with one `O_APPEND` write, so
/// concurrent appends never interleave. The file (existing length + `line`) must stay within
/// `MAX_DATA_BYTES`; the check and the write share one lock, so the cap is exact in this process.
pub fn append_data(dir: &Path, rel: &str, line: &str) -> Result<(), CoreError> {
    use std::io::Write;
    static APPEND: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let p = data_file(dir, rel)?;
    let _guard = lock(&APPEND);
    let have = match std::fs::symlink_metadata(&p) {
        Ok(m) if m.is_file() => m.len() as usize,
        Ok(_) => return Err(CoreError::InvalidInput("is a folder".into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.into()),
    };
    if have.saturating_add(line.len()) > MAX_DATA_BYTES { return Err(CoreError::TooLarge); }
    std::fs::create_dir_all(p.parent().ok_or(CoreError::InvalidPath)?)?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p)?;
    f.write_all(line.as_bytes())?;
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
    if !valid_path(rel) || rel.split('/').next() == Some(DATA) { return Err(CoreError::InvalidPath); }
    let root = std::fs::canonicalize(dir).map_err(|_| CoreError::NotFound)?;
    let p = std::fs::canonicalize(dir.join(rel)).map_err(|_| CoreError::NotFound)?;
    let inside = p.strip_prefix(&root).ok().filter(|r| r.components().next() != Some(Component::Normal(DATA.as_ref())));
    if inside.is_none() || !p.is_file() { return Err(CoreError::NotFound); }
    Ok(p)
}


#[cfg(test)]
mod tests {
    use super::super::test_support::{plugin, OK};
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

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
        assert!(matches!(write_data(&dir, "../token", "x").unwrap_err(), CoreError::InvalidPath));
        let big = "x".repeat(MAX_DATA_BYTES + 1);
        assert!(matches!(write_data(&dir, "big.txt", &big).unwrap_err(), CoreError::TooLarge));
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(d.path().join("secret.txt"), "s").unwrap();
        symlink(d.path().join("secret.txt"), dir.join("data/leak.txt")).unwrap();
        symlink(d.path(), dir.join("data/out")).unwrap();
        assert!(matches!(read_data(&dir, "leak.txt").unwrap_err(), CoreError::InvalidPath));
        assert!(matches!(write_data(&dir, "out/new.txt", "x").unwrap_err(), CoreError::InvalidPath));
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
}
