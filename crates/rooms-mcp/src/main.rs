use std::io::{BufRead, Write};

fn main() {
    let api = rooms_mcp::HttpApi::from_env();
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
