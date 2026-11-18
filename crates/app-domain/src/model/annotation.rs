//! User annotation entity (Highlight, Underline, Comment) and validation rules.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::DomainError;
use crate::value_objects::document_id::DocumentId;
use crate::value_objects::page_index::PageIndex;

/// Maximum length in characters for annotation quote or comment text.
pub const MAX_ANNOTATION_TEXT_LEN: usize = 4000;

/// Unique identifier for a user-created annotation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct AnnotationId(String);

impl AnnotationId {
    /// Validates and constructs a non-empty `AnnotationId`, trimming surrounding whitespace.
    pub fn new(id: impl Into<String>) -> Result<Self, DomainError> {
        let trimmed = id.into().trim().to_owned();
        if trimmed.is_empty() {
            return Err(DomainError::EmptyAnnotationId);
        }
        Ok(Self(trimmed))
    }

    /// Validates and constructs a non-empty `AnnotationId`.
    pub fn try_new(raw: impl Into<String>) -> Result<Self, DomainError> {
        Self::new(raw)
    }

    /// Generates a new random annotation ID.
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

impl TryFrom<String> for AnnotationId {
    type Error = DomainError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_new(value)
    }
}

/// Supported Phase 4 annotation primitives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationKind {
    /// Colored highlight swatch (`#f3d96b`, `#f0a88f`, `#a9d5b2`, `#9bc8e0`, `#c9afe2`).
    Highlight,
    /// Underline style (`Underline instead` toggle in Highlight Options).
    Underline,
    /// Page or selection comment note.
    Comment,
}

impl AnnotationKind {
    /// Converts the annotation kind to its canonical storage string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Highlight => "highlight",
            Self::Underline => "underline",
            Self::Comment => "comment",
        }
    }

    /// Parses an annotation kind from its storage string.
    pub fn from_storage(s: &str) -> Result<Self, DomainError> {
        match s {
            "highlight" => Ok(Self::Highlight),
            "underline" => Ok(Self::Underline),
            "comment" => Ok(Self::Comment),
            other => Err(DomainError::InvalidAnnotation {
                reason: format!("unknown annotation kind '{other}' in storage"),
            }),
        }
    }
}

/// A persistent user annotation associated with a document and page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Annotation {
    /// Unique annotation identifier.
    pub id: AnnotationId,
    /// Document this annotation belongs to.
    pub document_id: DocumentId,
    /// Zero-based page index.
    pub page_index: PageIndex,
    /// Annotation primitive kind (`Highlight`, `Underline`, `Comment`).
    pub kind: AnnotationKind,
    /// Hex color swatch (e.g. `#f3d96b`).
    pub color_hex: String,
    /// Highlighted or quoted excerpt from the page.
    pub quote_text: String,
    /// User comment or note attached to the annotation.
    pub note_text: String,
    /// Creation/update timestamp in Unix milliseconds.
    pub created_at_unix_ms: i64,
}

impl Annotation {
    /// Validates and constructs an [`Annotation`].
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: AnnotationId,
        document_id: DocumentId,
        page_index: PageIndex,
        kind: AnnotationKind,
        color_hex: impl Into<String>,
        quote_text: impl Into<String>,
        note_text: impl Into<String>,
        created_at_unix_ms: i64,
    ) -> Result<Self, DomainError> {
        if id.as_str().trim().is_empty() {
            return Err(DomainError::EmptyAnnotationId);
        }
        let color_trimmed = color_hex.into().trim().to_lowercase();
        let valid_color = color_trimmed.len() == 7
            && color_trimmed.starts_with('#')
            && color_trimmed[1..].chars().all(|c| c.is_ascii_hexdigit());
        if !valid_color {
            return Err(DomainError::InvalidAnnotation {
                reason: format!("color_hex must be a #RRGGBB hex string, got '{color_trimmed}'"),
            });
        }

        let clean_quote: String = quote_text
            .into()
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .collect::<String>()
            .trim()
            .to_owned();
        let clean_note: String = note_text
            .into()
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .collect::<String>()
            .trim()
            .to_owned();

        if clean_quote.is_empty() && clean_note.is_empty() {
            return Err(DomainError::InvalidAnnotation {
                reason: "annotation must contain quote_text or note_text".to_owned(),
            });
        }

        if clean_quote.chars().count() > MAX_ANNOTATION_TEXT_LEN
            || clean_note.chars().count() > MAX_ANNOTATION_TEXT_LEN
        {
            return Err(DomainError::InvalidAnnotation {
                reason: format!("annotation text exceeds {MAX_ANNOTATION_TEXT_LEN} characters"),
            });
        }

        Ok(Self {
            id,
            document_id,
            page_index,
            kind,
            color_hex: color_trimmed,
            quote_text: clean_quote,
            note_text: clean_note,
            created_at_unix_ms,
        })
    }
}
