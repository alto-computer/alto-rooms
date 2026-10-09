//! What Jev sees (spec §3): the repo a file lives in (N1), the state text and the room options,
//! each cut to its budget. Nothing else about the document or the machine is sent.
use std::path::{Path, PathBuf};

pub const TITLE_CHARS: usize = 120;
pub const LOCATION_CHARS: usize = 200;
pub const EXCERPT_CHARS: usize = 2_000;
pub const ROOM_TITLES: usize = 5;
pub const ROOM_TITLE_CHARS: usize = 60;
pub const ROOM_CHARS: usize = 350;
pub const OPTIONS_CHARS: usize = 6_000;
/// Jev allows 255 options per Choice; one is `none`.
pub const MAX_ROOMS: usize = 254;
pub const NONE_KEY: &str = "none";
pub const NONE_TEXT: &str = "어느 룸에도 뚜렷이 맞지 않음";
pub const INSTRUCTIONS: &str = "이 문서를 어느 룸에 두면 나중에 찾기 쉬운가? 뚜렷이 맞는 룸이 없으면 none.";

/// N1: (repo name, repo root) when the file is inside a git repo (a worktree is named after its
/// main repo) or an Orca workspace. Unlike rooms-collect, a plain parent folder is not a repo.
pub fn repo_of(real: &Path) -> Option<(String, PathBuf)> {
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty());
    let mut d = real.parent();
    while let Some(dir) = d {
        let g = dir.join(".git");
        if g.is_dir() { return Some((name(dir)?, dir.to_path_buf())); }
        if g.is_file() {
            let first = std::fs::read_to_string(&g).ok()?.lines().next().unwrap_or("").trim().to_string();
            let main = first.strip_prefix("gitdir:").and_then(|r| r.trim().split("/.git/worktrees/").next().filter(|_| first.contains("/.git/worktrees/")));
            let repo = main.and_then(|m| name(Path::new(m))).or_else(|| dir.parent().and_then(name)).or_else(|| name(dir))?;
            return Some((repo, dir.to_path_buf()));
        }
        d = dir.parent();
    }
    // …/orca/workspaces/<project>/<workspace>/…
    let s = real.to_string_lossy();
    let at = s.find("/orca/workspaces/")? + "/orca/workspaces/".len();
    let mut parts = s[at..].splitn(3, '/');
    let (project, ws) = (parts.next()?, parts.next()?);
    if project.is_empty() || ws.is_empty() || parts.next().is_none() { return None; }
    Some((project.to_string(), PathBuf::from(&s[..at + project.len() + 1 + ws.len()])))
}

/// "repo/path/in/repo.html", or just the file name: never the home folder or the user's name.
pub fn location(real: &Path, repo: Option<&(String, PathBuf)>) -> String {
    let file = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let loc = match repo {
        Some((name, root)) => real.strip_prefix(root).map(|rel| format!("{name}/{}", rel.to_string_lossy())).unwrap_or(file),
        None => file,
    };
    cut(&loc, LOCATION_CHARS)
}

/// The visible text of an HTML page: no script/style/head-only markup, no tags, collapsed whitespace.
pub fn visible_text(html: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let b = html.as_bytes();
    let mut last_space = true;
    while i < b.len() && out.chars().count() < max_chars {
        if b[i] == b'<' {
            let skip_to = ["script", "style", "noscript", "template", "svg", "title"].iter().find_map(|t| {
                let open = format!("<{t}");
                let next = lower.as_bytes().get(i + open.len()).copied();
                (lower[i..].starts_with(&open) && matches!(next, Some(b'>' | b' ' | b'\n' | b'\t' | b'\r' | b'/')))
                    .then(|| lower[i..].find(&format!("</{t}")).map(|e| i + e).unwrap_or(b.len()))
            });
            i = skip_to.unwrap_or(i);
            i = lower[i..].find('>').map(|e| i + e + 1).unwrap_or(b.len());
            if !last_space { out.push(' '); last_space = true; }
            continue;
        }
        let ch = html[i..].chars().next().unwrap();
        i += ch.len_utf8();
        if ch == '&' {
            if let Some((rep, len)) = entity(&html[i - 1..]) {
                i += len - 1;
                out.push(rep);
                last_space = rep == ' ';
                continue;
            }
        }
        if ch.is_whitespace() {
            if !last_space { out.push(' '); last_space = true; }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    cut(out.trim(), max_chars)
}

fn entity(s: &str) -> Option<(char, usize)> {
    for (name, c) in [("&amp;", '&'), ("&lt;", '<'), ("&gt;", '>'), ("&quot;", '"'), ("&#39;", '\''), ("&nbsp;", ' ')] {
        if s.starts_with(name) { return Some((c, name.len())); }
    }
    None
}

/// The state Jev reads for one document.
pub fn state(title: &str, location: &str, excerpt: &str) -> String {
    format!("제목: {}\n위치: {location}\n\n{excerpt}", cut(title, TITLE_CHARS))
}

/// One room's option text: "name — 포함: t1; t2; …" within ROOM_CHARS.
pub fn room_option(name: &str, recent_titles: &[String]) -> String {
    let titles: Vec<String> = recent_titles.iter().take(ROOM_TITLES).map(|t| cut(t, ROOM_TITLE_CHARS)).collect();
    let s = if titles.is_empty() { name.to_string() } else { format!("{name} — 포함: {}", titles.join("; ")) };
    cut(&s, ROOM_CHARS)
}

/// The options map: rooms in the order given (most recently active first) while the total fits
/// OPTIONS_CHARS and MAX_ROOMS, then `none`.
pub fn options(rooms: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut total = 0;
    for (id, text) in rooms.iter().take(MAX_ROOMS) {
        let n = text.chars().count();
        if total + n > OPTIONS_CHARS { break; }
        total += n;
        out.push((id.clone(), text.clone()));
    }
    out.push((NONE_KEY.to_string(), NONE_TEXT.to_string()));
    out
}

pub fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max { return s.to_string(); }
    let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
    t.push('…');
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_worktree_orca_and_plain_folders() {
        let d = tempfile::tempdir().unwrap();
        let repo = d.path().join("alto-rooms");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("docs")).unwrap();
        assert_eq!(repo_of(&repo.join("docs/a.html")).unwrap().0, "alto-rooms");
        let wt = d.path().join("wt/feat");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}/.git/worktrees/feat\n", repo.display())).unwrap();
        assert_eq!(repo_of(&wt.join("a.html")), Some(("alto-rooms".into(), wt.clone())));
        assert_eq!(repo_of(Path::new("/x/orca/workspaces/proj/ws1/a/b.html")), Some(("proj".into(), PathBuf::from("/x/orca/workspaces/proj/ws1"))));
        let plain = d.path().join("Downloads");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(repo_of(&plain.join("x.html")), None, "a plain folder is not a repo");
    }

    #[test]
    fn location_never_holds_the_home_path() {
        let root = PathBuf::from("/Users/me/code/excalidraw");
        let real = root.join("notes/perf.html");
        assert_eq!(location(&real, Some(&("excalidraw".into(), root))), "excalidraw/notes/perf.html");
        assert_eq!(location(Path::new("/Users/me/Downloads/t.html"), None), "t.html");
    }

    #[test]
    fn visible_text_drops_markup_and_respects_the_budget() {
        let html = "<html><head><style>p{color:red}</style><script>var x='<p>';</script></head>\n<body><h1>Canvas&amp;perf</h1>\n\n<p>2,000개 &lt;요소&gt;</p><svg><text>no</text></svg><p>끝</p></body></html>";
        assert_eq!(visible_text(html, 100), "Canvas&perf 2,000개 <요소> 끝");
        let long = format!("<p>{}</p>", "가".repeat(5000));
        assert_eq!(visible_text(&long, EXCERPT_CHARS).chars().count(), EXCERPT_CHARS);
    }

    #[test]
    fn options_fit_the_budget_and_end_with_none() {
        let opt = room_option("alto-rooms", &["x".repeat(100), "b".into(), "c".into(), "d".into(), "e".into(), "f".into()]);
        assert!(opt.starts_with("alto-rooms — 포함: xxx") && opt.ends_with("; e"), "{opt}");
        let many: Vec<(String, String)> = (0..300).map(|i| (format!("r{i}"), "y".repeat(ROOM_CHARS))).collect();
        let o = options(&many);
        assert_eq!(o.len(), OPTIONS_CHARS / ROOM_CHARS + 1);
        assert_eq!(o.last().unwrap().0, NONE_KEY);
        let small: Vec<(String, String)> = (0..300).map(|i| (format!("r{i}"), "y".into())).collect();
        assert_eq!(options(&small).len(), MAX_ROOMS + 1);
    }
}
