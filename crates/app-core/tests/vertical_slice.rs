//! End-to-end vertical slice integration tests exercising `AppCore` across all layers:
//! open local PDF -> render page -> zoom/rotate/navigate -> search -> bookmark ->
//! close -> reopen recent document and verify restored reading position.

use app_application::{
    NavigationAction, OpenDocumentRequest, RenderPageCommand, SearchRequestDto, SettingsPatchDto,
    UpsertBookmarkCommand,
};
use app_core::AppCore;
use app_domain::{RenderMode, ThemePreference};
use pdfium_adapter::build_synthetic_pdf_bytes;

#[test]
fn vertical_slice_open_render_zoom_navigate_bookmark_and_reopen_recent() {
    let temp_dir = tempfile::tempdir().unwrap();
    let core = AppCore::new_in_memory().unwrap();

    // 1. Create and open a local multi-page PDF document
    let pdf_path = core.create_sample_pdf(temp_dir.path()).unwrap();
    let session = core
        .open_document(OpenDocumentRequest {
            path: pdf_path.clone(),
            password: None,
        })
        .unwrap();

    let doc_id = session.descriptor.id.as_str().to_owned();
    assert_eq!(session.descriptor.page_count, 5);
    assert_eq!(session.view_state.current_page.zero_based(), 0);
    assert!(!session.outline.is_empty());

    // 2. Render page 0 and verify PNG data URL & subsequent LRU cache hit
    let render_cmd = RenderPageCommand {
        document_id: doc_id.clone(),
        page_index: 0,
        scale: 1.0,
        rotation_degrees: 0,
        render_mode: RenderMode::Standard,
        generation: None,
    };
    let first_render = core.render_page(render_cmd.clone()).unwrap();
    assert!(!first_render.cache_hit);
    assert!(first_render.data_url.starts_with("data:image/png;base64,"));

    let cached_render = core.render_page(render_cmd).unwrap();
    assert!(cached_render.cache_hit);

    // 3. Zoom, rotate, and navigate to page 3 (1-based page 4)
    let state_after_zoom = core
        .navigate(&doc_id, NavigationAction::StepZoomIn)
        .unwrap();
    assert_eq!(state_after_zoom.zoom.percentage(), 125);

    let state_after_rotate = core
        .navigate(&doc_id, NavigationAction::RotateClockwise)
        .unwrap();
    assert_eq!(state_after_rotate.rotation.degrees(), 90);

    let state_after_nav = core
        .navigate(&doc_id, NavigationAction::GoToPage(3))
        .unwrap();
    assert_eq!(state_after_nav.current_page.zero_based(), 3);

    // 4. Search text and extract page text
    let hits = core
        .search_document(SearchRequestDto {
            document_id: doc_id.clone(),
            query: "SQLite".to_owned(),
            case_sensitive: false,
            max_hits: 20,
        })
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].page_index.zero_based(), 3);

    let page_text = core.extract_page_text(&doc_id, 3).unwrap();
    assert!(page_text.contains("SQLite Persistence"));

    // 5. Create a bookmark and update settings
    let bookmark = core
        .upsert_bookmark(UpsertBookmarkCommand {
            document_id: doc_id.clone(),
            page_index: 3,
            label: "Persistence Layer".to_owned(),
        })
        .unwrap();
    assert_eq!(bookmark.label, "Persistence Layer");

    let settings = core
        .update_settings(SettingsPatchDto {
            theme: Some(ThemePreference::Dark),
            prefetch_window: Some(2),
            ..SettingsPatchDto::default()
        })
        .unwrap();
    assert_eq!(settings.theme, ThemePreference::Dark);
    assert_eq!(settings.prefetch_window, 2);

    // 6. Close the document and verify it appears in recent documents
    core.close_document(&doc_id).unwrap();
    let recents = core.list_recent_documents(10).unwrap();
    assert_eq!(recents.len(), 1);
    assert_eq!(recents[0].last_page.zero_based(), 3);

    // 7. Reopen the recent document and confirm reading position, zoom, rotation, and bookmarks restore
    let reopened = core
        .open_document(OpenDocumentRequest {
            path: recents[0].file_path.clone(),
            password: None,
        })
        .unwrap();
    assert_eq!(reopened.view_state.current_page.zero_based(), 3);
    assert_eq!(reopened.view_state.zoom.percentage(), 125);
    assert_eq!(reopened.view_state.rotation.degrees(), 90);
    assert_eq!(reopened.bookmarks.len(), 1);
}

#[test]
fn password_protected_pdf_workflow_in_app_core() {
    let temp_dir = tempfile::tempdir().unwrap();
    let enc_path = temp_dir.path().join("encrypted.pdf");
    let enc_bytes = build_synthetic_pdf_bytes(
        "Confidential Report",
        &["Secret financials on page 1"],
        Some("vault-key-42"),
    );
    std::fs::write(&enc_path, enc_bytes).unwrap();
    let path_str = enc_path.to_string_lossy().into_owned();

    let core = AppCore::new_in_memory().unwrap();

    // Opening without password prompts PasswordRequired
    let err = core
        .open_document(OpenDocumentRequest {
            path: path_str.clone(),
            password: None,
        })
        .unwrap_err();
    assert!(err.to_string().contains("password-protected"));

    // Opening with correct password succeeds
    let opened = core
        .open_document(OpenDocumentRequest {
            path: path_str,
            password: Some("vault-key-42".to_owned()),
        })
        .unwrap();
    assert!(opened.descriptor.metadata.is_encrypted);
    assert_eq!(opened.descriptor.page_count, 1);
}
