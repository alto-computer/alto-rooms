//! Helpers for `RoomsCore::call_tool`: input checks, document resolution and the data-file line.
//! Generic: nothing here knows what any plugin's tool means.

use crate::core::RoomsCore;
use crate::error::CoreError;
use serde_json::Value;
use std::path::Path;

/// Largest serialized tool input.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;

fn bad(why: &str) -> CoreError { CoreError::BadRequest(why.into()) }

/// The `doc` of a call's input: the input must be a JSON object of at most 64 KiB with a string `doc`.
pub(crate) fn doc_of(input: &Value) -> Result<&str, CoreError> {
    let obj = input.as_object().ok_or_else(|| bad("input must be an object"))?;
    if serde_json::to_vec(input).map_or(true, |b| b.len() > MAX_INPUT_BYTES) { return Err(bad("input too large")); }
    match obj.get("doc") {
        Some(Value::String(s)) if !s.is_empty() => Ok(s),
        _ => Err(bad("doc is required")),
    }
}

fn is_file_key(s: &str) -> bool { s.len() == 16 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) }

/// A document reference to its fileKey: a fileKey must be indexed; an absolute path is compared by
/// realpath with the original file of every indexed artifact (a linear scan over all rooms, fine
/// for now; an index lookup by resolved path would replace it if rooms get large).
pub(crate) fn resolve_doc(core: &RoomsCore, doc: &str) -> Result<String, CoreError> {
    if is_file_key(doc) {
        return core.artifact_by_file_key(doc).map(|a| a.file_key).ok_or(CoreError::NotFound);
    }
    if !Path::new(doc).is_absolute() { return Err(bad("doc must be a fileKey or an absolute path")); }
    let want = std::fs::canonicalize(doc).map_err(|_| CoreError::NotFound)?;
    let mut rooms: Vec<String> = core.list_rooms().into_iter().map(|r| r.id).collect();
    rooms.push(rooms_protocol::JOURNAL_ROOM_ID.into());
    for room in rooms {
        for a in core.list_artifacts(&room).unwrap_or_default() {
            if core.resolve_file(&room, &a.rel_path).is_ok_and(|p| p == want) { return Ok(a.file_key); }
        }
    }
    Err(CoreError::NotFound)
}

/// `{"at":…,"tool":…,"input":…}` plus a newline.
pub(crate) fn envelope_line(at: &str, tool: &str, input: &Value) -> String {
    let mut s = serde_json::json!({ "at": at, "tool": tool, "input": input }).to_string();
    s.push('\n');
    s
}
