//! The room list: lookups, and creating, linking, renaming and reordering rooms.

use crate::lock::lock;
use crate::core::{Inner, RoomsCore};
use crate::error::CoreError;
use crate::rules::{room_slug, slug_key, validate_room_name};
use crate::state::{inode_of, RoomRecord};
use rooms_protocol::*;
use std::path::{Path, PathBuf};

impl RoomsCore {
    pub fn list_rooms(&self) -> Vec<Room> {
        let inner = lock(&self.inner);
        inner.state.rooms.iter().map(|r| Self::to_room(&inner, r)).collect()
    }

    pub fn room_root(&self, room: &RoomId) -> Option<(PathBuf, RoomKind)> {
        let inner = lock(&self.inner);
        if room == JOURNAL_ROOM_ID { return Some((inner.home.join("journal"), RoomKind::Journal)); }
        inner.state.find(room).map(|r| (r.path.clone(), r.kind))
    }

    pub(crate) fn all_roots(inner: &Inner) -> Vec<(RoomId, PathBuf, RoomKind)> {
        let mut v: Vec<_> = inner.state.rooms.iter().map(|r| (r.id.clone(), r.path.clone(), r.kind)).collect();
        v.push((JOURNAL_ROOM_ID.into(), inner.home.join("journal"), RoomKind::Journal));
        v
    }

    /// Every room root (journal included), longest first, for mapping many paths to rooms with one
    /// lock (see `owner_of`).
    pub fn room_roots(&self) -> Vec<(RoomId, PathBuf)> {
        let mut roots: Vec<_> = Self::all_roots(&lock(&self.inner)).into_iter().map(|(id, root, _)| (id, root)).collect();
        roots.sort_by_key(|(_, root)| std::cmp::Reverse(root.as_os_str().len()));
        roots
    }

    /// Roots of the linked rooms not flagged unavailable. Unlike `list_rooms` it computes no
    /// per-room counts, so the watcher's periodic checks barely hold the lock.
    pub fn linked_roots(&self) -> Vec<PathBuf> {
        let inner = lock(&self.inner);
        inner.state.rooms.iter()
            .filter(|r| r.kind == RoomKind::Linked && !inner.unavailable.contains(&r.id))
            .map(|r| r.path.clone()).collect()
    }

    fn slug_taken(inner: &Inner, slug: &str) -> bool { Self::slug_taken_except(inner, slug, None) }

    fn slug_taken_except(inner: &Inner, slug: &str, except: Option<&str>) -> bool {
        let key = slug_key(slug);
        inner.state.rooms.iter().filter(|r| Some(r.id.as_str()) != except).any(|r| slug_key(&r.name) == key || r.path.file_name().map(|f| slug_key(&f.to_string_lossy()) == key).unwrap_or(false))
    }

    pub fn create_room(&self, name: &str) -> Result<Room, CoreError> {
        let name = validate_room_name(name)?;
        let slug = room_slug(&name);
        let mut inner = lock(&self.inner);
        // The stat + mkdir below stay under the lock on purpose: the slug check and the folder
        // creation must be atomic with respect to other create/rename calls.
        if Self::slug_taken(&inner, &slug) { return Err(CoreError::RoomExists); }
        let path = inner.home.join(&slug);
        // A plain folder of that name (not yet adopted) or any other entry: the name is taken.
        if std::fs::symlink_metadata(&path).is_ok() { return Err(CoreError::RoomExists); }
        std::fs::create_dir(&path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { CoreError::RoomExists } else { e.into() })?;
        let (dev, ino) = inode_of(&path).unzip();
        let rec = RoomRecord { id: nanoid::nanoid!(12), name, kind: RoomKind::Owned, path, dev, ino };
        inner.state.rooms.push(rec.clone());
        inner.state.save()?;
        let room = Self::to_room(&inner, &rec);
        self.emit(&mut inner, EventKind::RoomAdded { room: room.clone() });
        Ok(room)
    }

    pub fn link_folder(&self, path: &Path, name: Option<&str>) -> Result<Room, CoreError> {
        let real = std::fs::canonicalize(path).map_err(|_| CoreError::InvalidLinkPath("not found".into()))?;
        if !real.is_dir() || std::fs::read_dir(&real).is_err() { return Err(CoreError::InvalidLinkPath("not a readable directory".into())); }
        let mut inner = lock(&self.inner);
        if real == inner.home || inner.home.starts_with(&real) || real.starts_with(&inner.home) {
            return Err(CoreError::InvalidLinkPath("home".into()));
        }
        for r in inner.state.rooms.iter().filter(|r| r.kind == RoomKind::Linked) {
            if real.starts_with(&r.path) || r.path.starts_with(&real) { return Err(CoreError::OverlappingRoom); }
        }
        let display = match name { Some(n) => validate_room_name(n)?, None => validate_room_name(&real.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default())? };
        if Self::slug_taken(&inner, &room_slug(&display)) { return Err(CoreError::RoomExists); }
        let rec = RoomRecord { id: nanoid::nanoid!(12), name: display, kind: RoomKind::Linked, path: real, dev: None, ino: None };
        inner.state.rooms.push(rec.clone());
        inner.state.save()?;
        let room = Self::to_room(&inner, &rec);
        self.emit(&mut inner, EventKind::RoomAdded { room: room.clone() });
        drop(inner);
        self.rescan_room(&rec.id);
        Ok(room)
    }

    pub fn rename_room(&self, room: &RoomId, name: &str) -> Result<Room, CoreError> {
        let name = validate_room_name(name)?;
        let mut inner = lock(&self.inner);
        let rec = inner.state.find(room).cloned().ok_or(CoreError::RoomNotFound)?;
        if rec.id == INBOX_ROOM_ID { return Err(CoreError::InvalidRoomName); }
        if Self::slug_taken_except(&inner, &room_slug(&name), Some(&rec.id)) { return Err(CoreError::RoomExists); }
        // The stat + rename below stay under the lock on purpose: the slug check and the folder
        // rename must be atomic with respect to other create/rename calls.
        let new_path = if rec.kind == RoomKind::Owned {
            let p = inner.home.join(room_slug(&name));
            if p != rec.path {
                let same_dir = std::fs::canonicalize(&p).ok() == std::fs::canonicalize(&rec.path).ok();
                if !same_dir && std::fs::symlink_metadata(&p).is_ok() { return Err(CoreError::RoomExists); }
                std::fs::rename(&rec.path, &p)?;
            }
            p
        } else { rec.path.clone() };
        let updated = {
            let r = inner.state.find_mut(room).ok_or(CoreError::RoomNotFound)?; // found above, same lock
            r.name = name;
            r.path = new_path;
            r.clone()
        };
        inner.state.save()?;
        let room_v = Self::to_room(&inner, &updated);
        self.emit(&mut inner, EventKind::RoomUpdated { room: room_v.clone() });
        Ok(room_v)
    }

    /// Moves `room` to position `to` among the rooms other than the inbox, which keeps its place
    /// (`to` past the end = last). Saves state.json and emits `rooms.reordered` with the full order.
    pub fn move_room(&self, room: &RoomId, to: usize) -> Result<Vec<RoomId>, CoreError> {
        if room == INBOX_ROOM_ID { return Err(CoreError::InvalidInput("the inbox can't be moved".into())); }
        let mut inner = lock(&self.inner);
        let from = inner.state.rooms.iter().position(|r| &r.id == room).ok_or(CoreError::RoomNotFound)?;
        let rec = inner.state.rooms.remove(from);
        let rooms = &inner.state.rooms;
        let at = rooms.iter().enumerate().filter(|(_, r)| r.id != INBOX_ROOM_ID).nth(to).map(|(i, _)| i).unwrap_or(rooms.len());
        inner.state.rooms.insert(at, rec);
        inner.state.save()?;
        let room_ids: Vec<RoomId> = inner.state.rooms.iter().map(|r| r.id.clone()).collect();
        self.emit(&mut inner, EventKind::RoomsReordered { room_ids: room_ids.clone() });
        Ok(room_ids)
    }
}
