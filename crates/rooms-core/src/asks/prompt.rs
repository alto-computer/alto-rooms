//! The only text Rooms writes into a question (spec §6.3), plus the R0 checks on doc meta.
use super::agents::SCOPE_PREAMBLE;
use rooms_protocol::{AskKind, AskMode, AskStatus, AskTurn, IsoDate};
use std::path::PathBuf;

/// How much earlier Q&A goes along with a question, in characters, summary included. A prompt on
/// stdin has no OS limit; one passed as an argv element (a template with `{prompt}`) does: Linux
/// takes at most 128 KiB per argument, about 40k Korean characters with the rest of the prompt.
pub(crate) const PRIOR_CHARS_STDIN: usize = 100_000;
pub(crate) const PRIOR_CHARS_ARGV: usize = 24_000;

/// R0: meta from a doc is untrusted. A leading '-' would read as a CLI flag.
pub(crate) fn valid_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    s.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// fileKey names a file under .rooms/asks/.
pub(crate) fn valid_file_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// What `/compact` asks the agent; its answer is sent along in place of the Q&A it summarizes.
pub(crate) const COMPACT_ASK: &str = "Summarize the Q&A above so it can replace it in later questions: keep what was asked, \
the answers' facts and decisions, file and symbol names, and anything left open. Reply with the summary only.";

/// What goes along with a question: the summary from the last `/compact`, then the latest answered
/// questions since it (or since the last `/new`), as many as fit.
#[derive(Debug, Default)]
pub(crate) struct Context<'a> {
    pub summary: Option<&'a str>,
    pub turns: Vec<&'a AskTurn>,
    /// Answered questions since then that didn't fit.
    pub left_out: usize,
}

impl Context<'_> {
    pub fn is_empty(&self) -> bool { self.summary.is_none() && self.turns.is_empty() && self.left_out == 0 }
}

/// The newest answered questions that fit in `budget` characters along with the summary.
pub(crate) fn context(prior: &[AskTurn], budget: usize) -> Context<'_> {
    let ends = |t: &AskTurn| t.kind == AskKind::Clear || (t.kind == AskKind::Compact && t.status == AskStatus::Done);
    let (summary, since) = match prior.iter().rposition(ends) {
        Some(i) if prior[i].kind == AskKind::Compact => (Some(prior[i].answer.as_str()), &prior[i + 1..]),
        Some(i) => (None, &prior[i + 1..]),
        None => (None, prior),
    };
    let done: Vec<&AskTurn> = since.iter().filter(|t| t.kind == AskKind::Question && t.status == AskStatus::Done).collect();
    let mut turns = done.clone();
    let budget = budget.saturating_sub(summary.map_or(0, |s| s.chars().count()));
    let size = |ts: &[&AskTurn]| ts.iter().map(|t| t.question.chars().count() + t.answer.chars().count()).sum::<usize>();
    while !turns.is_empty() && size(&turns) > budget { turns.remove(0); }
    Context { summary, left_out: done.len() - turns.len(), turns }
}

/// The question with its images listed, so an agent without an image flag can still open them.
pub(crate) fn with_image_paths(question: &str, paths: &[String]) -> String {
    if paths.is_empty() { return question.to_string(); }
    let list: Vec<String> = paths.iter().map(|p| format!("- {p}")).collect();
    format!("{question}\n\nAttached images (open each one to see it):\n{}", list.join("\n"))
}

pub(crate) fn build_prompt(preamble: &str, mode: AskMode, file: &str, file_key: &str, ctx: &Context, question: &str) -> String {
    let mut out = format!("{preamble}\n\nDocument: {file}\nRooms doc: {file_key}\n");
    if mode == AskMode::New { out.push_str("Read this file first.\n"); }
    push_thread(&mut out, ctx, question);
    out
}

/// One document a room or day ask lists. `path` is a realpath: `rg` skips symlinks.
#[derive(Debug)]
pub(crate) struct ContextEntry {
    /// Where it lives: the room name, "Journal", "Review" (the day's dream) or "Note".
    pub label: String,
    pub title: String,
    pub path: PathBuf,
    pub day: IsoDate,
}

/// The most documents a room or day prompt lists. A template with `{prompt}` passes the prompt as
/// one argv element (macOS caps all of argv at 1 MiB); 400 lines stay far under that.
pub(crate) const MAX_LISTED: usize = 400;

/// A room or day ask: the documents (newest first, as given), then the thread and the question.
pub(crate) fn build_scope_prompt(heading: &str, entries: &[ContextEntry], ctx: &Context, question: &str) -> String {
    let mut out = format!("{SCOPE_PREAMBLE}\n\n{heading}\nDocuments ({}):\n", entries.len());
    for e in entries.iter().take(MAX_LISTED) {
        let title = e.title.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!("- {title} ({}, {}) :: {}\n", e.label, e.day, e.path.display()));
    }
    if entries.len() > MAX_LISTED { out.push_str(&format!("({} older documents not listed)\n", entries.len() - MAX_LISTED)); }
    push_thread(&mut out, ctx, question);
    out
}

fn push_thread(out: &mut String, ctx: &Context, question: &str) {
    if let Some(s) = ctx.summary { out.push_str(&format!("\nSummary of the earlier Q&A:\n{s}\n")); }
    if !ctx.turns.is_empty() {
        out.push_str("\nPrevious Q&A:\n");
        for t in &ctx.turns { out.push_str(&format!("Q: {}\nA: {}\n", t.question, t.answer)); }
    }
    out.push_str(&format!("\nQuestion: {question}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use rooms_protocol::{AskScope, AskStatus};

    fn turn(q: &str, a: &str, status: AskStatus) -> AskTurn {
        AskTurn { id: q.into(), scope: AskScope::Doc { file_key: "k".into() }, question: q.into(), answer: a.into(), agent: "x".into(), model: None,
            mode: AskMode::New, status, error: None, started_at: "t".into(), ended_at: None, images: vec![], kind: AskKind::Question, left_out: 0 }
    }

    fn of(kind: AskKind, a: &str) -> AskTurn { AskTurn { kind, ..turn("", a, AskStatus::Done) } }

    fn prompt(prior: &[AskTurn], q: &str) -> String { build_prompt("P", AskMode::Resume, "/f", "k", &context(prior, PRIOR_CHARS_ARGV), q) }

    #[test]
    fn resume_without_prior() {
        assert_eq!(build_prompt("P", AskMode::Resume, "/d/a.html", "0123abcd", &context(&[], PRIOR_CHARS_ARGV), "왜?"), "P\n\nDocument: /d/a.html\nRooms doc: 0123abcd\n\nQuestion: 왜?");
    }

    #[test]
    fn new_mode_asks_to_read_and_includes_done_prior_only() {
        let prior = [turn("q1", "a1", AskStatus::Done), turn("q2", "", AskStatus::Failed), turn("q3", "a3", AskStatus::Done)];
        assert_eq!(
            build_prompt("P", AskMode::New, "/d/a.html", "0123abcd", &context(&prior, PRIOR_CHARS_ARGV), "q4"),
            "P\n\nDocument: /d/a.html\nRooms doc: 0123abcd\nRead this file first.\n\nPrevious Q&A:\nQ: q1\nA: a1\nQ: q3\nA: a3\n\nQuestion: q4"
        );
    }

    #[test]
    fn keeps_every_answer_that_fits_then_trims_the_oldest() {
        let many: Vec<_> = (0..40).map(|i| turn(&format!("q{i}"), "a", AskStatus::Done)).collect();
        let p = prompt(&many, "z");
        assert!(p.contains("Q: q0\n") && p.contains("Q: q39\n"));
        assert_eq!(context(&many, PRIOR_CHARS_ARGV).left_out, 0);
        let big = "가".repeat(15_000);
        let heavy = [turn("old", &big, AskStatus::Done), turn("new", &big, AskStatus::Done)];
        let p = prompt(&heavy, "z");
        assert!(!p.contains("Q: old") && p.contains("Q: new"));
        // on stdin both fit
        assert_eq!(context(&heavy, PRIOR_CHARS_STDIN).turns.len(), 2);
        let huge = [turn("only", &"x".repeat(30_000), AskStatus::Done)];
        assert!(!prompt(&huge, "z").contains("Previous Q&A"));
        assert_eq!(context(&huge, PRIOR_CHARS_ARGV).left_out, 1);
    }

    #[test]
    fn new_starts_over_and_compact_sends_its_summary_instead() {
        let mut t = vec![turn("q1", "a1", AskStatus::Done), of(AskKind::Clear, ""), turn("q2", "a2", AskStatus::Done)];
        assert_eq!(prompt(&t, "z"), "P\n\nDocument: /f\nRooms doc: k\n\nPrevious Q&A:\nQ: q2\nA: a2\n\nQuestion: z");
        t.push(of(AskKind::Compact, "S2"));
        t.push(turn("q3", "a3", AskStatus::Done));
        assert_eq!(prompt(&t, "z"), "P\n\nDocument: /f\nRooms doc: k\n\nSummary of the earlier Q&A:\nS2\n\nPrevious Q&A:\nQ: q3\nA: a3\n\nQuestion: z");
        // a compact that didn't finish changes nothing
        t.push(AskTurn { status: AskStatus::Failed, ..of(AskKind::Compact, "") });
        assert!(prompt(&t, "z").contains("S2") && prompt(&t, "z").contains("Q: q3"));
        // a clear after a summary drops it too
        t.push(of(AskKind::Clear, ""));
        assert!(context(&t, PRIOR_CHARS_ARGV).is_empty());
        assert_eq!(prompt(&t, "z"), "P\n\nDocument: /f\nRooms doc: k\n\nQuestion: z");
        // the summary takes its share of the budget
        let big = "가".repeat(PRIOR_CHARS_ARGV - 10);
        let c = [of(AskKind::Compact, &big), turn("q", "0123456789ab", AskStatus::Done)];
        let ctx = context(&c, PRIOR_CHARS_ARGV);
        assert_eq!((ctx.turns.len(), ctx.left_out), (0, 1));
    }

    fn entry(title: &str, label: &str, path: &str) -> ContextEntry {
        ContextEntry { label: label.into(), title: title.into(), path: path.into(), day: "2026-10-09".into() }
    }

    #[test]
    fn scope_prompt_is_fixed() {
        let room = [entry("New  plan\n", "Research", "/o/b.html"), entry("Old", "Research", "/o/a.html")];
        assert_eq!(build_scope_prompt("Room: Research", &room, &context(&[], PRIOR_CHARS_STDIN), "왜?"), format!(
            "{SCOPE_PREAMBLE}\n\nRoom: Research\nDocuments (2):\n- New plan (Research, 2026-10-09) :: /o/b.html\n- Old (Research, 2026-10-09) :: /o/a.html\n\nQuestion: 왜?"));
        let day = [entry("Dream", "Review", "/h/journal/2026-10-09/dream.html"), entry("n.md", "Note", "/h/journal/2026-10-09/n.md")];
        let prior = [turn("q1", "a1", AskStatus::Done)];
        assert_eq!(build_scope_prompt("Journal day: 2026-10-09", &day, &context(&prior, PRIOR_CHARS_STDIN), "q2"), format!(
            "{SCOPE_PREAMBLE}\n\nJournal day: 2026-10-09\nDocuments (2):\n- Dream (Review, 2026-10-09) :: /h/journal/2026-10-09/dream.html\n- n.md (Note, 2026-10-09) :: /h/journal/2026-10-09/n.md\n\nPrevious Q&A:\nQ: q1\nA: a1\n\nQuestion: q2"));
        let compacted = [turn("q1", "a1", AskStatus::Done), of(AskKind::Compact, "S"), turn("q2", "a2", AskStatus::Done)];
        assert_eq!(build_scope_prompt("Room: Research", &room[..1], &context(&compacted, PRIOR_CHARS_STDIN), "q3"), format!(
            "{SCOPE_PREAMBLE}\n\nRoom: Research\nDocuments (1):\n- New plan (Research, 2026-10-09) :: /o/b.html\n\nSummary of the earlier Q&A:\nS\n\nPrevious Q&A:\nQ: q2\nA: a2\n\nQuestion: q3"));
        let empty = build_scope_prompt("Room: Empty", &[], &context(&[], PRIOR_CHARS_STDIN), "q");
        assert_eq!(empty, format!("{SCOPE_PREAMBLE}\n\nRoom: Empty\nDocuments (0):\n\nQuestion: q"));
    }

    #[test]
    fn scope_prompt_caps_entries() {
        let many: Vec<_> = (0..450).map(|i| entry(&format!("d{i}"), "R", &format!("/o/{i}.html"))).collect();
        let p = build_scope_prompt("Room: R", &many, &context(&[], PRIOR_CHARS_STDIN), "q");
        assert_eq!(p.lines().filter(|l| l.starts_with("- d")).count(), MAX_LISTED);
        assert!(p.contains("Documents (450):\n- d0 (R, 2026-10-09) :: /o/0.html\n"), "newest first, as given");
        assert!(p.contains("- d399 (R, 2026-10-09) :: /o/399.html\n(50 older documents not listed)\n\nQuestion: q"));
        assert!(!p.contains("d400"));
    }

    #[test]
    fn ident_rules() {
        for ok in ["claude-code", "7f3a1c2e-0000-4000-8000-000000000000", "ses_01HQ7B", "a.b:c", "A"] { assert!(valid_ident(ok), "{ok}"); }
        let long = "a".repeat(129);
        for bad in ["", "-x", "--dangerously-bypass-approvals-and-sandbox", "a b", "a/b", "a;b", "ㄱ", long.as_str()] { assert!(!valid_ident(bad), "{bad}"); }
    }

    #[test]
    fn file_key_rules() {
        assert!(valid_file_key("0123456789abcdef"));
        for bad in ["", "../x", "a.b", &"a".repeat(65)] { assert!(!valid_file_key(bad), "{bad}"); }
    }
}
