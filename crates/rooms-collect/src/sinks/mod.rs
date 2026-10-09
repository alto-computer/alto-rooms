//! What happens to stored events. Each sink keeps its own cursor in `sink_cursors`, so a new
//! sink starts from the first stored event and an old one never sees an event twice.
pub mod linker;
pub mod sources;
