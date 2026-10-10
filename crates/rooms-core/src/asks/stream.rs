//! Reads an agent's JSON-lines stdout by the rules in its profile (`[[agents.X.events]]`): which
//! fields of which lines are answer text, the whole answer, or what the agent is doing now.
//! Rooms knows JSON pointers, not any agent's format: the formats live in the rules.
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// One rule: when every `match` pointer holds that string, take the fields it names.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EventRule {
    #[serde(default, rename = "match")]
    pub when: BTreeMap<String, String>,
    /// Appended to the answer so far (a streamed chunk).
    pub delta: Option<String>,
    /// The whole answer so far; the last one seen is the final answer.
    pub answer: Option<String>,
    /// What the agent is doing: `label`, then each of these that is a string, e.g. "Read · a.ts".
    /// When none is, the line leaves the activity as it was.
    #[serde(default)]
    pub activity: Vec<String>,
    pub label: Option<String>,
    /// Start the streamed answer over (e.g. a new model message after a tool call).
    #[serde(default)]
    pub clear: bool,
    /// The agent's own session id; the first one seen is the run's. A profile with this and a
    /// `continue` template sends later questions to that session (see `agents.rs`).
    pub session: Option<String>,
}

impl EventRule {
    pub fn check(&self) -> Result<(), String> {
        let pointers = self.when.keys().chain(&self.delta).chain(&self.answer).chain(&self.activity).chain(&self.session);
        if let Some(p) = pointers.into_iter().find(|p| !p.starts_with('/')) {
            return Err(format!("\"{p}\" is not a JSON pointer (it must start with /)"));
        }
        let does = self.delta.is_some() || self.answer.is_some() || !self.activity.is_empty() || self.label.is_some() || self.clear || self.session.is_some();
        if does { Ok(()) } else { Err("a rule needs delta, answer, activity, label, clear or session".into()) }
    }

    fn matches(&self, v: &Value) -> bool {
        self.when.iter().all(|(p, want)| find(v, p).and_then(Value::as_str) == Some(want.as_str()))
    }
}

/// RFC 6901 pointer, plus `*` for "any element of this array" (the last one that resolves wins).
fn find<'a>(v: &'a Value, pointer: &str) -> Option<&'a Value> {
    let segs: Vec<String> = pointer.split('/').skip(1).map(|s| s.replace("~1", "/").replace("~0", "~")).collect();
    walk(v, &segs)
}

fn walk<'a>(v: &'a Value, segs: &[String]) -> Option<&'a Value> {
    let Some((seg, rest)) = segs.split_first() else { return Some(v) };
    match v {
        Value::Array(items) if seg == "*" => items.iter().rev().find_map(|x| walk(x, rest)),
        Value::Array(items) => walk(items.get(seg.parse::<usize>().ok()?)?, rest),
        Value::Object(map) => walk(map.get(seg)?, rest),
        _ => None,
    }
}

const ACTIVITY_CHARS: usize = 80;

/// One short line: a path shows its file name, whitespace collapses, long text is cut.
fn short(s: &str) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = if !s.contains(' ') && s.contains('/') { s.rsplit('/').find(|x| !x.is_empty()).unwrap_or(&s).to_string() } else { s };
    if s.chars().count() <= ACTIVITY_CHARS { return s; }
    let cut: String = s.chars().take(ACTIVITY_CHARS - 1).collect();
    format!("{cut}…")
}

/// Feeds stdout bytes through the rules, line by line.
pub(crate) struct Reader<'r> {
    rules: &'r [EventRule],
    pending: Vec<u8>,
    draft: String,
    answer: Option<String>,
    activity: Option<String>,
    session: Option<String>,
    saw_json: bool,
}

impl<'r> Reader<'r> {
    pub fn new(rules: &'r [EventRule]) -> Self {
        Self { rules, pending: Vec::new(), draft: String::new(), answer: None, activity: None, session: None, saw_json: false }
    }

    /// Takes the complete lines in `bytes`; a partial last line waits for the next call or `finish`.
    pub fn push(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        while let Some(i) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=i).collect();
            self.line(&line);
        }
    }

    pub fn finish(&mut self) {
        let line = std::mem::take(&mut self.pending);
        self.line(&line);
    }

    fn line(&mut self, line: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
        if !v.is_object() { return; }
        self.saw_json = true;
        for r in self.rules.iter().filter(|r| r.matches(&v)) {
            if r.clear { self.draft.clear(); }
            if self.session.is_none() {
                self.session = r.session.as_deref().and_then(|p| find(&v, p)).and_then(Value::as_str).map(str::to_string);
            }
            if let Some(s) = r.delta.as_deref().and_then(|p| find(&v, p)).and_then(Value::as_str) {
                self.draft.push_str(s);
                self.activity = None;
            }
            if let Some(s) = r.answer.as_deref().and_then(|p| find(&v, p)).and_then(Value::as_str) {
                self.answer = Some(s.to_string());
                self.activity = None;
            }
            let details: Vec<String> = r.activity.iter().filter_map(|p| find(&v, p).and_then(Value::as_str)).map(short).collect();
            if r.activity.is_empty() || !details.is_empty() {
                let parts: Vec<String> = r.label.iter().filter(|l| !l.is_empty()).cloned().chain(details).collect();
                if !parts.is_empty() { self.activity = Some(parts.join(" · ")); }
            }
        }
    }

    /// Whether any line was a JSON object: if none was, the template doesn't ask for JSON output.
    pub fn saw_json(&self) -> bool { self.saw_json }

    /// The last whole answer, else everything streamed since the last `clear`.
    pub fn text(&self) -> &str { self.answer.as_deref().unwrap_or(&self.draft) }

    pub fn activity(&self) -> Option<&str> { self.activity.as_deref() }

    /// The first session id a `session` rule read, unchecked: it is the agent's output.
    pub fn session(&self) -> Option<&str> { self.session.as_deref() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(toml_text: &str) -> EventRule { toml::from_str(toml_text).unwrap() }

    fn read(rules: &[EventRule], lines: &[&str]) -> (String, Option<String>, bool) {
        let mut r = Reader::new(rules);
        for l in lines { r.push(format!("{l}\n").as_bytes()); }
        r.finish();
        (r.text().to_string(), r.activity().map(str::to_string), r.saw_json())
    }

    #[test]
    fn pointers_with_escapes_indexes_and_wildcards() {
        let v: Value = serde_json::from_str(r#"{"a/b":{"~x":1},"c":[{"n":"first"},{"m":2},{"n":"last"}]}"#).unwrap();
        assert_eq!(find(&v, "/a~1b/~0x"), Some(&Value::from(1)));
        assert_eq!(find(&v, "/c/1/m"), Some(&Value::from(2)));
        assert_eq!(find(&v, "/c/*/n"), Some(&Value::from("last")));
        assert_eq!(find(&v, "/c/*/zzz"), None);
        assert_eq!(find(&v, ""), Some(&v));
    }

    #[test]
    fn deltas_stream_and_a_later_answer_wins() {
        let rules = [
            rule("match = { \"/type\" = \"delta\" }\ndelta = \"/text\""),
            rule("match = { \"/type\" = \"start\" }\nclear = true"),
            rule("match = { \"/type\" = \"result\" }\nanswer = \"/result\""),
        ];
        let lines = [r#"{"type":"delta","text":"Let me "}"#, r#"{"type":"delta","text":"look."}"#];
        assert_eq!(read(&rules, &lines).0, "Let me look.");
        let more = [lines[0], lines[1], r#"{"type":"start"}"#, r#"{"type":"delta","text":"표는"}"#];
        assert_eq!(read(&rules, &more).0, "표는");
        let done = [more[0], more[1], more[2], more[3], r#"{"type":"result","result":"Final."}"#];
        assert_eq!(read(&rules, &done).0, "Final.");
    }

    #[test]
    fn activity_is_label_and_short_detail_and_text_clears_it() {
        let rules = [
            rule("match = { \"/type\" = \"tool\" }\nactivity = [\"/input/file_path\", \"/input/pattern\"]\nlabel = \"Read\""),
            rule("match = { \"/type\" = \"think\" }\nlabel = \"Thinking\""),
            rule("match = { \"/type\" = \"delta\" }\ndelta = \"/text\""),
        ];
        assert_eq!(read(&rules, &[r#"{"type":"tool","input":{"file_path":"/a/b/AskBar.tsx"}}"#]).1.as_deref(), Some("Read · AskBar.tsx"));
        assert_eq!(read(&rules, &[r#"{"type":"tool","input":{"pattern":"fn   main"}}"#]).1.as_deref(), Some("Read · fn main"));
        assert_eq!(read(&rules, &[r#"{"type":"tool","input":{"file_path":"a.ts","pattern":"x"}}"#]).1.as_deref(), Some("Read · a.ts · x"));
        // a rule with pointers that all miss leaves the last activity as it was
        assert_eq!(read(&rules, &[r#"{"type":"think"}"#, r#"{"type":"tool","input":{}}"#]).1.as_deref(), Some("Thinking"));
        assert_eq!(read(&rules, &[r#"{"type":"think"}"#, r#"{"type":"delta","text":"x"}"#]).1, None);
        let long = format!(r#"{{"type":"tool","input":{{"pattern":"{}"}}}}"#, "가 ".repeat(100));
        assert_eq!(read(&rules, &[&long]).1.unwrap().chars().count(), "Read · ".chars().count() + ACTIVITY_CHARS);
        // no label: just the details
        let bare = [rule("activity = [\"/name\", \"/path\"]")];
        assert_eq!(read(&bare, &[r#"{"name":"Grep","path":"src/"}"#]).1.as_deref(), Some("Grep · src"));
    }

    #[test]
    fn lines_split_across_chunks_and_non_json_lines() {
        let rules = [rule("delta = \"/t\"")];
        let mut r = Reader::new(&rules);
        r.push(r#"{"t":"한"#.as_bytes());
        assert_eq!(r.text(), "");
        r.push("글\"}\nnot json\n[1]\n{\"t\":\"!\"}".as_bytes());
        assert_eq!(r.text(), "한글");
        r.finish();
        assert_eq!(r.text(), "한글!");
        assert_eq!(read(&rules, &["plain text answer"]), (String::new(), None, false));
    }

    #[test]
    fn the_first_session_id_seen_is_the_runs() {
        let rules = [
            rule("match = { \"/type\" = \"system\", \"/subtype\" = \"init\" }\nsession = \"/session_id\""),
            rule("match = { \"/type\" = \"thread.started\" }\nsession = \"/thread_id\""),
            rule("match = { \"/type\" = \"result\" }\nanswer = \"/result\""),
        ];
        let session = |lines: &[&str]| {
            let mut r = Reader::new(&rules);
            for l in lines { r.push(format!("{l}\n").as_bytes()); }
            r.finish();
            r.session().map(str::to_string)
        };
        assert_eq!(session(&[r#"{"type":"system","subtype":"init","session_id":"S1"}"#, r#"{"type":"result","result":"a"}"#]).as_deref(), Some("S1"));
        assert_eq!(session(&[r#"{"type":"thread.started","thread_id":"T1"}"#, r#"{"type":"thread.started","thread_id":"T2"}"#]).as_deref(), Some("T1"));
        // a matching line without the field, or with a non-string, reads nothing
        assert_eq!(session(&[r#"{"type":"system","subtype":"init"}"#, r#"{"type":"thread.started","thread_id":7}"#]), None);
        assert_eq!(session(&[r#"{"type":"system","subtype":"hook","session_id":"S9"}"#]), None);
    }

    #[test]
    fn rule_checks() {
        assert!(rule("session = \"/id\"").check().is_ok());
        assert!(rule("session = \"id\"").check().unwrap_err().contains("JSON pointer"));
        assert!(rule("delta = \"/t\"").check().is_ok());
        assert!(rule("match = { \"/type\" = \"x\" }").check().unwrap_err().contains("needs"));
        assert!(rule("delta = \"t\"").check().unwrap_err().contains("JSON pointer"));
        assert!(rule("match = { \"type\" = \"x\" }\nclear = true").check().unwrap_err().contains("JSON pointer"));
        assert!(toml::from_str::<EventRule>("delta = \"/t\"\nextra = 1").is_err());
    }
}
