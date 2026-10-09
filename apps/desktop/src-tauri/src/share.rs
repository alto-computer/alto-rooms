//! The doc tab's Share menu: the original file behind a doc's room link, copied, revealed in
//! Finder, or opened in the default app. These run here, not through the opener plugin's JS
//! API, because its open-path scope resolves symlinks and originals usually live outside
//! `~/rooms`. In exchange, only HTML files qualify, so the webview can't open anything else.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

fn original(link: &Path) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(link).map_err(|e| format!("{}: {e}", link.display()))?;
    let html = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
    if html && path.is_file() {
        Ok(path)
    } else {
        Err(format!("{}: not an HTML file", path.display()))
    }
}

#[tauri::command]
pub fn doc_original(link: PathBuf) -> Result<String, String> {
    original(&link).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reveal_doc(link: PathBuf) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(original(&link)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_doc(app: AppHandle, link: PathBuf) -> Result<(), String> {
    app.opener().open_path(original(&link)?.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rooms-share-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(d).unwrap()
    }

    #[test]
    fn a_room_link_resolves_to_its_original() {
        let d = temp_dir("link");
        let doc = d.join("project/report.HTML");
        fs::create_dir_all(doc.parent().unwrap()).unwrap();
        fs::write(&doc, "<p>hi</p>").unwrap();
        fs::create_dir_all(d.join("rooms/room")).unwrap();
        symlink(&doc, d.join("rooms/room/report.HTML")).unwrap();
        assert_eq!(original(&d.join("rooms/room/report.HTML")).unwrap(), doc);
        assert_eq!(original(&doc).unwrap(), doc);
    }

    #[test]
    fn only_existing_html_files_qualify() {
        let d = temp_dir("refuse");
        fs::write(d.join("run.command"), "#!/bin/sh").unwrap();
        symlink(d.join("run.command"), d.join("disguised.html")).unwrap();
        fs::create_dir_all(d.join("folder.html")).unwrap();
        for p in ["run.command", "disguised.html", "folder.html", "missing.html"] {
            assert!(original(&d.join(p)).is_err(), "{p} must be refused");
        }
    }
}
