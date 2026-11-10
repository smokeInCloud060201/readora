//! Dependency wiring, session management, and command-facing application facade.
//!
//! `AppCore` composes the concrete infrastructure adapters (`PdfiumEngineAdapter`,
//! `SqliteStorage`, `NativePlatformAdapter`, `MemoryRenderCache`, and
//! `GenerationCancellationRegistry`) behind application use cases.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use app_application::{
    AnnotationRepository, ApplicationError, BookmarkRepository, DocumentSessionDto,
    ExportAnnotationsBundleDto, NavigationAction, OpenDocumentRequest, PlatformPort,
    RecentDocumentRepository, RenderCachePort, RenderCancellationPort, RenderPageCommand,
    RenderedPageResultDto, SearchRequestDto, SettingsPatchDto, SettingsRepository,
    SystemDiagnosticsDto, ThirdPartyNoticeDto, UpsertAnnotationCommand, UpsertBookmarkCommand,
    execute_delete_annotation, execute_delete_bookmark, execute_export_annotations_bundle,
    execute_get_settings, execute_list_annotations, execute_list_bookmarks,
    execute_navigation_action, execute_open_document, execute_render_page, execute_search_document,
    execute_update_settings, execute_upsert_annotation, execute_upsert_bookmark,
};
use app_domain::{
    Annotation, AppSettings, Bookmark, DEFAULT_CACHE_BUDGET_BYTES, DocumentDescriptor, DocumentId,
    OutlineNode, PageIndex, RecentDocument, SearchHit, ViewState,
};
use app_infrastructure::{GenerationCancellationRegistry, MemoryRenderCache, encode_png_data_url};
use pdf_engine::{PdfDocument, PdfEngine, PdfEngineKind};
use pdfium_adapter::{PdfiumEngineAdapter, build_synthetic_pdf_bytes};
use platform::NativePlatformAdapter;
use storage::SqliteStorage;

struct ActiveDocumentEntry {
    canonical_path: String,
    descriptor: DocumentDescriptor,
    outline: Vec<OutlineNode>,
    view_state: Mutex<ViewState>,
    document: Arc<dyn PdfDocument>,
}

/// Primary application facade shared by the desktop composition root.
pub struct AppCore {
    pdf_engine: Arc<dyn PdfEngine>,
    platform: Arc<dyn PlatformPort>,
    storage: Arc<SqliteStorage>,
    render_cache: Arc<MemoryRenderCache>,
    cancellation: Arc<GenerationCancellationRegistry>,
    sessions: RwLock<HashMap<DocumentId, Arc<ActiveDocumentEntry>>>,
}

impl AppCore {
    /// Initializes `AppCore` using the OS application data directory for SQLite persistence.
    pub fn new_default() -> Result<Self, ApplicationError> {
        let data_dir = NativePlatformAdapter::resolve_app_data_dir();
        let db_path = data_dir.join("readora.sqlite");
        let storage = Arc::new(SqliteStorage::open(&db_path)?);
        Self::with_storage(storage)
    }

    /// Initializes `AppCore` with an in-memory SQLite database for isolated tests.
    pub fn new_in_memory() -> Result<Self, ApplicationError> {
        let storage = Arc::new(SqliteStorage::open_in_memory()?);
        Self::with_storage(storage)
    }

    fn with_storage(storage: Arc<SqliteStorage>) -> Result<Self, ApplicationError> {
        let initial_budget = storage
            .load()
            .map(|s| s.render_cache_budget_bytes)
            .unwrap_or(DEFAULT_CACHE_BUDGET_BYTES);

        Ok(Self {
            pdf_engine: Arc::new(PdfiumEngineAdapter::new_with_fallback(None)),
            platform: Arc::new(NativePlatformAdapter::new()),
            storage,
            render_cache: Arc::new(MemoryRenderCache::new(initial_budget)),
            cancellation: Arc::new(GenerationCancellationRegistry::new()),
            sessions: RwLock::new(HashMap::new()),
        })
    }

    /// Returns which PDF engine runtime is currently active (`pdfium_dynamic` or `pure_rust_fallback`).
    #[must_use]
    pub fn engine_kind(&self) -> PdfEngineKind {
        self.pdf_engine.kind()
    }

    /// Opens a local PDF document, restores its last reading state, and registers an active session.
    pub fn open_document(
        &self,
        request: OpenDocumentRequest,
    ) -> Result<DocumentSessionDto, ApplicationError> {
        let opened = execute_open_document(
            &request,
            self.pdf_engine.as_ref(),
            self.platform.as_ref(),
            self.storage.as_ref(),
            self.storage.as_ref(),
            self.storage.as_ref(),
        )?;

        let doc_id = opened.session.descriptor.id.clone();
        let entry = Arc::new(ActiveDocumentEntry {
            canonical_path: opened.file_info.canonical_path,
            descriptor: opened.session.descriptor.clone(),
            outline: opened.session.outline.clone(),
            view_state: Mutex::new(opened.session.view_state.clone()),
            document: Arc::from(opened.document),
        });

        {
            let mut guard = self.sessions.write().map_err(|_| {
                ApplicationError::Platform("session registry lock poisoned".to_owned())
            })?;
            guard.insert(doc_id, entry);
        }

        Ok(opened.session)
    }

    /// Closes an open document session, invalidating its cached bitmaps and cancelling in-flight renders.
    pub fn close_document(&self, document_id: &str) -> Result<(), ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        self.cancellation.clear_document(&doc_id);
        self.render_cache.invalidate_document(&doc_id);

        let mut guard = self
            .sessions
            .write()
            .map_err(|_| ApplicationError::Platform("session registry lock poisoned".to_owned()))?;
        guard.remove(&doc_id);
        Ok(())
    }

    /// Returns the current session snapshot for an open document.
    pub fn get_document_session(
        &self,
        document_id: &str,
    ) -> Result<DocumentSessionDto, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let entry = self.lookup_session(&doc_id)?;
        let view_state = entry
            .view_state
            .lock()
            .map_err(|_| ApplicationError::Platform("view state lock poisoned".to_owned()))?
            .clone();
        let bookmarks = BookmarkRepository::list_for_document(self.storage.as_ref(), &doc_id)?;

        Ok(DocumentSessionDto {
            descriptor: entry.descriptor.clone(),
            view_state,
            outline: entry.outline.clone(),
            bookmarks,
        })
    }

    /// Applies a navigation or viewport mutation to an open document, cancels obsolete renders,
    /// and updates the persisted recent document position.
    pub fn navigate(
        &self,
        document_id: &str,
        action: NavigationAction,
    ) -> Result<ViewState, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let entry = self.lookup_session(&doc_id)?;

        let mut view_state = entry
            .view_state
            .lock()
            .map_err(|_| ApplicationError::Platform("view state lock poisoned".to_owned()))?
            .clone();

        let (updated_state, _gen) = execute_navigation_action(
            &mut view_state,
            &entry.canonical_path,
            &entry.descriptor.file_name,
            action,
            self.cancellation.as_ref(),
            self.storage.as_ref(),
            self.platform.as_ref(),
        )?;

        {
            let mut state_guard = entry
                .view_state
                .lock()
                .map_err(|_| ApplicationError::Platform("view state lock poisoned".to_owned()))?;
            *state_guard = updated_state.clone();
        }

        Ok(updated_state)
    }

    /// Renders a page for an open document without holding the session registry lock across rendering.
    pub fn render_page(
        &self,
        command: RenderPageCommand,
    ) -> Result<RenderedPageResultDto, ApplicationError> {
        let doc_id = DocumentId::new(&command.document_id)?;
        // Short critical section: clone only the Arc<ActiveDocumentEntry>, then release RwLock.
        let entry = self.lookup_session(&doc_id)?;

        execute_render_page(
            &command,
            entry.document.as_ref(),
            self.render_cache.as_ref(),
            self.cancellation.as_ref(),
            encode_png_data_url,
        )
    }

    /// Explicitly advances the render generation for `document_id` to cancel stale render requests.
    pub fn cancel_renders(&self, document_id: &str) -> Result<u64, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        Ok(self.cancellation.next_generation(&doc_id))
    }

    /// Searches text across an open document without holding the session lock during extraction.
    pub fn search_document(
        &self,
        request: SearchRequestDto,
    ) -> Result<Vec<SearchHit>, ApplicationError> {
        let doc_id = DocumentId::new(&request.document_id)?;
        let entry = self.lookup_session(&doc_id)?;
        execute_search_document(&request, entry.document.as_ref())
    }

    /// Extracts plain text for a specific page of an open document (for copy-text workflows).
    pub fn extract_page_text(
        &self,
        document_id: &str,
        page_index: u32,
    ) -> Result<String, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let entry = self.lookup_session(&doc_id)?;
        let validated = PageIndex::within(page_index, entry.descriptor.page_count)?;
        Ok(entry.document.extract_page_text(validated)?)
    }

    /// Lists recently opened documents ordered from most-recently-opened to oldest.
    pub fn list_recent_documents(
        &self,
        limit: usize,
    ) -> Result<Vec<RecentDocument>, ApplicationError> {
        self.storage.list(limit)
    }

    /// Sets the favorite flag on a recent document record.
    pub fn set_favorite_document(
        &self,
        document_id: &str,
        is_favorite: bool,
    ) -> Result<Option<RecentDocument>, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        self.storage.set_favorite(&doc_id, is_favorite)
    }

    /// Sets the archived flag on a recent document record.
    pub fn set_document_archived(
        &self,
        document_id: &str,
        is_archived: bool,
    ) -> Result<Option<RecentDocument>, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        self.storage.set_archived(&doc_id, is_archived)
    }

    /// Permanently removes a document entry from recent/archived library records.
    pub fn delete_recent_document(&self, document_id: &str) -> Result<(), ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        self.storage.remove(&doc_id)
    }

    /// Creates or updates a user bookmark on a page.
    pub fn upsert_bookmark(
        &self,
        command: UpsertBookmarkCommand,
    ) -> Result<Bookmark, ApplicationError> {
        let doc_id = DocumentId::new(&command.document_id)?;
        let page_count = if let Ok(entry) = self.lookup_session(&doc_id) {
            entry.descriptor.page_count
        } else if let Some(recent) = self.storage.get(&doc_id)? {
            recent.page_count
        } else {
            return Err(ApplicationError::DocumentNotOpen(command.document_id));
        };

        execute_upsert_bookmark(
            &command,
            page_count,
            self.storage.as_ref(),
            self.platform.as_ref(),
        )
    }

    /// Lists all saved bookmarks for a document.
    pub fn list_bookmarks(&self, document_id: &str) -> Result<Vec<Bookmark>, ApplicationError> {
        execute_list_bookmarks(document_id, self.storage.as_ref())
    }

    /// Deletes a bookmark by ID.
    pub fn delete_bookmark(&self, bookmark_id: &str) -> Result<bool, ApplicationError> {
        execute_delete_bookmark(bookmark_id, self.storage.as_ref())
    }

    /// Creates or updates a persistent annotation (highlight, underline, or comment) on a page.
    pub fn upsert_annotation(
        &self,
        command: UpsertAnnotationCommand,
    ) -> Result<Annotation, ApplicationError> {
        let doc_id = DocumentId::new(&command.document_id)?;
        let page_count = if let Ok(entry) = self.lookup_session(&doc_id) {
            entry.descriptor.page_count
        } else if let Some(recent) = self.storage.get(&doc_id)? {
            recent.page_count
        } else {
            return Err(ApplicationError::DocumentNotOpen(command.document_id));
        };

        let storage_ref: &dyn AnnotationRepository = self.storage.as_ref();
        execute_upsert_annotation(&command, page_count, storage_ref, self.platform.as_ref())
    }

    /// Lists all persistent annotations for a document.
    pub fn list_annotations(&self, document_id: &str) -> Result<Vec<Annotation>, ApplicationError> {
        let storage_ref: &dyn AnnotationRepository = self.storage.as_ref();
        execute_list_annotations(document_id, storage_ref)
    }

    /// Deletes a persistent annotation by ID.
    pub fn delete_annotation(&self, annotation_id: &str) -> Result<bool, ApplicationError> {
        let storage_ref: &dyn AnnotationRepository = self.storage.as_ref();
        execute_delete_annotation(annotation_id, storage_ref)
    }

    /// Exports bookmarks and annotations for `document_id` into a Markdown bundle, optionally
    /// writing it atomically to `destination_path`.
    pub fn export_annotations(
        &self,
        document_id: &str,
        include_annotations: bool,
        destination_path: Option<&str>,
    ) -> Result<ExportAnnotationsBundleDto, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let title = if let Ok(entry) = self.lookup_session(&doc_id) {
            entry.descriptor.file_name.clone()
        } else if let Some(recent) = self.storage.get(&doc_id)? {
            recent.display_name
        } else {
            return Err(ApplicationError::DocumentNotOpen(document_id.to_owned()));
        };

        let bookmark_repo: &dyn BookmarkRepository = self.storage.as_ref();
        let annotation_repo: &dyn AnnotationRepository = self.storage.as_ref();
        execute_export_annotations_bundle(
            document_id,
            &title,
            include_annotations,
            destination_path,
            bookmark_repo,
            annotation_repo,
            self.platform.as_ref(),
        )
    }

    /// Returns the current application settings.
    pub fn get_settings(&self) -> Result<AppSettings, ApplicationError> {
        execute_get_settings(self.storage.as_ref())
    }

    /// Applies a partial settings update and resizes the live render cache budget if changed.
    pub fn update_settings(
        &self,
        patch: SettingsPatchDto,
    ) -> Result<AppSettings, ApplicationError> {
        execute_update_settings(patch, self.storage.as_ref(), self.render_cache.as_ref())
    }

    /// Returns privacy-preserving support and packaging diagnostics (SBOM notices, schema version,
    /// active PDF engine, and redacted data directory) without any document contents or user paths.
    pub fn system_diagnostics(&self) -> Result<SystemDiagnosticsDto, ApplicationError> {
        let sqlite_schema_version = self.storage.schema_version()?;
        let pdf_engine_kind = match self.pdf_engine.kind() {
            PdfEngineKind::PdfiumDynamic => "pdfium_dynamic".to_owned(),
            PdfEngineKind::PureRustFallback => "pure_rust_fallback".to_owned(),
        };
        Ok(SystemDiagnosticsDto {
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            target_os: std::env::consts::OS.to_owned(),
            target_arch: std::env::consts::ARCH.to_owned(),
            pdf_engine_kind,
            sqlite_schema_version,
            redacted_data_dir: NativePlatformAdapter::redacted_data_dir_display().to_owned(),
            render_cache_usage_bytes: self.render_cache.current_usage_bytes(),
            third_party_notices: vec![
                ThirdPartyNoticeDto {
                    name: "PDFium".to_owned(),
                    version: "chromium/6723".to_owned(),
                    license: "BSD-3-Clause AND Apache-2.0".to_owned(),
                    role: "Dynamic native PDF rendering engine".to_owned(),
                },
                ThirdPartyNoticeDto {
                    name: "rusqlite + SQLite".to_owned(),
                    version: "0.32".to_owned(),
                    license: "MIT AND Blessing".to_owned(),
                    role: "Local WAL persistence for recents, bookmarks, annotations, and settings"
                        .to_owned(),
                },
                ThirdPartyNoticeDto {
                    name: "Tauri".to_owned(),
                    version: "2.x".to_owned(),
                    license: "MIT OR Apache-2.0".to_owned(),
                    role: "Cross-platform desktop application shell and IPC".to_owned(),
                },
                ThirdPartyNoticeDto {
                    name: "React + TypeScript".to_owned(),
                    version: "19.x / 5.7".to_owned(),
                    license: "MIT AND Apache-2.0".to_owned(),
                    role: "Presentation UI layer".to_owned(),
                },
            ],
        })
    }

    /// Writes a multi-page sample PDF into `target_dir` and returns its path so the user can
    /// immediately test opening, navigating, searching, and bookmarking without external files.
    pub fn create_sample_pdf(&self, target_dir: &Path) -> Result<String, ApplicationError> {
        let sample_path = target_dir.join("Readora-Welcome-Guide.pdf");
        let sample_str = sample_path.to_string_lossy().into_owned();
        let bytes = build_synthetic_pdf_bytes(
            "Readora Desktop Architecture Guide",
            &[
                "Page 1: Welcome to Readora — Local-first Rust + Tauri 2 PDF Reader.",
                "Page 2: Hexagonal Architecture — Domain, Application, and Replaceable Ports.",
                "Page 3: Memory-Bounded LRU Render Cache and Stale Request Cancellation.",
                "Page 4: SQLite Persistence for Recent Documents, Bookmarks, and Preferences.",
                "Page 5: Security and Privacy Baseline — Every PDF Treated as Untrusted Input.",
            ],
            None,
        );
        self.platform.atomic_write_file(&sample_str, &bytes)?;
        Ok(sample_str)
    }

    fn lookup_session(
        &self,
        document_id: &DocumentId,
    ) -> Result<Arc<ActiveDocumentEntry>, ApplicationError> {
        let guard = self
            .sessions
            .read()
            .map_err(|_| ApplicationError::Platform("session registry lock poisoned".to_owned()))?;
        guard
            .get(document_id)
            .cloned()
            .ok_or_else(|| ApplicationError::DocumentNotOpen(document_id.as_str().to_owned()))
    }
}
