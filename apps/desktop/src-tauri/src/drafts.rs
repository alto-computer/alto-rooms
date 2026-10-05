//! Note drafts: the text of notes that could not be saved before the app quit.
//!
//! The webview keeps them through `save_note_draft` / `load_note_draft` /
//! `delete_note_draft` (localStorage is not guaranteed to reach disk before
//! the process exits). Each draft is one file, mode 0600, in
//! `<app data dir>/note-drafts/` (mode 0700), named after its key. A save is
//! written to a temp file, fsynced, renamed into place, and the directory is
//! fsynced, before the command returns. The value is opaque to Rust (the
//! webview stores JSON with the note text); it never holds a token.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const DIR: &str = "note-drafts";
/// Keys whose hex form would be longer than this are named by a hash instead.
const MAX_HEX_NAME: usize = 200;
/// Drafts larger than this are refused (a note, not a dump).
const MAX_DRAFT_BYTES: u64 = 8 * 1024 * 1024;

/// A safe file name for `key`: lowercase hex of its UTF-8 bytes (`k-…`), or,
/// for long keys, a 64-bit FNV-1a hash plus the byte length (`h-…`).
pub fn key_file_name(key: &str) -> String {
    let hex: String = key.bytes().map(|b| format!("{b:02x}")).collect();
    if hex.len() <= MAX_HEX_NAME {
        return format!("k-{hex}");
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("h-{h:016x}-{}", key.len())
}

fn ensure_dir(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

/// Writes the draft durably: temp file (0600) → fsync → rename → fsync dir.
pub fn save_draft(dir: &Path, key: &str, value: &str) -> io::Result<()> {
    ensure_dir(dir)?;
    let name = key_file_name(key);
    let tmp = dir.join(format!("{name}.tmp"));
    let dest = dir.join(&name);
    {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(value.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, &dest)?;
    File::open(dir)?.sync_all()
}

/// The draft for `key`, if any.
pub fn load_draft(dir: &Path, key: &str) -> io::Result<Option<String>> {
    let path = dir.join(key_file_name(key));
    let f = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut raw = String::new();
    f.take(MAX_DRAFT_BYTES).read_to_string(&mut raw)?;
    Ok(Some(raw))
}

/// Removes the draft for `key`; a missing draft is fine.
pub fn delete_draft(dir: &Path, key: &str) -> io::Result<()> {
    match fs::remove_file(dir.join(key_file_name(key))) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join(DIR)).map_err(|e| format!("no app data dir: {e}"))
}

fn log_err(what: &str) -> impl Fn(io::Error) -> String + '_ {
    move |e| {
        eprintln!("note draft: {what} failed: {:?}", e.kind());
        format!("{what} failed")
    }
}

#[tauri::command]
pub fn save_note_draft(app: AppHandle, key: String, value: String) -> Result<(), String> {
    if value.len() as u64 > MAX_DRAFT_BYTES {
        return Err("draft too large".into());
    }
    let dir = drafts_dir(&app)?;
    save_draft(&dir, &key, &value).map_err(log_err("save"))?;
    eprintln!("note draft: saved {}", key_file_name(&key));
    Ok(())
}

#[tauri::command]
pub fn load_note_draft(app: AppHandle, key: String) -> Result<Option<String>, String> {
    load_draft(&drafts_dir(&app)?, &key).map_err(log_err("load"))
}

#[tauri::command]
pub fn delete_note_draft(app: AppHandle, key: String) -> Result<(), String> {
    let dir = drafts_dir(&app)?;
    let existed = dir.join(key_file_name(&key)).exists();
    delete_draft(&dir, &key).map_err(log_err("delete"))?;
    if existed {
        eprintln!("note draft: deleted {}", key_file_name(&key));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rooms-drafts-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn key_file_names_are_safe_and_distinct() {
        let k = "alto-rooms.note-draft.v1:2026-10-05/계획.md";
        let name = key_file_name(k);
        assert!(name.starts_with("k-"));
        assert!(name[2..].bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(name, key_file_name("alto-rooms.note-draft.v1:2026-10-05/회고.md"));
        assert_eq!(key_file_name("../x"), "k-2e2e2f78"); // no separators survive
        let long = format!("2026-10-05/{}.md", "아주 긴 노트 이름".repeat(10));
        let h = key_file_name(&long);
        assert!(h.starts_with("h-") && h.len() < 64 && !h.contains('/'));
        assert_eq!(h, key_file_name(&long));
        assert_ne!(h, key_file_name(&format!("{long}x")));
    }

    #[test]
    fn save_load_delete_round_trip_with_private_modes() {
        let dir = temp_dir("rt").join("note-drafts");
        let key = "2026-10-05/계획.md";
        assert_eq!(load_draft(&dir, key).unwrap(), None);
        save_draft(&dir, key, r#"{"text":"글","baseHash":"1"}"#).unwrap();
        let file = dir.join(key_file_name(key));
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(load_draft(&dir, key).unwrap().as_deref(), Some(r#"{"text":"글","baseHash":"1"}"#));
        // Overwrite replaces; no temp file is left behind.
        save_draft(&dir, key, "두 번째").unwrap();
        assert_eq!(load_draft(&dir, key).unwrap().as_deref(), Some("두 번째"));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        delete_draft(&dir, key).unwrap();
        assert_eq!(load_draft(&dir, key).unwrap(), None);
        delete_draft(&dir, key).unwrap(); // already gone: fine
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_symlinked_draft_is_not_followed() {
        let dir = temp_dir("link");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("elsewhere");
        fs::write(&target, "secret").unwrap();
        std::os::unix::fs::symlink(&target, dir.join(key_file_name("k"))).unwrap();
        assert!(load_draft(&dir, "k").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
