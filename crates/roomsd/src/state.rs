use crate::NetConfig;
use rooms_core::RoomsCore;

/// Everything a handler or guard needs; cloned per request.
#[derive(Clone)]
pub struct AppState {
    pub core: RoomsCore,
    pub asks: rooms_core::asks::Asks,
    pub token: String,
    pub read_only: bool,
    pub files_origin: String,
    pub net: NetConfig,
}
