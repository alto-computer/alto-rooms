//! Splices one block of bytes into a streamed HTML document where the parser opens the head, so
//! the block's scripts run before anything the document itself declares, including a `<meta
//! http-equiv="Content-Security-Policy">`. A policy in `<head>` governs every script parsed after
//! it, so a block appended at the tail is blocked by any strict artifact policy; one at the start
//! of the head is not (measured on Chromium and WebKit, see the F2-3 placement results).
//!
//! The scan reads only the document's prologue the way the HTML parser's "initial", "before html"
//! and "before head" modes do: whitespace, comments, the doctype and `<html …>` are skipped. The
//! first other tag or text opens an implied head, so the block goes before it (after `<html …>`,
//! else after the doctype, else at the start). This keeps the block out of a late `<head>` that the
//! parser would ignore, and out of `<script>` or `<style>` text that happens to contain `<head>`.

use axum::body::Bytes;
use futures::{Stream, StreamExt};

/// How far into the document to look for the head before giving up on it.
const SEARCH_LIMIT: usize = 64 * 1024;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
const UTF16_BE_BOM: &[u8] = b"\xFE\xFF";
const UTF16_LE_BOM: &[u8] = b"\xFF\xFE";

/// Buffers the document's start until the insertion point is known, emits it with the block
/// spliced in, then passes every later chunk through untouched.
pub struct Splicer {
    block: Bytes,
    pending: Option<Vec<u8>>,
}

impl Splicer {
    pub fn new(block: Bytes) -> Self {
        Splicer { block, pending: Some(Vec::new()) }
    }

    /// Feeds one chunk; returns bytes ready to send, if any.
    pub fn push(&mut self, chunk: Bytes) -> Option<Bytes> {
        let Some(buf) = self.pending.as_mut() else { return Some(chunk) };
        buf.extend_from_slice(&chunk);
        let at = match scan(buf) {
            Scan::At(at) => Some(at),
            Scan::NotYet(_) if buf.len() < SEARCH_LIMIT => return None,
            Scan::NotYet(at) => Some(at),
            Scan::Utf16 => None,
        };
        Some(self.emit(at))
    }

    /// The end of the document: whatever is still buffered, with the block at the best spot found.
    pub fn end(mut self) -> Option<Bytes> {
        let at = match scan(self.pending.as_deref()?) {
            Scan::At(at) | Scan::NotYet(at) => Some(at),
            Scan::Utf16 => None,
        };
        Some(self.emit(at))
    }

    fn emit(&mut self, at: Option<usize>) -> Bytes {
        let buf = self.pending.take().unwrap_or_default();
        let Some(at) = at else { return Bytes::from(buf) };
        let mut out = Vec::with_capacity(buf.len() + self.block.len());
        out.extend_from_slice(&buf[..at]);
        out.extend_from_slice(&self.block);
        out.extend_from_slice(&buf[at..]);
        Bytes::from(out)
    }
}

/// `stream` with `block` spliced in right after `<head …>`, else where the parser would open the
/// head on its own. A UTF-16 document passes through unchanged.
pub fn splice<S>(block: Bytes, stream: S) -> impl Stream<Item = std::io::Result<Bytes>>
where
    S: Stream<Item = std::io::Result<Bytes>> + Unpin,
{
    futures::stream::unfold((stream, Some(Splicer::new(block))), |(mut stream, splicer)| async move {
        let mut splicer = splicer?;
        loop {
            match stream.next().await {
                Some(Ok(chunk)) => {
                    if let Some(out) = splicer.push(chunk) {
                        return Some((Ok(out), (stream, Some(splicer))));
                    }
                }
                Some(Err(e)) => return Some((Err(e), (stream, None))),
                None => return splicer.end().map(|out| (Ok(out), (stream, None))),
            }
        }
    })
}

enum Scan {
    /// The insertion point is settled: right after `<head …>`, or, when the parser would open an
    /// implied head first, after `<html …>`, else after the doctype, else after a UTF-8 BOM or at 0.
    At(usize),
    /// Still inside the prologue (whitespace, comments, the doctype, `<html …>`, or a tag cut off
    /// by the chunk boundary): the best point so far, used if the search limit or the end is hit.
    NotYet(usize),
    /// A UTF-16 BOM: the browser decodes the whole document as UTF-16, so a UTF-8 block would be
    /// garbage in it. Nothing is inserted.
    Utf16,
}

/// Walks the prologue from the start of the document. Tag names match case-insensitively and must
/// end at whitespace, `/` or `>`, so `<header>` is not `<head>`.
fn scan(buf: &[u8]) -> Scan {
    if buf.starts_with(UTF16_BE_BOM) || buf.starts_with(UTF16_LE_BOM) { return Scan::Utf16; }
    if buf.len() < 3 && [UTF8_BOM, UTF16_BE_BOM, UTF16_LE_BOM].iter().any(|bom| bom.starts_with(buf)) { return Scan::NotYet(0); }
    let mut at = if buf.starts_with(UTF8_BOM) { UTF8_BOM.len() } else { 0 };
    let mut i = at;
    loop {
        while buf.get(i).is_some_and(u8::is_ascii_whitespace) { i += 1; }
        let Some(&b) = buf.get(i) else { return Scan::NotYet(at) };
        if b != b'<' { return Scan::At(at) }
        let rest = &buf[i..];
        if rest.starts_with(b"<!--") {
            match find(&rest[2..], b"-->") {
                Some(end) => i += 2 + end + 3,
                None => return Scan::NotYet(at),
            }
            continue;
        }
        if b"<!--".starts_with(rest) { return Scan::NotYet(at) }
        if rest[1] == b'!' || rest[1] == b'?' {
            let Some(end) = rest.iter().position(|&b| b == b'>') else { return Scan::NotYet(at) };
            i += end + 1;
            if tag_is(rest, b"!doctype") == Some(true) { at = i; }
            continue;
        }
        match (tag_is(rest, b"html"), tag_is(rest, b"head")) {
            (None, _) | (_, None) => return Scan::NotYet(at),
            (Some(true), _) => match tag_end(rest) {
                Some(end) => { i += end; at = i; }
                None => return Scan::NotYet(at),
            },
            (_, Some(true)) => return match tag_end(rest) { Some(end) => Scan::At(i + end), None => Scan::NotYet(at) },
            _ => return Scan::At(at),
        }
    }
}

/// Whether the tag at the start of `tag` is named `name`, ignoring case, with the name ended by
/// whitespace, `/` or `>`. `None` while the buffer ends before that can be told.
fn tag_is(tag: &[u8], name: &[u8]) -> Option<bool> {
    let rest = &tag[1..];
    let n = rest.len().min(name.len());
    if !rest[..n].eq_ignore_ascii_case(&name[..n]) { return Some(false); }
    rest.get(name.len()).map(|b| b.is_ascii_whitespace() || *b == b'/' || *b == b'>')
}

/// The offset right after the `>` that ends the tag at the start of `tag`. A `>` inside a quoted
/// attribute value does not count; a quote starts a value only after `=`, as in the tokenizer.
/// `None` while the buffer ends inside the tag.
fn tag_end(tag: &[u8]) -> Option<usize> {
    let mut after_eq = false;
    let mut i = 1;
    while let Some(&b) = tag.get(i) {
        match b {
            b'>' => return Some(i + 1),
            b'=' => after_eq = true,
            b'"' | b'\'' if after_eq => {
                i += 1 + tag[i + 1..].iter().position(|&c| c == b)?;
                after_eq = false;
            }
            b if !b.is_ascii_whitespace() => after_eq = false,
            _ => {}
        }
        i += 1;
    }
    None
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: &[u8] = b"<script>1</script>";

    fn whole(doc: &[u8], chunk: usize) -> Vec<u8> {
        let mut s = Splicer::new(Bytes::from_static(BLOCK));
        let mut out = Vec::new();
        for c in doc.chunks(chunk.max(1)) {
            if let Some(b) = s.push(Bytes::copy_from_slice(c)) { out.extend_from_slice(&b); }
        }
        if let Some(b) = s.end() { out.extend_from_slice(&b); }
        out
    }

    fn text(v: &[u8]) -> String { String::from_utf8(v.to_vec()).unwrap() }

    /// The document spliced whole and at every chunk size agree.
    fn every_split(doc: &[u8]) -> String {
        let expected = whole(doc, usize::MAX);
        for chunk in 1..doc.len() {
            assert_eq!(whole(doc, chunk), expected, "chunk size {chunk}");
        }
        text(&expected)
    }

    #[test]
    fn splices_after_head() {
        let doc = b"<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head><body><p>x</p></body></html>";
        let out = whole(doc, usize::MAX);
        assert_eq!(text(&out), "<!doctype html><html><head><script>1</script><meta charset=\"utf-8\"><title>t</title></head><body><p>x</p></body></html>");
        assert_eq!(out.len(), doc.len() + BLOCK.len(), "nothing lost, nothing duplicated");
    }

    #[test]
    fn head_split_across_chunks() {
        let doc: Vec<u8> = format!("<!doctype html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title></head><body>{}</body></html>", "제목".repeat(20), "x".repeat(150)).into_bytes();
        assert!(doc.len() > 280);
        assert!(every_split(&doc).contains("<head><script>1</script>\n<meta"), "right after the tag's '>', before the newline");
    }

    #[test]
    fn uppercase_and_attributes_on_head() {
        let out = whole(b"<HTML><HEAD lang=\"en\" data-x=\"1\"><TITLE>t</TITLE></HEAD><BODY></BODY></HTML>", 7);
        assert_eq!(text(&out), "<HTML><HEAD lang=\"en\" data-x=\"1\"><script>1</script><TITLE>t</TITLE></HEAD><BODY></BODY></HTML>");
        let out = whole(b"<html><head\n><title>t</title></head></html>", 3);
        assert_eq!(text(&out), "<html><head\n><script>1</script><title>t</title></head></html>");
    }

    #[test]
    fn a_tag_that_is_not_head_opens_an_implied_head() {
        assert_eq!(every_split(b"<html><header>not the head</header><head><title>t</title></head></html>"),
            "<html><script>1</script><header>not the head</header><head><title>t</title></head></html>",
            "the parser opens the head at <header> and ignores the later <head>");
        assert_eq!(every_split(b"<!doctype html><html><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"><head><title>t</title></head></html>"),
            "<!doctype html><html><script>1</script><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"><head><title>t</title></head></html>",
            "a late <head> after a policy would leave the block governed by the policy");
        assert_eq!(every_split(b"<!doctype html><script>var t='<head>';</script><head></head>"),
            "<!doctype html><script>1</script><script>var t='<head>';</script><head></head>",
            "a <head> inside script text is never reached");
        assert_eq!(every_split(b"<html>\n  text <head><title>t</title></head></html>"),
            "<html><script>1</script>\n  text <head><title>t</title></head></html>",
            "text before <head> opens the head too");
        assert_eq!(every_split(b"<html></p><head><title>t</title></head></html>"),
            "<html><script>1</script></p><head><title>t</title></head></html>",
            "an end tag counts as the first tag");
    }

    #[test]
    fn a_gt_inside_an_attribute_value_does_not_end_the_tag() {
        assert_eq!(every_split(b"<html><head data-x=\"a>b\" y='c>d'><title>t</title></head></html>"),
            "<html><head data-x=\"a>b\" y='c>d'><script>1</script><title>t</title></head></html>");
        assert_eq!(every_split(b"<html data-x=\"a>b\"><body></body></html>"),
            "<html data-x=\"a>b\"><script>1</script><body></body></html>", "also on the <html> fallback");
        assert_eq!(every_split(b"<html><head data-x=a\"b><title>t</title></head></html>"),
            "<html><head data-x=a\"b><script>1</script><title>t</title></head></html>", "a quote inside an unquoted value is not a quote");
        assert_eq!(every_split(b"<html><head \"x>\"><title>t</title></head></html>"),
            "<html><head \"x><script>1</script>\"><title>t</title></head></html>", "a quote where an attribute name goes is a name character, so the first > ends the tag");
    }

    #[test]
    fn comments_the_doctype_and_processing_instructions_are_skipped() {
        assert_eq!(every_split(b"<!-- <head> --><html><head><title>t</title></head></html>"),
            "<!-- <head> --><html><head><script>1</script><title>t</title></head></html>");
        assert_eq!(every_split(b"<!---->\n<!--->\n<!-->\n<head><title>t</title></head>"),
            "<!---->\n<!--->\n<!-->\n<head><script>1</script><title>t</title></head>", "the short comment forms");
        assert_eq!(every_split(b"<?xml version=\"1.0\"?>\n<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">\n<html><head><title>t</title></head></html>"),
            "<?xml version=\"1.0\"?>\n<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">\n<html><head><script>1</script><title>t</title></head></html>");
    }

    #[test]
    fn falls_back_without_head() {
        assert_eq!(every_split(b"<!doctype html><html lang=\"en\"><body><p>x</p></body></html>"), "<!doctype html><html lang=\"en\"><script>1</script><body><p>x</p></body></html>");
        assert_eq!(every_split(b"<!DOCTYPE html>\n<p>x</p>"), "<!DOCTYPE html><script>1</script>\n<p>x</p>");
        assert_eq!(every_split(b"<p>hi</p>"), "<script>1</script><p>hi</p>");
        assert_eq!(text(&whole(b"", 6)), "<script>1</script>");
        assert_eq!(text(&whole(b"hi", 6)), "<script>1</script>hi");
        assert_eq!(every_split(b"<html><body>x</body><head></head></html>"), "<html><script>1</script><body>x</body><head></head></html>", "a head after the body is too late");
    }

    #[test]
    fn a_utf8_bom_stays_first_and_a_utf16_document_is_untouched() {
        assert_eq!(whole(b"\xEF\xBB\xBF<p>hi</p>", 1), b"\xEF\xBB\xBF<script>1</script><p>hi</p>");
        assert_eq!(whole(b"\xEF\xBB\xBF<!doctype html><html><head><title>t</title></head></html>", 2), b"\xEF\xBB\xBF<!doctype html><html><head><script>1</script><title>t</title></head></html>");
        let be = b"\xFE\xFF\x00<\x00h\x00e\x00a\x00d\x00>";
        let le = b"\xFF\xFE<\x00h\x00e\x00a\x00d\x00>\x00";
        for doc in [&be[..], &le[..]] {
            for chunk in [1, 2, 3, usize::MAX] {
                assert_eq!(whole(doc, chunk), doc, "chunk size {chunk}");
            }
        }
        assert_eq!(whole(b"\xFF", 1), b"<script>1</script>\xFF", "a lone first byte is not a BOM");
    }

    #[test]
    fn no_head_in_first_64k_falls_back() {
        let mut doc = b"<!doctype html><html>".to_vec();
        doc.extend(std::iter::repeat_n(b' ', SEARCH_LIMIT));
        doc.extend_from_slice(b"<head><title>t</title></head><body></body></html>");
        let out = whole(&doc, 4096);
        assert!(text(&out).starts_with("<!doctype html><html><script>1</script> "));
        assert_eq!(out.len(), doc.len() + BLOCK.len());
        let mut s = Splicer::new(Bytes::from_static(BLOCK));
        let mut sent = 0;
        for c in doc.chunks(4096) {
            if let Some(b) = s.push(Bytes::copy_from_slice(c)) { sent += b.len(); }
            if sent > 0 { break; }
        }
        assert!((SEARCH_LIMIT..SEARCH_LIMIT + 8192).contains(&sent), "the buffer is flushed as soon as the limit is reached, not held to the end ({sent})");
    }

    #[test]
    fn lands_before_a_meta_csp() {
        let doc = b"<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"></head><body></body></html>";
        let out = text(&whole(doc, 11));
        let block = out.find("<script>1</script>").unwrap();
        let csp = out.find("<meta http-equiv").unwrap();
        assert!(block < csp, "{out}");
    }

    #[tokio::test]
    async fn the_stream_keeps_every_byte_and_passes_errors_through() {
        let doc = b"<html><head><title>t</title></head><body>abc</body></html>";
        let chunks = doc.chunks(5).map(|c| Ok(Bytes::copy_from_slice(c))).collect::<Vec<std::io::Result<Bytes>>>();
        let out: Vec<Bytes> = splice(Bytes::from_static(BLOCK), futures::stream::iter(chunks)).map(|r| r.unwrap()).collect().await;
        assert_eq!(text(&out.concat()), "<html><head><script>1</script><title>t</title></head><body>abc</body></html>");
        let failing = futures::stream::iter(vec![Ok(Bytes::from_static(b"<html>")), Err(std::io::Error::other("disk"))]);
        let out: Vec<std::io::Result<Bytes>> = splice(Bytes::from_static(BLOCK), failing).collect().await;
        assert!(matches!(out.as_slice(), [Err(e)] if e.to_string() == "disk"), "the error ends the stream without a fallback splice");
    }
}
