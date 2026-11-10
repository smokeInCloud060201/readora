//! User bookmark entity and validation rules.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::DomainError;
use crate::value_objects::document_id::DocumentId;
use crate::value_objects::page_index::PageIndex;

/// Maximum length in characters for a bookmark label.
pub const MAX_BOOKMARK_LABEL_LEN: usize = 200;

/// Unique identifier for a user-created bookmark.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BookmarkId(String);

impl BookmarkId {
    /// Wraps an existing bookmark ID string.
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Generates a new random bookmark ID.
    #[must_use]
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// Returns the string slice representation.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A persistent user bookmark associated with a specific document and page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    /// Unique bookmark identifier.
    pub id: BookmarkId,
    /// Document this bookmark belongs to.
    pub document_id: DocumentId,
    /// Zero-based page index.
    pub page_index: PageIndex,
    /// User-facing bookmark label.
    pub label: String,
    /// Creation/update timestamp in Unix milliseconds.
    pub created_at_unix_ms: i64,
}

impl Bookmark {
    /// Validates and creates a `Bookmark`.
    pub fn new(
        id: BookmarkId,
        document_id: DocumentId,
        page_index: PageIndex,
        label: impl Into<String>,
        created_at_unix_ms: i64,
    ) -> Result<Self, DomainError> {
        let trimmed: String = label
            .into()
            .chars()
            .filter(|c| !c.is_control())
            .collect::<String>()
            .trim()
            .to_owned();
        let char_count = trimmed.chars().count();
        if char_count == 0 || char_count > MAX_BOOKMARK_LABEL_LEN {
            return Err(DomainError::InvalidBookmarkLabel {
                max_len: MAX_BOOKMARK_LABEL_LEN,
            });
        }
        Ok(Self {
            id,
            document_id,
            page_index,
            label: trimmed,
            created_at_unix_ms,
        })
    }
}
