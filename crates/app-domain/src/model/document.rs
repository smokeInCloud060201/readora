//! Core document metadata, outline, and search hit entities.

use serde::{Deserialize, Serialize};

use crate::error::DomainError;
use crate::value_objects::document_id::DocumentId;
use crate::value_objects::page_index::PageIndex;

/// Untrusted metadata extracted from a PDF document header/info dictionary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DocumentMetadata {
    /// Optional document title.
    pub title: Option<String>,
    /// Optional document author.
    pub author: Option<String>,
    /// Optional document subject.
    pub subject: Option<String>,
    /// Optional creator application.
    pub creator: Option<String>,
    /// PDF specification version string (e.g. `"1.7"`).
    pub pdf_version: String,
    /// Whether the document is encrypted.
    pub is_encrypted: bool,
}

/// Summary descriptor for an opened PDF document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentDescriptor {
    /// Unique identifier for this document.
    pub id: DocumentId,
    /// Sanitized display filename (never a full OS path).
    pub file_name: String,
    /// Total file size in bytes.
    pub file_size_bytes: u64,
    /// Total number of pages (`>= 1`).
    pub page_count: u32,
    /// Extracted document metadata.
    pub metadata: DocumentMetadata,
}

impl DocumentDescriptor {
    /// Constructs a validated `DocumentDescriptor`.
    pub fn new(
        id: DocumentId,
        file_name: impl Into<String>,
        file_size_bytes: u64,
        page_count: u32,
        metadata: DocumentMetadata,
    ) -> Result<Self, DomainError> {
        if page_count == 0 {
            return Err(DomainError::InvalidPageCount(0));
        }
        let clean_name = sanitize_display_name(&file_name.into());
        Ok(Self {
            id,
            file_name: clean_name,
            file_size_bytes,
            page_count,
            metadata,
        })
    }
}

/// Hierarchical table-of-contents / outline node from a PDF document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineNode {
    /// Display title of the outline entry.
    pub title: String,
    /// Target page index, if the entry points to an internal page destination.
    pub page_index: Option<PageIndex>,
    /// Nested child outline entries.
    pub children: Vec<OutlineNode>,
}

/// A text search match within a document page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    /// Page where the match occurred.
    pub page_index: PageIndex,
    /// Zero-based match index on that page.
    pub match_index: u32,
    /// Short surrounding snippet for navigation display.
    pub snippet: String,
}

/// Sanitizes an arbitrary filename or title into safe single-line display text.
#[must_use]
pub fn sanitize_display_name(raw: &str) -> String {
    let filtered: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_owned();
    if filtered.is_empty() {
        "Untitled.pdf".to_owned()
    } else {
        filtered
    }
}
