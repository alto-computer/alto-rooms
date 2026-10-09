//! The sorting rules R1–R5 (spec §2), as one pure function: no I/O, no clock, no network.
//! The first rule that matches decides. R1 and R2 need no key; R3 and R4 need Jev's answer.
use rooms_core::rules::{room_slug, slug_key};
use std::collections::{HashMap, HashSet};

/// N2: repo names too generic to name a room after (R4 only; R1 still applies).
pub const GENERIC_NAMES: &[&str] = &[
    "downloads", "desktop", "documents", "tmp", "temp", "docs", "notes", "scratch", "test", "tests", "out", "dist",
    "build", "untitled",
];

/// One inbox document as the rules see it.
#[derive(Debug, Clone)]
pub struct Doc {
    pub file_key: String,
    /// N1: the git repo the original lives in, if any.
    pub repo: Option<String>,
}

/// An owned room a document may move to (never the inbox).
#[derive(Debug, Clone, PartialEq)]
pub struct Room {
    pub id: String,
    pub name: String,
}

/// What the store remembers between runs.
#[derive(Debug, Default, Clone)]
pub struct Memory {
    /// R2: repo → the room R4 created for it (dropped once that room is gone).
    pub repo_rooms: HashMap<String, String>,
    /// N4: repos whose R4 room the user deleted (or a run that created it was undone).
    pub forgotten: HashSet<String>,
    /// N3: votes per repo from other documents still in the inbox.
    pub votes: HashMap<String, HashSet<String>>,
}

/// Jev's answer to "which room?": a room id or `None` for the none option.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub choice: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub min_confidence: f64,
    pub new_room_min_docs: usize,
    pub ignore_names: Vec<String>,
}

impl Default for Config {
    fn default() -> Self { Config { min_confidence: 0.7, new_room_min_docs: 3, ignore_names: Vec::new() } }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule { R1, R2, R3, R4, R5 }

impl Rule {
    pub fn id(self) -> &'static str {
        match self { Rule::R1 => "R1", Rule::R2 => "R2", Rule::R3 => "R3", Rule::R4 => "R4", Rule::R5 => "R5" }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Move to this room.
    Move { room_id: String },
    /// R4: one vote for `repo`; `create` once the votes (this one included) reach the minimum.
    Vote { repo: String, votes: usize, create: bool },
    /// Stay in the inbox.
    Keep,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub rule: Rule,
    pub action: Action,
    /// The line `rooms-sort log` shows after the rule id.
    pub why: String,
}

impl Decision {
    /// R5 because there is no key: not recorded, so a key added later sorts the document (N5).
    pub fn is_no_key(&self) -> bool { self.rule == Rule::R5 && self.why == "no_key" }
}

/// R1 and R2: the rules that need no model. `Some` means Jev is not asked.
pub fn deterministic(doc: &Doc, rooms: &[Room], mem: &Memory) -> Option<Decision> {
    let repo = doc.repo.as_deref()?;
    let want = slug_key(&room_slug(repo));
    if !want.is_empty() {
        if let Some(r) = rooms.iter().find(|r| slug_key(&room_slug(&r.name)) == want) {
            return Some(Decision {
                rule: Rule::R1,
                action: Action::Move { room_id: r.id.clone() },
                why: format!("repo \"{repo}\" = room \"{}\"", r.name),
            });
        }
    }
    let id = mem.repo_rooms.get(repo)?;
    let r = rooms.iter().find(|r| &r.id == id)?;
    Some(Decision { rule: Rule::R2, action: Action::Move { room_id: r.id.clone() }, why: format!("repo \"{repo}\" → room \"{}\"", r.name) })
}

/// The whole table: R1, R2, then R3 and R4 from Jev's answer (`None` = no key), else R5.
pub fn decide(doc: &Doc, rooms: &[Room], mem: &Memory, jev: Option<&Answer>, cfg: &Config) -> Decision {
    if let Some(d) = deterministic(doc, rooms, mem) { return d; }
    let Some(a) = jev else { return keep("no_key".into()) };
    let picked = a.choice.as_ref().and_then(|id| rooms.iter().find(|r| &r.id == id));
    if let Some(r) = picked {
        if a.confidence >= cfg.min_confidence {
            return Decision {
                rule: Rule::R3,
                action: Action::Move { room_id: r.id.clone() },
                why: format!("jev \"{}\" {:.2} ≥ {}", r.name, a.confidence, cfg.min_confidence),
            };
        }
    }
    if let Some(repo) = doc.repo.as_deref().filter(|r| votable(r, mem, cfg)) {
        let others = mem.votes.get(repo).map(|v| v.iter().filter(|k| *k != &doc.file_key).count()).unwrap_or(0);
        let votes = others + 1;
        let create = votes >= cfg.new_room_min_docs;
        let why = if create { format!("created room \"{repo}\" ({votes} votes)") } else { format!("vote \"{repo}\" {votes}/{}", cfg.new_room_min_docs) };
        return Decision { rule: Rule::R4, action: Action::Vote { repo: repo.to_string(), votes, create }, why };
    }
    keep(match picked {
        Some(r) => format!("jev_low \"{}\" {:.2} < {}", r.name, a.confidence, cfg.min_confidence),
        None => "jev_none".into(),
    })
}

/// R4's preconditions on the repo name: not generic (N2) and not forgotten (N4).
fn votable(repo: &str, mem: &Memory, cfg: &Config) -> bool {
    let lower = repo.to_lowercase();
    !GENERIC_NAMES.contains(&lower.as_str())
        && !cfg.ignore_names.iter().any(|n| n.to_lowercase() == lower)
        && !mem.forgotten.contains(repo)
}

fn keep(why: String) -> Decision { Decision { rule: Rule::R5, action: Action::Keep, why } }

#[cfg(test)]
mod tests {
    use super::*;

    fn rooms() -> Vec<Room> {
        vec![Room { id: "r_alto".into(), name: "alto rooms".into() }, Room { id: "r_design".into(), name: "디자인 리서치".into() }]
    }
    fn doc(repo: Option<&str>) -> Doc { Doc { file_key: "k1".into(), repo: repo.map(Into::into) } }
    fn ans(choice: Option<&str>, confidence: f64) -> Answer { Answer { choice: choice.map(Into::into), confidence } }
    fn go(d: &Doc, mem: &Memory, a: Option<&Answer>) -> Decision { decide(d, &rooms(), mem, a, &Config::default()) }

    #[test]
    fn r1_name_match_moves_without_jev() {
        let d = go(&doc(Some("alto-rooms")), &Memory::default(), None);
        assert_eq!((d.rule, d.action), (Rule::R1, Action::Move { room_id: "r_alto".into() }));
        assert_eq!(d.why, "repo \"alto-rooms\" = room \"alto rooms\"");
    }

    #[test]
    fn r1_comes_before_a_confident_jev_answer() {
        let d = go(&doc(Some("Alto-Rooms")), &Memory::default(), Some(&ans(Some("r_design"), 0.99)));
        assert_eq!(d.rule, Rule::R1);
    }

    #[test]
    fn r2_remembered_room_survives_a_rename() {
        let mut mem = Memory::default();
        mem.repo_rooms.insert("rooms-plugin-excalidraw".into(), "r_design".into());
        let d = go(&doc(Some("rooms-plugin-excalidraw")), &mem, None);
        assert_eq!((d.rule, d.action), (Rule::R2, Action::Move { room_id: "r_design".into() }));
    }

    #[test]
    fn r2_skips_a_room_that_is_gone() {
        let mut mem = Memory::default();
        mem.repo_rooms.insert("x".into(), "r_gone".into());
        assert!(deterministic(&doc(Some("x")), &rooms(), &mem).is_none());
    }

    #[test]
    fn r3_moves_at_or_above_the_threshold() {
        let d = go(&doc(None), &Memory::default(), Some(&ans(Some("r_design"), 0.7)));
        assert_eq!((d.rule, d.action), (Rule::R3, Action::Move { room_id: "r_design".into() }));
        assert_eq!(d.why, "jev \"디자인 리서치\" 0.70 ≥ 0.7");
    }

    #[test]
    fn r3_ignores_a_choice_that_is_not_a_room() {
        let d = go(&doc(None), &Memory::default(), Some(&ans(Some("r_unknown"), 0.99)));
        assert_eq!(d.rule, Rule::R5);
    }

    #[test]
    fn r4_votes_on_none_and_on_low_confidence() {
        for a in [ans(None, 0.9), ans(Some("r_alto"), 0.5)] {
            let d = go(&doc(Some("excalidraw")), &Memory::default(), Some(&a));
            assert_eq!(d.rule, Rule::R4);
            assert_eq!(d.action, Action::Vote { repo: "excalidraw".into(), votes: 1, create: false });
            assert_eq!(d.why, "vote \"excalidraw\" 1/3");
        }
    }

    #[test]
    fn r4_third_vote_creates_room() {
        let mut mem = Memory::default();
        mem.votes.insert("excalidraw".into(), ["a".to_string(), "b".to_string(), "k1".to_string()].into());
        let d = go(&doc(Some("excalidraw")), &mem, Some(&ans(None, 0.9)));
        assert_eq!(d.action, Action::Vote { repo: "excalidraw".into(), votes: 3, create: true });
        assert_eq!(d.why, "created room \"excalidraw\" (3 votes)");
    }

    #[test]
    fn r4_skips_generic_ignored_and_forgotten_repos() {
        let mut mem = Memory::default();
        mem.forgotten.insert("old".into());
        let cfg = Config { ignore_names: vec!["Sandbox".into()], ..Config::default() };
        for repo in ["Downloads", "notes", "sandbox", "old"] {
            let d = decide(&doc(Some(repo)), &rooms(), &mem, Some(&ans(None, 0.9)), &cfg);
            assert_eq!((d.rule, d.why.as_str()), (Rule::R5, "jev_none"), "{repo}");
        }
    }

    #[test]
    fn r5_keeps_and_says_why() {
        let d = go(&doc(None), &Memory::default(), Some(&ans(Some("r_alto"), 0.52)));
        assert_eq!((d.rule, d.action, d.why.as_str()), (Rule::R5, Action::Keep, "jev_low \"alto rooms\" 0.52 < 0.7"));
        let d = go(&doc(None), &Memory::default(), None);
        assert!(d.is_no_key());
    }
}
