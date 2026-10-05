use lol_html::{element, text, HtmlRewriter, Settings};
use rooms_protocol::Source;
use std::cell::RefCell;
use std::io::Read;
use std::path::Path;

const HEAD_LIMIT: usize = 64 * 1024;

#[derive(Debug, Default, Clone)]
pub struct Meta {
    pub title: Option<String>,
    pub created: Option<String>,
    pub source: Source,
}

pub fn extract_meta(head: &[u8]) -> Meta {
    let tag_title = RefCell::new(String::new());
    let meta = RefCell::new(Meta::default());
    let mut rw = HtmlRewriter::new(
        Settings {
            element_content_handlers: vec![
                text!("title", |t| { tag_title.borrow_mut().push_str(t.as_str()); Ok(()) }),
                element!("meta[name]", |el| {
                    let name = el.get_attribute("name").unwrap_or_default();
                    let content = el.get_attribute("content").map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
                    let mut m = meta.borrow_mut();
                    match name.as_str() {
                        "rooms:title" => m.title = content,
                        "rooms:created" => m.created = content.filter(|c| chrono::DateTime::parse_from_rfc3339(c).is_ok()),
                        "rooms:agent" => m.source.agent = content,
                        "rooms:session" => m.source.session = content,
                        "rooms:cwd" => m.source.cwd = content,
                        "rooms:machine" => m.source.machine = content,
                        _ => {}
                    }
                    Ok(())
                }),
            ],
            ..Settings::new()
        },
        |_: &[u8]| {},
    );
    let _ = rw.write(&head[..head.len().min(HEAD_LIMIT)]);
    let _ = rw.end();
    let mut m = meta.into_inner();
    if m.title.is_none() {
        let t = tag_title.into_inner().trim().to_string();
        if !t.is_empty() { m.title = Some(t); }
    }
    m
}

pub fn read_meta(path: &Path) -> Meta {
    let mut buf = Vec::with_capacity(HEAD_LIMIT);
    match std::fs::File::open(path) {
        Ok(f) => { let _ = f.take(HEAD_LIMIT as u64).read_to_end(&mut buf); }
        Err(_) => return Meta::default(),
    }
    extract_meta(&buf)
}

pub fn file_times(path: &Path) -> (String, String) {
    let to_rfc = |t: std::time::SystemTime| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339();
    match std::fs::metadata(path) {
        Ok(m) => {
            let modified = m.modified().map(to_rfc).unwrap_or_default();
            let created = m.created().map(to_rfc).unwrap_or_else(|_| modified.clone());
            (created, modified)
        }
        Err(_) => { let now = chrono::Local::now().to_rfc3339(); (now.clone(), now) }
    }
}

pub fn title_or_filename(meta: &Meta, rel_path: &str) -> String {
    if let Some(t) = meta.title.as_ref().map(|t| t.trim()).filter(|t| !t.is_empty()) { return t.to_string(); }
    Path::new(rel_path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| rel_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooms_title_beats_title_tag() {
        let m = extract_meta(br#"<html><head><meta name="rooms:title" content="Meta T"><title>Tag T</title></head>"#);
        assert_eq!(m.title.as_deref(), Some("Meta T"));
    }

    #[test]
    fn reads_title_and_source_meta() {
        let html = r#"<head><title> 벤치마크 현황 </title>
          <meta name="rooms:created" content="2026-10-05T10:02:00+09:00">
          <meta name="rooms:agent" content="codex"><meta name="rooms:session" content="s1">
          <meta name="rooms:cwd" content="/w"><meta name="rooms:machine" content="mac-mini"></head>"#.as_bytes();
        let m = extract_meta(html);
        assert_eq!(m.title.as_deref(), Some("벤치마크 현황"));
        assert_eq!(m.created.as_deref(), Some("2026-10-05T10:02:00+09:00"));
        assert_eq!(m.source.agent.as_deref(), Some("codex"));
        assert_eq!(m.source.session.as_deref(), Some("s1"));
        assert_eq!(m.source.cwd.as_deref(), Some("/w"));
        assert_eq!(m.source.machine.as_deref(), Some("mac-mini"));
    }

    #[test]
    fn invalid_created_is_dropped() {
        let m = extract_meta(br#"<meta name="rooms:created" content="yesterday">"#);
        assert!(m.created.is_none());
    }

    #[test]
    fn binary_and_huge_files_fall_back_to_filename() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("blob.html");
        let mut bytes = vec![0xffu8, 0xfe, 0x00];
        bytes.extend(std::iter::repeat(b'x').take(5 * 1024 * 1024));
        std::fs::write(&p, &bytes).unwrap();
        let m = read_meta(&p);
        assert_eq!(title_or_filename(&m, "sub/blob.html"), "blob");
    }

    #[test]
    fn empty_title_falls_back() {
        let m = extract_meta(b"<title>   </title>");
        assert_eq!(title_or_filename(&m, "a/report.htm"), "report");
    }
}
