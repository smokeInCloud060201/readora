//! Domain error definitions for Readora.

use thiserror::Error;

/// Domain-level validation and invariant violations.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum DomainError {
    /// Document identifier is empty or contains invalid characters.
    #[error("document identifier must not be empty")]
    EmptyDocumentId,

    /// Page count must be at least 1 for a valid PDF document.
    #[error("invalid page count {0}; a PDF document must have at least 1 page")]
    InvalidPageCount(u32),

    /// One-based page number must be >= 1.
    #[error("one-based page number must be at least 1, got {0}")]
    InvalidOneBasedPage(u32),

    /// Requested page index exceeds the document's page count.
    #[error("page index {page_index} is out of bounds for document with {page_count} pages")]
    PageOutOfBounds {
        /// Requested zero-based page index.
        page_index: u32,
        /// Total pages in the document.
        page_count: u32,
    },

    /// Zoom factor is outside the supported `[0.25, 5.0]` range or non-finite.
    #[error("zoom factor {0} is outside the allowed range [0.25, 5.0]")]
    InvalidZoomLevel(f32),

    /// Rotation angle in degrees is not a multiple of 90 in `{0, 90, 180, 270}`.
    #[error("unsupported rotation degrees {0}; expected 0, 90, 180, or 270")]
    InvalidRotationDegrees(u16),

    /// Page dimensions in points must be positive and finite.
    #[error("invalid page dimensions ({width_pt} x {height_pt} pt)")]
    InvalidPageDimensions {
        /// Width in points.
        width_pt: f32,
        /// Height in points.
        height_pt: f32,
    },

    /// Target pixel dimensions exceed the safety cap (`MAX_RENDER_DIMENSION_PX`).
    #[error("target render dimensions ({width_px}x{height_px}) exceed limit {max_px}px")]
    RenderDimensionsExceedLimit {
        /// Requested width in pixels.
        width_px: u32,
        /// Requested height in pixels.
        height_px: u32,
        /// Configured maximum dimension in pixels.
        max_px: u32,
    },

    /// Bookmark label is empty or exceeds the maximum character limit.
    #[error("bookmark label must be between 1 and {max_len} characters")]
    InvalidBookmarkLabel {
        /// Maximum allowed length.
        max_len: usize,
    },

    /// Annotation content or color is invalid.
    #[error("invalid annotation: {reason}")]
    InvalidAnnotation {
        /// Validation failure reason.
        reason: String,
    },

    /// Cache byte budget is outside the valid range.
    #[error("render cache budget {budget_bytes} bytes is outside [{min_bytes}, {max_bytes}]")]
    InvalidCacheBudget {
        /// Requested budget in bytes.
        budget_bytes: usize,
        /// Minimum allowed budget in bytes.
        min_bytes: usize,
        /// Maximum allowed budget in bytes.
        max_bytes: usize,
    },

    /// Prefetch window is too large.
    #[error("prefetch window {window} exceeds maximum allowed {max_window}")]
    InvalidPrefetchWindow {
        /// Requested window.
        window: u32,
        /// Maximum allowed window.
        max_window: u32,
    },
}
