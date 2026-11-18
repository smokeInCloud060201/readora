//! Typed IPC command handlers bridging the desktop frontend to `AppCore`.

use app_application::{
    AppCleanupReportDto, AppUpdateStatusDto, ApplicationError, DocumentSessionDto,
    ExportAnnotationsBundleDto, NavigationAction, OpenDocumentRequest, ReleaseManifestDto,
    RenderPageCommand, RenderedPageResultDto, SearchRequestDto, SettingsPatchDto,
    SystemDiagnosticsDto, UpsertAnnotationCommand, UpsertBookmarkCommand,
};
use app_core::AppCore;
use app_domain::{Annotation, AppSettings, Bookmark, RecentDocument, SearchHit, ViewState};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// Official GitHub `owner/repo` slug used to pin update checks and binary self-updates in release builds.
pub const OFFICIAL_RELEASE_REPO: &str = "smokeInCloud060201/readora";

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

    /// Handles `document_open` when authorized either by the native OS file picker (`dialog_approved`)
    /// or as a previously persisted/app-owned document (`is_authorized_reopen_path`).
    pub fn document_open_authorized(
        &self,
        request: OpenDocumentRequest,
        dialog_approved: bool,
    ) -> Result<DocumentSessionDto, CommandErrorDto> {
        if !dialog_approved
            && !self
                .core
                .is_authorized_reopen_path(&request.path)
                .unwrap_or(false)
        {
            return Err(CommandErrorDto {
                code: "permission_denied".to_owned(),
                message: "Opening external files requires the native file picker dialog".to_owned(),
            });
        }
        Ok(self.core.open_document(request)?)
    }

    /// Handles `document_open`.
    pub fn document_open(
        &self,
        request: OpenDocumentRequest,
    ) -> Result<DocumentSessionDto, CommandErrorDto> {
        self.document_open_authorized(request, false)
    }

    /// Imports raw PDF bytes selected via file picker or drag-and-drop into the local library and opens a session.
    pub fn document_import_bytes(
        &self,
        file_name: &str,
        bytes: &[u8],
        password: Option<String>,
    ) -> Result<DocumentSessionDto, CommandErrorDto> {
        Ok(self
            .core
            .import_document_bytes(file_name, bytes, password)?)
    }

    /// Reads raw PDF bytes for an open or persisted library document.
    pub fn document_read_bytes(&self, document_id: &str) -> Result<Vec<u8>, CommandErrorDto> {
        Ok(self.core.read_document_bytes(document_id)?)
    }

    /// Reads the staged release manifest on disk if present.
    pub fn read_staged_update_manifest(
        &self,
    ) -> Result<Option<ReleaseManifestDto>, CommandErrorDto> {
        Ok(self.core.read_staged_update_manifest()?)
    }

    /// Handles `document_open_sample` (generates and opens the built-in welcome guide PDF).
    pub fn document_open_sample(&self) -> Result<DocumentSessionDto, CommandErrorDto> {
        static SAMPLE_PDF_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = SAMPLE_PDF_LOCK.lock().map_err(|_| CommandErrorDto {
            code: "platform_error".to_owned(),
            message: "sample PDF generation lock poisoned".to_owned(),
        })?;
        Ok(self.core.open_sample_document()?)
    }

    /// Synchronizes a higher fallback page count reported by WebView `pdfjs-dist`.
    pub fn document_sync_page_count(
        &self,
        document_id: &str,
        page_count: u32,
    ) -> Result<ViewState, CommandErrorDto> {
        Ok(self
            .core
            .sync_document_page_count(document_id, page_count)?)
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
    pub fn settings_update(
        &self,
        mut patch: SettingsPatchDto,
    ) -> Result<AppSettings, CommandErrorDto> {
        #[cfg(not(any(test, debug_assertions)))]
        {
            if let Some(ref repo) = patch.github_release_repo
                && repo.trim() != OFFICIAL_RELEASE_REPO
            {
                return Err(CommandErrorDto {
                    code: "validation_error".to_owned(),
                    message: "Release builds pin updates to the official repository".to_owned(),
                });
            }
            patch.github_release_repo = Some(OFFICIAL_RELEASE_REPO.to_owned());
        }
        #[cfg(any(test, debug_assertions))]
        let _ = &mut patch;
        Ok(self.core.update_settings(patch)?)
    }

    /// Handles `system_diagnostics`.
    pub fn system_diagnostics(&self) -> Result<SystemDiagnosticsDto, CommandErrorDto> {
        Ok(self.core.system_diagnostics()?)
    }

    /// Handles `app_cleanup_data` (removes only Readora-created database, cache, and temp files).
    pub fn app_cleanup_data(&self) -> Result<AppCleanupReportDto, CommandErrorDto> {
        Ok(self.core.cleanup_application_data()?)
    }

    /// Handles `app_check_for_updates`.
    pub fn app_check_for_updates(
        &self,
        include_dismissed: bool,
    ) -> Result<AppUpdateStatusDto, CommandErrorDto> {
        Ok(self.core.check_for_updates(include_dismissed)?)
    }

    /// Handles `app_stage_update_manifest`.
    pub fn app_stage_update_manifest(
        &self,
        manifest: ReleaseManifestDto,
    ) -> Result<AppUpdateStatusDto, CommandErrorDto> {
        Ok(self.core.stage_update_manifest(manifest)?)
    }

    /// Handles `app_stage_github_release` by parsing GitHub's `/releases/latest` JSON payload
    /// and falling back to a bounded `release-manifest-<platform>.json` fetch when `asset.digest` is absent.
    pub fn app_stage_github_release(
        &self,
        raw_json: &str,
    ) -> Result<AppUpdateStatusDto, CommandErrorDto> {
        let manifest = crate::server::parse_and_resolve_github_release_manifest(
            raw_json,
            std::env::consts::OS,
            std::env::consts::ARCH,
            crate::server::fetch_allowed_github_manifest_bytes,
        )?;
        self.app_stage_update_manifest(manifest)
    }

    /// Handles `app_install_update`.
    pub fn app_install_update(&self, version: &str) -> Result<AppUpdateStatusDto, CommandErrorDto> {
        Ok(self.core.install_update(version)?)
    }

    /// Handles `app_dismiss_update`.
    pub fn app_dismiss_update(&self, version: &str) -> Result<AppUpdateStatusDto, CommandErrorDto> {
        Ok(self.core.dismiss_update(version)?)
    }

    /// Dispatches a JSON-serialized IPC command by name (`cmd`) and `args` object onto `AppCore`.
    pub fn dispatch_rpc(&self, cmd: &str, args: Value) -> Result<Value, CommandErrorDto> {
        match cmd {
            "document_open" => {
                let request: OpenDocumentRequest = parse_arg(&args, "request")?;
                to_json_value(self.document_open_authorized(request, false)?)
            }
            "document_open_sample" => to_json_value(self.document_open_sample()?),
            "document_sync_page_count" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                let page_count: u32 = parse_arg(&args, "pageCount")?;
                to_json_value(self.document_sync_page_count(&document_id, page_count)?)
            }
            "document_close" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                self.document_close(&document_id)?;
                Ok(Value::Null)
            }
            "document_get_info" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                to_json_value(self.document_get_info(&document_id)?)
            }
            "document_navigate" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                let action: NavigationAction = parse_arg(&args, "action")?;
                to_json_value(self.document_navigate(&document_id, action)?)
            }
            "page_render" => {
                let command: RenderPageCommand = parse_arg(&args, "command")?;
                to_json_value(self.page_render(command)?)
            }
            "page_cancel_renders" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                to_json_value(self.page_cancel_renders(&document_id)?)
            }
            "page_extract_text" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                let page_index: u32 = parse_arg(&args, "pageIndex")?;
                to_json_value(self.page_extract_text(&document_id, page_index)?)
            }
            "document_search" => {
                let request: SearchRequestDto = parse_arg(&args, "request")?;
                to_json_value(self.document_search(request)?)
            }
            "recent_documents_list" => {
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
                    .unwrap_or(20);
                to_json_value(self.recent_documents_list(limit)?)
            }
            "recent_document_set_favorite" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                let is_favorite: bool = parse_arg(&args, "isFavorite")?;
                to_json_value(self.recent_document_set_favorite(&document_id, is_favorite)?)
            }
            "recent_document_set_archived" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                let is_archived: bool = parse_arg(&args, "isArchived")?;
                to_json_value(self.recent_document_set_archived(&document_id, is_archived)?)
            }
            "recent_document_delete" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                self.recent_document_delete(&document_id)?;
                Ok(Value::Null)
            }
            "bookmark_upsert" => {
                let command: UpsertBookmarkCommand = parse_arg(&args, "command")?;
                to_json_value(self.bookmark_upsert(command)?)
            }
            "bookmark_list" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                to_json_value(self.bookmark_list(&document_id)?)
            }
            "bookmark_delete" => {
                let bookmark_id: String = parse_arg(&args, "bookmarkId")?;
                to_json_value(self.bookmark_delete(&bookmark_id)?)
            }
            "annotation_upsert" => {
                let command: UpsertAnnotationCommand = parse_arg(&args, "command")?;
                to_json_value(self.annotation_upsert(command)?)
            }
            "annotation_list" => {
                let document_id: String = parse_arg(&args, "documentId")?;
                to_json_value(self.annotation_list(&document_id)?)
            }
            "annotation_delete" => {
                let annotation_id: String = parse_arg(&args, "annotationId")?;
                to_json_value(self.annotation_delete(&annotation_id)?)
            }
            "annotation_export" => to_json_value(crate::server::execute_annotation_export_rpc(
                self, &args, None,
            )?),
            "settings_get" => to_json_value(self.settings_get()?),
            "settings_update" => {
                let patch: SettingsPatchDto = parse_arg(&args, "patch")?;
                to_json_value(self.settings_update(patch)?)
            }
            "system_diagnostics" => to_json_value(self.system_diagnostics()?),
            "app_cleanup_data" => to_json_value(self.app_cleanup_data()?),
            "app_check_for_updates" => {
                let include_dismissed = args
                    .get("includeDismissed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if args.get("fetchRemote").and_then(Value::as_bool) == Some(true)
                    && let Ok(settings) = self.settings_get()
                {
                    let release_repo = if cfg!(not(any(test, debug_assertions))) {
                        OFFICIAL_RELEASE_REPO
                    } else {
                        settings.github_release_repo.as_str()
                    };
                    if let Ok(manifest) = crate::server::fetch_github_release_manifest(release_repo)
                    {
                        let _ = self.app_stage_update_manifest(manifest);
                    }
                }
                to_json_value(self.app_check_for_updates(include_dismissed)?)
            }
            "app_stage_update_manifest" => {
                let manifest: ReleaseManifestDto = parse_arg(&args, "manifest")?;
                to_json_value(self.app_stage_update_manifest(manifest)?)
            }
            "app_stage_github_release" => {
                let raw_json: String = parse_arg(&args, "rawJson")?;
                to_json_value(self.app_stage_github_release(&raw_json)?)
            }
            "app_install_update" => Err(CommandErrorDto {
                code: "forbidden".to_owned(),
                message: "Update installation must be invoked through the verified self-updater"
                    .to_owned(),
            }),
            "app_dismiss_update" => {
                let version: String = parse_arg(&args, "version")?;
                to_json_value(self.app_dismiss_update(&version)?)
            }
            _ => Err(CommandErrorDto {
                code: "unknown_command".to_owned(),
                message: format!("unrecognized IPC command '{cmd}'"),
            }),
        }
    }
}

fn parse_arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, CommandErrorDto> {
    let field = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(field).map_err(|err| CommandErrorDto {
        code: "validation_error".to_owned(),
        message: format!("invalid IPC argument '{key}': {err}"),
    })
}

fn to_json_value<T: Serialize>(val: T) -> Result<Value, CommandErrorDto> {
    serde_json::to_value(val).map_err(|err| CommandErrorDto {
        code: "serialization_error".to_owned(),
        message: format!("failed to serialize IPC response: {err}"),
    })
}
