//! Core document metadata, outline, and search hit entities.

use serde::{Deserialize, Serialize};

use crate::error::DomainError;
use crate::value_objects::document_id::DocumentId;
use crate::value_objects::page_index::PageIndex;

/// Interactive form support status detected for a PDF document (Phase 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FormSupportStatus {
    /// No interactive form dictionary (`/AcroForm` or `/XFA`) detected.
    #[default]
    None,
    /// Standard PDF AcroForm fields detected (supported in read-only inspection mode).
    AcroFormReadOnly,
    /// Dynamic/XML XFA form detected (explicitly unsupported for security and portability).
    UnsupportedXfa,
}

/// Digital signature presence status (Phase 5).
///
/// Per security and roadmap rules, signature field presence is never described as
/// cryptographically trusted without full certificate-chain and revocation verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SignaturePresenceStatus {
    /// No signature fields (`/FT /Sig` or `/Type /Sig`) detected in the document.
    #[default]
    NoSignatures,
    /// One or more signature fields exist, but cryptographic trust/revocation is not verified.
    SignaturePresentUnverified,
}

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
    /// Detected interactive form support status.
    #[serde(default)]
    pub form_support: FormSupportStatus,
    /// Number of interactive form fields detected.
    #[serde(default)]
    pub form_field_count: u32,
    /// Detected digital signature presence status.
    #[serde(default)]
    pub signature_status: SignaturePresenceStatus,
    /// Number of signature fields detected.
    #[serde(default)]
    pub signature_field_count: u32,
}

impl DocumentMetadata {
    /// Returns an explicit, non-misleading human-readable summary of digital signature status.
    #[must_use]
    pub fn signature_status_summary(&self) -> String {
        match self.signature_status {
            SignaturePresenceStatus::NoSignatures => {
                "No digital signature fields detected".to_owned()
            }
            SignaturePresenceStatus::SignaturePresentUnverified => format!(
                "{} signature field(s) present (cryptographic certificate trust not verified)",
                self.signature_field_count.max(1)
            ),
        }
    }

    /// Returns an explicit summary of interactive form support for this document.
    #[must_use]
    pub fn form_status_summary(&self) -> String {
        match self.form_support {
            FormSupportStatus::None => "No interactive forms".to_owned(),
            FormSupportStatus::AcroFormReadOnly => format!(
                "AcroForm detected ({} field(s), read-only display)",
                self.form_field_count.max(1)
            ),
            FormSupportStatus::UnsupportedXfa => {
                "Unsupported XFA form detected (disabled for security)".to_owned()
            }
        }
    }
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
