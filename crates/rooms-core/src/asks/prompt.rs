//! The only text Rooms writes into a question (spec §6.3), plus the R0 checks on doc meta.
use rooms_protocol::{AskMode, AskStatus, AskTurn};

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

fn pick_prior(prior: &[AskTurn]) -> Vec<&AskTurn> {
    let done: Vec<&AskTurn> = prior.iter().filter(|t| t.status == AskStatus::Done).collect();
    let mut picked: Vec<&AskTurn> = done[done.len().saturating_sub(MAX_PRIOR_TURNS)..].to_vec();
    let size = |ts: &[&AskTurn]| ts.iter().map(|t| t.question.chars().count() + t.answer.chars().count()).sum::<usize>();
    while !picked.is_empty() && size(&picked) > MAX_PRIOR_CHARS { picked.remove(0); }
    picked
}

pub(crate) fn build_prompt(preamble: &str, mode: AskMode, file: &str, prior: &[AskTurn], question: &str) -> String {
    let mut out = format!("{preamble}\n\nDocument: {file}\n");
    if mode == AskMode::New { out.push_str("Read this file first.\n"); }
    let picked = pick_prior(prior);
    if !picked.is_empty() {
        out.push_str("\nPrevious Q&A:\n");
        for t in picked { out.push_str(&format!("Q: {}\nA: {}\n", t.question, t.answer)); }
    }
    out.push_str(&format!("\nQuestion: {question}"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rooms_protocol::AskStatus;

    fn turn(q: &str, a: &str, status: AskStatus) -> AskTurn {
        AskTurn { id: q.into(), file_key: "k".into(), question: q.into(), answer: a.into(), agent: "x".into(),
            mode: AskMode::New, status, error: None, started_at: "t".into(), ended_at: None }
    }

    #[test]
    fn resume_without_prior() {
        assert_eq!(build_prompt("P", AskMode::Resume, "/d/a.html", &[], "왜?"), "P\n\nDocument: /d/a.html\n\nQuestion: 왜?");
    }

    #[test]
    fn new_mode_asks_to_read_and_includes_done_prior_only() {
        let prior = [turn("q1", "a1", AskStatus::Done), turn("q2", "", AskStatus::Failed), turn("q3", "a3", AskStatus::Done)];
        assert_eq!(
            build_prompt("P", AskMode::New, "/d/a.html", &prior, "q4"),
            "P\n\nDocument: /d/a.html\nRead this file first.\n\nPrevious Q&A:\nQ: q1\nA: a1\nQ: q3\nA: a3\n\nQuestion: q4"
        );
    }

    #[test]
    fn keeps_last_six_then_trims_oldest_over_char_budget() {
        let many: Vec<_> = (0..8).map(|i| turn(&format!("q{i}"), "a", AskStatus::Done)).collect();
        let p = build_prompt("P", AskMode::Resume, "/f", &many, "z");
        assert!(!p.contains("Q: q1\n") && p.contains("Q: q2\n") && p.contains("Q: q7\n"));
        let big = "가".repeat(15_000);
        let heavy = [turn("old", &big, AskStatus::Done), turn("new", &big, AskStatus::Done)];
        let p = build_prompt("P", AskMode::Resume, "/f", &heavy, "z");
        assert!(!p.contains("Q: old") && p.contains("Q: new"));
        let huge = [turn("only", &"x".repeat(30_000), AskStatus::Done)];
        assert!(!build_prompt("P", AskMode::Resume, "/f", &huge, "z").contains("Previous Q&A"));
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
