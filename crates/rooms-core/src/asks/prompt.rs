//! The only text Rooms writes into a question (spec §6.3), plus the R0 checks on doc meta.
use rooms_protocol::{AskKind, AskMode, AskStatus, AskTurn};

pub(crate) const MAX_PRIOR_TURNS: usize = 6;
pub(crate) const MAX_PRIOR_CHARS: usize = 24_000;

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

pub(crate) fn context(prior: &[AskTurn]) -> Context<'_> {
    let ends = |t: &AskTurn| t.kind == AskKind::Clear || (t.kind == AskKind::Compact && t.status == AskStatus::Done);
    let (summary, since) = match prior.iter().rposition(ends) {
        Some(i) if prior[i].kind == AskKind::Compact => (Some(prior[i].answer.as_str()), &prior[i + 1..]),
        Some(i) => (None, &prior[i + 1..]),
        None => (None, prior),
    };
    let done: Vec<&AskTurn> = since.iter().filter(|t| t.kind == AskKind::Question && t.status == AskStatus::Done).collect();
    let mut turns: Vec<&AskTurn> = done[done.len().saturating_sub(MAX_PRIOR_TURNS)..].to_vec();
    let budget = MAX_PRIOR_CHARS.saturating_sub(summary.map_or(0, |s| s.chars().count()));
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
    if let Some(s) = ctx.summary { out.push_str(&format!("\nSummary of the earlier Q&A:\n{s}\n")); }
    if !ctx.turns.is_empty() {
        out.push_str("\nPrevious Q&A:\n");
        for t in &ctx.turns { out.push_str(&format!("Q: {}\nA: {}\n", t.question, t.answer)); }
    }
    out.push_str(&format!("\nQuestion: {question}"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rooms_protocol::AskStatus;

    fn turn(q: &str, a: &str, status: AskStatus) -> AskTurn {
        AskTurn { id: q.into(), file_key: "k".into(), question: q.into(), answer: a.into(), agent: "x".into(), model: None,
            mode: AskMode::New, status, error: None, started_at: "t".into(), ended_at: None, images: vec![], kind: AskKind::Question, left_out: 0 }
    }

    fn of(kind: AskKind, a: &str) -> AskTurn { AskTurn { kind, ..turn("", a, AskStatus::Done) } }

    fn prompt(prior: &[AskTurn], q: &str) -> String { build_prompt("P", AskMode::Resume, "/f", "k", &context(prior), q) }

    #[test]
    fn resume_without_prior() {
        assert_eq!(build_prompt("P", AskMode::Resume, "/d/a.html", "0123abcd", &context(&[]), "왜?"), "P\n\nDocument: /d/a.html\nRooms doc: 0123abcd\n\nQuestion: 왜?");
    }

    #[test]
    fn new_mode_asks_to_read_and_includes_done_prior_only() {
        let prior = [turn("q1", "a1", AskStatus::Done), turn("q2", "", AskStatus::Failed), turn("q3", "a3", AskStatus::Done)];
        assert_eq!(
            build_prompt("P", AskMode::New, "/d/a.html", "0123abcd", &context(&prior), "q4"),
            "P\n\nDocument: /d/a.html\nRooms doc: 0123abcd\nRead this file first.\n\nPrevious Q&A:\nQ: q1\nA: a1\nQ: q3\nA: a3\n\nQuestion: q4"
        );
    }

    #[test]
    fn keeps_last_six_then_trims_oldest_over_char_budget() {
        let many: Vec<_> = (0..8).map(|i| turn(&format!("q{i}"), "a", AskStatus::Done)).collect();
        let p = prompt(&many, "z");
        assert!(!p.contains("Q: q1\n") && p.contains("Q: q2\n") && p.contains("Q: q7\n"));
        assert_eq!(context(&many).left_out, 2);
        let big = "가".repeat(15_000);
        let heavy = [turn("old", &big, AskStatus::Done), turn("new", &big, AskStatus::Done)];
        let p = prompt(&heavy, "z");
        assert!(!p.contains("Q: old") && p.contains("Q: new"));
        let huge = [turn("only", &"x".repeat(30_000), AskStatus::Done)];
        assert!(!prompt(&huge, "z").contains("Previous Q&A"));
        assert_eq!(context(&huge).left_out, 1);
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
        assert!(context(&t).is_empty());
        assert_eq!(prompt(&t, "z"), "P\n\nDocument: /f\nRooms doc: k\n\nQuestion: z");
        // the summary takes its share of the budget
        let big = "가".repeat(MAX_PRIOR_CHARS - 10);
        let c = [of(AskKind::Compact, &big), turn("q", "0123456789ab", AskStatus::Done)];
        assert_eq!((context(&c).turns.len(), context(&c).left_out), (0, 1));
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
