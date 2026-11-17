//! Platform and filesystem abstraction port.

use std::path::Path;

use app_domain::DocumentId;

use crate::error::ApplicationError;

/// Validated metadata about a local PDF file path without exposing OS internals to domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFileInfo {
    /// Deterministic document identifier derived from the canonical file path.
    pub document_id: DocumentId,
    /// Canonicalized local path string.
    pub canonical_path: String,
    /// Sanitized file name for UI display.
    pub display_name: String,
    /// File size in bytes.
    pub file_size_bytes: u64,
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

    /// Removes an empty directory at `path` if it exists and is empty (non-recursive).
    fn remove_empty_dir_if_exists(&self, _path: &str) -> Result<bool, ApplicationError> {
        Ok(false)
    }

    /// Returns `true` if `candidate_path` resolves strictly inside `parent_dir`,
    /// rejecting any `..` or `.` path traversal components.
    fn is_path_within_dir(&self, candidate_path: &str, parent_dir: &Path) -> bool {
        use std::path::Component;
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
