//! Sessions as the Journal and rooms show them: the `message` events of one (agent, session id),
//! summarized. Times are the store's UTC `YYYY-MM-DDTHH:MM:SSZ`, so string order is
//! time order.
use crate::event::PREVIEW_CHARS;
use rooms_protocol::{Agent, Session, SessionId, SessionRef};
use rusqlite::{params, Connection, OptionalExtension};

/// How many of a session's first prompts are tried for a title.
const TITLE_PROMPTS: i64 = 10;
/// Codex automations open every run with this block; such runs are not sessions to show.
const HEARTBEAT: &str = "<heartbeat>";

/// Sessions with a message in `[from, to)`, each with the time of its first message in that
/// range, earliest first. Codex automation runs are left out.
pub fn on_day(c: &Connection, from: &str, to: &str) -> rusqlite::Result<Vec<(String, Session)>> {
    let rows: Vec<(String, String, String)> = {
        let mut st = c.prepare_cached(
            "SELECT agent, session, min(ts) AS at FROM events
             WHERE kind='message' AND ts>=?1 AND ts<?2 AND session IS NOT NULL
             GROUP BY agent, session ORDER BY at")?;
        let it = st.query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        it.collect::<rusqlite::Result<_>>()?
    };
    let mut out = Vec::new();
    for (agent, id, at) in rows {
        let (Some(agent), Some(id)) = (Agent::parse(&agent), SessionId::parse(&id)) else { continue };
        let session_ref = SessionRef { agent, id };
        let prompts = prompts_of(c, agent.as_str(), session_ref.id.as_str())?;
        if prompts.first().is_some_and(|p| p.starts_with(HEARTBEAT)) { continue; }
        if let Some(session) = summarize(c, session_ref, &prompts)? { out.push((at, session)); }
    }
    Ok(out)
}

/// One session, or `None` when the store has no message of it.
pub fn get(c: &Connection, session_ref: &SessionRef) -> rusqlite::Result<Option<Session>> {
    let prompts = prompts_of(c, session_ref.agent.as_str(), session_ref.id.as_str())?;
    summarize(c, session_ref.clone(), &prompts)
}

/// The Aside account session `id` was recorded under, from where its log is.
pub fn aside_account(c: &Connection, id: &SessionId) -> rusqlite::Result<Option<String>> {
    let log: Option<String> = c.query_row(
        "SELECT src_path FROM events WHERE agent='aside' AND session=?1 LIMIT 1",
        [id.as_str()], |r| r.get(0)).optional()?;
    Ok(log.and_then(|p| crate::adapters::aside::account_of(std::path::Path::new(&p))))
}

/// A session's title: one the user gave it, else the agent's latest (Claude Code's AI title or
/// summary, Codex's thread name), else its first prompt with the agents' wrapper blocks removed.
pub fn title(c: &Connection, agent: &str, session_id: &str) -> rusqlite::Result<Option<String>> {
    title_with(c, agent, session_id, &prompts_of(c, agent, session_id)?)
}

fn title_with(c: &Connection, agent: &str, session_id: &str, prompts: &[String]) -> rusqlite::Result<Option<String>> {
    let named: Option<String> = c.query_row(
        "SELECT preview FROM events WHERE agent=?1 AND session=?2 AND kind='session.seen' AND preview IS NOT NULL
         ORDER BY coalesce(role='user', 0) DESC, rowid DESC LIMIT 1",
        params![agent, session_id], |r| r.get(0)).optional()?;
    Ok(named.or_else(|| prompts.iter().find_map(|p| clean_prompt(p))))
}

fn summarize(c: &Connection, session_ref: SessionRef, prompts: &[String]) -> rusqlite::Result<Option<Session>> {
    let (agent, session_id) = (session_ref.agent.as_str(), session_ref.id.as_str());
    let (started, ended, messages): (Option<String>, Option<String>, i64) = c.query_row(
        "SELECT min(ts), max(ts), count(*) FROM events WHERE agent=?1 AND session=?2 AND kind='message'",
        params![agent, session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let (Some(started_at), Some(ended_at)) = (started, ended) else { return Ok(None) };
    let cwd: Option<String> = c.query_row(
        "SELECT cwd FROM events WHERE agent=?1 AND session=?2 AND cwd IS NOT NULL ORDER BY rowid LIMIT 1",
        params![agent, session_id], |r| r.get(0)).optional()?;
    let last_reply: Option<String> = c.query_row(
        "SELECT preview FROM events WHERE agent=?1 AND session=?2 AND kind='message' AND role='assistant'
         ORDER BY ts DESC, rowid DESC LIMIT 1",
        params![agent, session_id], |r| r.get(0)).optional()?.flatten();
    let artifacts_written: Vec<String> = {
        let mut st = c.prepare_cached(
            "SELECT path FROM events WHERE agent=?1 AND session=?2 AND kind='file.written' AND path IS NOT NULL
             GROUP BY path ORDER BY min(rowid)")?;
        let it = st.query_map(params![agent, session_id], |r| r.get(0))?;
        it.collect::<rusqlite::Result<_>>()?
    };
    let title = title_with(c, agent, session_id, prompts)?;
    let SessionRef { agent, id } = session_ref;
    Ok(Some(Session {
        agent, id, title, cwd, started_at, ended_at, messages: messages as u32, last_reply, artifacts_written, room_id: None,
    }))
}

/// The previews of a session's first user messages, in log order.
fn prompts_of(c: &Connection, agent: &str, session_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare_cached(
        "SELECT preview FROM events WHERE agent=?1 AND session=?2 AND kind='message' AND role='user' AND preview IS NOT NULL
         ORDER BY rowid LIMIT ?3")?;
    let it = st.query_map(params![agent, session_id, TITLE_PROMPTS], |r| r.get(0))?;
    it.collect()
}

/// A prompt preview without the blocks agents and apps put before what the user typed
/// (`<command-message>`, `<recommended_plugins>`, `<pasted_content id=..>`, ...). `<command-args>`
/// gives its text: it is what the user typed after a slash command. `None` when nothing is left.
pub fn clean_prompt(preview: &str) -> Option<String> {
    let mut rest = preview.trim();
    while let Some(tag) = rest.strip_prefix('<') {
        if !tag.starts_with(|ch: char| ch.is_ascii_alphabetic()) { break; }
        let name_len = tag.find(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | '.'))).unwrap_or(tag.len());
        let name = &tag[..name_len];
        let Some(open_end) = tag.find('>') else { break };
        let body = &tag[open_end + 1..];
        let close = format!("</{name}>");
        let Some(end) = body.find(&close) else {
            // Unclosed: in a preview cut at its limit the block's end was cut off; in a whole one it is text.
            if name == "command-args" { rest = body; } else if preview.chars().count() >= PREVIEW_CHARS { return None; }
            break;
        };
        if name == "command-args" { rest = &body[..end]; break; }
        rest = body[end + close.len()..].trim_start();
    }
    let t = rest.trim();
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_lose_their_wrapper_blocks() {
        let cases = [
            ("fix the login page", Some("fix the login page")),
            ("<command-message>pstack:poteto-mode</command-message> <command-name>/pstack:poteto-mode</command-name> <command-args>read the brief first</command-args>", Some("read the brief first")),
            ("<command-name>/mcp</command-name> <command-message>mcp</command-message> <command-args></command-args>", None),
            ("<recommended_plugins> - Box </recommended_plugins> <wake reason=\"x\">w</wake> make the chart", Some("make the chart")),
            ("<pasted_content id=\"76c2\"> pasted words </pasted_content> summarize this", Some("summarize this")),
            ("<task-notification> <task-id>a1</task-id> </task-notification>", None),
            ("<div> tags render wrong", Some("<div> tags render wrong")),
            ("<3 thanks", Some("<3 thanks")),
            ("", None),
        ];
        for (raw, want) in cases { assert_eq!(clean_prompt(raw).as_deref(), want, "{raw}"); }
        let cut: String = format!("<recommended_plugins> {}", "- Gmail ".repeat(40)).chars().take(PREVIEW_CHARS).collect();
        assert_eq!(clean_prompt(&cut), None, "a wrapper cut off by the preview is not a title");
        let args: String = format!("<command-name>/x</command-name> <command-args>{}", "long ask ".repeat(40)).chars().take(PREVIEW_CHARS).collect();
        assert!(clean_prompt(&args).unwrap().starts_with("long ask"), "cut command args are still the prompt");
    }
}
