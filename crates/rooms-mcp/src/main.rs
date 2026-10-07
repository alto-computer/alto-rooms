use std::io::{BufRead, Write};

fn main() {
    let api = match rooms_mcp::HttpApi::from_env() {
        Ok(api) => api,
        Err(e) => {
            eprintln!("rooms-mcp: {e}");
            std::process::exit(2);
        }
    };
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        if let Some(resp) = rooms_mcp::handle(&api, &line) {
            let mut out = stdout.lock();
            if writeln!(out, "{resp}").and_then(|_| out.flush()).is_err() { break; }
        }
    }
}
