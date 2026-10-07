//! `CoreError`: every way a core call fails, with the wire `code()` and HTTP `status()` roomsd
//! answers with (the message is the `Display` text).

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("invalid room name")] InvalidRoomName,
    #[error("room exists")] RoomExists,
    #[error("note exists")] NoteExists,
    #[error("invalid link path: {0}")] InvalidLinkPath(String),
    #[error("overlapping room")] OverlappingRoom,
    #[error("room not found")] RoomNotFound,
    #[error("not found")] NotFound,
    #[error("invalid input: {0}")] InvalidInput(String),
    /// A plugin data or asset path breaking the path rule, or crossing a symlink.
    #[error("invalid path")] InvalidPath,
    /// Plugin data over `plugins::MAX_DATA_BYTES`.
    #[error("too large")] TooLarge,
    /// A tool call whose input is not what tools take; the text says why.
    #[error("{0}")] BadRequest(String),
    #[error("path escape")] PathEscape,
    #[error("write failed: {0}")] WriteFailed(String),
    /// Filesystem IO. On the wire it is `write_failed`, like every IO failure has always been.
    #[error("write failed: {0}")] Io(#[from] std::io::Error),
    /// The index (SQLite). On the wire it is `write_failed`, as `Io`.
    #[error("write failed: {0}")] Db(#[from] rusqlite::Error),
    #[error("internal error: {0}")] Internal(String),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::InvalidRoomName => "invalid_room_name",
            CoreError::RoomExists => "room_exists",
            CoreError::NoteExists => "note_exists",
            CoreError::InvalidLinkPath(_) => "invalid_link_path",
            CoreError::OverlappingRoom => "overlapping_room",
            CoreError::RoomNotFound => "room_not_found",
            CoreError::NotFound => "not_found",
            CoreError::InvalidInput(_) => "invalid_input",
            CoreError::InvalidPath => "invalid_path",
            CoreError::TooLarge => "too_large",
            CoreError::BadRequest(_) => "bad_request",
            CoreError::PathEscape => "path_escape",
            CoreError::WriteFailed(_) | CoreError::Io(_) | CoreError::Db(_) => "write_failed",
            CoreError::Internal(_) => "internal",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            CoreError::RoomExists | CoreError::NoteExists | CoreError::OverlappingRoom => 409,
            CoreError::RoomNotFound | CoreError::NotFound => 404,
            CoreError::TooLarge => 413,
            CoreError::WriteFailed(_) | CoreError::Io(_) | CoreError::Db(_) | CoreError::Internal(_) => 500,
            CoreError::InvalidRoomName | CoreError::InvalidLinkPath(_) | CoreError::InvalidInput(_)
            | CoreError::InvalidPath | CoreError::BadRequest(_) | CoreError::PathEscape => 400,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(e: CoreError) -> (u16, &'static str, String) { (e.status(), e.code(), e.to_string()) }

    #[test]
    fn io_and_db_failures_keep_the_write_failed_wire_shape() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(wire(io.into()), (500, "write_failed", "write failed: denied".into()));
        let db = rusqlite::Error::QueryReturnedNoRows;
        let text = db.to_string();
        assert_eq!(wire(db.into()), (500, "write_failed", format!("write failed: {text}")));
    }

    #[test]
    fn plugin_and_tool_errors_carry_their_own_codes() {
        assert_eq!(wire(CoreError::InvalidPath), (400, "invalid_path", "invalid path".into()));
        assert_eq!(wire(CoreError::TooLarge), (413, "too_large", "too large".into()));
        assert_eq!(wire(CoreError::BadRequest("doc is required".into())), (400, "bad_request", "doc is required".into()));
    }
}
