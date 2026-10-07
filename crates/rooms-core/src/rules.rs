use crate::error::CoreError;
use sha1::{Digest, Sha1};
use std::path::{Component, Path};
use unicode_normalization::UnicodeNormalization;

pub const DEFAULT_IGNORED_DIRS: [&str; 5] = ["node_modules", "dist", "build", ".next", "coverage"];
pub const RESERVED_NAMES: [&str; 2] = ["journal", "inbox"];

#[derive(Debug, PartialEq, Eq)]
pub enum PathClass { Artifact, Note { date: String }, Ignored }

/// `.html` or `.htm`, any case.
pub(crate) fn is_html(p: &Path) -> bool {
    matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("html" | "htm"))
}

fn has_control_char(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

pub fn classify_path(rel: &Path, in_journal: bool) -> PathClass {
    let mut parts: Vec<&str> = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => {
                match s.to_str() {
                    Some(s_str) => parts.push(s_str),
                    None => return PathClass::Ignored,
                }
            }
            _ => return PathClass::Ignored,
        }
    }
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
    if n == 0 || n > 80 || t.contains(['/', '\\', ':']) || t.contains("..") || t.starts_with('.') || has_control_char(t) { return Err(CoreError::InvalidRoomName); }
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
    let trimmed = name.trim();
    // Strip exactly ONE trailing ".md" (case-insensitively)
    // Use safe byte slicing that respects UTF-8 boundaries
    let base = if trimmed.get(trimmed.len().saturating_sub(3)..).map_or(false, |s| s.eq_ignore_ascii_case(".md")) {
        &trimmed[..trimmed.len()-3]
    } else {
        trimmed
    };
    // NFC-normalize the base
    let normalized_base: String = base.nfc().collect();
    let n = normalized_base.chars().count();
    if n == 0 || n > 60 || normalized_base.contains(['/', '\\', ':']) || normalized_base.contains("..") || normalized_base.starts_with('.') || has_control_char(&normalized_base) {
        return Err(CoreError::InvalidInput("note name".into()));
    }
    Ok(format!("{}.md", normalized_base))
}

pub fn validate_iso_date(d: &str) -> Result<(), CoreError> {
    let bad = || CoreError::InvalidInput("date".into());
    let parsed = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| bad())?;
    if parsed.format("%Y-%m-%d").to_string() != d { return Err(bad()); }
    Ok(())
}

/// The `fileKey` of an original at `target` (its canonical path): first 16 hex of sha256.
pub fn file_key(target: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(target.as_bytes()))[..16].to_string()
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

    #[test]
    fn iso_date_must_be_canonical() {
        assert!(validate_iso_date("2026-10-05").is_ok());
        for bad in [" 2026-10-5", "+026-10-05", "2026-1-005", "2026-13-01"] {
            assert!(validate_iso_date(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn room_name_rejects_dot_prefix_and_control_chars() {
        assert!(validate_room_name(".hidden").is_err());
        assert!(validate_room_name(".rooms").is_err());
        assert!(validate_room_name("a\0b").is_err()); // NUL control char
        assert!(validate_room_name("test\nname").is_err()); // newline control char
    }

    #[test]
    fn note_name_strips_one_md_and_normalizes() {
        // Strip exactly ONE ".md"
        assert_eq!(validate_note_name("a.md.md").unwrap(), "a.md.md");
        assert_eq!(validate_note_name("a.md").unwrap(), "a.md");
        assert_eq!(validate_note_name("X.MD").unwrap(), "X.md");

        // NFC normalization: NFD input -> NFC output
        let nfd: String = unicode_normalization::UnicodeNormalization::nfd("café").collect();
        let result = validate_note_name(&nfd).unwrap();
        // The base "café" (whether NFD or NFC) becomes "café.md" in NFC form
        let expected = "café.md"; // This is in NFC form
        assert_eq!(result, expected);

        // Control character rejection
        assert!(validate_note_name("a\0b").is_err()); // NUL control char
    }

    #[test]
    fn classify_path_rejects_non_normal_and_non_utf8() {
        // Path with ".." component should be ignored
        assert_eq!(classify_path(Path::new("a/../b.html"), false), PathClass::Ignored);

        // Non-UTF-8 path on Unix (using OsStr)
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            use std::ffi::OsStr;
            let non_utf8_bytes = b"invalid\xffu.html";
            let non_utf8 = OsStr::from_bytes(non_utf8_bytes);
            let path = Path::new(non_utf8);
            assert_eq!(classify_path(path, false), PathClass::Ignored);
        }
    }

    #[test]
    fn note_name_handles_multibyte_chars_safely() {
        // These should not panic on multi-byte character boundary checks
        assert_eq!(validate_note_name("회a").unwrap(), "회a.md");
        assert_eq!(validate_note_name("éé").unwrap(), "éé.md");
        assert_eq!(validate_note_name("日本a").unwrap(), "日本a.md");
        assert_eq!(validate_note_name("가.MD").unwrap(), "가.md");
    }
}
