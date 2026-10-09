//! rooms-sort: `run` (what the app starts every minute), `undo`, `log`.
use rooms_sort::{api, config::{self, Config}, jev, run, store::Store};
use std::process::ExitCode;

const USAGE: &str = "usage:
  rooms-sort [run] [--dry-run]   sort the inbox once (dry-run: decide and print, move nothing)
  rooms-sort undo [--run ID]     move the last run's documents back to the inbox
  rooms-sort log [-n 20]         recent decisions and the rule behind each
  rooms-sort check-key           exit 0 if TypeSafe accepts $TYPESAFE_API_KEY, 3 if it refuses it
options: --home DIR (Rooms home, default $ROOMS_HOME or ~/rooms), --data DIR (default $ROOMS_SORT_DATA
  or the app's data folder). roomsd's port: $ROOMS_API_PORT (default 4317). The Jev rules (R3, R4)
  run only when $TYPESAFE_API_KEY is set.";

fn main() -> ExitCode {
    match real_main(std::env::args().skip(1).collect()) {
        Ok(code) => code,
        Err(e) => { eprintln!("rooms-sort: {e}"); ExitCode::FAILURE }
    }
}

fn real_main(args: Vec<String>) -> Result<ExitCode, Box<dyn std::error::Error>> {
    let mut cmd: Option<String> = None;
    let mut flags: std::collections::HashMap<String, String> = Default::default();
    let mut dry_run = false;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => { println!("{USAGE}"); return Ok(ExitCode::SUCCESS); }
            "--dry-run" => dry_run = true,
            f if f.starts_with('-') => {
                let (k, v) = match f.split_once('=') { Some((k, v)) => (k.to_string(), v.to_string()), None => (f.to_string(), it.next().ok_or(format!("{f} needs a value"))?) };
                flags.insert(k, v);
            }
            _ if cmd.is_none() => cmd = Some(a),
            _ => return Err(format!("unexpected argument {a}\n{USAGE}").into()),
        }
    }
    let home = flags.get("--home").map(std::path::PathBuf::from).or_else(rooms_protocol::layout::home_from_env).ok_or("no Rooms home")?;
    let data = flags.get("--data").map(std::path::PathBuf::from).or_else(config::data_dir).ok_or("no data folder")?;
    let port = rooms_protocol::layout::parse_port("ROOMS_API_PORT", std::env::var("ROOMS_API_PORT").ok().as_deref(), rooms_protocol::layout::DEFAULT_API_PORT)?;
    std::fs::create_dir_all(&data)?;
    let store = Store::open(&data.join("sort.db"))?;

    match cmd.as_deref().unwrap_or("run") {
        "run" => {
            let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(data.join("sort.lock"))?;
            if lock.try_lock().is_err() { println!("another run is in progress"); return Ok(ExitCode::SUCCESS); }
            let cfg = Config::load(&home);
            if !cfg.enabled { println!("sorting is off (enabled = false in sort.toml)"); return Ok(ExitCode::SUCCESS); }
            let rooms = api::Http::new(&home, port)?;
            let key = std::env::var(jev::KEY_ENV).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
            let j = key.map(|k| jev::Jev::new(k, cfg.model.clone()));
            let now = chrono::Utc::now();
            let s = run::run(&rooms, j.as_ref().map(|j| j as &dyn jev::Classifier), &store, &run::Opts { home: &home, cfg: &cfg, dry_run, now });
            for l in &s.lines { println!("{l}"); }
            if s.considered == 0 && s.error.is_none() { println!("nothing to sort"); }
            if !dry_run { if let Err(e) = run::write_status(&data, &store, &s, now) { eprintln!("rooms-sort: could not write status: {e}"); } }
            if s.unauthorized { eprintln!("rooms-sort: TypeSafe rejected the key; only R1 and R2 ran"); return Ok(ExitCode::from(3)); }
            if let Some(e) = &s.error { eprintln!("rooms-sort: {e}"); return Ok(ExitCode::FAILURE); }
            Ok(ExitCode::SUCCESS)
        }
        "check-key" => {
            // One tiny Choice call: exit 0 when TypeSafe takes the key, 3 when it refuses it.
            let key = std::env::var(jev::KEY_ENV).ok().filter(|k| !k.trim().is_empty()).ok_or("TYPESAFE_API_KEY is not set")?;
            let j = jev::Jev::new(key.trim().to_string(), Config::load(&home).model);
            let opts = [("a".to_string(), "rooms".to_string()), (rooms_sort::doc::NONE_KEY.to_string(), rooms_sort::doc::NONE_TEXT.to_string())];
            match jev::Classifier::ask(&j, "key check", &opts) {
                Ok(_) => { println!("key ok"); Ok(ExitCode::SUCCESS) }
                Err(jev::JevError::Unauthorized) => { println!("key rejected"); Ok(ExitCode::from(3)) }
                Err(e) => Err(e.to_string().into()),
            }
        }
        "undo" => {
            let rooms = api::Http::new(&home, port)?;
            for l in run::undo(&rooms, &store, &home, flags.get("--run").map(String::as_str))? { println!("{l}"); }
            Ok(ExitCode::SUCCESS)
        }
        "log" => {
            let n: u32 = flags.get("-n").map(|s| s.parse()).transpose()?.unwrap_or(20);
            for r in store.recent(n)? {
                let local = chrono::DateTime::parse_from_rfc3339(&r.at).map(|t| t.with_timezone(&chrono::Local).format("%m-%d %H:%M").to_string()).unwrap_or(r.at.clone());
                println!("{local}  {:<6} {}  {} {}", r.action, rooms_sort::doc::cut(&r.title, 40), r.rule, r.why);
            }
            Ok(ExitCode::SUCCESS)
        }
        other => Err(format!("unknown command {other}\n{USAGE}").into()),
    }
}
