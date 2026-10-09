//! rooms-collect: reads the agents' own logs (Claude Code, Codex, Aside) while the app runs,
//! links the HTML they write into `~/rooms`, records which conversation wrote each file,
//! keeps a copy of the logs, and indexes recent conversations for search.
//!
//! It talks to Rooms only through folders: a symlink in `~/rooms/<room>` or `~/rooms/inbox`
//! is picked up by roomsd's existing watcher. Everything it keeps besides that is in
//! `collect.db` (a cache) and the archive folder, under the app's data folder.
pub mod adapters;
pub mod archive;
pub mod config;
pub mod conversations;
pub mod daemon;
pub mod event;
pub mod filter;
pub mod ingest;
pub mod js;
pub mod pathutil;
pub mod reader;
pub mod search;
pub mod shell;
pub mod sinks;
pub mod store;
