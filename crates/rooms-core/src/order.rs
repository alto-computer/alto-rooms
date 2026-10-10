//! The room order and its one invariant: pinned (coloured) rooms are a prefix of the rooms other
//! than the inbox. The inbox is never pinned and keeps its own index, so every rule here works on
//! the list with the inbox set aside. Every change to the order or to a colour goes through here.

use crate::state::RoomRecord;
use rooms_protocol::{RoomColor, INBOX_ROOM_ID};

/// What `set_color` did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ColorChange {
    /// The room already had that colour.
    Unchanged,
    /// The colour changed and the room kept its index.
    InPlace,
    /// The room crossed into the other section, so the order changed.
    Moved,
}

/// Runs `f` on the rooms other than the inbox, then puts the inbox back at the index it had.
fn without_inbox<T>(rooms: &mut Vec<RoomRecord>, f: impl FnOnce(&mut Vec<RoomRecord>) -> T) -> T {
    let inbox = rooms.iter().position(|r| r.id == INBOX_ROOM_ID).map(|i| (i, rooms.remove(i)));
    let out = f(rooms);
    if let Some((i, rec)) = inbox { rooms.insert(i.min(rooms.len()), rec); }
    out
}

fn pinned_len(rooms: &[RoomRecord]) -> usize {
    rooms.iter().take_while(|r| r.color.is_some()).count()
}

/// Restores the invariant on a list read from disk (hand-edited, or written by another build):
/// the inbox loses any colour, and pinned rooms move first keeping each section's own order.
pub(crate) fn put_pinned_first(rooms: &mut Vec<RoomRecord>) {
    without_inbox(rooms, |rest| rest.sort_by_key(|r| r.color.is_none()));
    if let Some(inbox) = rooms.iter_mut().find(|r| r.id == INBOX_ROOM_ID) { inbox.color = None; }
}

/// Moves room `id` to index `to` among the rooms other than the inbox, clamped to its own
/// section: a pinned room stays among the pinned, an unpinned one below them.
/// Returns `false` (and changes nothing) when there is no such room.
pub(crate) fn move_within_section(rooms: &mut Vec<RoomRecord>, id: &str, to: usize) -> bool {
    without_inbox(rooms, |rest| {
        let Some(from) = rest.iter().position(|r| r.id == id) else { return false };
        let rec = rest.remove(from);
        let pinned = pinned_len(rest);
        let at = if rec.color.is_some() { to.min(pinned) } else { to.clamp(pinned, rest.len()) };
        rest.insert(at, rec);
        true
    })
}

/// Sets or clears room `id`'s colour. Pinning moves it to the end of the pinned run, unpinning to
/// the start of the unpinned rooms, and changing one colour for another keeps its place.
/// `None` when there is no such room (the inbox included).
pub(crate) fn set_color(rooms: &mut Vec<RoomRecord>, id: &str, color: Option<RoomColor>) -> Option<ColorChange> {
    without_inbox(rooms, |rest| {
        let i = rest.iter().position(|r| r.id == id)?;
        let was = std::mem::replace(&mut rest[i].color, color);
        if was == color { return Some(ColorChange::Unchanged); }
        if was.is_some() == color.is_some() { return Some(ColorChange::InPlace); }
        let rec = rest.remove(i);
        let at = pinned_len(rest);
        rest.insert(at, rec);
        Some(if at == i { ColorChange::InPlace } else { ColorChange::Moved })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rooms_protocol::RoomKind;
    use RoomColor::*;

    fn rec(id: &str, color: Option<RoomColor>) -> RoomRecord {
        RoomRecord { id: id.into(), name: id.into(), kind: RoomKind::Owned, path: format!("/h/{id}").into(), dev: None, ino: None, color }
    }

    /// `inbox` and plain ids are neutral; `id:colour` is pinned (`a:sage`).
    fn list(spec: &str) -> Vec<RoomRecord> {
        spec.split_whitespace().map(|s| match s.split_once(':') {
            Some((id, c)) => rec(id, Some(serde_json::from_value(serde_json::json!(c)).unwrap())),
            None => rec(s, None),
        }).collect()
    }

    fn show(rooms: &[RoomRecord]) -> String {
        rooms.iter().map(|r| match r.color {
            Some(c) => format!("{}:{}", r.id, serde_json::to_value(c).unwrap().as_str().unwrap()),
            None => r.id.clone(),
        }).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn pinning_moves_the_room_to_the_end_of_the_pinned_run() {
        let mut v = list("inbox a:sage b c d");
        assert_eq!(set_color(&mut v, "d", Some(Rose)), Some(ColorChange::Moved));
        assert_eq!(show(&v), "inbox a:sage d:rose b c");
        // The first unpinned room is already where the pinned run ends: pinned in place.
        assert_eq!(set_color(&mut v, "b", Some(Sage)), Some(ColorChange::InPlace));
        assert_eq!(show(&v), "inbox a:sage d:rose b:sage c");
    }

    #[test]
    fn unpinning_moves_the_room_to_the_top_of_the_unpinned_rooms() {
        let mut v = list("inbox a:sage b:rose c:sage d e");
        assert_eq!(set_color(&mut v, "a", None), Some(ColorChange::Moved));
        assert_eq!(show(&v), "inbox b:rose c:sage a d e");
        assert_eq!(set_color(&mut v, "c", None), Some(ColorChange::InPlace));
        assert_eq!(show(&v), "inbox b:rose c a d e");
    }

    #[test]
    fn changing_a_pinned_rooms_colour_keeps_its_place() {
        let mut v = list("inbox a:sage b:sage c");
        assert_eq!(set_color(&mut v, "a", Some(Rose)), Some(ColorChange::InPlace));
        assert_eq!(show(&v), "inbox a:rose b:sage c");
        // Same colour again, and clearing a neutral room: nothing moves.
        assert_eq!(set_color(&mut v, "a", Some(Rose)), Some(ColorChange::Unchanged));
        assert_eq!(set_color(&mut v, "c", None), Some(ColorChange::Unchanged));
        assert_eq!(show(&v), "inbox a:rose b:sage c");
    }

    #[test]
    fn the_inbox_is_not_a_room_to_colour_and_keeps_its_index() {
        let mut v = list("inbox a b");
        assert_eq!(set_color(&mut v, "inbox", Some(Sage)), None);
        assert_eq!(set_color(&mut v, "nope", Some(Sage)), None);
        assert_eq!(show(&v), "inbox a b");
        // An inbox that is not first (an old state file) stays at its index.
        let mut v = list("a inbox b c");
        set_color(&mut v, "c", Some(Sage));
        assert_eq!(show(&v), "c:sage inbox a b");
    }

    #[test]
    fn moves_stay_within_their_section() {
        let mut v = list("inbox a:sage b:sage c:sage d e f");
        assert!(move_within_section(&mut v, "c", 0));
        assert_eq!(show(&v), "inbox c:sage a:sage b:sage d e f");
        // A pinned room dragged into the unpinned rooms stops at the end of the pinned run.
        assert!(move_within_section(&mut v, "c", 5));
        assert_eq!(show(&v), "inbox a:sage b:sage c:sage d e f");
        // An unpinned room dragged into the pinned run stops at the top of the unpinned rooms.
        assert!(move_within_section(&mut v, "f", 0));
        assert_eq!(show(&v), "inbox a:sage b:sage c:sage f d e");
        assert!(move_within_section(&mut v, "f", 99));
        assert_eq!(show(&v), "inbox a:sage b:sage c:sage d e f");
        assert!(move_within_section(&mut v, "d", 4));
        assert_eq!(show(&v), "inbox a:sage b:sage c:sage e d f");
        assert!(!move_within_section(&mut v, "nope", 0));
    }

    #[test]
    fn put_pinned_first_keeps_each_sections_order_and_untints_the_inbox() {
        let mut v = list("inbox:sea a b:sage c d:rose");
        put_pinned_first(&mut v);
        assert_eq!(show(&v), "inbox b:sage d:rose a c");
    }
}
