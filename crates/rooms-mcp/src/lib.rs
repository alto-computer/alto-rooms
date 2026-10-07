//! MCP stdio server core: turns roomsd's plugin tools into MCP tools. Knows no specific plugin.
use rooms_protocol::{ToolCall, ToolInfo};
use serde_json::{json, Value};

/// The slice of roomsd's API this server needs; faked in tests.
pub trait Api {
    fn tools(&self) -> Result<Vec<ToolInfo>, String>;
    /// Returns the data path the call appended to, or the API's error message.
    fn call(&self, call: &ToolCall) -> Result<String, String>;
}

const DEFAULT_PROTOCOL: &str = "2025-06-18";

fn mcp_name(t: &ToolInfo) -> String { format!("{}__{}", t.plugin_id, t.name) }

/// MCP requires `inputSchema.type == "object"`; one bad schema must not break the whole list.
fn object_schema(input: &Value) -> Value {
    let mut schema = json!({"type": "object"});
    if let (Some(s), Some(o)) = (input.as_object(), schema.as_object_mut()) { o.extend(s.clone()); }
    if schema["type"] != "object" { schema["type"] = json!("object"); }
    schema
}

fn result(id: &Value, r: Value) -> Value { json!({"jsonrpc": "2.0", "id": id, "result": r}) }
fn rpc_error(id: &Value, code: i64, message: &str) -> Value { json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}) }
fn text_result(text: &str, is_error: bool) -> Value { json!({"content": [{"type": "text", "text": text}], "isError": is_error}) }

/// Handles one JSON-RPC line. `None` means no response (notifications).
pub fn handle(api: &dyn Api, line: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(rpc_error(&Value::Null, -32700, &format!("parse error: {e}"))),
    };
    let id = msg.get("id").cloned()?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match msg.get("method").and_then(Value::as_str) {
        Some("initialize") => {
            let v = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(DEFAULT_PROTOCOL);
            result(&id, json!({"protocolVersion": v, "capabilities": {"tools": {}},
                "serverInfo": {"name": "rooms", "version": env!("CARGO_PKG_VERSION")}}))
        }
        Some("ping") => result(&id, json!({})),
        Some("tools/list") => {
            let tools = api.tools().unwrap_or_else(|e| { eprintln!("rooms-mcp: {e}"); vec![] });
            let list: Vec<Value> = tools.iter()
                .map(|t| json!({"name": mcp_name(t), "description": t.description, "inputSchema": object_schema(&t.input)})).collect();
            result(&id, json!({"tools": list}))
        }
        Some("tools/call") => result(&id, call_tool(api, &params)),
        Some(m) => rpc_error(&id, -32601, &format!("method not found: {m}")),
        None => rpc_error(&id, -32600, "invalid request"),
    })
}

fn call_tool(api: &dyn Api, params: &Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else { return text_result("missing tool name", true) };
    let tools = match api.tools() { Ok(t) => t, Err(e) => return text_result(&e, true) };
    // Match against the live list rather than splitting the name: tool names may themselves contain `__`.
    let Some(t) = tools.iter().find(|t| mcp_name(t) == name) else { return text_result(&format!("unknown tool: {name}"), true) };
    let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    match api.call(&ToolCall { plugin_id: t.plugin_id.clone(), name: t.name.clone(), input }) {
        Ok(path) => text_result(&format!("Saved to {path}"), false),
        Err(e) => text_result(&e, true),
    }
}

/// roomsd over loopback HTTP. The token is re-read on every request so a daemon restart keeps working.
/// No `Origin` header is sent: the write guard treats a missing Origin as a non-browser client.
pub struct HttpApi { pub home: std::path::PathBuf, pub port: u16, pub timeout: std::time::Duration }

impl HttpApi {
    pub fn from_env() -> Self {
        let home = std::env::var("ROOMS_HOME").map(std::path::PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().expect("home dir").join("rooms"));
        let port = std::env::var("ROOMS_API_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4317);
        HttpApi { home, port, timeout: std::time::Duration::from_secs(10) }
    }

    fn request(&self, method: &str, path: &str) -> Result<ureq::Request, String> {
        let token = std::fs::read_to_string(self.home.join(".rooms/token")).map_err(|e| format!("cannot read roomsd token: {e}"))?;
        let agent = ureq::AgentBuilder::new().timeout_connect(self.timeout).timeout_read(self.timeout).timeout_write(self.timeout).build();
        Ok(agent.request(method, &format!("http://127.0.0.1:{}{path}", self.port))
            .set("Host", &format!("127.0.0.1:{}", self.port))
            .set("Authorization", &format!("Bearer {}", token.trim())))
    }
}

fn api_message(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => r.into_json::<rooms_protocol::ApiError>().map(|b| b.message).unwrap_or_else(|_| format!("roomsd returned {code}")),
        e => format!("roomsd is not reachable: {e}"),
    }
}

impl Api for HttpApi {
    fn tools(&self) -> Result<Vec<ToolInfo>, String> {
        self.request("GET", "/v1/tools")?.call().map_err(api_message)?.into_json().map_err(|e| e.to_string())
    }
    fn call(&self, call: &ToolCall) -> Result<String, String> {
        let r: rooms_protocol::ToolResult = self.request("POST", "/v1/tools/call")?
            .send_json(serde_json::to_value(call).map_err(|e| e.to_string())?).map_err(api_message)?
            .into_json().map_err(|e| e.to_string())?;
        Ok(r.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake { tools: Result<Vec<ToolInfo>, String>, call: Result<String, String>, seen: std::cell::RefCell<Option<ToolCall>> }
    impl Api for Fake {
        fn tools(&self) -> Result<Vec<ToolInfo>, String> { self.tools.clone() }
        fn call(&self, c: &ToolCall) -> Result<String, String> { *self.seen.borrow_mut() = Some(c.clone()); self.call.clone() }
    }
    fn info(p: &str, n: &str) -> ToolInfo { ToolInfo { plugin_id: p.into(), name: n.into(), description: format!("{n} it"), input: json!({"type": "object"}) } }
    fn fake() -> Fake { Fake { tools: Ok(vec![info("draw", "draw"), info("my-plug", "do__it")]), call: Ok("ops/k.jsonl".into()), seen: Default::default() } }
    fn run(api: &Fake, line: &str) -> Value { handle(api, line).expect("response") }

    #[test]
    fn initialize_echoes_client_version_or_defaults() {
        let r = run(&fake(), r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#);
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(r["result"]["capabilities"], json!({"tools": {}}));
        assert_eq!(r["result"]["serverInfo"]["name"], "rooms");
        let r = run(&fake(), r#"{"jsonrpc":"2.0","id":"a","method":"initialize"}"#);
        assert_eq!((r["id"].as_str(), r["result"]["protocolVersion"].as_str()), (Some("a"), Some("2025-06-18")));
    }

    #[test]
    fn notifications_get_no_response() {
        assert!(handle(&fake(), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
    }

    #[test]
    fn tools_list_prefixes_plugin_id() {
        let r = run(&fake(), r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let t = &r["result"]["tools"][0];
        assert_eq!((t["name"].as_str(), t["description"].as_str()), (Some("draw__draw"), Some("draw it")));
        assert_eq!(t["inputSchema"], json!({"type": "object"}));
    }

    #[test]
    fn tools_list_forces_object_schemas() {
        let mut bad = info("p", "a");
        bad.input = json!({"properties": {"x": {"type": "string"}}});
        let mut worse = info("p", "b");
        worse.input = json!({"type": "string"});
        let mut junk = info("p", "c");
        junk.input = json!(null);
        let api = Fake { tools: Ok(vec![bad, worse, junk]), ..fake() };
        let r = run(&api, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let t = &r["result"]["tools"];
        assert_eq!(t[0]["inputSchema"], json!({"type": "object", "properties": {"x": {"type": "string"}}}));
        assert_eq!(t[1]["inputSchema"], json!({"type": "object"}));
        assert_eq!(t[2]["inputSchema"], json!({"type": "object"}));
    }

    #[test]
    fn a_silent_roomsd_times_out_instead_of_hanging() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let home = std::env::temp_dir().join(format!("rooms-mcp-timeout-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".rooms")).unwrap();
        std::fs::write(home.join(".rooms/token"), "t").unwrap();
        let api = HttpApi { home: home.clone(), port: l.local_addr().unwrap().port(), timeout: std::time::Duration::from_millis(200) };
        let start = std::time::Instant::now();
        let e = api.tools().unwrap_err();
        std::fs::remove_dir_all(home).ok();
        assert!(e.contains("not reachable"), "{e}");
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn unreachable_roomsd_lists_nothing_and_call_errors() {
        let api = Fake { tools: Err("roomsd is not reachable".into()), ..fake() };
        assert_eq!(run(&api, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)["result"]["tools"], json!([]));
        let r = run(&api, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"draw__draw","arguments":{}}}"#);
        assert_eq!((r["result"]["isError"].clone(), r["result"]["content"][0]["text"].as_str()), (json!(true), Some("roomsd is not reachable")));
    }

    #[test]
    fn call_maps_name_and_reports_saved_path() {
        let api = fake();
        let r = run(&api, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"my-plug__do__it","arguments":{"doc":"k"}}}"#);
        assert_eq!(r["result"], json!({"content": [{"type": "text", "text": "Saved to ops/k.jsonl"}], "isError": false}));
        let c = api.seen.borrow().clone().unwrap();
        assert_eq!((c.plugin_id.as_str(), c.name.as_str(), c.input), ("my-plug", "do__it", json!({"doc": "k"})));
    }

    #[test]
    fn api_errors_and_unknown_tools_are_error_results() {
        let api = Fake { call: Err("doc not found".into()), ..fake() };
        let r = run(&api, r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"draw__draw","arguments":{}}}"#);
        assert_eq!((r["result"]["isError"].clone(), r["result"]["content"][0]["text"].as_str()), (json!(true), Some("doc not found")));
        let r = run(&fake(), r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope__x"}}"#);
        assert_eq!(r["result"]["isError"], true);
    }

    #[test]
    fn unknown_method_and_bad_json_are_rpc_errors() {
        let r = run(&fake(), r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#);
        assert_eq!((r["error"]["code"].clone(), r["id"].clone()), (json!(-32601), json!(6)));
        assert_eq!(run(&fake(), "{nope")["error"]["code"], -32700);
    }
}
