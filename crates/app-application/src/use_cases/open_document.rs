//! Use case for opening a PDF document, restoring its last reading state, and recording recents.

use std::path::Path;

use app_domain::{DocumentDescriptor, RecentDocument, ViewState};
use pdf_engine::{DEFAULT_MAX_PDF_FILE_SIZE_BYTES, OpenDocumentOptions, PdfDocument, PdfEngine};

use crate::dto::{DocumentSessionDto, OpenDocumentRequest};
use crate::error::ApplicationError;
use crate::ports::platform::{PlatformPort, ResolvedFileInfo};
use crate::ports::storage::{BookmarkRepository, RecentDocumentRepository, SettingsRepository};

/// Opened document bundle containing the active engine handle and initial session DTO.
pub struct OpenedDocumentSession {
    /// Validated file info (including canonical path for recent-file persistence).
    pub file_info: ResolvedFileInfo,
    /// Session DTO returned to the UI.
    pub session: DocumentSessionDto,
    /// Underlying engine document handle.
    pub document: Box<dyn PdfDocument>,
}

/// Orchestrates opening a local PDF file, restoring previous reading position/settings,
/// loading outline and bookmarks, and updating the recent documents list.
pub fn execute_open_document(
    request: &OpenDocumentRequest,
    pdf_engine: &dyn PdfEngine,
    platform: &dyn PlatformPort,
    recent_repo: &dyn RecentDocumentRepository,
    bookmark_repo: &dyn BookmarkRepository,
    settings_repo: &dyn SettingsRepository,
) -> Result<OpenedDocumentSession, ApplicationError> {
    let file_info =
        platform.resolve_and_validate_pdf_path(&request.path, DEFAULT_MAX_PDF_FILE_SIZE_BYTES)?;

    let open_opts = OpenDocumentOptions {
        password: request.password.clone(),
        max_file_size_bytes: DEFAULT_MAX_PDF_FILE_SIZE_BYTES,
    };

    let document = pdf_engine.open_path(Path::new(&file_info.canonical_path), &open_opts)?;
    let engine_info = document.info().clone();

    let descriptor = DocumentDescriptor::new(
        file_info.document_id.clone(),
        file_info.display_name.clone(),
        file_info.file_size_bytes,
        engine_info.page_count,
        engine_info.metadata,
    )?;

    let settings = settings_repo.load().unwrap_or_default();
    let mut view_state = ViewState::new(file_info.document_id.clone(), descriptor.page_count)?;
    view_state.layout_mode = settings.default_layout;
    view_state.fit_mode = settings.default_fit_mode;
    view_state.zoom = settings.default_zoom;

    // Restore last reading position, zoom, and rotation if previously opened.
    if let Some(previous) = recent_repo.get(&file_info.document_id)? {
        let clamped_page = previous
            .last_page
            .zero_based()
            .min(descriptor.page_count.saturating_sub(1));
        let _ = view_state.go_to_page(app_domain::PageIndex::new(clamped_page));
        view_state.zoom = previous.last_zoom;
        view_state.rotation = previous.last_rotation;
    }

    let now_ms = platform.current_unix_ms();
    let recent_entry = RecentDocument::from_view_state(
        &file_info.canonical_path,
        &descriptor.file_name,
        &view_state,
        now_ms,
    );
    recent_repo.upsert(&recent_entry)?;

    let outline = document.outline().unwrap_or_default();
    let bookmarks = bookmark_repo.list_for_document(&file_info.document_id)?;

    Ok(OpenedDocumentSession {
        file_info,
        session: DocumentSessionDto {
            descriptor,
            view_state,
            outline,
            bookmarks,
        },
        document,
    })
}
