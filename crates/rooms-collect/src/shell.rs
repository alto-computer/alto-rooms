//! Which `.html` files a shell command writes: `>`/`>>` targets, `tee`, and `cp`/`mv`/`install`
//! destinations. A port of find_html.py's `shell_writes`; its tests are mirrored below.
use crate::pathutil::{is_html, resolve};
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SHELL_MAX_CHARS: usize = 100_000;
const SEPARATORS: &str = "();|&\n";
const COPY_LONG_VALUE_FLAGS: [&str; 5] = ["--mode", "--owner", "--group", "--suffix", "--target-directory"];

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).expect("valid regex"))
}

fn token_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // words may mix quoted parts and escapes; a quote left open runs as a plain character
    re(&R, r#"[ \t\r]+|(?P<comment>\#[^\n]*)|(?P<op>[();<>|&\n]+)|(?P<word>(?:[^\s();<>|&'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*"|['"\\])+)"#)
}

fn dequote_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r#"'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)|['"\\]"#)
}

fn unescape_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r#"\\([\\"$`])"#)
}

fn assign_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z_]\w*=")
}

/// `command` without here-document bodies (their text is data, not commands).
fn strip_heredocs(command: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut end: Option<String> = None;
    for line in command.split('\n') {
        if let Some(e) = &end {
            if line.trim() == e { end = None; }
            continue;
        }
        if let Some(e) = heredoc_end(line) { end = Some(e); }
        out.push(line);
    }
    out.join("\n")
}

/// The terminator word of a `<<WORD` / `<<-'WORD'` on this line (not `<<<`).
fn heredoc_end(line: &str) -> Option<String> {
    let b = line.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'<' && b[i + 1] == b'<' && (i == 0 || b[i - 1] != b'<') {
            let mut j = i + 2;
            if j < b.len() && b[j] == b'-' { j += 1; }
            while j < b.len() && b[j].is_ascii_whitespace() { j += 1; }
            let quote = if j < b.len() && (b[j] == b'\'' || b[j] == b'"') { j += 1; Some(b[j - 1]) } else { None };
            let start = j;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') { j += 1; }
            if j > start && quote.is_none_or(|q| j < b.len() && b[j] == q) {
                return Some(line[start..j].to_string());
            }
        }
        i += 1;
    }
    None
}

fn dequote(word: &str) -> String {
    dequote_re().replace_all(word, |c: &regex::Captures| {
        if let Some(s) = c.get(1) { return s.as_str().to_string(); }
        if let Some(d) = c.get(2) { return unescape_re().replace_all(d.as_str(), "$1").into_owned(); }
        c.get(3).map(|e| e.as_str().to_string()).unwrap_or_default()
    }).into_owned()
}

/// (is_operator, text) tokens. Operators are recognised only outside quotes.
fn tokens(command: &str) -> Vec<(bool, String)> {
    let text = strip_heredocs(command).replace("\\\n", "");
    let mut out = Vec::new();
    for c in token_re().captures_iter(&text) {
        if let Some(op) = c.name("op") {
            out.push((true, op.as_str().to_string()));
        } else if let Some(w) = c.name("word") {
            out.push((false, dequote(w.as_str())));
        }
    }
    out
}

/// Simple commands, split on `&&`, `||`, `;`, `|`, `&`, `( )` and newlines. Redirect operators stay.
fn segments(tokens: Vec<(bool, String)>) -> Vec<Vec<(bool, String)>> {
    let mut segs = Vec::new();
    let mut seg = Vec::new();
    for (op, text) in tokens {
        if op && text.chars().all(|c| SEPARATORS.contains(c)) {
            if !seg.is_empty() { segs.push(std::mem::take(&mut seg)); }
        } else {
            seg.push((op, text));
        }
    }
    if !seg.is_empty() { segs.push(seg); }
    segs
}

/// (argv, output redirect targets) of one simple command.
fn split_redirects(seg: Vec<(bool, String)>) -> (Vec<String>, Vec<String>) {
    let (mut argv, mut targets) = (Vec::new(), Vec::new());
    let mut it = seg.into_iter();
    while let Some((op, text)) = it.next() {
        if !op { argv.push(text); continue; }
        let target = it.next().map(|t| t.1).unwrap_or_default();
        if text.contains('>') { targets.push(target); }
    }
    (argv, targets)
}

fn is_flag(w: &str) -> bool { w.starts_with('-') && w != "-" }

/// (letter, value) of the first value-taking letter in a short-flag cluster.
fn short_flag_value(flag: &str, letters: &str, it: &mut std::vec::IntoIter<String>) -> (Option<char>, Option<String>) {
    for (i, ch) in flag.char_indices().skip(1) {
        if letters.contains(ch) {
            let rest = &flag[i + ch.len_utf8()..];
            let v = if rest.is_empty() { it.next() } else { Some(rest.to_string()) };
            return (Some(ch), v);
        }
    }
    (None, None)
}

/// `words` after their leading flags; flags in `letters` also skip their value.
fn skip_flags(words: Vec<String>, letters: &str) -> Vec<String> {
    let mut it = words.into_iter();
    while let Some(w) = it.next() {
        if w == "--" { break; }
        if !is_flag(&w) {
            let mut v = vec![w];
            v.extend(it);
            return v;
        }
        if !w.starts_with("--") { short_flag_value(&w, letters, &mut it); }
    }
    it.collect()
}

fn prefix_letters(w: &str) -> Option<&'static str> {
    match w { "sudo" => Some("ugChp"), "env" => Some("uCS"), "command" => Some(""), _ => None }
}

/// `argv` from the command word on: env assignments and sudo/env/command (with flags) skipped.
fn command_words(argv: Vec<String>) -> Vec<String> {
    let mut rest = argv;
    while !rest.is_empty() {
        let w = rest.remove(0);
        if let Some(letters) = prefix_letters(&w) {
            rest = skip_flags(rest, letters);
        } else if !assign_re().is_match(&w) {
            let mut v = vec![w];
            v.extend(rest);
            return v;
        }
    }
    Vec::new()
}

fn copy_value_flags(prog: &str) -> Option<&'static str> {
    match prog { "cp" | "mv" => Some("St"), "install" => Some("mogSt"), _ => None }
}

fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    t.rsplit('/').next().unwrap_or(t)
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') || dir.is_empty() { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

/// Destinations of `cp`/`mv`/`install` args: `-t DIR`, or the last arg (a dir gets basenames).
fn copy_dests(prog: &str, args: Vec<String>, cwd: Option<&Path>, user_home: &Path) -> Vec<String> {
    let letters = copy_value_flags(prog).unwrap_or("");
    let (mut target, mut srcs, mut flags) = (None::<String>, Vec::new(), true);
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if !(flags && is_flag(&a)) {
            srcs.push(a);
        } else if a == "--" {
            flags = false;
        } else if a.starts_with("--") {
            let (name, value) = match a.split_once('=') {
                Some((n, v)) => (n.to_string(), Some(v.to_string())),
                None => (a.clone(), if COPY_LONG_VALUE_FLAGS.contains(&a.as_str()) { it.next() } else { None }),
            };
            if name == "--target-directory" { target = value; }
        } else {
            let (letter, value) = short_flag_value(&a, letters, &mut it);
            if letter == Some('t') { target = value; }
        }
    }
    let target = match target {
        Some(t) => t,
        None => {
            if srcs.len() < 2 { return Vec::new(); }
            let t = srcs.pop().unwrap();
            let is_dir = shell_path(&t, cwd, user_home).is_some_and(|d| d.is_dir());
            if !(t.ends_with('/') || srcs.len() > 1 || is_dir) { return vec![t]; }
            t
        }
    };
    srcs.iter().map(|s| join(&target, basename(s))).collect()
}

/// `word` as an absolute path, or None when it is dynamic (`$`, backticks) or unresolvable.
fn shell_path(word: &str, cwd: Option<&Path>, user_home: &Path) -> Option<PathBuf> {
    if word.contains('$') || word.contains('`') { return None; }
    resolve(word, cwd, user_home)
}

/// Absolute `.html` paths a shell command writes. Relative paths follow `cd` from `cwd`; they
/// are dropped when the directory is unknown.
pub fn shell_writes(command: &str, cwd: Option<&Path>, user_home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if command.len() > SHELL_MAX_CHARS { return out; }
    let mut cwd: Option<PathBuf> = cwd.map(Path::to_path_buf);
    for seg in segments(tokens(command)) {
        let (argv, mut targets) = split_redirects(seg);
        let words = command_words(argv);
        let prog = words.first().map(|w| basename(w).to_string()).unwrap_or_default();
        if prog == "cd" {
            cwd = match words.get(1) {
                None => Some(user_home.to_path_buf()),
                Some(a) if a == "-" => None,
                Some(a) => shell_path(a, cwd.as_deref(), user_home),
            };
        } else if copy_value_flags(&prog).is_some() {
            targets.extend(copy_dests(&prog, words[1..].to_vec(), cwd.as_deref(), user_home));
        } else if prog == "tee" {
            targets.extend(words[1..].iter().filter(|a| !a.starts_with('-')).cloned());
        }
        for t in targets.iter().filter(|t| is_html(t)) {
            if let Some(p) = shell_path(t, cwd.as_deref(), user_home) { out.push(p); }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(cmd: &str, cwd: Option<&str>) -> Vec<String> {
        shell_writes(cmd, cwd.map(Path::new), Path::new("/home/u")).into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn redirects_tee_and_copies() {
        assert_eq!(w("echo hi > out.html", Some("/w")), ["/w/out.html"]);
        assert_eq!(w("echo hi >> /a/b.html", None), ["/a/b.html"]);
        assert_eq!(w("cat x | tee -a r.html", Some("/w")), ["/w/r.html"]);
        assert_eq!(w("cp a.html /dst/b.html", None), ["/dst/b.html"]);
        assert_eq!(w("cp a.html b.html /dst", Some("/w")), ["/dst/a.html", "/dst/b.html"]);
        assert_eq!(w("cp -t /dst x/a.html", None), ["/dst/a.html"]);
        assert_eq!(w("install -m 644 a.html /d/", None), ["/d/a.html"]);
        assert_eq!(w("mv --target-directory /d a.html", None), ["/d/a.html"]);
        assert!(w("cat a.html", Some("/w")).is_empty());
        assert!(w("echo > $OUT.html", Some("/w")).is_empty());
    }

    #[test]
    fn cd_quotes_prefixes_and_heredocs() {
        assert_eq!(w("cd /p && echo x > 'my file.html'", None), ["/p/my file.html"]);
        assert_eq!(w("cd - ; echo x > a.html", Some("/w")), Vec::<String>::new());
        assert_eq!(w("cd; echo > a.html", None), ["/home/u/a.html"]);
        assert_eq!(w("sudo -u root FOO=1 cp a.html \"/x y/b.html\"", None), ["/x y/b.html"]);
        assert_eq!(w("env -u X tee /t.html < in", None), ["/t.html"]);
        assert_eq!(w("cat <<'EOF' > /o.html\necho > /no.html\nEOF\n", None), ["/o.html"]);
        assert_eq!(w("echo '>' fake.html", Some("/w")), Vec::<String>::new());
        assert_eq!(w("echo x > ~/r.html # > /c.html", None), ["/home/u/r.html"]);
    }

    #[test]
    fn copy_into_existing_dir_gets_basename() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_string_lossy().into_owned();
        assert_eq!(w(&format!("cp x/a.html {dir}"), Some("/w")), [format!("{dir}/a.html")]);
        assert_eq!(w(&format!("cp x/a.html {dir}/new.html"), Some("/w")), [format!("{dir}/new.html")]);
    }
}
