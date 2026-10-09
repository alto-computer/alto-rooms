//! `.html` paths written by `writeFile`/`appendFile(Sync)` in JavaScript (Aside's repl tool).
//! A port of find_html.py's `js_writes`: string consts are followed across calls of a session.
use crate::pathutil::{is_html, resolve};
use regex::Regex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const JS_STR: &str = r#"'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`"#;
const JS_NAME: &str = r"[A-Za-z_$][\w$]*";

fn term_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(&format!(r"^\s*(?:({JS_STR})|({JS_NAME}))[ \t]*")).unwrap())
}
fn event_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(&format!(r"\b(?:const|let|var)\s+({JS_NAME})\s*=|\b(?:writeFile|appendFile)(?:Sync)?\s*\(")).unwrap())
}
fn decl_end_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[ \t]*(?:;|\r?\n|$)").unwrap())
}
fn arg_end_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\s*[,)]").unwrap())
}
fn template_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\$\{\s*(.*?)\s*\}").unwrap())
}
fn escape_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\\(.)").unwrap())
}

pub type Syms = BTreeMap<String, String>;

/// The value of a JS string literal; a template may only use `${NAME}` of known names.
fn js_string(lit: &str, syms: &Syms) -> Option<String> {
    let body = &lit[1..lit.len() - 1];
    let unescape = |s: &str| escape_re().replace_all(s, "$1").into_owned();
    if !lit.starts_with('`') { return Some(unescape(body)); }
    let mut out = String::new();
    let mut last = 0;
    for c in template_re().captures_iter(body) {
        let m = c.get(0).unwrap();
        out.push_str(&unescape(&body[last..m.start()]));
        out.push_str(syms.get(c.get(1).unwrap().as_str())?);
        last = m.end();
    }
    out.push_str(&unescape(&body[last..]));
    Some(out)
}

/// (value, end) of `term (+ term)*` at `pos`; value is None when any term is unknown.
fn js_expr(code: &str, mut pos: usize, syms: &Syms) -> (Option<String>, usize) {
    let mut parts = String::new();
    loop {
        let Some(c) = term_re().captures(&code[pos..]) else { return (None, pos) };
        let end = pos + c.get(0).unwrap().end();
        let v = match (c.get(1), c.get(2)) {
            (Some(lit), _) => js_string(lit.as_str(), syms),
            (_, Some(name)) => syms.get(name.as_str()).cloned(),
            _ => None,
        };
        let Some(v) = v else { return (None, end) };
        parts.push_str(&v);
        pos = end;
        if !code[pos..].starts_with('+') { return (Some(parts), pos); }
        pos += 1;
    }
}

/// Absolute `.html` paths passed to writeFile/appendFile(Sync) in `code`. `syms` is updated in place.
pub fn js_writes(code: &str, syms: &mut Syms, user_home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(c) = event_re().captures_at(code, at) {
        let m = c.get(0).unwrap();
        at = m.end().max(at + 1);
        let (value, end) = js_expr(code, m.end(), syms);
        if let Some(name) = c.get(1) {
            match value {
                Some(v) if decl_end_re().is_match(&code[end..]) => { syms.insert(name.as_str().to_string(), v); }
                _ => { syms.remove(name.as_str()); }
            }
        } else if let Some(v) = value {
            if is_html(&v) && arg_end_re().is_match(&code[end..]) {
                if let Some(p) = resolve(&v, None, user_home) { out.push(p); }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(code: &str, syms: &mut Syms) -> Vec<String> {
        js_writes(code, syms, Path::new("/home/u")).into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn consts_templates_and_concat() {
        let mut s = Syms::new();
        assert_eq!(w("const dir = '/out';\nfs.writeFileSync(dir + '/a.html', html)", &mut s), ["/out/a.html"]);
        // state carries across calls of one session
        assert_eq!(w("await fs.writeFile(`${dir}/b.html`, x)", &mut s), ["/out/b.html"]);
        assert_eq!(w("appendFileSync(\"~/c.html\", x)", &mut s), ["/home/u/c.html"]);
    }

    #[test]
    fn unknown_expressions_ignored() {
        let mut s = Syms::new();
        assert!(w("writeFileSync(path.join(a, 'x.html'), y)", &mut s).is_empty());
        assert!(w("const d = getDir(); writeFileSync(d + '/x.html', y)", &mut s).is_empty());
        assert!(w("writeFileSync(`${nope}/x.html`, y)", &mut s).is_empty());
        assert!(w("writeFileSync('/x.txt', y)", &mut s).is_empty());
    }
}
