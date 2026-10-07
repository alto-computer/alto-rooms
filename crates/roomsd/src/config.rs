//! Listener ports and the optional dev-server origin, read from the environment.
use rooms_protocol::layout::{parse_port, DEFAULT_API_PORT, DEFAULT_FILES_PORT};

/// Listener ports and the optional dev-server origin; the guards and CORS derive their allow-lists from it.
#[derive(Clone, Debug, PartialEq)]
pub struct NetConfig {
    pub api_port: u16,
    pub files_port: u16,
    pub dev_origin: Option<String>,
}

impl Default for NetConfig {
    fn default() -> Self { NetConfig { api_port: DEFAULT_API_PORT, files_port: DEFAULT_FILES_PORT, dev_origin: None } }
}

impl NetConfig {
    /// Reads `ROOMS_API_PORT`, `ROOMS_FILES_PORT`, `ROOMS_DEV_ORIGIN`. Invalid ports are an error;
    /// an invalid dev origin is warned about and ignored.
    pub fn from_env() -> Result<Self, String> {
        let get = |k: &str| std::env::var(k).ok();
        let dev_origin = get("ROOMS_DEV_ORIGIN").and_then(|raw| {
            let o = parse_dev_origin(&raw);
            if o.is_none() { eprintln!("roomsd: ignoring invalid ROOMS_DEV_ORIGIN={raw:?} (want http(s)://host[:port])"); }
            o
        });
        Ok(NetConfig {
            api_port: parse_port("ROOMS_API_PORT", get("ROOMS_API_PORT").as_deref(), DEFAULT_API_PORT)?,
            files_port: parse_port("ROOMS_FILES_PORT", get("ROOMS_FILES_PORT").as_deref(), DEFAULT_FILES_PORT)?,
            dev_origin,
        })
    }
}

/// Accepts only `http(s)://host[:port]` (no path, query, fragment, trailing slash); anything else
/// (`null`, `*`, empty, ...) is `None`. Never lets the sandboxed-iframe origin `null` through.
pub fn parse_dev_origin(raw: &str) -> Option<String> {
    let v = raw.trim();
    let rest = v.strip_prefix("http://").or_else(|| v.strip_prefix("https://"))?;
    let (host, port) = match rest.split_once(':') { Some((h, p)) => (h, Some(p)), None => (rest, None) };
    let host_ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()));
    (host_ok && port_ok).then(|| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_dev_origin;

    #[test]
    fn dev_origin_parsing() {
        assert_eq!(parse_dev_origin("http://localhost:4173").as_deref(), Some("http://localhost:4173"));
        assert_eq!(parse_dev_origin("https://a.b:8443").as_deref(), Some("https://a.b:8443"));
        assert_eq!(parse_dev_origin(" http://localhost:1420 ").as_deref(), Some("http://localhost:1420"));
        for bad in ["null", "*", "", "http://x/", "http://x/path", "ftp://x", "localhost:1420", "http://", "http://x:", "http://x:abc", "http://x?q", "http://x#f", "http://a b"] {
            assert_eq!(parse_dev_origin(bad), None, "{bad:?}");
        }
    }
}
