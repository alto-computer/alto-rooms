//! Splices one block of bytes into a streamed HTML document right after its `<head>` tag, so the
//! block's scripts run before anything the document itself declares, including a `<meta
//! http-equiv="Content-Security-Policy">`. A policy in `<head>` governs every script parsed after
//! it, so a block appended at the tail is blocked by any strict artifact policy; one right after
//! `<head>` is not (measured on Chromium and WebKit, see the F2-3 placement results).

use axum::body::Bytes;
use futures::{Stream, StreamExt};

/// How far into the document to look for `<head>` before giving up on it.
const SEARCH_LIMIT: usize = 64 * 1024;

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
        let at = match after_head(buf) {
            Scan::Found(at) => at,
            Scan::NotYet if buf.len() < SEARCH_LIMIT => return None,
            Scan::NotYet | Scan::Absent => fallback(buf),
        };
        Some(self.emit(at))
    }

    /// The end of the document: whatever is still buffered, with the block at the fallback spot.
    pub fn end(mut self) -> Option<Bytes> {
        let at = fallback(self.pending.as_deref()?);
        Some(self.emit(at))
    }

    fn emit(&mut self, at: usize) -> Bytes {
        let buf = self.pending.take().unwrap_or_default();
        let mut out = Vec::with_capacity(buf.len() + self.block.len());
        out.extend_from_slice(&buf[..at]);
        out.extend_from_slice(&self.block);
        out.extend_from_slice(&buf[at..]);
        Bytes::from(out)
    }
}

/// `stream` with `block` spliced in right after `<head …>`, else after `<html …>`, else after the
/// doctype, else at the very start.
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
    /// The byte offset right after the `<head …>` tag's `>`.
    Found(usize),
    /// No complete `<head …>` yet, but the buffer may still end inside one.
    NotYet,
    /// The buffer holds a `<body` or `</head`, so there is no `<head>` to find.
    Absent,
}

/// Looks for the first `<head …>` outside comments. Tag names match case-insensitively and must
/// end at whitespace, `/` or `>`, so `<header>` is not `<head>`.
fn after_head(buf: &[u8]) -> Scan {
    let mut i = 0;
    while let Some(off) = buf[i..].iter().position(|&b| b == b'<') {
        let p = i + off;
        if buf[p..].starts_with(b"<!--") {
            match find(&buf[p + 4..], b"-->") {
                Some(end) => i = p + 4 + end + 3,
                None => return Scan::NotYet,
            }
            continue;
        }
        if tag_at(buf, p, b"head") {
            return match buf[p..].iter().position(|&b| b == b'>') {
                Some(end) => Scan::Found(p + end + 1),
                None => Scan::NotYet,
            };
        }
        if tag_at(buf, p, b"body") || tag_at(buf, p, b"/head") {
            return Scan::Absent;
        }
        i = p + 1;
    }
    Scan::NotYet
}

/// Where the block goes when there is no `<head>`: after `<html …>`, after `<!doctype …>`, or 0.
fn fallback(buf: &[u8]) -> usize {
    let after = |name: &[u8]| {
        (0..buf.len()).find(|&p| buf[p] == b'<' && tag_at(buf, p, name)).and_then(|p| buf[p..].iter().position(|&b| b == b'>').map(|end| p + end + 1))
    };
    after(b"html").or_else(|| after(b"!doctype")).unwrap_or(0)
}

/// Whether `buf[p..]` is `<name` followed by whitespace, `/` or `>`, ignoring case.
fn tag_at(buf: &[u8], p: usize, name: &[u8]) -> bool {
    let rest = &buf[p + 1..];
    rest.len() >= name.len()
        && rest[..name.len()].eq_ignore_ascii_case(name)
        && rest.get(name.len()).is_some_and(|b| b.is_ascii_whitespace() || *b == b'/' || *b == b'>')
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
        let expected = whole(&doc, usize::MAX);
        for chunk in 1..doc.len() {
            assert_eq!(whole(&doc, chunk), expected, "chunk size {chunk}");
        }
        assert!(text(&expected).contains("<head><script>1</script>\n<meta"), "right after the tag's '>', before the newline");
    }

    #[test]
    fn uppercase_and_attributes_on_head() {
        let out = whole(b"<HTML><HEAD lang=\"en\" data-x=\"1\"><TITLE>t</TITLE></HEAD><BODY></BODY></HTML>", 7);
        assert_eq!(text(&out), "<HTML><HEAD lang=\"en\" data-x=\"1\"><script>1</script><TITLE>t</TITLE></HEAD><BODY></BODY></HTML>");
        let out = whole(b"<html><head\n><title>t</title></head></html>", 3);
        assert_eq!(text(&out), "<html><head\n><script>1</script><title>t</title></head></html>");
        let out = whole(b"<html><header>not the head</header><head><title>t</title></head></html>", 5);
        assert_eq!(text(&out), "<html><header>not the head</header><head><script>1</script><title>t</title></head></html>");
    }

    #[test]
    fn a_commented_out_head_is_skipped() {
        let out = whole(b"<!-- <head> --><html><head><title>t</title></head></html>", 4);
        assert_eq!(text(&out), "<!-- <head> --><html><head><script>1</script><title>t</title></head></html>");
    }

    #[test]
    fn falls_back_without_head() {
        assert_eq!(text(&whole(b"<!doctype html><html lang=\"en\"><body><p>x</p></body></html>", 6)), "<!doctype html><html lang=\"en\"><script>1</script><body><p>x</p></body></html>");
        assert_eq!(text(&whole(b"<!DOCTYPE html>\n<p>x</p>", 6)), "<!DOCTYPE html><script>1</script>\n<p>x</p>");
        assert_eq!(text(&whole(b"<p>hi</p>", 6)), "<script>1</script><p>hi</p>");
        assert_eq!(text(&whole(b"", 6)), "<script>1</script>");
        assert_eq!(text(&whole(b"<html><body>x</body><head></head></html>", 6)), "<html><script>1</script><body>x</body><head></head></html>", "a head after the body is too late");
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
