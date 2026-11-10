//! Native OS integration adapter implementing `PlatformPort`.
//!
//! Handles path resolution, file size validation, deterministic document ID hashing,
//! OS application data directory discovery, and atomic file writes.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use app_application::{ApplicationError, PlatformPort, ResolvedFileInfo};
use app_domain::{DocumentId, sanitize_display_name};
use sha2::{Digest, Sha256};

/// Default platform adapter for desktop operating systems (macOS, Windows, Linux).
#[derive(Debug, Clone, Default)]
pub struct NativePlatformAdapter;

impl NativePlatformAdapter {
    /// Creates a new `NativePlatformAdapter`.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Resolves the OS-appropriate application data directory for storing `readora.sqlite`.
    #[must_use]
    pub fn resolve_app_data_dir() -> PathBuf {
        if let Ok(override_dir) = std::env::var("READORA_DATA_DIR") {
            let trimmed = override_dir.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("com.readora.desktop");
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return PathBuf::from(appdata).join("Readora");
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
                let trimmed = xdg.trim();
                if !trimmed.is_empty() {
                    return PathBuf::from(trimmed).join("readora");
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("readora");
            }
        }

        std::env::temp_dir().join("readora-data")
    }
}

impl PlatformPort for NativePlatformAdapter {
    fn resolve_and_validate_pdf_path(
        &self,
        raw_path: &str,
        max_size_bytes: u64,
    ) -> Result<ResolvedFileInfo, ApplicationError> {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::Platform(
                "file path must not be empty".to_owned(),
            ));
        }

        let input_path = Path::new(trimmed);
        let canonical = fs::canonicalize(input_path).map_err(|_| {
            ApplicationError::Platform("selected file does not exist or is inaccessible".to_owned())
        })?;

        let metadata = fs::metadata(&canonical)
            .map_err(|_| ApplicationError::Platform("unable to read file metadata".to_owned()))?;

        if !metadata.is_file() {
            return Err(ApplicationError::Platform(
                "selected path is not a regular file".to_owned(),
            ));
        }

        let file_size_bytes = metadata.len();
        if file_size_bytes == 0 {
            return Err(ApplicationError::Platform("PDF file is empty".to_owned()));
        }
        if max_size_bytes > 0 && file_size_bytes > max_size_bytes {
            return Err(ApplicationError::Platform(format!(
                "file size ({file_size_bytes} bytes) exceeds maximum allowed ({max_size_bytes} bytes)"
            )));
        }

        let canonical_str = canonical.to_string_lossy().into_owned();
        let display_name = canonical
            .file_name()
            .map(|n| sanitize_display_name(&n.to_string_lossy()))
            .unwrap_or_else(|| "Document.pdf".to_owned());

        let document_id = derive_document_id(&canonical_str)?;

        Ok(ResolvedFileInfo {
            document_id,
            canonical_path: canonical_str,
            display_name,
            file_size_bytes,
        })
    }

    fn current_unix_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(0))
            .unwrap_or(0)
    }

    fn atomic_write_file(&self, target_path: &str, bytes: &[u8]) -> Result<(), ApplicationError> {
        let target = Path::new(target_path.trim());
        if target.as_os_str().is_empty() {
            return Err(ApplicationError::Platform(
                "export target path must not be empty".to_owned(),
            ));
        }
        let parent = target.parent().ok_or_else(|| {
            ApplicationError::Platform("export target path has no parent directory".to_owned())
        })?;
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| {
                ApplicationError::Platform(format!("failed to create export directory: {e}"))
            })?;
        }

        let pid = std::process::id();
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temp_name = format!(
            ".{}.tmp-{pid}-{now_nanos}",
            target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "export".to_owned())
        );
        let temp_path = parent.join(temp_name);

        let write_result = (|| -> Result<(), ApplicationError> {
            let mut file = File::create(&temp_path).map_err(|e| {
                ApplicationError::Platform(format!("failed to create temporary export file: {e}"))
            })?;
            file.write_all(bytes).map_err(|e| {
                ApplicationError::Platform(format!("failed to write export bytes: {e}"))
            })?;
            file.sync_all().map_err(|e| {
                ApplicationError::Platform(format!("failed to flush export file: {e}"))
            })?;
            fs::rename(&temp_path, target).map_err(|e| {
                ApplicationError::Platform(format!("failed to finalize atomic export write: {e}"))
            })?;
            Ok(())
        })();

        if write_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }

        write_result
    }
}

fn derive_document_id(canonical_path: &str) -> Result<DocumentId, ApplicationError> {
    let mut hasher = Sha256::new();
    hasher.update(canonical_path.as_bytes());
    let digest = hasher.finalize();
    let mut hex_id = String::with_capacity(36);
    hex_id.push_str("doc-");
    for byte in &digest[..16] {
        use std::fmt::Write as _;
        let _ = write!(&mut hex_id, "{byte:02x}");
    }
    Ok(DocumentId::new(hex_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_validates_files_and_performs_atomic_writes() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = NativePlatformAdapter::new();

        let file_path = dir.path().join("sample_doc.pdf");
        let file_str = file_path.to_string_lossy().into_owned();

        adapter
            .atomic_write_file(&file_str, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF")
            .unwrap();

        let resolved = adapter
            .resolve_and_validate_pdf_path(&file_str, 1024 * 1024)
            .unwrap();
        assert_eq!(resolved.display_name, "sample_doc.pdf");
        assert!(resolved.document_id.as_str().starts_with("doc-"));

        // Size limit exceeded
        assert!(adapter.resolve_and_validate_pdf_path(&file_str, 5).is_err());
    }
}
