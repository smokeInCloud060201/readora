//! Engine-neutral request and response types for PDF inspection, rendering, and search.

use std::fmt;

use app_domain::{
    DocumentMetadata, MAX_RENDER_DIMENSION_PX, PageDimensions, PageIndex, RenderMode, Rotation,
};
use serde::{Deserialize, Serialize};

/// Default maximum allowed PDF file size (512 MiB).
pub const DEFAULT_MAX_PDF_FILE_SIZE_BYTES: u64 = 512 * 1024 * 1024;

/// Identifies which underlying engine implementation is serving requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfEngineKind {
    /// Native PDFium shared library loaded dynamically via `pdfium-render`.
    PdfiumDynamic,
    /// Built-in pure-Rust fallback engine used when native PDFium binary is absent.
    PureRustFallback,
}

/// Options supplied when opening a PDF document.
#[derive(Clone, Default)]
pub struct OpenDocumentOptions {
    /// Optional password for opening encrypted PDFs. Never logged or serialized.
    pub password: Option<String>,
    /// Maximum allowed file size in bytes (`0` uses `DEFAULT_MAX_PDF_FILE_SIZE_BYTES`).
    pub max_file_size_bytes: u64,
}

impl OpenDocumentOptions {
    /// Returns the effective maximum file size in bytes.
    #[must_use]
    pub const fn effective_max_file_size(&self) -> u64 {
        if self.max_file_size_bytes == 0 {
            DEFAULT_MAX_PDF_FILE_SIZE_BYTES
        } else {
            self.max_file_size_bytes
        }
    }
}

impl fmt::Debug for OpenDocumentOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenDocumentOptions")
            .field("has_password", &self.password.is_some())
            .field("max_file_size_bytes", &self.effective_max_file_size())
            .finish()
    }
}

/// Document-level information extracted by the PDF engine upon opening.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineDocumentInfo {
    /// Total number of pages in the document (`>= 1`).
    pub page_count: u32,
    /// Document metadata dictionary values.
    pub metadata: DocumentMetadata,
}

/// Geometry and intrinsic rotation of a single page in a PDF document.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageGeometry {
    /// Zero-based page index.
    pub page_index: PageIndex,
    /// Unrotated page dimensions in points (1/72 inch).
    pub dimensions: PageDimensions,
    /// Intrinsic rotation specified by the PDF page dictionary.
    pub intrinsic_rotation: Rotation,
}

/// Parameters for rendering a single PDF page to a raster buffer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderPageRequest {
    /// Target zero-based page index.
    pub page_index: PageIndex,
    /// Scale factor (`1.0` = 72 DPI base point scale multiplied by device pixel ratio).
    pub scale: f32,
    /// User-applied rotation delta.
    pub rotation: Rotation,
    /// Color rendering mode.
    pub render_mode: RenderMode,
    /// Maximum allowed width or height in pixels.
    pub max_pixel_dimension: u32,
}

impl RenderPageRequest {
    /// Creates a standard render request for `page_index` at `scale`.
    #[must_use]
    pub const fn new(page_index: PageIndex, scale: f32) -> Self {
        Self {
            page_index,
            scale,
            rotation: Rotation::Deg0,
            render_mode: RenderMode::Standard,
            max_pixel_dimension: MAX_RENDER_DIMENSION_PX,
        }
    }
}

/// Rendered page bitmap output produced by the PDF engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPage {
    /// Zero-based page index that was rendered.
    pub page_index: PageIndex,
    /// Rendered bitmap width in pixels.
    pub width_px: u32,
    /// Rendered bitmap height in pixels.
    pub height_px: u32,
    /// Encoded PNG image bytes for compact IPC/protocol transfer.
    pub png_bytes: Vec<u8>,
}

impl RenderedPage {
    /// Returns the approximate memory footprint of this rendered page entry in bytes.
    #[must_use]
    pub fn memory_footprint_bytes(&self) -> usize {
        self.png_bytes.len().max(64)
    }
}
