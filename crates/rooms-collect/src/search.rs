//! Searching the indexed conversations: matches grouped by session, best first, each with an
//! excerpt read back from the log (or its archived copy) and the command that resumes it.
use crate::archive;
use crate::conversations::title;
use crate::reader::read_chunk;
use rooms_protocol::{Agent, SessionId};
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde::Serialize;

#[derive(Debug, Default, Clone)]
pub struct Query {
    pub text: String,
    pub agent: Option<String>,
    /// Sessions whose working folder starts with this.
    pub cwd: Option<String>,
    /// Only messages at or after this time (`YYYY-MM-DDTHH:MM:SSZ`).
    pub since: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub agent: String,
    pub session: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub ts: Option<String>,
    pub excerpt: String,
    pub matches: usize,
    pub resume: String,
}

/// The FTS5 query for what the user typed: every word must appear; the last may be a prefix.
pub fn fts_query(text: &str) -> Option<String> {
    let words: Vec<String> = text.split_whitespace().map(|w| format!("\"{}\"", w.replace('"', "\"\""))).collect();
    let n = words.len();
    (n > 0).then(|| words.into_iter().enumerate().map(|(i, w)| if i + 1 == n { format!("{w}*") } else { w }).collect::<Vec<_>>().join(" "))
}

pub fn resume_command(agent: &str, session: &str) -> String {
    match (Agent::parse(agent), SessionId::parse(session)) {
        (Some(a), Some(s)) => a.resume_argv(&s).join(" "),
        _ => session.to_string(),
    }
}

struct Row { agent: String, session: String, ts: Option<String>, cwd: Option<String>, src_path: String, key: String, offset: u64, len: u64, preview: Option<String> }

pub fn search(c: &Connection, q: &Query) -> rusqlite::Result<Vec<Hit>> {
    let Some(m) = fts_query(&q.text) else { return Ok(Vec::new()) };
    let mut sql = String::from(
        "SELECT e.agent, e.session, e.ts, e.cwd, e.src_path, e.file_key, e.src_offset, e.src_len, e.preview
         FROM messages_fts JOIN events e ON e.rowid=messages_fts.rowid
         WHERE messages_fts MATCH ?1 AND e.session IS NOT NULL");
    let mut args: Vec<Sql> = vec![Sql::Text(m)];
    if let Some(a) = &q.agent { args.push(Sql::Text(a.clone())); sql += &format!(" AND e.agent=?{}", args.len()); }
    if let Some(d) = &q.cwd { args.push(Sql::Text(format!("{}%", d.trim_end_matches('/')))); sql += &format!(" AND e.cwd LIKE ?{}", args.len()); }
    if let Some(s) = &q.since { args.push(Sql::Text(s.clone())); sql += &format!(" AND e.ts>=?{}", args.len()); }
    sql += " ORDER BY bm25(messages_fts, 1.0, 1.0, 0.5, 0.7) LIMIT 2000";
    let rows: Vec<Row> = {
        let mut st = c.prepare(&sql)?;
        let it = st.query_map(params_from_iter(args), |r| Ok(Row {
            agent: r.get(0)?, session: r.get(1)?, ts: r.get(2)?, cwd: r.get(3)?, src_path: r.get(4)?, key: r.get(5)?,
            offset: r.get::<_, i64>(6)? as u64, len: r.get::<_, i64>(7)? as u64, preview: r.get(8)?,
        }))?;
        it.collect::<rusqlite::Result<_>>()?
    };
    let limit = if q.limit == 0 { 20 } else { q.limit };
    let mut hits: Vec<Hit> = Vec::new();
    let mut best: Vec<Row> = Vec::new();
    for r in rows {
        if let Some(h) = hits.iter_mut().find(|h| h.agent == r.agent && h.session == r.session) { h.matches += 1; continue; }
        if hits.len() >= limit { continue; }
        hits.push(Hit { agent: r.agent.clone(), session: r.session.clone(), title: None, cwd: r.cwd.clone(), ts: r.ts.clone(),
            excerpt: String::new(), matches: 1, resume: resume_command(&r.agent, &r.session) });
        best.push(r);
    }
    for (h, r) in hits.iter_mut().zip(&best) {
        h.title = title(c, &h.agent, &h.session)?;
        h.excerpt = line_text(c, r).map(|t| excerpt(&t, &q.text)).filter(|t| !t.is_empty())
            .or_else(|| r.preview.clone()).unwrap_or_default();
    }
    Ok(hits)
}

/// The text of the matching log line: from the log, else from the archive (the log may be gone).
fn line_text(c: &Connection, r: &Row) -> Option<String> {
    let from_log = || -> Option<Vec<u8>> {
        let p = std::path::Path::new(&r.src_path);
        let chunk = read_chunk(p, r.src_path.ends_with(".zst"), r.offset, r.len + 1).ok()?;
        (chunk.from == r.offset && chunk.bytes.len() as u64 > r.len).then(|| chunk.bytes[..r.len as usize].to_vec())
    };
    let from_archive = || -> Option<Vec<u8>> {
        let seg = archive::find(c, &r.src_path, &r.key, r.offset).ok()??;
        let all = archive::read_all(&seg).ok()?;
        let at = (r.offset - seg.base) as usize;
        all.get(at..at + r.len as usize).map(<[u8]>::to_vec)
    };
    let bytes = from_log().filter(|b| b.first() == Some(&b'{')).or_else(from_archive)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let mut out = Vec::new();
    strings(&v, false, &mut out);
    Some(out.join(" "))
}

/// Keys whose string values are what someone said or ran (not ids, paths of logs, times).
const TEXT_KEYS: [&str; 12] = ["text", "content", "input", "arguments", "command", "code", "message", "summary", "output", "prompt", "file_path", "path"];

fn strings(v: &serde_json::Value, text: bool, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if text => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| strings(x, text, out)),
        serde_json::Value::Object(o) => o.iter().for_each(|(k, x)| strings(x, TEXT_KEYS.contains(&k.as_str()), out)),
        _ => {}
    }
}

/// About 200 characters of `text` around the first word of `query` found in it.
pub fn excerpt(text: &str, query: &str) -> String {
    let flat: Vec<char> = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().collect();
    let fold = |c: &char| c.to_lowercase().next().unwrap_or(*c);
    let hay: Vec<char> = flat.iter().map(fold).collect();
    let at = query.split_whitespace().filter_map(|w| {
        let w: Vec<char> = w.chars().map(|c| fold(&c)).collect();
        hay.windows(w.len()).position(|win| win == &w[..])
    }).min().unwrap_or(0);
    let (start, end) = (at.saturating_sub(80), (at + 120).min(flat.len()));
    let mut s: String = flat[start..end].iter().collect();
    if start > 0 { s.insert(0, '…'); }
    if end < flat.len() { s.push('…'); }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_and_excerpts() {
        assert_eq!(fts_query("pricing  \"plan"), Some("\"pricing\" \"\"\"plan\"*".to_string()));
        assert_eq!(fts_query("  "), None);
        let long = format!("{} the Pricing page {}", "a ".repeat(100), "b ".repeat(100));
        let x = excerpt(&long, "pricing");
        assert!(x.starts_with('…') && x.ends_with('…') && x.contains("Pricing page"), "{x}");
        assert_eq!(excerpt("short text", "nothing"), "short text");
    }
}
