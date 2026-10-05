use crate::error::CoreError;
use sha1::{Digest, Sha1};
use std::path::{Component, Path};
use unicode_normalization::UnicodeNormalization;

pub const DEFAULT_IGNORED_DIRS: [&str; 5] = ["node_modules", "dist", "build", ".next", "coverage"];
pub const RESERVED_NAMES: [&str; 2] = ["journal", "inbox"];

#[derive(Debug, PartialEq, Eq)]
pub enum PathClass { Artifact, Note { date: String }, Ignored }

fn is_html(p: &Path) -> bool {
    matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("html" | "htm"))
}

pub fn classify_path(rel: &Path, in_journal: bool) -> PathClass {
    let parts: Vec<&str> = rel.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    }).collect();
    if parts.is_empty() { return PathClass::Ignored; }
    for dir in &parts[..parts.len() - 1] {
        if dir.starts_with('.') || DEFAULT_IGNORED_DIRS.contains(dir) { return PathClass::Ignored; }
    }
    if parts[parts.len() - 1].starts_with('.') { return PathClass::Ignored; }
    if is_html(rel) { return PathClass::Artifact; }
    let is_md = rel.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false);
    if in_journal && is_md && parts.len() == 2 && validate_iso_date(parts[0]).is_ok() {
        return PathClass::Note { date: parts[0].to_string() };
    }
    PathClass::Ignored
}

pub fn validate_room_name(name: &str) -> Result<String, CoreError> {
    let t = name.trim();
    let n = t.chars().count();
    if n == 0 || n > 80 || t.contains(['/', '\\', ':']) || t.contains("..") { return Err(CoreError::InvalidRoomName); }
    let key = slug_key(&room_slug(t));
    if RESERVED_NAMES.contains(&key.as_str()) { return Err(CoreError::InvalidRoomName); }
    Ok(t.to_string())
}

pub fn room_slug(name: &str) -> String {
    name.trim().nfc().map(|c| if c.is_whitespace() { '-' } else { c }).collect()
}

pub fn slug_key(slug: &str) -> String {
    slug.nfc().collect::<String>().to_lowercase()
}

pub fn validate_note_name(name: &str) -> Result<String, CoreError> {
    let base = name.trim().trim_end_matches(".md");
    let n = base.chars().count();
    if n == 0 || n > 60 || base.contains(['/', '\\', ':']) || base.contains("..") || base.starts_with('.') {
        return Err(CoreError::InvalidInput("note name".into()));
    }
    Ok(format!("{base}.md"))
}

pub fn validate_iso_date(d: &str) -> Result<(), CoreError> {
    if d.len() != 10 { return Err(CoreError::InvalidInput("date".into())); }
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map(|_| ()).map_err(|_| CoreError::InvalidInput("date".into()))
}

pub fn artifact_id(room_id: &str, rel_path: &str) -> String {
    let mut h = Sha1::new();
    h.update(room_id.as_bytes());
    h.update(b":");
    h.update(rel_path.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

pub fn local_day(rfc3339: &str) -> Option<String> {
    let t = chrono::DateTime::parse_from_rfc3339(rfc3339).ok()?;
    Some(t.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn html_is_artifact_md_is_note_only_in_journal() {
        assert_eq!(classify_path(Path::new("a/b.html"), false), PathClass::Artifact);
        assert_eq!(classify_path(Path::new("B.HTM"), false), PathClass::Artifact);
        assert_eq!(classify_path(Path::new("notes.md"), false), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("2026-10-05/회고.md"), true), PathClass::Note { date: "2026-10-05".into() });
        assert_eq!(classify_path(Path::new("2026-10-05/sub/x.md"), true), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("img.png"), false), PathClass::Ignored);
    }

    #[test]
    fn hidden_and_build_dirs_are_ignored() {
        assert_eq!(classify_path(Path::new(".git/x.html"), false), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("node_modules/p/index.html"), false), PathClass::Ignored);
        assert_eq!(classify_path(Path::new("site/dist/index.html"), false), PathClass::Ignored);
    }

    #[test]
    fn room_name_rules() {
        assert_eq!(validate_room_name("  연구 도구 ").unwrap(), "연구 도구");
        assert!(validate_room_name("").is_err());
        assert!(validate_room_name("a/b").is_err());
        assert!(validate_room_name("..").is_err());
        assert!(validate_room_name("Journal").is_err());
        assert!(validate_room_name("INBOX").is_err());
        assert!(validate_room_name(&"x".repeat(81)).is_err());
    }

    #[test]
    fn nfd_and_nfc_names_collide() {
        let nfc = "연구 도구";
        let nfd: String = unicode_normalization::UnicodeNormalization::nfd(nfc).collect();
        assert_ne!(nfc, nfd);
        assert_eq!(slug_key(&room_slug(nfc)), slug_key(&room_slug(&nfd)));
        assert_eq!(slug_key(&room_slug("연구 도구")), slug_key(&room_slug("연구-도구")));
        assert_eq!(slug_key("Research"), slug_key("research"));
    }

    #[test]
    fn artifact_id_is_stable_16_hex() {
        let a = artifact_id("r1", "x/a.html");
        assert_eq!(a.len(), 16);
        assert_eq!(a, artifact_id("r1", "x/a.html"));
        assert_ne!(a, artifact_id("r2", "x/a.html"));
    }

    #[test]
    fn note_and_date_rules() {
        assert_eq!(validate_note_name("회고").unwrap(), "회고.md");
        assert!(validate_note_name("a/b").is_err());
        assert!(validate_iso_date("2026-10-05").is_ok());
        assert!(validate_iso_date("2026-02-30").is_err());
        assert!(validate_iso_date("2026-10-5").is_err());
    }
}
