#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CoreError {
    #[error("invalid room name")] InvalidRoomName,
    #[error("room exists")] RoomExists,
    #[error("invalid link path: {0}")] InvalidLinkPath(String),
    #[error("overlapping room")] OverlappingRoom,
    #[error("room not found")] RoomNotFound,
    #[error("invalid input: {0}")] InvalidInput(String),
    #[error("path escape")] PathEscape,
    #[error("write failed: {0}")] WriteFailed(String),
    #[error("internal error: {0}")] Internal(String),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::InvalidRoomName => "invalid_room_name",
            CoreError::RoomExists => "room_exists",
            CoreError::InvalidLinkPath(_) => "invalid_link_path",
            CoreError::OverlappingRoom => "overlapping_room",
            CoreError::RoomNotFound => "room_not_found",
            CoreError::InvalidInput(_) => "invalid_input",
            CoreError::PathEscape => "path_escape",
            CoreError::WriteFailed(_) => "write_failed",
            CoreError::Internal(_) => "internal",
        }
    }
    pub fn status(&self) -> u16 {
        match self {
            CoreError::RoomExists | CoreError::OverlappingRoom => 409,
            CoreError::RoomNotFound => 404,
            CoreError::WriteFailed(_) | CoreError::Internal(_) => 500,
            _ => 400,
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self { CoreError::WriteFailed(e.to_string()) }
}
