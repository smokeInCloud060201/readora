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
    /// Strips ASCII/Unicode control characters and bounds metadata field lengths.
    #[must_use]
    pub fn sanitized(mut self) -> Self {
        self.title = self.title.as_deref().and_then(sanitize_metadata_title);
        self.author = sanitize_optional_metadata_field(self.author, 512);
        self.subject = sanitize_optional_metadata_field(self.subject, 1024);
        self.creator = sanitize_optional_metadata_field(self.creator, 512);
        self.pdf_version = sanitize_display_name(&self.pdf_version)
            .chars()
            .take(32)
            .collect();
        self
    }

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
        mut metadata: DocumentMetadata,
    ) -> Result<Self, DomainError> {
        if page_count == 0 {
            return Err(DomainError::InvalidPageCount(0));
        }
        let clean_name = sanitize_display_name(&file_name.into());
        metadata = metadata.sanitized();
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

/// Normalized page-relative bounding box (`0.0..=1.0` from top-left origin) for a search match.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SearchBoundingBox {
    /// Left edge ratio (`0.0..=1.0`).
    pub x_ratio: f32,
    /// Top edge ratio (`0.0..=1.0`).
    pub y_ratio: f32,
    /// Width ratio (`0.0..=1.0`).
    pub width_ratio: f32,
    /// Height ratio (`0.0..=1.0`).
    pub height_ratio: f32,
}

/// A text search match within a document page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    /// Page where the match occurred.
    pub page_index: PageIndex,
    /// Zero-based match index on that page.
    pub match_index: u32,
    /// Short surrounding snippet for navigation display.
    pub snippet: String,
    /// Exact matched substring on the page, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_text: Option<String>,
    /// Primary normalized bounding box enclosing the match on the page, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounding_box: Option<SearchBoundingBox>,
    /// Individual normalized segment bounding boxes for the match on the page, when available.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bounding_boxes: Vec<SearchBoundingBox>,
}

const fn is_invisible_or_bidi_format(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

fn clean_single_line_text(raw: &str, max_chars: usize) -> String {
    let normalized: String = raw
        .chars()
        .filter(|c| !is_invisible_or_bidi_format(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// Sanitizes an optional metadata string (`author`, `subject`, `creator`), mapping control
/// characters to spaces, stripping invisible BiDi formatting characters, and bounding character count.
#[must_use]
pub fn sanitize_optional_metadata_field(raw: Option<String>, max_chars: usize) -> Option<String> {
    let cleaned = clean_single_line_text(&raw?, max_chars);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Sanitizes all titles across a hierarchical PDF outline tree without unbounded recursion or node blowup.
#[must_use]
pub fn sanitize_outline_tree(nodes: Vec<OutlineNode>) -> Vec<OutlineNode> {
    const MAX_OUTLINE_DEPTH: usize = 32;
    const MAX_OUTLINE_NODES: usize = 2_048;

    fn sanitize_recursive(
        nodes: Vec<OutlineNode>,
        depth: usize,
        remaining: &mut usize,
    ) -> Vec<OutlineNode> {
        let mut out = Vec::new();
        for mut node in nodes {
            if *remaining == 0 {
                break;
            }
            *remaining -= 1;

            let clean = clean_single_line_text(&node.title, 512);
            node.title = if clean.is_empty() {
                "Untitled Section".to_owned()
            } else {
                clean
            };
            node.children = if depth < MAX_OUTLINE_DEPTH && *remaining > 0 {
                sanitize_recursive(node.children, depth + 1, remaining)
            } else {
                Vec::new()
            };
            out.push(node);
        }
        out
    }

    let mut remaining = MAX_OUTLINE_NODES;
    sanitize_recursive(nodes, 0, &mut remaining)
}

/// Sanitizes an arbitrary filename or title into bounded, safe single-line display text.
#[must_use]
pub fn sanitize_display_name(raw: &str) -> String {
    let cleaned = clean_single_line_text(raw, 512);
    if cleaned.is_empty() {
        "Untitled.pdf".to_owned()
    } else {
        cleaned
    }
}

/// Cleans an untrusted PDF `/Info /Title` string, returning `None` when the embedded title is
/// empty, a generic converter placeholder, a URI (`file://`, `http://`, `https://`, etc.), or an
/// OS filesystem path (`H:\...`, `\\server\...`, `/Users/...`) so the UI falls back to the clean
/// PDF filename instead of displaying converter junk.
#[must_use]
pub fn sanitize_metadata_title(raw: &str) -> Option<String> {
    let cleaned = clean_single_line_text(raw, 512);
    if cleaned.is_empty() {
        return None;
    }

    let stripped = if cleaned.len() >= 17
        && cleaned
            .get(..17)
            .is_some_and(|p| p.eq_ignore_ascii_case("microsoft word - "))
    {
        cleaned[17..].trim()
    } else {
        cleaned.as_str()
    };
    if stripped.is_empty() {
        return None;
    }

    let lower = stripped.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "untitled" | "untitled document" | "document"
    ) {
        return None;
    }

    // Reject URI schemes commonly stamped by HTML-to-PDF / browser print converters
    for scheme in [
        "file:",
        "http://",
        "https://",
        "ftp://",
        "about:",
        "data:",
        "blob:",
        "mailto:",
        "javascript:",
        "chrome-extension://",
    ] {
        if lower.starts_with(scheme) {
            return None;
        }
    }

    // Reject Windows drive paths (`C:\...`, `H:/...`) and UNC paths (`\\server\...`)
    let bytes = stripped.as_bytes();
    if (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || stripped.starts_with("\\\\")
    {
        return None;
    }

    // Reject absolute Unix filesystem paths (`/Users/...`, `/home/...`, etc.)
    if let Some(after_slash) = stripped.strip_prefix('/')
        && (after_slash.contains('/')
            || lower.starts_with("/tmp")
            || lower.starts_with("/var")
            || lower.starts_with("/etc"))
    {
        return None;
    }

    // Reject path-like converter source filenames (`folder/trungbokinh.htm`, `sub\index.html`)
    if (stripped.contains('/') || stripped.contains('\\'))
        && [
            ".htm", ".html", ".xhtml", ".mht", ".mhtml", ".doc", ".docx", ".tmp",
        ]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return None;
    }

    Some(stripped.to_owned())
}

/// Returns `true` if `stem` (or the segment before the first `.` or `:`) matches a Windows
/// reserved device name (`CON`, `CONIN$`, `CONOUT$`, `PRN`, `AUX`, `NUL`,
/// `COM0`..`COM9`, `LPT0`..`LPT9`, or superscript `COM¹`/`COM²`/`COM³`/`LPT¹`/`LPT²`/`LPT³`).
#[must_use]
pub fn is_windows_reserved_device_name(stem: &str) -> bool {
    let before_stream = stem.split(':').next().unwrap_or(stem);
    let head = before_stream
        .split('.')
        .next()
        .unwrap_or(before_stream)
        .trim()
        .trim_end_matches(|c: char| c.is_whitespace());
    let upper = head.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON"
            | "CONIN$"
            | "CONOUT$"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM0"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM\u{00B9}"
            | "COM\u{00B2}"
            | "COM\u{00B3}"
            | "LPT0"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT\u{00B9}"
            | "LPT\u{00B2}"
            | "LPT\u{00B3}"
    )
}

/// Returns `true` if `raw_path` uses Windows UNC/DOS device prefixes (`\\server\...`, `\\.\...`,
/// `\\?\...`), contains NTFS alternate data stream colons (`file.pdf:stream`), NUL bytes, or
/// includes any Windows reserved DOS device segment.
#[must_use]
pub fn has_unsafe_os_path_or_ads(raw_path: &str) -> bool {
    let trimmed = raw_path.trim();
    if trimmed.is_empty()
        || trimmed.contains('\0')
        || trimmed.starts_with(r"\\")
        || trimmed.starts_with("//")
    {
        return true;
    }

    let bytes = trimmed.as_bytes();
    let has_leading_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';

    let mut is_first_segment = true;
    for seg in trimmed.split(['/', '\\']) {
        if seg.is_empty() {
            continue;
        }
        if is_first_segment && has_leading_drive && seg.len() == 2 && seg.as_bytes()[1] == b':' {
            is_first_segment = false;
            continue;
        }
        is_first_segment = false;
        if seg.contains(':') || is_windows_reserved_device_name(seg) {
            return true;
        }
    }
    false
}

/// Sanitizes an arbitrary title or filename stem for cross-platform filesystem export:
/// strips control characters and path/OS-reserved characters (`/`, `\`, `:`, `*`, `?`,
/// `"`, `<`, `>`, `|`), trims leading/trailing `.` and whitespace, prefixes `doc_` onto
/// Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`),
/// preserves Unicode alphanumeric characters, and truncates cleanly at a UTF-8 char boundary
/// (`<= 120` bytes).
#[must_use]
pub fn sanitize_export_stem(raw: &str) -> String {
    const MAX_STEM_BYTES: usize = 120;

    let filtered: String = raw
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();

    let trimmed = filtered.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        return "Document".to_owned();
    }

    let guarded = if is_windows_reserved_device_name(trimmed) {
        format!("doc_{trimmed}")
    } else {
        trimmed.to_owned()
    };

    let mut end = guarded.len().min(MAX_STEM_BYTES);
    while end > 0 && !guarded.is_char_boundary(end) {
        end -= 1;
    }

    let truncated = guarded[..end].trim_matches(|c: char| c == '.' || c.is_whitespace());
    if truncated.is_empty() {
        "Document".to_owned()
    } else if is_windows_reserved_device_name(truncated) {
        let re_guarded = format!("doc_{truncated}");
        let mut re_end = re_guarded.len().min(MAX_STEM_BYTES);
        while re_end > 0 && !re_guarded.is_char_boundary(re_end) {
            re_end -= 1;
        }
        re_guarded[..re_end]
            .trim_matches(|c: char| c == '.' || c.is_whitespace())
            .to_owned()
    } else {
        truncated.to_owned()
    }
}
