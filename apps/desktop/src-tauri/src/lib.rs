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
        NavigationAction, RenderPageCommand, UpsertAnnotationCommand, UpsertBookmarkCommand,
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

        handler.document_close(&doc_id).unwrap();
    }
}
