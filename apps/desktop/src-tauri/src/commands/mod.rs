//! Typed IPC command handlers bridging the desktop frontend to `AppCore`.

use app_application::{
    ApplicationError, DocumentSessionDto, ExportAnnotationsBundleDto, NavigationAction,
    OpenDocumentRequest, RenderPageCommand, RenderedPageResultDto, SearchRequestDto,
    SettingsPatchDto, UpsertAnnotationCommand, UpsertBookmarkCommand,
};
use app_core::AppCore;
use app_domain::{Annotation, AppSettings, Bookmark, RecentDocument, SearchHit, ViewState};
use serde::{Deserialize, Serialize};

/// Structured, serializable error DTO returned across the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandErrorDto {
    /// Machine-readable error code for UI handling (e.g., `"password_required"`).
    pub code: String,
    /// User-safe error description (never contains passwords or raw document content).
    pub message: String,
}

impl From<ApplicationError> for CommandErrorDto {
    fn from(err: ApplicationError) -> Self {
        Self {
            code: err.error_code().to_owned(),
            message: err.to_string(),
        }
    }
}

/// Typed IPC command dispatcher wrapping `AppCore`.
pub struct DesktopCommandHandler {
    core: AppCore,
}

impl DesktopCommandHandler {
    /// Creates a new `DesktopCommandHandler` backed by `core`.
    #[must_use]
    pub const fn new(core: AppCore) -> Self {
        Self { core }
    }

    /// Initializes a `DesktopCommandHandler` using the default OS application data directory.
    pub fn try_new_default() -> Result<Self, CommandErrorDto> {
        let core = AppCore::new_default()?;
        Ok(Self { core })
    }

    /// Initializes an in-memory `DesktopCommandHandler` for testing.
    pub fn try_new_in_memory() -> Result<Self, CommandErrorDto> {
        let core = AppCore::new_in_memory()?;
        Ok(Self { core })
    }

    /// Handles `document_open`.
    pub fn document_open(
        &self,
        request: OpenDocumentRequest,
    ) -> Result<DocumentSessionDto, CommandErrorDto> {
        Ok(self.core.open_document(request)?)
    }

    /// Handles `document_open_sample` (generates and opens the built-in welcome guide PDF).
    pub fn document_open_sample(&self) -> Result<DocumentSessionDto, CommandErrorDto> {
        let sample_dir = std::env::temp_dir().join("readora-samples");
        let path = self.core.create_sample_pdf(&sample_dir)?;
        Ok(self.core.open_document(OpenDocumentRequest {
            path,
            password: None,
        })?)
    }

    /// Handles `document_close`.
    pub fn document_close(&self, document_id: &str) -> Result<(), CommandErrorDto> {
        Ok(self.core.close_document(document_id)?)
    }

    /// Handles `document_get_info`.
    pub fn document_get_info(
        &self,
        document_id: &str,
    ) -> Result<DocumentSessionDto, CommandErrorDto> {
        Ok(self.core.get_document_session(document_id)?)
    }

    /// Handles `document_navigate`.
    pub fn document_navigate(
        &self,
        document_id: &str,
        action: NavigationAction,
    ) -> Result<ViewState, CommandErrorDto> {
        Ok(self.core.navigate(document_id, action)?)
    }

    /// Handles `page_render`.
    pub fn page_render(
        &self,
        command: RenderPageCommand,
    ) -> Result<RenderedPageResultDto, CommandErrorDto> {
        Ok(self.core.render_page(command)?)
    }

    /// Handles `page_cancel_renders`.
    pub fn page_cancel_renders(&self, document_id: &str) -> Result<u64, CommandErrorDto> {
        Ok(self.core.cancel_renders(document_id)?)
    }

    /// Handles `page_extract_text`.
    pub fn page_extract_text(
        &self,
        document_id: &str,
        page_index: u32,
    ) -> Result<String, CommandErrorDto> {
        Ok(self.core.extract_page_text(document_id, page_index)?)
    }

    /// Handles `document_search`.
    pub fn document_search(
        &self,
        request: SearchRequestDto,
    ) -> Result<Vec<SearchHit>, CommandErrorDto> {
        Ok(self.core.search_document(request)?)
    }

    /// Handles `recent_documents_list`.
    pub fn recent_documents_list(
        &self,
        limit: usize,
    ) -> Result<Vec<RecentDocument>, CommandErrorDto> {
        Ok(self.core.list_recent_documents(limit)?)
    }

    /// Handles `recent_document_set_favorite`.
    pub fn recent_document_set_favorite(
        &self,
        document_id: &str,
        is_favorite: bool,
    ) -> Result<Option<RecentDocument>, CommandErrorDto> {
        Ok(self.core.set_favorite_document(document_id, is_favorite)?)
    }

    /// Handles `recent_document_set_archived`.
    pub fn recent_document_set_archived(
        &self,
        document_id: &str,
        is_archived: bool,
    ) -> Result<Option<RecentDocument>, CommandErrorDto> {
        Ok(self.core.set_document_archived(document_id, is_archived)?)
    }

    /// Handles `recent_document_delete`.
    pub fn recent_document_delete(&self, document_id: &str) -> Result<(), CommandErrorDto> {
        Ok(self.core.delete_recent_document(document_id)?)
    }

    /// Handles `bookmark_upsert`.
    pub fn bookmark_upsert(
        &self,
        command: UpsertBookmarkCommand,
    ) -> Result<Bookmark, CommandErrorDto> {
        Ok(self.core.upsert_bookmark(command)?)
    }

    /// Handles `bookmark_list`.
    pub fn bookmark_list(&self, document_id: &str) -> Result<Vec<Bookmark>, CommandErrorDto> {
        Ok(self.core.list_bookmarks(document_id)?)
    }

    /// Handles `bookmark_delete`.
    pub fn bookmark_delete(&self, bookmark_id: &str) -> Result<bool, CommandErrorDto> {
        Ok(self.core.delete_bookmark(bookmark_id)?)
    }

    /// Handles `annotation_upsert`.
    pub fn annotation_upsert(
        &self,
        command: UpsertAnnotationCommand,
    ) -> Result<Annotation, CommandErrorDto> {
        Ok(self.core.upsert_annotation(command)?)
    }

    /// Handles `annotation_list`.
    pub fn annotation_list(&self, document_id: &str) -> Result<Vec<Annotation>, CommandErrorDto> {
        Ok(self.core.list_annotations(document_id)?)
    }

    /// Handles `annotation_delete`.
    pub fn annotation_delete(&self, annotation_id: &str) -> Result<bool, CommandErrorDto> {
        Ok(self.core.delete_annotation(annotation_id)?)
    }

    /// Handles `annotation_export`.
    pub fn annotation_export(
        &self,
        document_id: &str,
        include_annotations: bool,
        destination_path: Option<&str>,
    ) -> Result<ExportAnnotationsBundleDto, CommandErrorDto> {
        Ok(self
            .core
            .export_annotations(document_id, include_annotations, destination_path)?)
    }

    /// Handles `settings_get`.
    pub fn settings_get(&self) -> Result<AppSettings, CommandErrorDto> {
        Ok(self.core.get_settings()?)
    }

    /// Handles `settings_update`.
    pub fn settings_update(&self, patch: SettingsPatchDto) -> Result<AppSettings, CommandErrorDto> {
        Ok(self.core.update_settings(patch)?)
    }
}
