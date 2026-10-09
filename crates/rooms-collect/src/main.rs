//! rooms-collect: `run` (default; what the app starts), `once`, and `search`.
use rooms_collect::adapters::Roots;
use rooms_collect::daemon::{Collector, Opts};
use rooms_collect::search::{self, Query};
use rooms_collect::{config, store};
use std::process::ExitCode;

const USAGE: &str = "usage:
  rooms-collect [run]          collect while the parent process runs
  rooms-collect once           collect everything new, then exit
  rooms-collect search QUERY [--agent claude-code|codex|aside] [--cwd DIR] [--since 7d|YYYY-MM-DD] [--limit N] [--json]
common options: --home DIR (Rooms home, default $ROOMS_HOME or ~/rooms), --data DIR (default $ROOMS_COLLECT_DATA
  or the app's data folder), --claude-dir DIR, --codex-dir DIR, --aside-dir DIR";

fn main() -> ExitCode {
    match real_main(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("rooms-collect: {e}"); ExitCode::FAILURE }
    }
}

fn real_main(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut cmd: Option<String> = None;
    let mut words: Vec<String> = Vec::new();
    let mut flags: std::collections::HashMap<String, String> = Default::default();
    let mut json = false;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => { println!("{USAGE}"); return Ok(()); }
            "--json" => json = true,
            f if f.starts_with("--") => {
                let (k, v) = match f.split_once('=') { Some((k, v)) => (k.to_string(), v.to_string()), None => (f.to_string(), it.next().ok_or(format!("{f} needs a value"))?) };
                flags.insert(k, v);
            }
            _ if cmd.is_none() => cmd = Some(a),
            _ => words.push(a),
        }
    }
    let user_home = dirs::home_dir().ok_or("no home folder")?;
    let dir = |k: &str| flags.get(k).map(|p| rooms_collect::pathutil::expand_tilde(p, &user_home));
    let mut roots = Roots::for_home(&user_home);
    if let Some(p) = dir("--claude-dir") { roots.claude = p; }
    if let Some(p) = dir("--codex-dir") { roots.codex = p; }
    if let Some(p) = dir("--aside-dir") { roots.aside = p; }
    let home = dir("--home").or_else(rooms_protocol::layout::home_from_env).ok_or("no Rooms home")?;
    let data = dir("--data").or_else(config::data_dir).ok_or("no data folder")?;
    let opts = Opts { home, roots, data };

    match cmd.as_deref().unwrap_or("run") {
        "run" => rooms_collect::daemon::run(opts),
        "once" => {
            let mut c = Collector::open(opts)?;
            let t = c.drain()?;
            c.compress();
            if !t.enabled { println!("collection is off (enabled = false in collect.toml)"); return Ok(()); }
            println!("read {} logs, {} new events, archived {} bytes, linked {}, recorded {} sources",
                t.ingest.files_read, t.ingest.events, t.ingest.archived_bytes, t.link.linked.len(), t.link.recorded);
            for l in &t.link.linked { println!("  linked {}", l.display()); }
            Ok(())
        }
        "search" => {
            let db = opts.db_path();
            if !db.exists() { return Err(format!("no index yet at {} (is the app running?)", db.display()).into()); }
            let c = store::open_read_only(&db)?;
            let q = Query {
                text: words.join(" "),
                agent: flags.get("--agent").cloned(),
                cwd: dir("--cwd").map(|p| p.to_string_lossy().into_owned()),
                since: flags.get("--since").map(|s| since(s)).transpose()?,
                limit: flags.get("--limit").map(|n| n.parse()).transpose()?.unwrap_or(20),
            };
            if q.text.trim().is_empty() { return Err(USAGE.into()); }
            let hits = search::search(&c, &q)?;
            if json { println!("{}", serde_json::to_string_pretty(&hits)?); return Ok(()); }
            if hits.is_empty() { println!("no matches"); }
            for h in hits {
                println!("{}  {}  {}", h.ts.as_deref().unwrap_or("-"), h.agent, h.title.as_deref().unwrap_or("(untitled)"));
                if let Some(d) = &h.cwd { println!("  {d}"); }
                println!("  {}", h.excerpt);
                println!("  {}  ({} matches)\n", h.resume, h.matches);
            }
            Ok(())
        }
        other => Err(format!("unknown command {other:?}\n{USAGE}").into()),
    }
}

/// `7d`, `12h`, or a date/time, as `YYYY-MM-DDTHH:MM:SSZ`.
fn since(s: &str) -> Result<String, String> {
    let now = chrono::Utc::now();
    let ago = |n: &str, unit: i64| n.parse::<i64>().ok().map(|n| now - chrono::Duration::seconds(n * unit));
    let t = if let Some(n) = s.strip_suffix('d') { ago(n, 86_400) }
        else if let Some(n) = s.strip_suffix('h') { ago(n, 3_600) }
        else {
            let full = if s.len() == 10 { format!("{s}T00:00:00") } else { s.to_string() };
            rooms_collect::event::parse_ts(&serde_json::Value::String(full))
        };
    t.map(|t| rooms_collect::event::fmt_ts(&t)).ok_or_else(|| format!("bad --since {s:?}"))
}

