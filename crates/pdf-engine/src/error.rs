//! Engine-neutral error types for PDF operations.

use thiserror::Error;

/// Errors returned by a `PdfEngine` or `PdfDocument` implementation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PdfEngineError {
    /// Target file does not exist or could not be read.
    #[error("document file could not be read")]
    IoError(String),

    /// File exceeds the configured maximum file size limit.
    #[error("file size {size_bytes} bytes exceeds limit of {max_bytes} bytes")]
    FileTooLarge {
        /// Actual file size in bytes.
        size_bytes: u64,
        /// Maximum allowed file size in bytes.
        max_bytes: u64,
    },

    /// Input bytes do not represent a valid or supported PDF document.
    #[error("malformed or unsupported PDF format: {0}")]
    InvalidPdfFormat(String),

    /// Document is encrypted and requires a password to open.
    #[error("document is password-protected")]
    PasswordRequired,

    /// Provided password could not decrypt the document.
    #[error("incorrect document password")]
    IncorrectPassword,

    /// Requested page index does not exist in the document.
    #[error("page index {page_index} is out of bounds (page count: {page_count})")]
    PageOutOfBounds {
        /// Requested zero-based page index.
        page_index: u32,
        /// Total page count.
        page_count: u32,
    },

    /// Requested render dimensions exceed the engine safety cap.
    #[error("requested render dimensions ({width_px}x{height_px}) exceed maximum {max_px}px")]
    RenderDimensionsExceedLimit {
        /// Requested width in pixels.
        width_px: u32,
        /// Requested height in pixels.
        height_px: u32,
        /// Maximum allowed dimension in pixels.
        max_px: u32,
    },

    /// Operation was cancelled because a newer request superseded it.
    #[error("PDF operation was cancelled")]
    Cancelled,

    /// Native engine runtime library could not be loaded and fallback is disabled.
    #[error("PDF engine runtime unavailable: {0}")]
    EngineUnavailable(String),

    /// Internal engine failure with sanitized diagnostic message.
    #[error("PDF engine error: {0}")]
    Internal(String),
}
