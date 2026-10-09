//! Reading complete lines from a log, plain or zstd-compressed.
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Bytes `[from, end)` of the (uncompressed) log, where `end` is the end of the last complete
/// line. A plain file is read at most `max` bytes at a time (longer when one line is longer);
/// a compressed file is read whole. `capped`: reading stopped at `max`, so complete lines may
/// follow `end` (an unfinished last line alone does not count).
pub struct Chunk { pub from: u64, pub bytes: Vec<u8>, pub end: u64, pub total: u64, pub capped: bool }

pub fn read_chunk(path: &Path, compressed: bool, from: u64, max: u64) -> std::io::Result<Chunk> {
    if compressed {
        let all = zstd::stream::decode_all(std::fs::File::open(path)?)?;
        let total = all.len() as u64;
        let from = from.min(total);
        let mut bytes = all[from as usize..].to_vec();
        let keep = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        bytes.truncate(keep);
        return Ok(Chunk { from, end: from + keep as u64, bytes, total, capped: false });
    }
    let mut f = std::fs::File::open(path)?;
    let total = f.metadata()?.len();
    let from = from.min(total);
    f.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::new();
    let want = max.max(1);
    let capped = loop {
        let start = bytes.len();
        (&mut f).take(want).read_to_end(&mut bytes)?;
        let got = (bytes.len() - start) as u64;
        if got < want { break false; }
        // a chunk with no newline (one long line) keeps reading until the line ends or the file does
        if bytes.contains(&b'\n') { break true; }
    };
    let keep = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    bytes.truncate(keep);
    Ok(Chunk { from, end: from + keep as u64, bytes, total, capped })
}

/// (offset, line without newline) for each line of `bytes`, which starts at file offset `from`.
pub fn lines(bytes: &[u8], from: u64) -> impl Iterator<Item = (u64, &[u8])> {
    let mut pos = 0usize;
    std::iter::from_fn(move || {
        if pos >= bytes.len() { return None; }
        let end = bytes[pos..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |i| pos + i);
        let item = (from + pos as u64, &bytes[pos..end]);
        pos = end + 1;
        Some(item)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_lines_only_and_long_lines() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.jsonl");
        std::fs::write(&p, b"one\ntwo\nthr").unwrap();
        let c = read_chunk(&p, false, 0, 1 << 20).unwrap();
        assert_eq!((c.bytes.as_slice(), c.end, c.total), (&b"one\ntwo\n"[..], 8, 11));
        assert_eq!(lines(&c.bytes, 0).collect::<Vec<_>>(), vec![(0, &b"one"[..]), (4, &b"two"[..])]);
        let c = read_chunk(&p, false, 8, 1 << 20).unwrap();
        assert_eq!((c.bytes.len(), c.end), (0, 8), "an unfinished last line is not read");
        let c = read_chunk(&p, false, 0, 2).unwrap();
        assert_eq!((c.end, c.capped), (4, true), "a chunk smaller than a line still ends on a line");
        assert!(!read_chunk(&p, false, 0, 1 << 20).unwrap().capped, "an unfinished line is not more to read");
    }

    #[test]
    fn compressed_logs() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.jsonl.zst");
        std::fs::write(&p, zstd::encode_all(&b"one\ntwo\n"[..], 3).unwrap()).unwrap();
        let c = read_chunk(&p, true, 4, 1).unwrap();
        assert_eq!((c.bytes.as_slice(), c.from, c.end, c.total), (&b"two\n"[..], 4, 8, 8));
    }
}
