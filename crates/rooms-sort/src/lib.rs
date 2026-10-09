//! rooms-sort: moves the documents rooms-collect put in the inbox to the room they belong in.
//!
//! The rules are in `rules` (spec §2): R1 name match and R2 remembered repo room need nothing
//! but the folder; R3 and R4 use TypeSafe Jev and run only with `TYPESAFE_API_KEY`. It talks to
//! Rooms only through roomsd's existing public API, and never parses agent logs.
pub mod api;
pub mod config;
pub mod doc;
pub mod jev;
pub mod rules;
pub mod run;
pub mod store;
