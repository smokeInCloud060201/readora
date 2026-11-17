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
    DocumentDescriptor, DocumentMetadata, FormSupportStatus, OutlineNode, SearchBoundingBox,
    SearchHit, SignaturePresenceStatus, is_windows_reserved_device_name, sanitize_display_name,
    sanitize_export_stem, sanitize_metadata_title,
};
pub use model::recent_document::RecentDocument;
pub use model::settings::{
    AppSettings, DEFAULT_CACHE_BUDGET_BYTES, MAX_CACHE_BUDGET_BYTES, MAX_PREFETCH_WINDOW,
    MIN_CACHE_BUDGET_BYTES, SemVer, compare_semver, is_valid_github_repo_slug,
};
pub use model::view_state::ViewState;
pub use value_objects::document_id::DocumentId;
pub use value_objects::page_index::PageIndex;
pub use value_objects::render_mode::{MAX_RENDER_DIMENSION_PX, PageDimensions, RenderMode};
pub use value_objects::rotation::Rotation;
pub use value_objects::theme::{LayoutMode, ThemePreference};
pub use value_objects::zoom::{
    FitMode, MAX_RENDER_SCALE_FACTOR, MAX_ZOOM_FACTOR, MIN_ZOOM_FACTOR, ScaleBucket, ZOOM_PRESETS,
    ZoomLevel,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_id_rejects_empty_and_trims_whitespace() {
        assert_eq!(DocumentId::new(""), Err(DomainError::EmptyDocumentId));
        assert_eq!(
            DocumentId::new("   \t\n "),
            Err(DomainError::EmptyDocumentId)
        );
        assert_eq!(BookmarkId::new(""), Err(DomainError::EmptyBookmarkId));
        assert_eq!(
            BookmarkId::new("   \t\n "),
            Err(DomainError::EmptyBookmarkId)
        );
        assert_eq!(AnnotationId::new(""), Err(DomainError::EmptyAnnotationId));
        assert_eq!(
            AnnotationId::new("   \t\n "),
            Err(DomainError::EmptyAnnotationId)
        );
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
        assert!(settings.auto_check_updates);
        assert!(settings.reopen_last_document);
        assert!(settings.remember_page_position);
        assert!(!settings.confirm_before_delete);
        assert!(settings.validate().is_ok());
        settings.render_cache_budget_bytes = 1024;
        assert!(settings.validate().is_err());

        let bad_slug = AppSettings {
            github_release_repo: "../../evil/repo".to_owned(),
            ..AppSettings::default()
        };
        assert!(bad_slug.validate().is_err());
    }

    #[test]
    fn compare_semver_orders_prereleases_per_semver_spec() {
        use std::cmp::Ordering;
        assert_eq!(compare_semver("1.0.7", "1.0.7-alpha.1"), Ordering::Greater);
        assert_eq!(compare_semver("1.0.6-rc.1", "1.0.6"), Ordering::Less);
        assert_eq!(
            compare_semver("1.0.7-alpha.1", "1.0.7-beta.1"),
            Ordering::Less
        );
        assert_eq!(compare_semver("v1.0.7+build.42", "1.0.7"), Ordering::Equal);
        assert_eq!(compare_semver("1.1.0-alpha.1", "1.0.9"), Ordering::Greater);
        assert_eq!(
            compare_semver("1.0.0-alpha.2", "1.0.0-alpha.10"),
            Ordering::Less
        );

        let chain = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.2",
            "1.0.0-alpha.10",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ];
        for pair in chain.windows(2) {
            assert_eq!(
                compare_semver(pair[0], pair[1]),
                Ordering::Less,
                "expected {} < {}",
                pair[0],
                pair[1]
            );
            let left = SemVer::parse(pair[0]).unwrap();
            let right = SemVer::parse(pair[1]).unwrap();
            assert!(left < right, "expected SemVer {} < {}", pair[0], pair[1]);
        }
        assert!(SemVer::parse("").is_err());
        assert!(SemVer::parse("1.0").is_err());
        assert!(SemVer::parse("1.0.0-").is_err());
        assert!(SemVer::parse("1.0.0+").is_err());
    }

    #[test]
    fn hidpi_render_scale_and_iso_a4_proportional_clamping_preserve_aspect_ratio() {
        assert!(ScaleBucket::from_render_scale(0.24).is_err());
        assert!(ScaleBucket::from_render_scale(10.01).is_err());
        assert!(ScaleBucket::from_render_scale(f32::NAN).is_err());
        assert_eq!(
            ScaleBucket::from_render_scale(10.0).unwrap().percentage(),
            1000
        );
        assert_eq!(ScaleBucket::from_scale(10.0).percentage(), 1000);

        let a4 = PageDimensions::new(595.0, 842.0).unwrap();
        let expected_ratio = 595.0_f32 / 842.0_f32;

        for scale in [5.0_f32, 10.0_f32] {
            let (w, h) = a4
                .clamped_target_pixel_size(scale, Rotation::Deg0, MAX_RENDER_DIMENSION_PX)
                .unwrap();
            assert!(w <= MAX_RENDER_DIMENSION_PX && h <= MAX_RENDER_DIMENSION_PX);
            assert_eq!(h, MAX_RENDER_DIMENSION_PX);
            let actual_ratio = (w as f32) / (h as f32);
            assert!(
                (actual_ratio - expected_ratio).abs() < 0.002,
                "scale={scale}: got {w}x{h} (ratio {actual_ratio}, expected {expected_ratio})"
            );
        }
    }

    #[test]
    fn github_repo_slug_and_export_stem_sanitization_guard_reserved_inputs() {
        assert!(is_valid_github_repo_slug("smokeInCloud060201/readora"));
        assert!(!is_valid_github_repo_slug("only-one-segment"));
        assert!(!is_valid_github_repo_slug("a/b/c"));
        assert!(!is_valid_github_repo_slug("../readora"));
        assert!(!is_valid_github_repo_slug("owner/repo?foo=bar"));

        assert_eq!(sanitize_export_stem("CON"), "doc_CON");
        assert_eq!(sanitize_export_stem("nul.txt"), "doc_nul.txt");
        assert_eq!(sanitize_export_stem("lpt9"), "doc_lpt9");
        assert_eq!(sanitize_export_stem("../../.zshrc"), "zshrc");
        assert_eq!(
            sanitize_export_stem("日本語の論文:2026*"),
            "日本語の論文2026"
        );

        let long_unicode = "あ".repeat(100); // 300 bytes
        let truncated = sanitize_export_stem(&long_unicode);
        assert!(truncated.len() <= 120);
        assert_eq!(truncated.len(), 120);
    }

    #[test]
    fn value_objects_enforce_invariants_during_deserialization() {
        assert!(serde_json::from_str::<ZoomLevel>("0.05").is_err());
        assert!(serde_json::from_str::<ZoomLevel>("99.0").is_err());
        assert_eq!(
            serde_json::from_str::<ZoomLevel>("1.25").unwrap(),
            ZoomLevel::new(1.25).unwrap()
        );

        assert!(serde_json::from_str::<DocumentId>("\"   \"").is_err());
        assert_eq!(
            serde_json::from_str::<DocumentId>("\" doc-abc \"")
                .unwrap()
                .as_str(),
            "doc-abc"
        );

        assert!(serde_json::from_str::<BookmarkId>("\"\"").is_err());
        assert!(serde_json::from_str::<AnnotationId>("\"   \"").is_err());
        assert!(
            serde_json::from_str::<PageDimensions>(r#"{"width_pt":-10.0,"height_pt":792.0}"#)
                .is_err()
        );
        assert!(
            serde_json::from_str::<PageDimensions>(r#"{"width_pt":612.0,"height_pt":792.0}"#)
                .is_ok()
        );

        // Junk converter URI / OS-path /Title metadata is filtered out while genuine titles remain
        assert_eq!(
            sanitize_metadata_title(
                "FILE://H:\\LOTUSHOME\\EBOOKS-HTML\\TRUNGBOKINH\\TRUNGBOKINH.HTM"
            ),
            None
        );
        assert_eq!(
            sanitize_metadata_title(
                "file://H:\\lotushome\\ebooks-html\\trungbokinh\\trungbokinh.htm"
            ),
            None
        );
        assert_eq!(sanitize_metadata_title("C:\\Documents\\book.htm"), None);
        assert_eq!(
            sanitize_metadata_title("/Users/alice/Downloads/book.html"),
            None
        );
        assert_eq!(
            sanitize_metadata_title("https://example.com/paper.pdf"),
            None
        );
        assert_eq!(
            sanitize_metadata_title("Microsoft Word - Trung Bộ Kinh"),
            Some("Trung Bộ Kinh".to_owned())
        );
        assert_eq!(
            sanitize_metadata_title("Spec (v2.0) — Notes on /Encrypt"),
            Some("Spec (v2.0) — Notes on /Encrypt".to_owned())
        );
    }
}
