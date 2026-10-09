//! The conversation archive: log bytes copied as they are read, so they outlive the agents'
//! own cleanup (Claude Code deletes logs after 30 days). Not a cache: never rebuilt, never
//! deleted by the collector.
use rusqlite::{params, Connection, OptionalExtension};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// A source this long unchanged is finished: its copy gets compressed.
pub const IDLE_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct Segment { pub id: i64, pub base: u64, pub len: u64, pub path: PathBuf, pub compressed: bool }

fn segment(r: &rusqlite::Row) -> rusqlite::Result<Segment> {
    Ok(Segment { id: r.get(0)?, base: r.get::<_, i64>(1)? as u64, len: r.get::<_, i64>(2)? as u64, path: PathBuf::from(r.get::<_, String>(3)?), compressed: r.get::<_, i64>(4)? != 0 })
}

pub fn get(c: &Connection, id: i64) -> rusqlite::Result<Option<Segment>> {
    c.query_row("SELECT id, base, len, path, compressed FROM archives WHERE id=?1", [id], segment).optional()
}

/// The newest segment of (agent, key), if any.
pub fn latest(c: &Connection, agent: &str, key: &str) -> rusqlite::Result<Option<Segment>> {
    c.query_row("SELECT id, base, len, path, compressed FROM archives WHERE agent=?1 AND key=?2 ORDER BY id DESC LIMIT 1", [agent, key], segment).optional()
}

/// The segment holding byte `offset` of source `src_path` (newest first).
pub fn find(c: &Connection, src_path: &str, key: &str, offset: u64) -> rusqlite::Result<Option<Segment>> {
    c.query_row(
        "SELECT id, base, len, path, compressed FROM archives WHERE (src_path=?1 OR key=?2) AND base<=?3 AND base+len>?3 ORDER BY id DESC LIMIT 1",
        params![src_path, key, offset as i64], segment).optional()
}

/// Starts a new segment of `src` at source offset `base`: `<dir>/<agent>/<YYYY-MM>/<key>[.n].jsonl`.
pub fn create(c: &Connection, dir: &Path, agent: &str, key: &str, src: &Path, base: u64) -> rusqlite::Result<Segment> {
    let month = chrono::Utc::now().format("%Y-%m").to_string();
    let folder = dir.join(agent).join(month);
    let _ = std::fs::create_dir_all(&folder);
    let stem: String = key.trim_end_matches(".zst").trim_end_matches(".jsonl").chars().map(|ch| if ch == '/' || ch == '\\' { '_' } else { ch }).collect();
    let mut path = folder.join(format!("{stem}.jsonl"));
    let mut n = 2;
    while path.exists() || path.with_extension("jsonl.zst").exists() {
        path = folder.join(format!("{stem}.{n}.jsonl"));
        n += 1;
    }
    c.execute("INSERT INTO archives(agent, key, src_path, base, len, path) VALUES(?1, ?2, ?3, ?4, 0, ?5)",
        params![agent, key, src.to_string_lossy(), base as i64, path.to_string_lossy()])?;
    Ok(Segment { id: c.last_insert_rowid(), base, len: 0, path, compressed: false })
}

/// Appends `bytes` to the segment's file after cutting it back to its committed length (a
/// crash between write and commit leaves a tail that is dropped here). Returns the new length.
pub fn append(seg: &Segment, bytes: &[u8]) -> std::io::Result<u64> {
    let mut f = std::fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&seg.path)?;
    f.set_len(seg.len)?;
    f.seek(SeekFrom::End(0))?;
    f.write_all(bytes)?;
    f.sync_data()?;
    Ok(seg.len + bytes.len() as u64)
}

/// The whole content of a segment.
pub fn read_all(seg: &Segment) -> std::io::Result<Vec<u8>> {
    let f = std::fs::File::open(&seg.path)?;
    if seg.compressed { return zstd::stream::decode_all(f); }
    let mut v = Vec::new();
    f.take(seg.len).read_to_end(&mut v)?;
    Ok(v)
}

/// Compresses the copies of sources unchanged for a day; the next new bytes start a new segment.
pub fn compress_idle(c: &Connection, now_ms: i64) -> rusqlite::Result<usize> {
    let rows: Vec<(String, i64)> = {
        let mut st = c.prepare(
            "SELECT f.path, a.id FROM files f JOIN archives a ON a.id=f.archive_id
             WHERE a.compressed=0 AND f.mtime_ms < ?1 AND f.archived_to >= f.size")?;
        let it = st.query_map([now_ms - IDLE_MS], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<rusqlite::Result<_>>()?
    };
    let mut n = 0;
    for (src, id) in rows {
        let Some(seg) = get(c, id)? else { continue };
        let zpath = seg.path.with_extension("jsonl.zst");
        let done = (|| -> std::io::Result<()> {
            let data = read_all(&seg)?;
            let tmp = seg.path.with_extension("jsonl.zst.tmp");
            std::fs::write(&tmp, zstd::encode_all(&data[..], 9)?)?;
            std::fs::File::open(&tmp)?.sync_all()?;
            std::fs::rename(&tmp, &zpath)
        })();
        if let Err(e) = done { eprintln!("rooms-collect: could not compress {}: {e}", seg.path.display()); continue; }
        c.execute("UPDATE archives SET compressed=1, path=?2 WHERE id=?1", params![id, zpath.to_string_lossy()])?;
        c.execute("UPDATE files SET archive_id=NULL WHERE path=?1", [&src])?;
        let _ = std::fs::remove_file(&seg.path);
        n += 1;
    }
    Ok(n)
}
