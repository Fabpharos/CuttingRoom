//! Minimal MCP server protocol: JSON-RPC 2.0 over newline-delimited stdio,
//! offering tools only. Kept independent of NovelAI so it can be tested with
//! a fake tool set.

use serde_json::{json, Value};

// Newest first. The client's requested version is echoed back if supported;
// otherwise the newest is offered, per the MCP version negotiation rules.
const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

pub struct ToolResult {
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self { content: vec![json!({ "type": "text", "text": text.into() })], is_error: false }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self { is_error: true, ..Self::text(text) }
    }
}

pub trait Tools {
    /// Tool definitions for `tools/list` (name, description, inputSchema).
    fn list(&self) -> Vec<Value>;
    /// Runs a tool. `None` means there's no tool by that name.
    fn call(&mut self, name: &str, arguments: &Value) -> Option<ToolResult>;
}

pub struct ServerInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub instructions: &'static str,
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// Handles one line from the client. Returns the line to send back, if any —
/// notifications and client responses get no reply.
pub fn handle_line<T: Tools>(tools: &mut T, info: &ServerInfo, line: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(error_response(Value::Null, -32700, format!("Parse error: {e}"))),
    };
    let id = msg.get("id").cloned();
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        // A response to something we sent, or malformed; never answer those
        // unless they carry an id we can attach an error to.
        return match (id, msg.get("result").or(msg.get("error"))) {
            (Some(id), None) => Some(error_response(id, -32600, "Invalid request")),
            _ => None,
        };
    };
    let id = id?; // notifications (e.g. notifications/initialized) get no reply
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            let version = requested
                .filter(|v| SUPPORTED_VERSIONS.contains(v))
                .unwrap_or(SUPPORTED_VERSIONS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": info.name, "version": info.version },
                "instructions": info.instructions,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools.list() }),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(error_response(id, -32602, "Missing tool name"));
            };
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match tools.call(name, &arguments) {
                Some(r) => json!({ "content": r.content, "isError": r.is_error }),
                None => return Some(error_response(id, -32602, format!("Unknown tool: {name}"))),
            }
        }
        _ => return Some(error_response(id, -32601, format!("Method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeTools {
        calls: Vec<(String, Value)>,
    }

    impl Tools for FakeTools {
        fn list(&self) -> Vec<Value> {
            vec![json!({ "name": "echo", "description": "test", "inputSchema": { "type": "object" } })]
        }
        fn call(&mut self, name: &str, arguments: &Value) -> Option<ToolResult> {
            self.calls.push((name.to_string(), arguments.clone()));
            (name == "echo").then(|| ToolResult::text(arguments.to_string()))
        }
    }

    const INFO: ServerInfo = ServerInfo { name: "test", version: "0.0.1", instructions: "hi" };

    fn send(tools: &mut FakeTools, msg: Value) -> Option<Value> {
        handle_line(tools, &INFO, &msg.to_string())
    }

    #[test]
    fn negotiates_protocol_version() {
        let mut t = FakeTools { calls: vec![] };
        let r = send(&mut t, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "test");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        let r = send(&mut t, json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], SUPPORTED_VERSIONS[0]);
    }

    #[test]
    fn notifications_and_client_responses_get_no_reply() {
        let mut t = FakeTools { calls: vec![] };
        assert!(send(&mut t, json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        assert!(send(&mut t, json!({"jsonrpc":"2.0","id":9,"result":{}})).is_none());
    }

    #[test]
    fn lists_and_calls_tools() {
        let mut t = FakeTools { calls: vec![] };
        let r = send(&mut t, json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).unwrap();
        assert_eq!(r["result"]["tools"][0]["name"], "echo");
        let r = send(&mut t, json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"a":1}}})).unwrap();
        assert_eq!(r["id"], 4);
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(r["result"]["content"][0]["type"], "text");
        assert_eq!(t.calls[0].1, json!({"a":1}));
    }

    #[test]
    fn reports_protocol_errors() {
        let mut t = FakeTools { calls: vec![] };
        let r = send(&mut t, json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}})).unwrap();
        assert_eq!(r["error"]["code"], -32602);
        let r = send(&mut t, json!({"jsonrpc":"2.0","id":6,"method":"resources/list"})).unwrap();
        assert_eq!(r["error"]["code"], -32601);
        let r = handle_line(&mut t, &INFO, "{not json").unwrap();
        assert_eq!(r["error"]["code"], -32700);
        let r = send(&mut t, json!({"jsonrpc":"2.0","id":7,"method":"ping"})).unwrap();
        assert_eq!(r["result"], json!({}));
    }
}
