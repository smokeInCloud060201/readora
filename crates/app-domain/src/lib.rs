//! Pure domain entities, value objects, invariants, and domain errors for Readora.
//!
//! This crate is the innermost layer of the hexagonal architecture and must never
//! depend on Tauri, UI frameworks, SQLite, PDFium, OS APIs, or network clients.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod error;
pub mod model;
pub mod value_objects;

pub use error::DomainError;
pub use model::annotation::{Annotation, AnnotationId, AnnotationKind, MAX_ANNOTATION_TEXT_LEN};
pub use model::bookmark::{Bookmark, BookmarkId, MAX_BOOKMARK_LABEL_LEN};
pub use model::document::{
    DocumentDescriptor, DocumentMetadata, FormSupportStatus, OutlineNode, SearchHit,
    SignaturePresenceStatus, sanitize_display_name,
};
pub use model::recent_document::RecentDocument;
pub use model::settings::{
    AppSettings, DEFAULT_CACHE_BUDGET_BYTES, MAX_CACHE_BUDGET_BYTES, MAX_PREFETCH_WINDOW,
    MIN_CACHE_BUDGET_BYTES, compare_semver,
};
pub use model::view_state::ViewState;
pub use value_objects::document_id::DocumentId;
pub use value_objects::page_index::PageIndex;
pub use value_objects::render_mode::{MAX_RENDER_DIMENSION_PX, PageDimensions, RenderMode};
pub use value_objects::rotation::Rotation;
pub use value_objects::theme::{LayoutMode, ThemePreference};
pub use value_objects::zoom::{
    FitMode, MAX_ZOOM_FACTOR, MIN_ZOOM_FACTOR, ScaleBucket, ZOOM_PRESETS, ZoomLevel,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_id_rejects_empty_and_trims_whitespace() {
        assert_eq!(DocumentId::new("   "), Err(DomainError::EmptyDocumentId));
        let id = DocumentId::new("  doc-123  ").unwrap();
        assert_eq!(id.as_str(), "doc-123");
    }

    #[test]
    fn page_index_validates_one_based_and_bounds() {
        assert_eq!(
            PageIndex::from_one_based(0),
            Err(DomainError::InvalidOneBasedPage(0))
        );
        let p = PageIndex::from_one_based(3).unwrap();
        assert_eq!(p.zero_based(), 2);
        assert_eq!(p.one_based(), 3);

        assert!(p.validate_within(5).is_ok());
        assert_eq!(
            p.validate_within(2),
            Err(DomainError::PageOutOfBounds {
                page_index: 2,
                page_count: 2
            })
        );
    }

    #[test]
    fn zoom_level_steps_and_quantizes_scale_buckets() {
        assert!(ZoomLevel::new(0.1).is_err());
        assert!(ZoomLevel::new(10.0).is_err());
        assert!(ZoomLevel::new(f32::NAN).is_err());

        let z = ZoomLevel::ONE_HUNDRED_PERCENT;
        assert_eq!(z.step_in().percentage(), 125);
        assert_eq!(z.step_out().percentage(), 90);
        assert_eq!(ScaleBucket::from_scale(1.24).percentage(), 125);
    }

    #[test]
    fn rotation_cycles_correctly() {
        let r = Rotation::Deg0;
        assert_eq!(r.rotate_clockwise(), Rotation::Deg90);
        assert_eq!(r.rotate_clockwise().rotate_clockwise(), Rotation::Deg180);
        assert_eq!(r.rotate_counter_clockwise(), Rotation::Deg270);
        assert!(Rotation::from_degrees(45).is_err());
    }

    #[test]
    fn page_dimensions_enforces_max_render_dimension() {
        let dims = PageDimensions::US_LETTER;
        let (w, h) = dims
            .target_pixel_size(1.0, Rotation::Deg90, MAX_RENDER_DIMENSION_PX)
            .unwrap();
        assert_eq!((w, h), (792, 612));

        assert!(matches!(
            dims.target_pixel_size(10.0, Rotation::Deg0, MAX_RENDER_DIMENSION_PX),
            Err(DomainError::RenderDimensionsExceedLimit { .. })
        ));
    }

    #[test]
    fn view_state_navigation_and_prefetch_order() {
        let id = DocumentId::new("doc-1").unwrap();
        let mut state = ViewState::new(id, 5).unwrap();
        assert_eq!(state.current_page.zero_based(), 0);

        state.go_to_page(PageIndex::new(2)).unwrap();
        let prioritized = state.prioritized_render_pages(1);
        assert_eq!(
            prioritized,
            vec![PageIndex::new(2), PageIndex::new(3), PageIndex::new(1)]
        );
    }

    #[test]
    fn bookmark_and_settings_validate_invariants() {
        let doc_id = DocumentId::new("doc-1").unwrap();
        assert!(
            Bookmark::new(
                BookmarkId::generate(),
                doc_id.clone(),
                PageIndex::FIRST,
                "  ",
                0
            )
            .is_err()
        );
        let bm = Bookmark::new(
            BookmarkId::generate(),
            doc_id,
            PageIndex::FIRST,
            "  Chapter 1\n",
            1000,
        )
        .unwrap();
        assert_eq!(bm.label, "Chapter 1");

        let mut settings = AppSettings::default();
        assert!(settings.validate().is_ok());
        settings.render_cache_budget_bytes = 1024;
        assert!(settings.validate().is_err());
    }
}
