//! Engine-neutral traits (`PdfEngine` and `PdfDocument`).

use std::path::Path;

use app_domain::{OutlineNode, PageIndex, SearchHit};

use crate::error::PdfEngineError;
use crate::types::{
    EngineDocumentInfo, OpenDocumentOptions, PageGeometry, PdfEngineKind, RenderPageRequest,
    RenderedPage,
};

/// An opened PDF document handle backed by a `PdfEngine`.
pub trait PdfDocument: Send + Sync {
    /// Returns document-level metadata and page count.
    fn info(&self) -> &EngineDocumentInfo;

    /// Returns geometry (width/height in points and intrinsic rotation) for `page_index`.
    fn page_geometry(&self, page_index: PageIndex) -> Result<PageGeometry, PdfEngineError>;

    /// Extracts the hierarchical outline (bookmarks/table of contents) from the PDF.
    fn outline(&self) -> Result<Vec<OutlineNode>, PdfEngineError>;

    /// Extracts plain text content from `page_index`.
    fn extract_page_text(&self, page_index: PageIndex) -> Result<String, PdfEngineError>;

    /// Searches across all pages in the document for `query`, returning up to `max_hits` matches.
    fn search_text(
        &self,
        query: &str,
        case_sensitive: bool,
        max_hits: usize,
    ) -> Result<Vec<SearchHit>, PdfEngineError>;

    /// Renders a single page into a PNG-encoded `RenderedPage`.
    fn render_page(&self, request: &RenderPageRequest) -> Result<RenderedPage, PdfEngineError>;

    /// Renders a single page while polling `is_cancelled` before expensive rasterization and encoding.
    fn render_page_cancellable(
        &self,
        request: &RenderPageRequest,
        is_cancelled: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<RenderedPage, PdfEngineError> {
        if is_cancelled() {
            return Err(PdfEngineError::Cancelled);
        }
        self.render_page(request)
    }

    /// Searches across pages while periodically polling `is_cancelled`.
    fn search_text_cancellable(
        &self,
        query: &str,
        case_sensitive: bool,
        max_hits: usize,
        is_cancelled: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Vec<SearchHit>, PdfEngineError> {
        if is_cancelled() {
            return Err(PdfEngineError::Cancelled);
        }
        self.search_text(query, case_sensitive, max_hits)
    }
}

/// Port trait for opening PDF documents from files or in-memory byte buffers.
pub trait PdfEngine: Send + Sync {
    /// Returns the active engine implementation kind.
    fn kind(&self) -> PdfEngineKind;

    /// Opens a PDF document from a local filesystem path.
    fn open_path(
        &self,
        path: &Path,
        options: &OpenDocumentOptions,
    ) -> Result<Box<dyn PdfDocument>, PdfEngineError>;

    /// Opens a PDF document from an in-memory byte slice.
    fn open_bytes(
        &self,
        bytes: &[u8],
        options: &OpenDocumentOptions,
    ) -> Result<Box<dyn PdfDocument>, PdfEngineError>;
}
