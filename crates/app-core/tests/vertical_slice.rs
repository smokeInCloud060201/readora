//! End-to-end vertical slice integration tests exercising `AppCore` across all layers:
//! open local PDF -> render page -> zoom/rotate/navigate -> search -> bookmark ->
//! close -> reopen recent document and verify restored reading position.

use app_application::{
    NavigationAction, OpenDocumentRequest, ReleaseManifestDto, RenderPageCommand, SearchRequestDto,
    SettingsPatchDto, UpsertAnnotationCommand, UpsertBookmarkCommand,
};
use app_core::AppCore;
use app_domain::{AnnotationKind, FitMode, LayoutMode, RenderMode, ThemePreference};
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

#[test]
fn in_memory_isolation_delete_cascade_and_verified_update_workflow() {
    let core = AppCore::new_in_memory().unwrap();

    // 1. Import PDF bytes with Unicode filename, add bookmark & annotation, then delete recent document
    let pdf_bytes = build_synthetic_pdf_bytes(
        "Research Paper",
        &["Section 1: Isolated ephemeral library test"],
        None,
    );
    let imported = core
        .import_document_bytes("日本語ノート.pdf", &pdf_bytes, None)
        .unwrap();
    assert_eq!(imported.descriptor.file_name, "日本語ノート.pdf");
    let doc_id = imported.descriptor.id.as_str().to_owned();

    let recents = core.list_recent_documents(10).unwrap();
    assert_eq!(recents.len(), 1);
    let staged_file_path = recents[0].file_path.clone();
    assert!(std::path::Path::new(&staged_file_path).is_file());

    core.upsert_bookmark(UpsertBookmarkCommand {
        document_id: doc_id.clone(),
        page_index: 0,
        label: "Bookmark to cascade".to_owned(),
    })
    .unwrap();
    core.upsert_annotation(UpsertAnnotationCommand {
        id: None,
        document_id: doc_id.clone(),
        page_index: 0,
        kind: AnnotationKind::Highlight,
        color_hex: "#f3d96b".to_owned(),
        quote_text: "Isolated ephemeral".to_owned(),
        note_text: "Note to cascade".to_owned(),
    })
    .unwrap();

    core.delete_recent_document(&doc_id).unwrap();
    assert!(core.list_recent_documents(10).unwrap().is_empty());
    assert!(core.list_bookmarks(&doc_id).unwrap().is_empty());
    assert!(core.list_annotations(&doc_id).unwrap().is_empty());
    assert!(!std::path::Path::new(&staged_file_path).exists());

    // 2. install_update rejects unverified or unstaged versions, and succeeds only with verified hex SHA-256
    assert!(core.install_update("9.9.9").is_err());

    let unverified_status = core
        .stage_update_manifest(ReleaseManifestDto {
            version: "9.9.9".to_owned(),
            title: "Unverified".to_owned(),
            notes: "Missing valid hex sha256".to_owned(),
            package_size_bytes: 1024,
            sha256: String::new(),
            published_at: "2026-11-17T00:00:00Z".to_owned(),
            download_url: None,
        })
        .unwrap();
    assert!(!unverified_status.verified);
    assert!(!unverified_status.update_available);
    assert!(core.install_update("9.9.9").is_err());

    let verified_status = core
        .stage_update_manifest(ReleaseManifestDto {
            version: "9.9.9".to_owned(),
            title: "Verified".to_owned(),
            notes: "Valid SHA-256".to_owned(),
            package_size_bytes: 4096,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
            published_at: "2026-11-17T00:00:00Z".to_owned(),
            download_url: None,
        })
        .unwrap();
    assert!(verified_status.verified);
    assert!(verified_status.update_available);

    let installed = core.install_update("9.9.9").unwrap();
    assert_eq!(installed.current_version, "9.9.9");

    let diag = core.system_diagnostics().unwrap();
    assert_eq!(diag.sqlite_schema_version, 5);
    assert_eq!(diag.app_version, "9.9.9");
    assert!(
        diag.third_party_notices
            .iter()
            .any(|n| n.name == "pdfjs-dist" && n.version == "6.5")
    );
    assert!(
        diag.third_party_notices
            .iter()
            .any(|n| n.name == "React + TypeScript" && n.version == "19.x / 5.9")
    );

    // 3. cleanup_application_data only cleans the isolated ephemeral dirs
    let cleanup = core.cleanup_application_data().unwrap();
    assert!(!cleanup.redacted_data_dir.is_empty());
}

#[test]
fn vertical_slice_persists_fit_layout_favorites_beyond_limit_and_syncs_page_count() {
    let temp_dir = tempfile::tempdir().unwrap();
    let core = AppCore::new_in_memory().unwrap();

    // 1. Open sample, apply FitPage + SinglePage + sync page count, close & reopen
    let sample_path = core.create_sample_pdf(temp_dir.path()).unwrap();
    let opened = core
        .open_document(OpenDocumentRequest {
            path: sample_path.clone(),
            password: None,
        })
        .unwrap();
    let doc_id = opened.descriptor.id.as_str().to_owned();

    core.navigate(&doc_id, NavigationAction::SetFitMode(FitMode::FitPage))
        .unwrap();
    core.navigate(
        &doc_id,
        NavigationAction::SetLayoutMode(LayoutMode::SinglePage),
    )
    .unwrap();
    core.sync_document_page_count(&doc_id, 12).unwrap();
    assert_eq!(
        core.get_document_session(&doc_id)
            .unwrap()
            .descriptor
            .page_count,
        12
    );
    assert_eq!(
        core.list_recent_documents(5)
            .unwrap()
            .into_iter()
            .find(|r| r.document_id.as_str() == doc_id)
            .unwrap()
            .page_count,
        12
    );
    let jumped = core
        .navigate(&doc_id, NavigationAction::GoToPage(9))
        .unwrap();
    assert_eq!(jumped.current_page.zero_based(), 9);

    core.close_document(&doc_id).unwrap();

    let reopened = core
        .open_document(OpenDocumentRequest {
            path: sample_path,
            password: None,
        })
        .unwrap();
    assert_eq!(reopened.view_state.fit_mode, FitMode::FitPage);
    assert_eq!(reopened.view_state.layout_mode, LayoutMode::SinglePage);

    // 2. Favorited doc remains returned even after >5 newer non-favorite recents are opened
    core.set_favorite_document(&doc_id, true).unwrap();
    core.close_document(&doc_id).unwrap();

    for idx in 0..6 {
        let extra_path = temp_dir.path().join(format!("extra-{idx}.pdf"));
        let bytes = build_synthetic_pdf_bytes(&format!("Extra {idx}"), &["Hello"], None);
        std::fs::write(&extra_path, bytes).unwrap();
        let extra_session = core
            .open_document(OpenDocumentRequest {
                path: extra_path.to_string_lossy().into_owned(),
                password: None,
            })
            .unwrap();
        core.close_document(extra_session.descriptor.id.as_str())
            .unwrap();
    }

    let library = core.list_recent_documents(5).unwrap();
    assert!(
        library
            .iter()
            .any(|r| r.document_id.as_str() == doc_id && r.is_favorite),
        "favorite document must remain visible beyond standard recent limit"
    );
}
