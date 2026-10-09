//! The only text Rooms writes into a question (spec §6.3), plus the R0 checks on doc meta.
use rooms_protocol::{AskKind, AskMode, AskStatus, AskTurn};

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

/// Where a conversation starts over: `/new`, or a `/compact` that produced its summary.
fn starts_over(t: &AskTurn) -> bool { t.kind == AskKind::Clear || (t.kind == AskKind::Compact && t.status == AskStatus::Done) }

/// The agent session the next question to `agent` continues: the latest one a turn since the
/// conversation last started over ran in, whatever became of that turn (a stopped question
/// stays in the session, as it would in the agent's own CLI).
pub(crate) fn chain_head<'a>(prior: &'a [AskTurn], agent: &str) -> Option<&'a str> {
    let since = prior.iter().rposition(starts_over).map_or(prior, |i| &prior[i + 1..]);
    since.iter().rev().filter(|t| t.agent == agent).find_map(|t| t.session.as_deref().filter(|s| valid_ident(s)))
}

/// The newest answered questions that fit in `budget` characters along with the summary.
pub(crate) fn context(prior: &[AskTurn], budget: usize) -> Context<'_> {
    let (summary, since) = match prior.iter().rposition(starts_over) {
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

/// A continued session already has the preamble, the doc and every earlier Q&A: it gets the question alone.
pub(crate) fn build_prompt(preamble: &str, mode: AskMode, file: &str, file_key: &str, ctx: &Context, question: &str) -> String {
    if mode == AskMode::Continue { return format!("Question: {question}"); }
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
    use rooms_protocol::{AskScope, AskStatus};

    fn turn(q: &str, a: &str, status: AskStatus) -> AskTurn {
        AskTurn { id: q.into(), scope: AskScope::Doc { file_key: "k".into() }, question: q.into(), answer: a.into(), agent: "x".into(), model: None,
            mode: AskMode::New, status, error: None, started_at: "t".into(), ended_at: None, images: vec![], kind: AskKind::Question, left_out: 0, session: None }
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

    #[test]
    fn continuing_sends_the_question_alone() {
        let prior = [turn("q1", "a1", AskStatus::Done)];
        assert_eq!(build_prompt("P", AskMode::Continue, "/f", "k", &context(&prior, PRIOR_CHARS_STDIN), "q2"), "Question: q2");
    }

    fn ran(agent: &str, session: Option<&str>, status: AskStatus) -> AskTurn {
        AskTurn { agent: agent.into(), session: session.map(str::to_string), ..turn("q", "a", status) }
    }

    #[test]
    fn chain_head_is_the_latest_session_since_starting_over() {
        assert_eq!(chain_head(&[], "x"), None);
        let mut t = vec![ran("x", Some("S1"), AskStatus::Done), ran("x", None, AskStatus::Failed)];
        assert_eq!(chain_head(&t, "x"), Some("S1"));
        // a stopped question that got a session still counts
        t.push(ran("x", Some("S1"), AskStatus::Cancelled));
        assert_eq!(chain_head(&t, "x"), Some("S1"));
        // another agent's session is not this one's
        t.push(ran("y", Some("T1"), AskStatus::Done));
        assert_eq!((chain_head(&t, "x"), chain_head(&t, "y")), (Some("S1"), Some("T1")));
        // a flag-shaped id is never used
        t.push(ran("x", Some("-x"), AskStatus::Done));
        assert_eq!(chain_head(&t, "x"), Some("S1"));
        // /new starts over
        t.push(of(AskKind::Clear, ""));
        assert_eq!(chain_head(&t, "x"), None);
        t.push(ran("x", Some("S2"), AskStatus::Done));
        assert_eq!(chain_head(&t, "x"), Some("S2"));
        // a compact that failed doesn't; one that summarized does
        t.push(AskTurn { kind: AskKind::Compact, ..ran("x", Some("S2"), AskStatus::Failed) });
        assert_eq!(chain_head(&t, "x"), Some("S2"));
        t.push(AskTurn { kind: AskKind::Compact, ..ran("x", Some("S2"), AskStatus::Done) });
        assert_eq!(chain_head(&t, "x"), None);
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
