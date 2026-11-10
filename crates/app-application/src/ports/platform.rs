//! Platform and filesystem abstraction port.

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
}
