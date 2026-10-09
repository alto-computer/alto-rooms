//! The Journal: a day's artifacts and notes, and the notes themselves (`journal/<date>/<name>.md`).
//!
//! Note IO runs without `Inner`, under `notes_lock` (lock order: notes_lock → Inner); `Inner` is
//! taken only to emit.

use crate::core::RoomsCore;
use crate::error::CoreError;
use crate::lock::lock;
use crate::rules::{classify_path, slug_key, validate_iso_date, validate_note_name, PathClass};
use rooms_protocol::*;
use std::collections::HashSet;
use std::path::Path;

const MAX_NOTE_BYTES: usize = 1_048_576;

impl RoomsCore {
    pub fn journal_day(&self, date: &IsoDate) -> Result<JournalDay, CoreError> {
        validate_iso_date(date)?;
        let rows = { lock(&self.inner).index.by_day(date)? };
        let mut seen = HashSet::new();
        let mut artifacts = Vec::new();
        for (a, target) in rows {
            if seen.insert(target) { artifacts.push(a); }
        }
        // Notes are listed from disk without the lock.
        let dir = self.home.join("journal").join(date);
        let mut notes = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let rel = format!("{}/{}", date, e.file_name().to_string_lossy());
                if let PathClass::Note { .. } = classify_path(Path::new(&rel), true) {
                    let (_, updated) = crate::meta::file_times(&e.path());
                    notes.push(Note { date: date.clone(), name: e.file_name().to_string_lossy().to_string(), rel_path: rel, updated_at: updated, author: Author::Me });
                }
            }
        }
        notes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(JournalDay { date: date.clone(), artifacts, notes, conversations: self.day_conversations(date) })
    }

    pub fn save_note(&self, date: &IsoDate, name: &str, body: &str) -> Result<Note, CoreError> {
        validate_iso_date(date)?;
        let name = validate_note_name(name)?;
        if body.len() > MAX_NOTE_BYTES { return Err(CoreError::InvalidInput("note too large".into())); }
        // `notes_lock` is held across the write, the rename and the emit so NoteSaved order
        // equals file order.
        let _notes = lock(&self.notes_lock);
        let dir = self.home.join("journal").join(date);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(&name);
        let tmp = dir.join(format!(".{name}.{}.tmp", nanoid::nanoid!(8)));
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &path)?;
        let (_, updated) = crate::meta::file_times(&path);
        let note = Note { date: date.clone(), name: name.clone(), rel_path: format!("{date}/{name}"), updated_at: updated, author: Author::Me };
        let mut inner = lock(&self.inner);
        self.emit(&mut inner, EventKind::NoteSaved { note: note.clone() });
        Ok(note)
    }

    /// Renames `journal/<date>/<from>` to `<to>` (both validated like `save_note`). Never
    /// overwrites: a target that exists — compared case-insensitively, since the default macOS
    /// volume is — is `NoteExists`, except the source itself (a case-only rename `a.md` → `A.md`).
    /// `notes_lock` is held across the checks, the rename and the emits.
    pub fn rename_note(&self, date: &IsoDate, from: &str, to: &str) -> Result<Note, CoreError> {
        validate_iso_date(date)?;
        let from = validate_note_name(from)?;
        let to = validate_note_name(to)?;
        let _notes = lock(&self.notes_lock);
        let dir = self.home.join("journal").join(date);
        let src = dir.join(&from);
        if !std::fs::symlink_metadata(&src).map(|m| m.is_file()).unwrap_or(false) { return Err(CoreError::NotFound); }
        let dst = dir.join(&to);
        if from != to {
            let fold = |s: &str| slug_key(s);
            let to_key = fold(&to);
            // Another entry folding to the target name (case-sensitive volumes), or the target
            // path itself resolving to something other than the source (case-insensitive ones).
            let clash = std::fs::read_dir(&dir)?.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n != from && fold(&n) == to_key
            });
            if clash || (fold(&from) != to_key && std::fs::symlink_metadata(&dst).is_ok()) { return Err(CoreError::NoteExists); }
            std::fs::rename(&src, &dst)?;
        }
        let (_, updated) = crate::meta::file_times(&dst);
        let note = Note { date: date.clone(), name: to.clone(), rel_path: format!("{date}/{to}"), updated_at: updated, author: Author::Me };
        if from != to {
            let mut inner = lock(&self.inner);
            self.emit(&mut inner, EventKind::NoteRemoved { date: date.clone(), name: from });
            self.emit(&mut inner, EventKind::NoteSaved { note: note.clone() });
        }
        Ok(note)
    }

    /// Reads `journal/<date>/<name>.md`. Holds only `notes_lock` (never `Inner`) so it cannot see a
    /// half-written file; saves are tmp + rename, so this is consistency rather than necessity.
    pub fn read_note(&self, date: &IsoDate, name: &str) -> Result<String, CoreError> {
        validate_iso_date(date)?;
        let name = validate_note_name(name)?;
        let _notes = lock(&self.notes_lock);
        let path = self.home.join("journal").join(date).join(&name);
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(CoreError::NotFound),
            Err(e) => Err(CoreError::Internal(e.to_string())),
        }
    }
}
