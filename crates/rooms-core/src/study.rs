//! The Study: rooms the user fills by understanding, their volumes, and the Study's days and day
//! books, kept as plain JSON files under `<home>/.rooms/study/` (outside `home_sync` and the watcher):
//!
//! ```text
//! rooms/<roomId>/room.json         { id, name, createdAt, links }
//! rooms/<roomId>/volumes/<n>.json  StudyVolume
//! days/<YYYY-MM-DD>.json           StudyDay
//! books/<YYYY-MM-DD>.json          StudyDayBook
//! ```
//!
//! Every read and write holds `study_lock` (lock order: study_lock → `Inner`, taken only to emit),
//! so the two files a publish writes are never seen apart. Writes are a hidden temp file plus a
//! rename, and refuse any symlink under the study root.

use crate::asks::prompt::{ContextEntry, StudyRoomListing};
use crate::core::RoomsCore;
use crate::error::CoreError;
use crate::lock::lock;
use crate::rules::{local_day, valid_room_id, validate_iso_date};
use rooms_protocol::*;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// Largest volume file, in bytes as stored.
pub const MAX_VOLUME_BYTES: usize = 2 * 1024 * 1024;
/// Largest day file, in bytes as stored.
pub const MAX_DAY_BYTES: usize = 256 * 1024;
/// Largest day book file, in bytes as stored.
pub const MAX_BOOK_BYTES: usize = 2 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 60;
const MAX_TITLE_CHARS: usize = 200;
const MAX_LINKS: usize = 1000;
const ROOM_ID_ALPHABET: [char; 36] = [
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

/// `room.json`: the room without its volumes, which live in their own files.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomFile {
    id: StudyRoomId,
    name: String,
    created_at: String,
    links: Vec<StudyLink>,
}

/// What the index reads of a volume file. Cards and edges are skipped, not kept: a flattened
/// `StudyVolumeStatus` would buffer them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VolumeHead {
    number: u32,
    title: String,
    status: StatusWord,
    published_at: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum StatusWord { Draft, Published }

/// What the book list reads of a book file: its cards are counted, never kept.
#[derive(Deserialize)]
struct BookHead {
    date: IsoDate,
    title: String,
    cards: Vec<IgnoredAny>,
}

/// A study room id as roomsd mints them: 10 chars of `[a-z0-9]`. Nothing else names a path.
pub(crate) fn valid_study_room_id(s: &str) -> bool {
    s.len() == 10 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// A client-made card, edge, memo or todo id: 1–64 chars of `[A-Za-z0-9_-]`.
fn valid_item_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn study_room_name(name: &str) -> Result<String, CoreError> {
    let t: String = name.trim().nfc().collect();
    let n = t.chars().count();
    if n == 0 || n > MAX_NAME_CHARS || t.chars().any(char::is_control) { return Err(CoreError::InvalidInput("study room name".into())); }
    Ok(t)
}

/// The links as given, minus repeats (the first one stays).
fn study_links(links: Vec<StudyLink>) -> Result<Vec<StudyLink>, CoreError> {
    if links.len() > MAX_LINKS { return Err(CoreError::InvalidInput("too many study links".into())); }
    let valid = |l: &StudyLink| match l {
        StudyLink::Room { room_id } => valid_room_id(room_id),
        StudyLink::Artifact { file_key } => file_key.len() == 16 && file_key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
    };
    if !links.iter().all(valid) { return Err(CoreError::InvalidInput("study link".into())); }
    let mut seen = HashSet::new();
    Ok(links.into_iter().filter(|l| seen.insert(l.clone())).collect())
}

/// Ids that are valid and unique within one list, as a set.
fn item_ids<'a>(ids: impl Iterator<Item = &'a str>, what: &str) -> Result<HashSet<&'a str>, CoreError> {
    let mut seen = HashSet::new();
    for id in ids {
        if !valid_item_id(id) || !seen.insert(id) { return Err(CoreError::InvalidInput(format!("{what} id"))); }
    }
    Ok(seen)
}

/// A volume's or a book's title, cards and edges: `what` names which in the error.
fn check_canvas(what: &str, title: &str, cards: &[StudyCard], edges: &[StudyEdge]) -> Result<(), CoreError> {
    if title.chars().count() > MAX_TITLE_CHARS { return Err(CoreError::InvalidInput(format!("{what} title"))); }
    let ids = item_ids(cards.iter().map(|c| c.id.as_str()), "card")?;
    if cards.iter().any(|c| c.height.is_some_and(|h| !h.is_finite() || h <= 0.0)) { return Err(CoreError::InvalidInput("card height".into())); }
    item_ids(edges.iter().map(|e| e.id.as_str()), "edge")?;
    if !edges.iter().all(|e| ids.contains(e.source.as_str()) && ids.contains(e.target.as_str())) {
        return Err(CoreError::InvalidInput(format!("an edge joins a card the {what} doesn't have")));
    }
    Ok(())
}

fn check_day(save: &SaveStudyDay) -> Result<(), CoreError> {
    item_ids(save.memos.iter().map(|m| m.id.as_str()), "memo")?;
    item_ids(save.todos.iter().map(|t| t.id.as_str()), "todo")?;
    Ok(())
}

fn now() -> String { chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false) }

fn volume_file(number: u32) -> String { format!("{number}.json") }

/// A volume number as a file or an ask scope key writes it: decimal, ≥ 1, no leading zero.
pub(crate) fn parse_volume_number(n: &str) -> Option<u32> {
    if n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) { return None; }
    n.parse().ok()
}

/// `<n>.json`; hidden temp files and anything else are not volumes.
fn volume_number(file_name: &str) -> Option<u32> { parse_volume_number(file_name.strip_suffix(".json")?) }

/// Pretty JSON for people and agents reading the files, refused past `max` bytes.
fn encode<T: Serialize>(v: &T, max: usize) -> Result<Vec<u8>, CoreError> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| CoreError::Internal(e.to_string()))?;
    if bytes.len() > max { return Err(CoreError::TooLarge); }
    Ok(bytes)
}

/// `room.json` needs no size check: its name and link count are bounded.
fn encode_room(room: &RoomFile) -> Result<Vec<u8>, CoreError> { encode(room, usize::MAX) }

/// `None` when the file isn't there; a file that isn't what it should be is an error.
fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, CoreError> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| CoreError::Internal(format!("unreadable {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Writes atomically: a hidden temp file of its own beside `path`, then a rename over it.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    use std::io::Write;
    let dir = path.parent().ok_or(CoreError::InvalidPath)?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().ok_or(CoreError::InvalidPath)?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.part", nanoid::nanoid!(8)));
    let mut f = std::fs::OpenOptions::new().create_new(true).write(true).open(&tmp)?;
    let written = f.write_all(bytes).and_then(|_| f.sync_all()).and_then(|_| std::fs::rename(&tmp, path));
    if written.is_err() { let _ = std::fs::remove_file(&tmp); }
    Ok(written?)
}

fn corrupt(path: &Path, what: &str) -> CoreError { CoreError::Internal(format!("unreadable {}: {what}", path.display())) }

impl RoomsCore {
    /// `<home>/.rooms/study/<segs…>`, refusing a symlink anywhere from the study root down. Callers
    /// pass only validated ids, numbers and dates, so no segment can climb out.
    fn study_path(&self, segs: &[&str]) -> Result<PathBuf, CoreError> {
        let mut p = self.home.join(".rooms").join("study");
        let is_link = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink());
        if is_link(&p) { return Err(CoreError::InvalidPath); }
        for s in segs {
            p.push(s);
            if is_link(&p) { return Err(CoreError::InvalidPath); }
        }
        Ok(p)
    }

    fn study_room_file(&self, id: &str) -> Result<RoomFile, CoreError> {
        if !valid_study_room_id(id) { return Err(CoreError::InvalidInput("study room id".into())); }
        let path = self.study_path(&["rooms", id, "room.json"])?;
        let room: RoomFile = read_json(&path)?.ok_or(CoreError::StudyRoomNotFound)?;
        if room.id != id { return Err(corrupt(&path, "its id is not its folder's")); }
        Ok(room)
    }

    fn study_volume_numbers(&self, id: &str) -> Result<Vec<u32>, CoreError> {
        let dir = self.study_path(&["rooms", id, "volumes"])?;
        let mut numbers: Vec<u32> = match std::fs::read_dir(&dir) {
            Ok(rd) => rd.flatten().filter_map(|e| volume_number(&e.file_name().to_string_lossy())).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        numbers.sort_unstable();
        Ok(numbers)
    }

    fn read_study_volume(&self, id: &str, number: u32) -> Result<StudyVolume, CoreError> {
        let path = self.study_path(&["rooms", id, "volumes", &volume_file(number)])?;
        let v: StudyVolume = read_json(&path)?.ok_or(CoreError::VolumeNotFound)?;
        if v.number != number { return Err(corrupt(&path, "its number is not its name's")); }
        Ok(v)
    }

    fn write_study_volume(&self, id: &str, v: &StudyVolume) -> Result<(), CoreError> {
        let bytes = encode(v, MAX_VOLUME_BYTES)?;
        write_atomic(&self.study_path(&["rooms", id, "volumes", &volume_file(v.number)])?, &bytes)
    }

    fn study_summary(&self, room: RoomFile) -> Result<StudyRoomSummary, CoreError> {
        let mut volumes = Vec::new();
        for n in self.study_volume_numbers(&room.id)? {
            let path = self.study_path(&["rooms", &room.id, "volumes", &volume_file(n)])?;
            let Some(h) = read_json::<VolumeHead>(&path)? else { continue };
            if h.number != n { return Err(corrupt(&path, "its number is not its name's")); }
            let status = match (h.status, h.published_at) {
                (StatusWord::Draft, _) => StudyVolumeStatus::Draft,
                (StatusWord::Published, Some(published_at)) => StudyVolumeStatus::Published { published_at },
                (StatusWord::Published, None) => return Err(corrupt(&path, "published without publishedAt")),
            };
            volumes.push(StudyVolumeSummary { number: n, title: h.title, status, created_at: h.created_at });
        }
        Ok(StudyRoomSummary { id: room.id, name: room.name, created_at: room.created_at, links: room.links, volumes })
    }

    fn emit_study_changed(&self, room_id: Option<StudyRoomId>) {
        let mut inner = lock(&self.inner);
        self.emit(&mut inner, EventKind::StudyChanged { room_id });
    }

    /// Every study room (a folder with a `room.json`), oldest first.
    pub fn study_index(&self) -> Result<StudyIndex, CoreError> {
        let _study = lock(&self.study_lock);
        let dir = self.study_path(&["rooms"])?;
        let ids: Vec<String> = match std::fs::read_dir(&dir) {
            Ok(rd) => rd.flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| valid_study_room_id(n))
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let mut rooms = Vec::new();
        for id in ids {
            match self.study_room_file(&id) {
                Ok(room) => rooms.push(self.study_summary(room)?),
                // A folder whose room.json was never written (a create cut short) is no room.
                Err(CoreError::StudyRoomNotFound) => {}
                Err(e) => return Err(e),
            }
        }
        rooms.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
        Ok(StudyIndex { rooms })
    }

    /// A new room with an empty draft volume 1. Volume 1 is written before `room.json`, so a
    /// create cut short leaves no room behind, only a folder the index skips.
    pub fn create_study_room(&self, name: &str) -> Result<StudyRoomSummary, CoreError> {
        let name = study_room_name(name)?;
        let _study = lock(&self.study_lock);
        let rooms = self.study_path(&["rooms"])?;
        std::fs::create_dir_all(&rooms)?;
        let id = loop {
            let id = nanoid::nanoid!(10, &ROOM_ID_ALPHABET);
            match std::fs::create_dir(rooms.join(&id)) {
                Ok(()) => break id,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        };
        let created_at = now();
        let first = StudyVolume { number: 1, title: String::new(), status: StudyVolumeStatus::Draft, created_at: created_at.clone(), cards: vec![], edges: vec![] };
        self.write_study_volume(&id, &first)?;
        let room = RoomFile { id: id.clone(), name, created_at, links: vec![] };
        write_atomic(&self.study_path(&["rooms", &id, "room.json"])?, &encode_room(&room)?)?;
        let summary = self.study_summary(room)?;
        self.emit_study_changed(Some(id));
        Ok(summary)
    }

    /// Renames the room and replaces its links (repeats dropped). Links are not checked against
    /// what exists: a room or artifact may go away later anyway.
    pub fn update_study_room(&self, id: &str, update: UpdateStudyRoom) -> Result<StudyRoomSummary, CoreError> {
        let name = study_room_name(&update.name)?;
        let links = study_links(update.links)?;
        let _study = lock(&self.study_lock);
        let old = self.study_room_file(id)?;
        let room = RoomFile { name, links, ..old };
        write_atomic(&self.study_path(&["rooms", id, "room.json"])?, &encode_room(&room)?)?;
        let summary = self.study_summary(room)?;
        self.emit_study_changed(Some(id.to_string()));
        Ok(summary)
    }

    pub fn study_volume(&self, id: &str, number: u32) -> Result<StudyVolume, CoreError> {
        let _study = lock(&self.study_lock);
        self.study_room_file(id)?;
        self.read_study_volume(id, number)
    }

    /// Replaces a draft volume's title, cards and edges. `volume_published` for a published one.
    pub fn save_study_volume(&self, id: &str, number: u32, save: SaveStudyVolume) -> Result<StudyVolume, CoreError> {
        check_canvas("volume", &save.title, &save.cards, &save.edges)?;
        let _study = lock(&self.study_lock);
        self.study_room_file(id)?;
        let old = self.read_study_volume(id, number)?;
        if old.status != StudyVolumeStatus::Draft { return Err(CoreError::VolumePublished); }
        let v = StudyVolume { number, title: save.title, status: StudyVolumeStatus::Draft, created_at: old.created_at, cards: save.cards, edges: save.edges };
        self.write_study_volume(id, &v)?;
        self.emit_study_changed(Some(id.to_string()));
        Ok(v)
    }

    /// Publishes the draft (the highest volume) and opens the next one with its cards and edges
    /// and an empty title. The draft is marked first: a publish cut short between the two writes
    /// leaves the highest volume published, and publishing again only opens the next draft.
    pub fn publish_study_room(&self, id: &str) -> Result<StudyRoomSummary, CoreError> {
        let _study = lock(&self.study_lock);
        let room = self.study_room_file(id)?;
        let top = *self.study_volume_numbers(id)?.last().ok_or(CoreError::VolumeNotFound)?;
        let mut v = self.read_study_volume(id, top)?;
        let at = now();
        if v.status == StudyVolumeStatus::Draft {
            v.status = StudyVolumeStatus::Published { published_at: at.clone() };
            self.write_study_volume(id, &v)?;
        }
        let next = StudyVolume { number: top + 1, title: String::new(), status: StudyVolumeStatus::Draft, created_at: at, cards: v.cards, edges: v.edges };
        self.write_study_volume(id, &next)?;
        let summary = self.study_summary(room)?;
        self.emit_study_changed(Some(id.to_string()));
        Ok(summary)
    }

    /// The day as saved, or an empty one.
    pub fn study_day(&self, date: &IsoDate) -> Result<StudyDay, CoreError> {
        validate_iso_date(date)?;
        let _study = lock(&self.study_lock);
        self.read_study_day(date)
    }

    fn read_study_day(&self, date: &IsoDate) -> Result<StudyDay, CoreError> {
        let path = self.study_path(&["days", &format!("{date}.json")])?;
        match read_json::<StudyDay>(&path)? {
            Some(day) if &day.date != date => Err(corrupt(&path, "its date is not its name's")),
            Some(day) => Ok(day),
            None => Ok(StudyDay { date: date.clone(), memos: vec![], todos: vec![] }),
        }
    }

    /// What a volume ask is about: the room's name and the volume as stored.
    pub(crate) fn study_volume_context(&self, id: &str, number: u32) -> Result<(String, StudyVolume), CoreError> {
        let _study = lock(&self.study_lock);
        let room = self.study_room_file(id)?;
        Ok((room.name, self.read_study_volume(id, number)?))
    }

    /// What a Study room ask is about: its volumes and links, and the documents it links to in
    /// Rooms, each once: the linked artifacts, then each linked room's documents, newest first.
    pub(crate) fn study_room_context(&self, id: &str) -> Result<(StudyRoomListing, Vec<ContextEntry>), CoreError> {
        let summary = {
            let _study = lock(&self.study_lock);
            let room = self.study_room_file(id)?;
            self.study_summary(room)?
        };
        let (mut entries, mut rooms, mut missing) = (Vec::new(), Vec::new(), 0);
        for link in &summary.links {
            if let StudyLink::Artifact { file_key } = link {
                match self.linked_artifact(file_key) {
                    Some(e) => entries.push(e),
                    None => missing += 1,
                }
            }
        }
        for link in &summary.links {
            if let StudyLink::Room { room_id } = link {
                match self.room_context(room_id) {
                    Ok((name, docs)) => {
                        rooms.push(name);
                        entries.extend(docs);
                    }
                    // Gone from Rooms, or the Journal, which is asked by day.
                    Err(CoreError::RoomNotFound | CoreError::InvalidInput(_)) => missing += 1,
                    Err(e) => return Err(e),
                }
            }
        }
        let mut seen = HashSet::new();
        entries.retain(|e| seen.insert(e.path.clone()));
        Ok((StudyRoomListing { name: summary.name, volumes: summary.volumes, rooms, missing }, entries))
    }

    /// A linked artifact as the first of its rooms whose file still resolves lists it.
    fn linked_artifact(&self, file_key: &str) -> Option<ContextEntry> {
        let (a, path) = self.artifacts_by_file_key(file_key).into_iter().find_map(|a| self.resolve_file(&a.room_id, &a.rel_path).ok().map(|p| (a, p)))?;
        let label = if a.room_id == JOURNAL_ROOM_ID { "Journal".to_string() } else {
            lock(&self.inner).state.find(&a.room_id).map_or_else(|| a.room_id.clone(), |r| r.name.clone())
        };
        Some(ContextEntry { label, day: local_day(&a.created_at).unwrap_or_default(), title: a.title, path })
    }

    pub fn save_study_day(&self, date: &IsoDate, save: SaveStudyDay) -> Result<StudyDay, CoreError> {
        validate_iso_date(date)?;
        check_day(&save)?;
        let day = StudyDay { date: date.clone(), memos: save.memos, todos: save.todos };
        let bytes = encode(&day, MAX_DAY_BYTES)?;
        let _study = lock(&self.study_lock);
        write_atomic(&self.study_path(&["days", &format!("{date}.json")])?, &bytes)?;
        self.emit_study_changed(None);
        Ok(day)
    }

    /// Every book with a title or a card, newest first. A file not named `<YYYY-MM-DD>.json` is
    /// not a book.
    pub fn study_day_books(&self) -> Result<StudyDayBooks, CoreError> {
        let _study = lock(&self.study_lock);
        let dir = self.study_path(&["books"])?;
        let dates: Vec<String> = match std::fs::read_dir(&dir) {
            Ok(rd) => rd.flatten()
                .filter_map(|e| Some(e.file_name().to_string_lossy().strip_suffix(".json")?.to_string()))
                .filter(|d| validate_iso_date(d).is_ok())
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let mut books = Vec::new();
        for date in dates {
            let path = self.study_path(&["books", &format!("{date}.json")])?;
            let Some(head) = read_json::<BookHead>(&path)? else { continue };
            if head.date != date { return Err(corrupt(&path, "its date is not its name's")); }
            // A book with no title and no card is not on the shelf.
            if head.title.trim().is_empty() && head.cards.is_empty() { continue; }
            books.push(StudyDayBookSummary { date, title: head.title, card_count: u32::try_from(head.cards.len()).unwrap_or(u32::MAX) });
        }
        books.sort_by(|a, b| b.date.cmp(&a.date));
        Ok(StudyDayBooks { books })
    }

    /// The day's book as saved, or an empty one.
    pub fn study_day_book(&self, date: &IsoDate) -> Result<StudyDayBook, CoreError> {
        validate_iso_date(date)?;
        let _study = lock(&self.study_lock);
        self.read_study_day_book(date)
    }

    fn read_study_day_book(&self, date: &IsoDate) -> Result<StudyDayBook, CoreError> {
        let path = self.study_path(&["books", &format!("{date}.json")])?;
        match read_json::<StudyDayBook>(&path)? {
            Some(book) if &book.date != date => Err(corrupt(&path, "its date is not its name's")),
            Some(book) => Ok(book),
            None => Ok(StudyDayBook { date: date.clone(), title: String::new(), cards: vec![], edges: vec![] }),
        }
    }

    /// Replaces the day's book. Any day can be written, past ones included.
    pub fn save_study_day_book(&self, date: &IsoDate, save: SaveStudyDayBook) -> Result<StudyDayBook, CoreError> {
        validate_iso_date(date)?;
        check_canvas("book", &save.title, &save.cards, &save.edges)?;
        let book = StudyDayBook { date: date.clone(), title: save.title, cards: save.cards, edges: save.edges };
        let bytes = encode(&book, MAX_BOOK_BYTES)?;
        let _study = lock(&self.study_lock);
        write_atomic(&self.study_path(&["books", &format!("{date}.json")])?, &bytes)?;
        self.emit_study_changed(None);
        Ok(book)
    }

    /// What a day book ask is about: the day's memos and TODOs and its book, read together.
    pub(crate) fn study_day_book_context(&self, date: &IsoDate) -> Result<(StudyDay, StudyDayBook), CoreError> {
        validate_iso_date(date)?;
        let _study = lock(&self.study_lock);
        Ok((self.read_study_day(date)?, self.read_study_day_book(date)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> (tempfile::TempDir, RoomsCore) {
        let d = tempfile::tempdir().unwrap();
        let core = RoomsCore::open(d.path()).unwrap();
        (d, core)
    }

    fn study(core: &RoomsCore) -> PathBuf { core.home().join(".rooms/study") }

    fn card(id: &str, body: &str) -> StudyCard {
        StudyCard { id: id.into(), kind: StudyCardKind::Ink, x: 10.0, y: 20.0, width: 280.0, body: body.into(), height: None }
    }

    fn two_cards() -> SaveStudyVolume {
        SaveStudyVolume {
            title: "첫 판".into(),
            cards: vec![card("c1", "# 제목"), StudyCard { kind: StudyCardKind::Question, ..card("c2", "왜?") }],
            edges: vec![StudyEdge { id: "e1".into(), source: "c1".into(), target: "c2".into() }],
        }
    }

    fn study_events(rx: &mut tokio::sync::broadcast::Receiver<RoomsEvent>) -> Vec<Option<String>> {
        std::iter::from_fn(|| rx.try_recv().ok()).filter_map(|e| match e.kind {
            EventKind::StudyChanged { room_id } => Some(room_id),
            _ => None,
        }).collect()
    }

    fn code(r: Result<impl std::fmt::Debug, CoreError>) -> &'static str { r.unwrap_err().code() }

    #[test]
    fn a_new_room_is_one_draft_volume_on_disk() {
        let (_d, core) = core();
        let mut rx = core.subscribe();
        let room = core.create_study_room("  양자 컴퓨팅  ").unwrap();
        assert!(valid_study_room_id(&room.id), "{}", room.id);
        assert_eq!(room.name, "양자 컴퓨팅", "trimmed");
        assert_eq!(room.volumes.len(), 1);
        assert_eq!((room.volumes[0].number, &room.volumes[0].status, room.volumes[0].title.as_str()), (1, &StudyVolumeStatus::Draft, ""));
        assert_eq!(study_events(&mut rx), vec![Some(room.id.clone())]);

        let dir = study(&core).join("rooms").join(&room.id);
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("room.json")).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({"id": room.id, "name": "양자 컴퓨팅", "createdAt": room.created_at, "links": []}));
        let v1: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("volumes/1.json")).unwrap()).unwrap();
        assert_eq!((&v1["status"], &v1["cards"], v1.get("publishedAt")), (&serde_json::json!("draft"), &serde_json::json!([]), None));
        assert_eq!(core.study_index().unwrap().rooms, vec![room]);
        let names = |d: PathBuf| d.read_dir().unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect::<Vec<_>>();
        assert_eq!((names(dir.clone()).len(), names(dir.join("volumes"))), (2, vec!["1.json".to_string()]), "no temp files left");
    }

    #[test]
    fn a_draft_saves_and_reads_back_keeping_its_created_at() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        let mut rx = core.subscribe();
        let saved = core.save_study_volume(&room.id, 1, two_cards()).unwrap();
        assert_eq!((saved.title.as_str(), saved.created_at.as_str(), &saved.status), ("첫 판", room.volumes[0].created_at.as_str(), &StudyVolumeStatus::Draft));
        assert_eq!(core.study_volume(&room.id, 1).unwrap(), saved);
        assert_eq!(saved.cards, two_cards().cards);
        assert_eq!(study_events(&mut rx), vec![Some(room.id.clone())]);
        assert_eq!(core.study_index().unwrap().rooms[0].volumes[0].title, "첫 판");
    }

    #[test]
    fn publish_freezes_the_draft_and_opens_the_next_with_its_cards() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        core.save_study_volume(&room.id, 1, two_cards()).unwrap();
        let mut rx = core.subscribe();
        let after = core.publish_study_room(&room.id).unwrap();
        assert_eq!(study_events(&mut rx), vec![Some(room.id.clone())]);
        assert_eq!(after.volumes.iter().map(|v| v.number).collect::<Vec<_>>(), vec![1, 2]);
        let v1 = core.study_volume(&room.id, 1).unwrap();
        let StudyVolumeStatus::Published { published_at } = &v1.status else { panic!("v1 is {:?}", v1.status) };
        assert!(chrono::DateTime::parse_from_rfc3339(published_at).is_ok(), "{published_at}");
        assert_eq!(v1.title, "첫 판");
        let v2 = core.study_volume(&room.id, 2).unwrap();
        assert_eq!((v2.status, v2.title.as_str()), (StudyVolumeStatus::Draft, ""));
        assert_eq!((v2.cards, v2.edges), (v1.cards.clone(), v1.edges.clone()));

        assert_eq!(code(core.save_study_volume(&room.id, 1, two_cards())), "volume_published");
        assert_eq!(core.study_volume(&room.id, 1).unwrap(), v1, "a refused write leaves the volume as it was");

        core.save_study_volume(&room.id, 2, SaveStudyVolume { title: "둘째".into(), cards: vec![], edges: vec![] }).unwrap();
        let again = core.publish_study_room(&room.id).unwrap();
        let drafts: Vec<u32> = again.volumes.iter().filter(|v| v.status == StudyVolumeStatus::Draft).map(|v| v.number).collect();
        assert_eq!(drafts, vec![3], "exactly one draft, the highest");
        assert_eq!(core.study_volume(&room.id, 1).unwrap(), v1, "publishing again leaves earlier volumes alone");
    }

    #[test]
    fn a_publish_cut_short_converges_on_the_next_publish() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        core.save_study_volume(&room.id, 1, two_cards()).unwrap();
        // The first of publish's two writes landed, the second didn't.
        let mut v1 = core.study_volume(&room.id, 1).unwrap();
        v1.status = StudyVolumeStatus::Published { published_at: "2026-11-03T09:00:00+09:00".into() };
        core.write_study_volume(&room.id, &v1).unwrap();
        let after = core.publish_study_room(&room.id).unwrap();
        assert_eq!(after.volumes.iter().map(|v| (v.number, v.status == StudyVolumeStatus::Draft)).collect::<Vec<_>>(), vec![(1, false), (2, true)]);
        assert_eq!(core.study_volume(&room.id, 1).unwrap(), v1, "the published volume is not published again");
        assert_eq!(core.study_volume(&room.id, 2).unwrap().cards, v1.cards);
    }

    #[test]
    fn bad_ids_and_missing_rooms_and_volumes_are_refused_without_touching_disk() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        for bad in ["../../../x", "ABCDEFGHIJ", "abc", "abcdefghij/", "abcdefghijk", ".abcdefghi", ""] {
            assert_eq!(code(core.study_volume(bad, 1)), "invalid_input", "{bad:?}");
            assert_eq!(code(core.save_study_volume(bad, 1, two_cards())), "invalid_input", "{bad:?}");
            assert_eq!(code(core.publish_study_room(bad)), "invalid_input", "{bad:?}");
            assert_eq!(code(core.update_study_room(bad, UpdateStudyRoom { name: "n".into(), links: vec![] })), "invalid_input", "{bad:?}");
        }
        assert_eq!(code(core.study_volume("zzzzzzzzzz", 1)), "study_room_not_found");
        assert_eq!(code(core.publish_study_room("zzzzzzzzzz")), "study_room_not_found");
        assert!(!study(&core).join("rooms/zzzzzzzzzz").exists());
        assert_eq!(code(core.study_volume(&room.id, 2)), "volume_not_found");
        assert_eq!(code(core.study_volume(&room.id, 0)), "volume_not_found");
        assert_eq!(code(core.save_study_volume(&room.id, 2, two_cards())), "volume_not_found");
        assert!(!study(&core).join("rooms").join(&room.id).join("volumes/2.json").exists());
    }

    #[test]
    fn names_are_one_to_sixty_characters_after_trimming() {
        let (_d, core) = core();
        for bad in ["", "   ", &"가".repeat(61), "a\nb"] {
            assert_eq!(code(core.create_study_room(bad)), "invalid_input", "{bad:?}");
        }
        assert!(!study(&core).join("rooms").exists() || study(&core).join("rooms").read_dir().unwrap().next().is_none(), "a refused create leaves nothing");
        let sixty = "가".repeat(60);
        assert_eq!(core.create_study_room(&format!(" {sixty} ")).unwrap().name, sixty);
        let room = core.create_study_room("r").unwrap();
        assert_eq!(code(core.update_study_room(&room.id, UpdateStudyRoom { name: " ".into(), links: vec![] })), "invalid_input");
    }

    #[test]
    fn update_renames_and_replaces_links_dropping_repeats() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        let a = StudyLink::Room { room_id: "inbox".into() };
        let b = StudyLink::Artifact { file_key: "0123456789abcdef".into() };
        let got = core.update_study_room(&room.id, UpdateStudyRoom { name: "새 이름".into(), links: vec![a.clone(), b.clone(), a.clone()] }).unwrap();
        assert_eq!((got.name.as_str(), &got.links), ("새 이름", &vec![a.clone(), b.clone()]));
        assert_eq!((got.created_at.as_str(), got.volumes.len()), (room.created_at.as_str(), 1));
        assert_eq!(core.study_index().unwrap().rooms, vec![got]);
        for bad in [StudyLink::Room { room_id: "../x".into() }, StudyLink::Artifact { file_key: "0123".into() }, StudyLink::Artifact { file_key: "0123456789ABCDEF".into() }] {
            assert_eq!(code(core.update_study_room(&room.id, UpdateStudyRoom { name: "n".into(), links: vec![bad.clone()] })), "invalid_input", "{bad:?}");
        }
        assert_eq!(core.study_index().unwrap().rooms[0].links, vec![a, b], "refused updates change nothing");
    }

    #[test]
    fn volumes_refuse_bad_card_and_edge_ids_and_dangling_edges() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        let dup = SaveStudyVolume { cards: vec![card("c1", "a"), card("c1", "b")], ..two_cards() };
        let bad_id = SaveStudyVolume { cards: vec![card("c 1", "a")], edges: vec![], ..two_cards() };
        let dangling = SaveStudyVolume { edges: vec![StudyEdge { id: "e1".into(), source: "c1".into(), target: "gone".into() }], ..two_cards() };
        let long_title = SaveStudyVolume { title: "t".repeat(201), ..two_cards() };
        for save in [dup, bad_id, dangling, long_title] {
            assert_eq!(code(core.save_study_volume(&room.id, 1, save)), "invalid_input");
        }
        assert!(core.study_volume(&room.id, 1).unwrap().cards.is_empty());
    }

    #[test]
    fn a_section_keeps_its_height_and_a_height_must_be_finite_and_positive() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        let section = |height| StudyCard { kind: StudyCardKind::Section, width: 640.0, height, ..card("s1", "읽기") };
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let save = SaveStudyVolume { cards: vec![section(Some(bad))], edges: vec![], ..two_cards() };
            assert_eq!(code(core.save_study_volume(&room.id, 1, save)), "invalid_input", "{bad}");
        }
        let save = SaveStudyVolume { cards: vec![section(Some(420.0)), StudyCard { kind: StudyCardKind::Text, ..card("t1", "## 메모") }], edges: vec![], ..two_cards() };
        core.save_study_volume(&room.id, 1, save.clone()).unwrap();
        assert_eq!(core.study_volume(&room.id, 1).unwrap().cards, save.cards);
        let file: serde_json::Value = serde_json::from_slice(&std::fs::read(study(&core).join(format!("rooms/{}/volumes/1.json", room.id))).unwrap()).unwrap();
        assert_eq!((&file["cards"][0]["height"], file["cards"][1].get("height")), (&serde_json::json!(420.0), None), "height is written only when a card has one");
    }

    #[test]
    fn days_round_trip_and_an_unsaved_day_is_empty() {
        let (_d, core) = core();
        let date = "2026-11-03".to_string();
        assert_eq!(core.study_day(&date).unwrap(), StudyDay { date: date.clone(), memos: vec![], todos: vec![] });
        assert!(!study(&core).join("days/2026-11-03.json").exists(), "reading an empty day writes nothing");
        let mut rx = core.subscribe();
        let save = SaveStudyDay {
            memos: vec![StudyMemo { id: "m1".into(), text: "왜 판이 필요할까".into(), at: "2026-11-03T09:00:00+09:00".into() }],
            todos: vec![StudyTodo { id: "t1".into(), text: "발행".into(), done: true, at: "2026-11-03T09:01:00+09:00".into() }],
        };
        let saved = core.save_study_day(&date, save.clone()).unwrap();
        assert_eq!(study_events(&mut rx), vec![None]);
        assert_eq!(core.study_day(&date).unwrap(), saved);
        assert_eq!((saved.memos, saved.todos), (save.memos, save.todos));
        assert!(study(&core).join("days/2026-11-03.json").is_file());
        assert_eq!(core.study_day(&"2026-11-04".to_string()).unwrap().memos, vec![], "days are separate");
        for bad in ["2026-13-01", "2026-1-01", "../2026-11-03", "2026-11-03.json"] {
            assert_eq!(code(core.study_day(&bad.to_string())), "invalid_input", "{bad:?}");
            assert_eq!(code(core.save_study_day(&bad.to_string(), SaveStudyDay { memos: vec![], todos: vec![] })), "invalid_input", "{bad:?}");
        }
        let twice = SaveStudyDay { memos: vec![], todos: vec![StudyTodo { id: "t".into(), text: "a".into(), done: false, at: "x".into() }; 2] };
        assert_eq!(code(core.save_study_day(&date, twice)), "invalid_input");
    }

    #[test]
    fn volumes_over_two_mib_and_days_over_256_kib_are_too_large() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        let fits = SaveStudyVolume { title: String::new(), cards: vec![card("c1", &"x".repeat(MAX_VOLUME_BYTES - 1024))], edges: vec![] };
        core.save_study_volume(&room.id, 1, fits).unwrap();
        let big = SaveStudyVolume { title: String::new(), cards: vec![card("c1", &"x".repeat(MAX_VOLUME_BYTES))], edges: vec![] };
        assert_eq!(code(core.save_study_volume(&room.id, 1, big)), "too_large");
        assert_eq!(core.study_volume(&room.id, 1).unwrap().cards[0].body.len(), MAX_VOLUME_BYTES - 1024, "the refused save wrote nothing");

        let date = "2026-11-03".to_string();
        let memo = |n: usize| SaveStudyDay { memos: vec![StudyMemo { id: "m".into(), text: "x".repeat(n), at: "t".into() }], todos: vec![] };
        core.save_study_day(&date, memo(MAX_DAY_BYTES - 1024)).unwrap();
        assert_eq!(code(core.save_study_day(&date, memo(MAX_DAY_BYTES))), "too_large");
        assert_eq!(core.study_day(&date).unwrap().memos[0].text.len(), MAX_DAY_BYTES - 1024);
    }

    fn book(title: &str, cards: Vec<StudyCard>) -> SaveStudyDayBook { SaveStudyDayBook { title: title.into(), cards, edges: vec![] } }

    #[test]
    fn day_books_round_trip_and_only_written_ones_are_listed_newest_first() {
        let (_d, core) = core();
        let date = "2026-11-03".to_string();
        assert_eq!(core.study_day_book(&date).unwrap(), StudyDayBook { date: date.clone(), title: String::new(), cards: vec![], edges: vec![] });
        assert!(!study(&core).join("books").exists(), "reading an empty book writes nothing");
        assert_eq!(core.study_day_books().unwrap().books, vec![]);

        let mut rx = core.subscribe();
        let two = two_cards();
        let saved = core.save_study_day_book(&date, SaveStudyDayBook { title: "정리".into(), cards: two.cards.clone(), edges: two.edges.clone() }).unwrap();
        assert_eq!(study_events(&mut rx), vec![None]);
        assert_eq!((saved.title.as_str(), &saved.cards, &saved.edges), ("정리", &two.cards, &two.edges));
        assert_eq!(core.study_day_book(&date).unwrap(), saved);
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(study(&core).join("books/2026-11-03.json")).unwrap()).unwrap();
        assert_eq!(json, serde_json::to_value(&saved).unwrap(), "the file is the book: date, title, cards, edges");

        core.save_study_day_book(&"2026-10-31".to_string(), book("", vec![card("c1", "a")])).unwrap();
        core.save_study_day_book(&"2026-11-01".to_string(), book("only a title", vec![])).unwrap();
        core.save_study_day_book(&"2026-11-02".to_string(), book("  ", vec![])).unwrap();
        std::fs::write(study(&core).join("books/notes.json"), "{}").unwrap();
        let listed: Vec<(String, String, u32)> = core.study_day_books().unwrap().books.into_iter().map(|b| (b.date, b.title, b.card_count)).collect();
        assert_eq!(listed, vec![
            ("2026-11-03".to_string(), "정리".to_string(), 2),
            ("2026-11-01".to_string(), "only a title".to_string(), 0),
            ("2026-10-31".to_string(), String::new(), 1),
        ], "an empty book and a file not named by a date are not listed");

        let emptied = core.save_study_day_book(&date, book("", vec![])).unwrap();
        assert_eq!(core.study_day_book(&date).unwrap(), emptied, "a past or present day can always be written again");
        assert_eq!(core.study_day_books().unwrap().books.len(), 2);
    }

    #[test]
    fn day_books_refuse_bad_dates_and_canvases_and_files_over_two_mib() {
        let (_d, core) = core();
        for bad in ["2026-13-01", "2026-1-01", "../2026-11-03", "2026-11-03.json", ""] {
            assert_eq!(code(core.study_day_book(&bad.to_string())), "invalid_input", "{bad:?}");
            assert_eq!(code(core.save_study_day_book(&bad.to_string(), book("t", vec![]))), "invalid_input", "{bad:?}");
        }
        let date = "2026-11-03".to_string();
        let dangling = SaveStudyDayBook { edges: vec![StudyEdge { id: "e1".into(), source: "c1".into(), target: "gone".into() }], ..book("", vec![card("c1", "a")]) };
        for save in [book(&"t".repeat(201), vec![]), book("", vec![card("c1", "a"), card("c1", "b")]), dangling] {
            assert_eq!(code(core.save_study_day_book(&date, save)), "invalid_input");
        }
        core.save_study_day_book(&date, book("", vec![card("c1", &"x".repeat(MAX_BOOK_BYTES - 1024))])).unwrap();
        assert_eq!(code(core.save_study_day_book(&date, book("", vec![card("c1", &"x".repeat(MAX_BOOK_BYTES))]))), "too_large");
        assert_eq!(core.study_day_book(&date).unwrap().cards[0].body.len(), MAX_BOOK_BYTES - 1024, "the refused save wrote nothing");
        assert!(!study(&core).join("books").read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with('.')), "no temp files left");

        std::fs::write(study(&core).join("books/2026-11-04.json"), r#"{"date":"2026-11-05","title":"x","cards":[],"edges":[]}"#).unwrap();
        assert_eq!(code(core.study_day_book(&"2026-11-04".to_string())), "internal", "a book filed under another date");
        assert_eq!(code(core.study_day_books()), "internal");
    }

    #[test]
    fn symlinks_under_the_study_root_are_refused() {
        let (_d, core) = core();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(study(&core)).unwrap();
        std::os::unix::fs::symlink(outside.path(), study(&core).join("days")).unwrap();
        let date = "2026-11-03".to_string();
        assert_eq!(code(core.save_study_day(&date, SaveStudyDay { memos: vec![], todos: vec![] })), "invalid_path");
        assert_eq!(code(core.study_day(&date)), "invalid_path");
        std::os::unix::fs::symlink(outside.path(), study(&core).join("books")).unwrap();
        assert_eq!(code(core.save_study_day_book(&date, book("t", vec![]))), "invalid_path");
        assert_eq!(code(core.study_day_books()), "invalid_path");
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none(), "nothing written through the link");

        let room = core.create_study_room("r").unwrap();
        let vols = study(&core).join("rooms").join(&room.id).join("volumes");
        std::fs::rename(&vols, outside.path().join("v")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("v"), &vols).unwrap();
        assert_eq!(code(core.save_study_volume(&room.id, 1, two_cards())), "invalid_path");
    }

    #[test]
    fn corrupt_files_are_errors_not_panics_and_half_made_rooms_are_skipped() {
        let (_d, core) = core();
        let room = core.create_study_room("r").unwrap();
        let dir = study(&core).join("rooms").join(&room.id);
        std::fs::create_dir_all(study(&core).join("rooms/aaaaaaaaaa/volumes")).unwrap();
        assert_eq!(core.study_index().unwrap().rooms.len(), 1, "a folder without room.json is no room");

        std::fs::write(dir.join("volumes/1.json"), "{").unwrap();
        assert_eq!(code(core.study_volume(&room.id, 1)), "internal");
        assert_eq!(code(core.save_study_volume(&room.id, 1, two_cards())), "internal");
        assert_eq!(code(core.study_index()), "internal");
        std::fs::write(dir.join("volumes/1.json"), r#"{"number":1,"title":"","status":"published","createdAt":"t","cards":[],"edges":[]}"#).unwrap();
        assert_eq!(code(core.study_index()), "internal", "published without publishedAt");
        std::fs::write(dir.join("room.json"), "[]").unwrap();
        assert_eq!(code(core.study_volume(&room.id, 1)), "internal");
        std::fs::create_dir_all(study(&core).join("days")).unwrap();
        std::fs::write(study(&core).join("days/2026-11-03.json"), "nope").unwrap();
        assert_eq!(code(core.study_day(&"2026-11-03".to_string())), "internal");
        std::fs::write(study(&core).join("days/2026-11-03.json"), r#"{"date":"2026-11-04","memos":[],"todos":[]}"#).unwrap();
        assert_eq!(code(core.study_day(&"2026-11-03".to_string())), "internal", "a day filed under another date");
    }
}
