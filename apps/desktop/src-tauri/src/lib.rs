//! Desktop composition root and typed IPC command handlers for Readora.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod commands;

pub use commands::{CommandErrorDto, DesktopCommandHandler};

/// Initializes structured tracing without logging sensitive document contents or paths.
pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .try_init();
}

#[cfg(test)]
mod tests {
    use app_application::{
        NavigationAction, ReleaseManifestDto, RenderPageCommand, UpsertAnnotationCommand,
        UpsertBookmarkCommand,
    };
    use app_domain::{AnnotationKind, RenderMode};

    use super::*;

    #[test]
    fn desktop_command_handler_executes_full_ipc_contract() {
        let handler = DesktopCommandHandler::try_new_in_memory().unwrap();

        let session = handler.document_open_sample().unwrap();
        let doc_id = session.descriptor.id.as_str().to_owned();
        assert_eq!(session.descriptor.page_count, 5);

        let rendered = handler
            .page_render(RenderPageCommand {
                document_id: doc_id.clone(),
                page_index: 0,
                scale: 1.0,
                rotation_degrees: 0,
                render_mode: RenderMode::Standard,
                generation: None,
            })
            .unwrap();
        assert!(rendered.data_url.starts_with("data:image/png;base64,"));

        let nav_state = handler
            .document_navigate(&doc_id, NavigationAction::NextPage)
            .unwrap();
        assert_eq!(nav_state.current_page.zero_based(), 1);

        let bm = handler
            .bookmark_upsert(UpsertBookmarkCommand {
                document_id: doc_id.clone(),
                page_index: 1,
                label: "Architecture Overview".to_owned(),
            })
            .unwrap();
        assert_eq!(handler.bookmark_list(&doc_id).unwrap().len(), 1);
        assert!(handler.bookmark_delete(bm.id.as_str()).unwrap());

        let ann = handler
            .annotation_upsert(UpsertAnnotationCommand {
                document_id: doc_id.clone(),
                page_index: 1,
                kind: AnnotationKind::Highlight,
                color_hex: "#a9d5b2".to_owned(),
                quote_text: "Hexagonal Architecture".to_owned(),
                note_text: "Key architecture pattern".to_owned(),
            })
            .unwrap();
        assert_eq!(handler.annotation_list(&doc_id).unwrap().len(), 1);

        let exported = handler.annotation_export(&doc_id, true, None).unwrap();
        assert_eq!(exported.annotation_count, 1);
        assert!(exported.markdown_content.contains("Hexagonal Architecture"));

        assert!(handler.annotation_delete(ann.id.as_str()).unwrap());

        let recents = handler.recent_documents_list(10).unwrap();
        assert_eq!(recents.len(), 1);

        let fav = handler
            .recent_document_set_favorite(&doc_id, true)
            .unwrap()
            .unwrap();
        assert!(fav.is_favorite);

        let arch = handler
            .recent_document_set_archived(&doc_id, true)
            .unwrap()
            .unwrap();
        assert!(arch.is_archived);

        let diag = handler.system_diagnostics().unwrap();
        assert_eq!(diag.sqlite_schema_version, 3);
        assert!(!diag.third_party_notices.is_empty());

        // Verify update check, staging, dismissal, and installation lifecycle
        let staged = handler
            .app_stage_update_manifest(ReleaseManifestDto {
                version: "1.1.0".to_owned(),
                title: "Focus Reader 1.1 is ready".to_owned(),
                notes: "A faster reader, improved annotations, and accessibility updates are ready to install.".to_owned(),
                package_size_bytes: 44_040_192,
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
                published_at: "2026-11-10T00:00:00Z".to_owned(),
            })
            .unwrap();
        assert!(staged.update_available);
        assert_eq!(staged.latest_version.as_deref(), Some("1.1.0"));

        let dismissed = handler.app_dismiss_update("1.1.0").unwrap();
        assert!(!dismissed.update_available);
        let manual_check = handler.app_check_for_updates(true).unwrap();
        assert!(manual_check.update_available);

        let installed = handler.app_install_update("1.1.0").unwrap();
        assert!(!installed.update_available);
        assert!(installed.staged_for_restart);
        assert_eq!(installed.current_version, "1.1.0");
        assert_eq!(handler.system_diagnostics().unwrap().app_version, "1.1.0");

        handler.document_close(&doc_id).unwrap();
    }
}
