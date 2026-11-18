//! Platform and filesystem abstraction port.

use std::fmt;
use std::path::Path;

use app_domain::{DocumentId, has_unsafe_os_path_or_ads};

use crate::error::ApplicationError;

/// Validated metadata about a local PDF file path without exposing OS internals to domain.
#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedFileInfo {
    /// Deterministic document identifier derived from the canonical file path.
    pub document_id: DocumentId,
    /// Canonicalized local path string (redacted in `Debug` output).
    pub canonical_path: String,
    /// Sanitized file name for UI display (redacted in `Debug` output).
    pub display_name: String,
    /// File size in bytes.
    pub file_size_bytes: u64,
}

impl fmt::Debug for ResolvedFileInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResolvedFileInfo")
            .field("document_id", &self.document_id)
            .field("canonical_path", &"<redacted>")
            .field("display_name", &"<redacted>")
            .field("file_size_bytes", &self.file_size_bytes)
            .finish()
    }
}

/// Port for OS-level file validation, clock access, and atomic writes.
pub trait PlatformPort: Send + Sync {
    /// Validates that `raw_path` exists, is a regular file within `max_size_bytes`,
    /// and returns a deterministic `DocumentId` and sanitized display name.
    fn resolve_and_validate_pdf_path(
        &self,
        raw_path: &str,
        max_size_bytes: u64,
    ) -> Result<ResolvedFileInfo, ApplicationError>;

    /// Returns the current wall-clock time in Unix milliseconds.
    fn current_unix_ms(&self) -> i64;

    /// Atomically writes `bytes` to `target_path` using a temporary sibling file and rename.
    fn atomic_write_file(&self, target_path: &str, bytes: &[u8]) -> Result<(), ApplicationError>;

    /// Removes a regular file at `path` if it exists, returning `Ok(true)` if removed or
    /// `Ok(false)` if not found.
    fn remove_file_if_exists(&self, path: &str) -> Result<bool, ApplicationError>;

    /// Reads up to `max_size_bytes` from a local file at `path`.
    fn read_file_bytes(&self, path: &str, max_size_bytes: u64)
    -> Result<Vec<u8>, ApplicationError>;

    /// Reads raw PDF bytes only after verifying `path` is a non-symlink regular file matching
    /// `expected_doc_id` (when known) and begins with a valid `%PDF-` header.
    fn read_verified_pdf_bytes(
        &self,
        raw_path: &str,
        expected_doc_id: &DocumentId,
        max_size_bytes: u64,
    ) -> Result<Vec<u8>, ApplicationError> {
        let resolved = self.resolve_and_validate_pdf_path(raw_path, max_size_bytes)?;
        if &resolved.document_id != expected_doc_id {
            return Err(ApplicationError::Platform(
                "document identity does not match persisted path".to_owned(),
            ));
        }
        let bytes = self.read_file_bytes(&resolved.canonical_path, max_size_bytes)?;
        let header_slice = &bytes[..bytes.len().min(1024)];
        if !header_slice.windows(5).any(|w| w == b"%PDF-") {
            return Err(ApplicationError::Platform(
                "target file does not have a valid PDF header".to_owned(),
            ));
        }
        Ok(bytes)
    }

    /// Removes an empty directory at `path` if it exists and is empty (non-recursive).
    fn remove_empty_dir_if_exists(&self, _path: &str) -> Result<bool, ApplicationError> {
        Ok(false)
    }

    /// Returns `true` if `candidate_path` resolves strictly inside `parent_dir`,
    /// rejecting any `..` or `.` path traversal components or unsafe Windows UNC/ADS syntax.
    fn is_path_within_dir(&self, candidate_path: &str, parent_dir: &Path) -> bool {
        use std::path::Component;
        if has_unsafe_os_path_or_ads(candidate_path) {
            return false;
        }
        let candidate = Path::new(candidate_path);
        let has_unsafe_components = |p: &Path| {
            p.components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        };
        if has_unsafe_components(candidate)
            || has_unsafe_components(parent_dir)
            || candidate_path
                .split(['/', '\\'])
                .any(|seg| seg == ".." || seg == ".")
        {
            return false;
        }
        candidate != parent_dir && candidate.starts_with(parent_dir)
    }
}
