//! Images attached to a question: kept under `<home>/.rooms/asks/images/`, named by content hash,
//! so the same picture is stored once. Rooms passes their paths to the agent and never reads them.
use sha2::Digest;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_IMAGES: usize = 5;

/// The image type from its first bytes; the upload's content-type is not trusted. No SVG (it is a document).
fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") { Some("png") }
    else if b.starts_with(&[0xFF, 0xD8, 0xFF]) { Some("jpg") }
    else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") { Some("gif") }
    else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" { Some("webp") }
    else { None }
}

/// `<32 hex>.<png|jpg|gif|webp>`: never a path, never flag-shaped.
pub fn valid_id(id: &str) -> bool {
    let Some((hash, ext)) = id.split_once('.') else { return false };
    hash.len() == 32 && hash.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) && matches!(ext, "png" | "jpg" | "gif" | "webp")
}

pub fn content_type(id: &str) -> &'static str {
    match id.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "image/webp",
    }
}

pub(crate) struct Images { dir: PathBuf }

impl Images {
    pub fn new(dir: PathBuf) -> Self { Self { dir } }

    pub fn dir(&self) -> &Path { &self.dir }

    /// The stored file for `id`, if `id` is well formed and the file exists.
    pub fn path(&self, id: &str) -> Option<PathBuf> {
        let p = self.dir.join(id);
        (valid_id(id) && p.is_file()).then_some(p)
    }

    /// Stores `bytes` and returns its id. Err is the message for the user.
    pub fn save(&self, bytes: &[u8]) -> Result<String, String> {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!("An image must be under {} MB", MAX_IMAGE_BYTES / (1024 * 1024)));
        }
        let ext = sniff(bytes).ok_or("Only PNG, JPEG, GIF and WebP images can be attached")?;
        let id = format!("{}.{ext}", &hex::encode(sha2::Sha256::digest(bytes))[..32]);
        let path = self.dir.join(&id);
        if path.is_file() { return Ok(id); }
        let io = |e: std::io::Error| format!("Couldn't save the image: {e}");
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir).map_err(io)?;
        // Written whole to a temp name, then renamed: a reader never sees half an image.
        let tmp = self.dir.join(format!(".{id}.{}", nanoid::nanoid!(8)));
        let mut f = std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(&tmp).map_err(io)?;
        let written = f.write_all(bytes).and_then(|_| f.sync_all()).and_then(|_| std::fs::rename(&tmp, &path));
        if let Err(e) = written { let _ = std::fs::remove_file(&tmp); return Err(io(e)); }
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest-of-png";

    #[test]
    fn saves_once_by_content_and_sniffs_the_type() {
        let d = tempfile::tempdir().unwrap();
        let im = Images::new(d.path().join("images"));
        let id = im.save(PNG).unwrap();
        assert!(valid_id(&id) && id.ends_with(".png"), "{id}");
        assert_eq!(im.save(PNG).unwrap(), id);
        assert_eq!(std::fs::read(im.path(&id).unwrap()).unwrap(), PNG);
        assert_eq!(std::fs::read_dir(im.dir()).unwrap().count(), 1);
        assert!(im.save(b"\xFF\xD8\xFFjpeg").unwrap().ends_with(".jpg"));
        assert!(im.save(b"GIF89a..").unwrap().ends_with(".gif"));
        assert!(im.save(b"RIFF\0\0\0\0WEBPVP8 ").unwrap().ends_with(".webp"));
        assert_eq!(content_type(&id), "image/png");
    }

    #[test]
    fn refuses_other_files_and_size() {
        let d = tempfile::tempdir().unwrap();
        let im = Images::new(d.path().join("images"));
        assert!(im.save(b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap_err().contains("PNG"));
        assert!(im.save(b"").is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(im.save(&big).unwrap_err().contains("10 MB"));
    }

    #[test]
    fn ids_are_never_paths() {
        assert!(valid_id("0123456789abcdef0123456789abcdef.png"));
        for bad in ["../x.png", "0123456789ABCDEF0123456789abcdef.png", "0123456789abcdef0123456789abcdef.svg", "0123456789abcdef0123456789abcdef", "-123456789abcdef0123456789abcdef.png"] {
            assert!(!valid_id(bad), "{bad}");
        }
        let d = tempfile::tempdir().unwrap();
        assert!(Images::new(d.path().to_path_buf()).path("0123456789abcdef0123456789abcdef.png").is_none());
    }
}
