pub mod core;
pub mod error;
pub mod index;
pub mod meta;
pub mod rules;
pub mod state;
pub mod walk;
pub mod watch;

pub use crate::core::RoomsCore;
pub use error::CoreError;
pub use watch::start_watching;
