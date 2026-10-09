//! Onboarding files written into Home (Plan 3). Inert, static text: Rooms core never runs them.
//!
//! Each embedded file carries a version marker (`rooms-onboarding vN`) on its marker line: the
//! first line after an optional `#!` shebang and an optional leading `---` YAML frontmatter block.
//! A file on disk is (re)written only when it is missing or its marker line has a lower version.
//! A file whose marker line is not a marker (the user edited it) is never overwritten.

use std::fs::{DirBuilder, OpenOptions, Permissions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub const ONBOARD_MD: &str = include_str!("../assets/onboarding/ONBOARD.md");
pub const SKILL_MD: &str = include_str!("../assets/onboarding/skill/rooms/SKILL.md");
pub const FIND_HTML_PY: &str = include_str!("../assets/onboarding/skill/rooms/scripts/find_html.py");

const SKILL_DIR: &str = ".rooms/onboarding/skill/rooms";

/// The version on a text's marker line, or `None` when that line is not a marker.
fn marker_version(text: &str) -> Option<u32> {
    let mut lines = text.lines().peekable();
    if lines.peek().is_some_and(|l| l.starts_with("#!")) { lines.next(); }
    if lines.peek() == Some(&"---") {
        lines.next();
        for l in lines.by_ref() { if l == "---" { break; } }
    }
    let line = lines.next()?.trim();
    let inner = line.strip_prefix("<!--").and_then(|s| s.strip_suffix("-->"))
        .or_else(|| line.strip_prefix('#'))?
        .trim();
    inner.strip_prefix("rooms-onboarding v")?.parse().ok()
}

/// Writes the onboarding files into `home` (see module docs). Every file is attempted; the
/// first error is returned.
pub fn ensure(home: &Path) -> std::io::Result<()> {
    let mut first_err = None;
    let mut note = |r: std::io::Result<()>| if let Err(e) = r { first_err.get_or_insert(e); };

    note(write_if_stale(&home.join("ONBOARD.md"), ONBOARD_MD, 0o644));

    let dirs = (|| {
        let dot = home.join(".rooms");
        if !dot.exists() { DirBuilder::new().mode(0o700).create(&dot)?; }
        let mut d = dot;
        for part in ["onboarding", "skill", "rooms", "scripts"] {
            d = d.join(part);
            match DirBuilder::new().mode(0o755).create(&d) {
                Ok(()) => std::fs::set_permissions(&d, Permissions::from_mode(0o755))?,
                Err(e) if e.kind() == ErrorKind::AlreadyExists && d.is_dir() => {}
                Err(e) => return Err(e),
            }
        }
        // the leaf is ours alone; make sure it is 0755 even if an older run left another mode
        std::fs::set_permissions(&d, Permissions::from_mode(0o755))
    })();
    match dirs {
        Ok(()) => {
            let skill = home.join(SKILL_DIR);
            note(write_if_stale(&skill.join("SKILL.md"), SKILL_MD, 0o644));
            note(write_if_stale(&skill.join("scripts/find_html.py"), FIND_HTML_PY, 0o755));
        }
        Err(e) => note(Err(e)),
    }
    match first_err { Some(e) => Err(e), None => Ok(()) }
}

/// Writes `body` to `path` when the file is missing or carries an older marker. Leaves alone a
/// file with the same/newer marker, a file without a marker, and anything that is not a regular
/// file (a symlink or directory the user put there).
fn write_if_stale(path: &Path, body: &str, mode: u32) -> std::io::Result<()> {
    let ours = marker_version(body).expect("embedded onboarding file has a marker");
    match std::fs::symlink_metadata(path) {
        Ok(m) if !m.file_type().is_file() => return Ok(()),
        Ok(_) => match marker_version(&std::fs::read_to_string(path)?) {
            Some(v) if v < ours => {}
            _ => return Ok(()),
        },
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let dir = path.parent().expect("onboarding path has a parent");
    let name = path.file_name().expect("onboarding path has a file name").to_string_lossy();
    let tmp = dir.join(format!(".{name}.tmp-{}", std::process::id()));
    let res = (|| {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        std::fs::set_permissions(&tmp, Permissions::from_mode(mode))?; // umask-proof
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() { let _ = std::fs::remove_file(&tmp); }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const ONBOARD: &str = "ONBOARD.md";
    const SKILL: &str = ".rooms/onboarding/skill/rooms/SKILL.md";
    const SCRIPT: &str = ".rooms/onboarding/skill/rooms/scripts/find_html.py";

    fn mode(p: &Path) -> u32 { std::fs::metadata(p).unwrap().permissions().mode() & 0o777 }

    #[test]
    fn missing_files_are_written_with_modes() {
        let d = tempfile::tempdir().unwrap();
        ensure(d.path()).unwrap();
        let onboard = std::fs::read_to_string(d.path().join(ONBOARD)).unwrap();
        assert!(onboard.starts_with("<!-- rooms-onboarding v8 -->\n"));
        let skill = std::fs::read_to_string(d.path().join(SKILL)).unwrap();
        assert!(skill.starts_with("---\nname: rooms\n"));
        assert!(skill.contains("\n<!-- rooms-onboarding v8 -->\n"));
        let script = std::fs::read_to_string(d.path().join(SCRIPT)).unwrap();
        assert!(script.starts_with("#!/usr/bin/env python3\n# rooms-onboarding v8\n"));
        assert_eq!(mode(&d.path().join(ONBOARD)), 0o644);
        assert_eq!(mode(&d.path().join(SKILL)), 0o644);
        assert_eq!(mode(&d.path().join(SCRIPT)), 0o755);
        assert_eq!(mode(&d.path().join(".rooms/onboarding/skill/rooms/scripts")), 0o755);
        // Only these three are shipped (no tests, no dry-run helpers)
        let names: Vec<_> = std::fs::read_dir(d.path().join(".rooms/onboarding/skill/rooms/scripts")).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["find_html.py".to_string()]);
        // no temp files left behind
        let top: Vec<_> = std::fs::read_dir(d.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert!(top.iter().all(|n| !n.contains(".tmp")), "{top:?}");
    }

    #[test]
    fn older_marker_is_upgraded() {
        let d = tempfile::tempdir().unwrap();
        ensure(d.path()).unwrap();
        std::fs::write(d.path().join(ONBOARD), "<!-- rooms-onboarding v0 -->\nold\n").unwrap();
        std::fs::write(d.path().join(SKILL), "---\nname: rooms\ndescription: x\n---\n<!-- rooms-onboarding v0 -->\nold\n").unwrap();
        std::fs::write(d.path().join(SCRIPT), "#!/usr/bin/env python3\n# rooms-onboarding v0\nold\n").unwrap();
        ensure(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join(ONBOARD)).unwrap(), ONBOARD_MD);
        assert_eq!(std::fs::read_to_string(d.path().join(SKILL)).unwrap(), SKILL_MD);
        assert_eq!(std::fs::read_to_string(d.path().join(SCRIPT)).unwrap(), FIND_HTML_PY);
    }

    /// Writes all three files at marker `v` with stale bodies, runs `ensure`, and checks each is
    /// now the embedded v8 file.
    fn assert_upgrades_from(v: u32) {
        let d = tempfile::tempdir().unwrap();
        ensure(d.path()).unwrap();
        std::fs::write(d.path().join(ONBOARD), format!("<!-- rooms-onboarding v{v} -->\n# old onboarding\n")).unwrap();
        std::fs::write(d.path().join(SKILL), format!("---\nname: rooms\ndescription: x\n---\n<!-- rooms-onboarding v{v} -->\nold\n")).unwrap();
        std::fs::write(d.path().join(SCRIPT), format!("#!/usr/bin/env python3\n# rooms-onboarding v{v}\nold\n")).unwrap();
        ensure(d.path()).unwrap();
        for (rel, body) in [(ONBOARD, ONBOARD_MD), (SKILL, SKILL_MD), (SCRIPT, FIND_HTML_PY)] {
            let now = std::fs::read_to_string(d.path().join(rel)).unwrap();
            assert_eq!(now, body, "{rel}");
            assert_eq!(marker_version(&now), Some(8), "{rel}");
        }
    }

    #[test]
    fn v1_files_are_upgraded_to_v8() { assert_upgrades_from(1); }

    #[test]
    fn v2_files_are_upgraded_to_v8() { assert_upgrades_from(2); }

    #[test]
    fn v3_files_are_upgraded_to_v8() { assert_upgrades_from(3); }

    #[test]
    fn v4_files_are_upgraded_to_v8() { assert_upgrades_from(4); }

    #[test]
    fn v5_files_are_upgraded_to_v8() { assert_upgrades_from(5); }

    #[test]
    fn v6_files_are_upgraded_to_v8() { assert_upgrades_from(6); }

    #[test]
    fn v7_files_are_upgraded_to_v8() { assert_upgrades_from(7); }

    #[test]
    fn embedded_skill_teaches_journal_writes() {
        assert!(SKILL_MD.contains("## Writing to the Journal"));
        assert!(SKILL_MD.contains("\"<home>/journal/<YYYY-MM-DD>/<name>.html\""));
        assert!(SKILL_MD.contains("`dream.html`"));
    }

    #[test]
    fn same_or_newer_marker_is_left_alone() {
        let d = tempfile::tempdir().unwrap();
        ensure(d.path()).unwrap();
        let same = "<!-- rooms-onboarding v8 -->\nlocally tweaked\n";
        std::fs::write(d.path().join(ONBOARD), same).unwrap();
        let newer = "#!/usr/bin/env python3\n# rooms-onboarding v9\nnewer\n";
        std::fs::write(d.path().join(SCRIPT), newer).unwrap();
        ensure(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join(ONBOARD)).unwrap(), same);
        assert_eq!(std::fs::read_to_string(d.path().join(SCRIPT)).unwrap(), newer);
    }

    #[test]
    fn file_without_marker_is_untouched() {
        let d = tempfile::tempdir().unwrap();
        ensure(d.path()).unwrap();
        let mine = "# 내가 고친 온보딩\n<!-- rooms-onboarding v0 -->\n";
        std::fs::write(d.path().join(ONBOARD), mine).unwrap();
        let skill = "---\nname: rooms\n---\nmy own skill\n";
        std::fs::write(d.path().join(SKILL), skill).unwrap();
        let script = "#!/usr/bin/env python3\nprint('mine')\n";
        std::fs::write(d.path().join(SCRIPT), script).unwrap();
        ensure(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join(ONBOARD)).unwrap(), mine);
        assert_eq!(std::fs::read_to_string(d.path().join(SKILL)).unwrap(), skill);
        assert_eq!(std::fs::read_to_string(d.path().join(SCRIPT)).unwrap(), script);
    }

    #[test]
    fn upgrade_resets_mode() {
        let d = tempfile::tempdir().unwrap();
        ensure(d.path()).unwrap();
        let p = d.path().join(SCRIPT);
        std::fs::write(&p, "#!/usr/bin/env python3\n# rooms-onboarding v0\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        ensure(d.path()).unwrap();
        assert_eq!(mode(&p), 0o755);
    }

    #[test]
    fn marker_version_parsing() {
        assert_eq!(marker_version("<!-- rooms-onboarding v3 -->\nx"), Some(3));
        assert_eq!(marker_version("#!/usr/bin/env python3\n# rooms-onboarding v12\n"), Some(12));
        assert_eq!(marker_version("---\nname: a\n---\n<!-- rooms-onboarding v2 -->\n"), Some(2));
        assert_eq!(marker_version("hello\n<!-- rooms-onboarding v2 -->\n"), None);
        assert_eq!(marker_version("<!-- rooms-onboarding vx -->"), None);
        assert_eq!(marker_version(""), None);
        assert_eq!(marker_version(ONBOARD_MD), Some(8));
        assert_eq!(marker_version(SKILL_MD), Some(8));
        assert_eq!(marker_version(FIND_HTML_PY), Some(8));
    }

    #[test]
    fn errors_are_returned_not_panicked() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        std::fs::write(d.path().join(".rooms/onboarding"), "not a dir").unwrap();
        assert!(ensure(d.path()).is_err());
        // ONBOARD.md is still written (it does not need .rooms/onboarding)
        assert!(d.path().join(ONBOARD).is_file());
    }

    #[test]
    fn open_survives_failed_onboarding_and_does_not_adopt_onboard_md() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".rooms")).unwrap();
        std::fs::write(d.path().join(".rooms/onboarding"), "not a dir").unwrap();
        let core = crate::RoomsCore::open(d.path()).expect("open must not fail on onboarding errors");
        drop(core);

        let d = tempfile::tempdir().unwrap();
        let core = crate::RoomsCore::open(d.path()).unwrap();
        assert!(d.path().join(ONBOARD).is_file());
        assert!(d.path().join(SKILL).is_file());
        let names: Vec<String> = core.list_rooms().into_iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["inbox".to_string()]);
        assert_eq!(core.current_seq(), 0);
    }
}
