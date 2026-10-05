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

#[derive(Default)]
struct Collector {
    titles: Vec<String>,
    meta: Meta,
}

impl Collector {
    fn apply_meta(&mut self, name: &str, content: Option<String>) {
        let Some(c) = content else { return };
        let m = &mut self.meta;
        match name {
            "rooms:title" => { if m.title.is_none() { m.title = Some(c); } }
            "rooms:created" => {
                if m.created.is_none() && chrono::DateTime::parse_from_rfc3339(&c).is_ok() { m.created = Some(c); }
            }
            "rooms:agent" => { if m.source.agent.is_none() { m.source.agent = Some(c); } }
            "rooms:session" => { if m.source.session.is_none() { m.source.session = Some(c); } }
            "rooms:cwd" => { if m.source.cwd.is_none() { m.source.cwd = Some(c); } }
            "rooms:machine" => { if m.source.machine.is_none() { m.source.machine = Some(c); } }
            _ => {}
        }
    }

    fn finish(self) -> Meta {
        let mut m = self.meta;
        if m.title.is_none() {
            m.title = self.titles.iter().map(|t| t.trim()).find(|t| !t.is_empty()).map(str::to_string);
        }
        m
    }
}

/// Head-scoped values win. Only when the document has no <head> element at all
/// (fragments) do we fall back to the first top-level <title> and first-wins <meta>.
pub fn extract_meta(head: &[u8]) -> Meta {
    let in_head = RefCell::new(Collector::default());
    let any = RefCell::new(Collector::default());
    let saw_head = RefCell::new(false);
    let mut rw = HtmlRewriter::new(
        Settings {
            element_content_handlers: vec![
                element!("head", |_| { *saw_head.borrow_mut() = true; Ok(()) }),
                element!("head title", |_| { in_head.borrow_mut().titles.push(String::new()); Ok(()) }),
                text!("head title", |t| {
                    if let Some(s) = in_head.borrow_mut().titles.last_mut() { s.push_str(t.as_str()); }
                    Ok(())
                }),
                element!("title", |_| { any.borrow_mut().titles.push(String::new()); Ok(()) }),
                text!("title", |t| {
                    if let Some(s) = any.borrow_mut().titles.last_mut() { s.push_str(t.as_str()); }
                    Ok(())
                }),
                element!("head meta[name]", |el| {
                    let name = el.get_attribute("name").unwrap_or_default();
                    let content = el.get_attribute("content").map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
                    in_head.borrow_mut().apply_meta(&name, content);
                    Ok(())
                }),
                element!("meta[name]", |el| {
                    let name = el.get_attribute("name").unwrap_or_default();
                    let content = el.get_attribute("content").map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
                    any.borrow_mut().apply_meta(&name, content);
                    Ok(())
                }),
            ],
            ..Settings::new()
        },
        |_: &[u8]| {},
    );
    let _ = rw.write(&head[..head.len().min(HEAD_LIMIT)]);
    let _ = rw.end();
    if *saw_head.borrow() { in_head.into_inner().finish() } else { any.into_inner().finish() }
}

pub fn read_meta(path: &Path) -> Meta {
    let mut buf = Vec::with_capacity(HEAD_LIMIT);
    match std::fs::File::open(path) {
        Ok(f) => { let _ = f.take(HEAD_LIMIT as u64).read_to_end(&mut buf); }
        Err(_) => return Meta::default(),
    }
    extract_meta(&buf)
}

fn to_rfc(t: std::time::SystemTime) -> String { chrono::DateTime::<chrono::Local>::from(t).to_rfc3339() }

/// mtime in the same format `file_times` reports as `updated` (None if it cannot be read).
pub fn file_mtime(path: &Path) -> Option<String> {
    std::fs::metadata(path).ok()?.modified().ok().map(to_rfc)
}

pub fn file_times(path: &Path) -> (String, String) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let modified = m.modified().map(to_rfc).unwrap_or_else(|_| chrono::Local::now().to_rfc3339());
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
    fn body_svg_title_is_ignored_when_head_exists() {
        let m = extract_meta(b"<head><title>Report</title></head><body><svg><title>Icon</title></svg></body>");
        assert_eq!(m.title.as_deref(), Some("Report"));
    }

    #[test]
    fn body_meta_does_not_override_head() {
        let m = extract_meta(br#"<head><meta name="rooms:agent" content="codex"></head><body><meta name="rooms:agent" content="x"></body>"#);
        assert_eq!(m.source.agent.as_deref(), Some("codex"));
    }

    #[test]
    fn later_empty_content_does_not_wipe_earlier() {
        let m = extract_meta(br#"<head><meta name="rooms:session" content="s1"><meta name="rooms:session" content="  "></head>"#);
        assert_eq!(m.source.session.as_deref(), Some("s1"));
    }

    #[test]
    fn empty_title_falls_back() {
        let m = extract_meta(b"<title>   </title>");
        assert_eq!(title_or_filename(&m, "a/report.htm"), "report");
    }
}
