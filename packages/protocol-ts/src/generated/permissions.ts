// Generated from rooms_protocol::PERMISSIONS by crates/rooms-protocol/tests/shape.rs. Do not edit.

export const PERMISSIONS = ["rooms.read", "clipboard", "downloads", "artifact.content"] as const;

export type Permission = (typeof PERMISSIONS)[number];
