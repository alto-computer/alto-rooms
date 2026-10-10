//! roomsd: the local HTTP daemon in front of a rooms home.
mod config;
pub mod guard;
mod home_files;
pub mod inject;
mod router;
pub mod routes;
pub mod sse;
mod state;

pub use config::{parse_dev_origin, NetConfig};
pub use home_files::{acquire_home_lock, resolve_mcp_bin, write_mcp_config, write_token};
pub use router::{build_api_router, build_files_router};
pub use state::AppState;
