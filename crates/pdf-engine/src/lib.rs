//! Engine-neutral PDF traits and data types.
//!
//! Application and UI crates depend only on these abstractions, keeping PDFium-specific
//! bindings isolated inside `pdfium-adapter`.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod error;
pub mod traits;
pub mod types;

pub use error::PdfEngineError;
pub use traits::{PdfDocument, PdfEngine};
pub use types::{
    DEFAULT_MAX_PDF_FILE_SIZE_BYTES, EngineDocumentInfo, OpenDocumentOptions, PageGeometry,
    PdfEngineKind, RenderPageRequest, RenderedPage,
};

#[cfg(test)]
mod tests {
    use super::*;
    use app_domain::PageIndex;

    #[test]
    fn open_options_redacts_password_in_debug_output() {
        let opts = OpenDocumentOptions {
            password: Some("super-secret-password".to_owned()),
            max_file_size_bytes: 0,
        };
        let debug_str = format!("{opts:?}");
        assert!(!debug_str.contains("super-secret-password"));
        assert!(debug_str.contains("has_password: true"));
        assert_eq!(
            opts.effective_max_file_size(),
            DEFAULT_MAX_PDF_FILE_SIZE_BYTES
        );
    }

    #[test]
    fn render_request_defaults_are_sensible() {
        let req = RenderPageRequest::new(PageIndex::FIRST, 1.5);
        assert_eq!(req.page_index, PageIndex::FIRST);
        assert_eq!(req.scale, 1.5);
    }
}
