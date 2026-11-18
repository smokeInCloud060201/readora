//! Dependency wiring, session management, and command-facing application facade.
//!
//! `AppCore` composes the concrete infrastructure adapters (`PdfiumEngineAdapter`,
//! `SqliteStorage`, `NativePlatformAdapter`, `MemoryRenderCache`, and
//! `GenerationCancellationRegistry`) behind application use cases.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, RwLock};

use app_application::{
    AnnotationRepository, AppCleanupReportDto, AppUpdateStatusDto, ApplicationError,
    BookmarkRepository, DocumentSessionDto, ExportAnnotationsBundleDto, NavigationAction,
    OpenDocumentRequest, PlatformPort, RecentDocumentRepository, ReleaseManifestDto,
    RenderCachePort, RenderCancellationPort, RenderPageCommand, RenderedPageResultDto,
    SearchRequestDto, SettingsPatchDto, SettingsRepository, SystemDiagnosticsDto,
    ThirdPartyNoticeDto, UpsertAnnotationCommand, UpsertBookmarkCommand, apply_navigation_action,
    build_recent_snapshot_for_navigation, execute_delete_annotation, execute_delete_bookmark,
    execute_export_annotations_bundle, execute_get_settings, execute_list_annotations,
    execute_list_bookmarks, execute_open_document, execute_render_page_cancellable,
    execute_search_document, execute_update_settings, execute_upsert_annotation,
    execute_upsert_bookmark, is_allowed_github_download_url,
};
use app_domain::{
    Annotation, AppSettings, Bookmark, DEFAULT_CACHE_BUDGET_BYTES, DocumentDescriptor, DocumentId,
    OutlineNode, PageIndex, RecentDocument, SearchHit, SemVer, ViewState, compare_semver,
    sanitize_export_stem, sanitize_outline_tree,
};
use app_infrastructure::{GenerationCancellationRegistry, MemoryRenderCache, encode_png_data_url};
use pdf_engine::{OpenDocumentOptions, PdfDocument, PdfEngine, PdfEngineKind};
use pdfium_adapter::{PdfiumEngineAdapter, build_synthetic_pdf_bytes};
use platform::NativePlatformAdapter;
use sha2::{Digest, Sha256};
use storage::SqliteStorage;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_ACTIVE_SESSIONS: usize = 16;
static EPHEMERAL_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(1);
static SESSION_ACCESS_SEQ: AtomicU64 = AtomicU64::new(1);

struct ActiveDocumentEntry {
    canonical_path: String,
    descriptor: RwLock<DocumentDescriptor>,
    outline: Vec<OutlineNode>,
    view_state: Mutex<ViewState>,
    document: Arc<dyn PdfDocument>,
    last_access_seq: AtomicU64,
}

impl ActiveDocumentEntry {
    fn touch(&self) {
        let seq = SESSION_ACCESS_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
        self.last_access_seq.store(seq, AtomicOrdering::Relaxed);
    }

    fn effective_page_count(&self) -> u32 {
        self.descriptor.read().map(|d| d.page_count).unwrap_or(1)
    }
}

/// Primary application facade shared by the desktop composition root.
pub struct AppCore {
    pdf_engine: Arc<dyn PdfEngine>,
    platform: Arc<dyn PlatformPort>,
    storage: Arc<SqliteStorage>,
    render_cache: Arc<MemoryRenderCache>,
    cancellation: Arc<GenerationCancellationRegistry>,
    sessions: RwLock<HashMap<DocumentId, Arc<ActiveDocumentEntry>>>,
    recent_persist_lock: Mutex<()>,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    library_pdfs_dir: PathBuf,
    is_ephemeral: bool,
}

impl Drop for AppCore {
    fn drop(&mut self) {
        if self.is_ephemeral {
            let _ = NativePlatformAdapter::cleanup_live_app_artifacts(
                &self.data_dir,
                &self.cache_dir,
                false,
            );
            if let Some(ephemeral_root) = self.data_dir.parent() {
                let _ = self
                    .platform
                    .remove_empty_dir_if_exists(&ephemeral_root.to_string_lossy());
            }
        }
    }
}

impl AppCore {
    /// Initializes `AppCore` using the OS application data and cache directories for SQLite persistence.
    pub fn new_default() -> Result<Self, ApplicationError> {
        let data_dir = NativePlatformAdapter::resolve_app_data_dir();
        let cache_dir = NativePlatformAdapter::resolve_app_cache_dir();
        let db_path = data_dir.join("readora.sqlite");
        let storage = Arc::new(SqliteStorage::open(&db_path)?);
        Self::with_storage_and_dirs(storage, data_dir, cache_dir, false)
    }

    /// Initializes `AppCore` with an in-memory SQLite database and an isolated unique temporary
    /// directory tree so tests never touch the user's real OS application data directory.
    pub fn new_in_memory() -> Result<Self, ApplicationError> {
        let storage = Arc::new(SqliteStorage::open_in_memory()?);
        let adapter = NativePlatformAdapter::new();
        let seq = EPHEMERAL_INSTANCE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let mut hasher = Sha256::new();
        hasher.update(std::process::id().to_le_bytes());
        hasher.update(adapter.current_unix_ms().to_le_bytes());
        hasher.update(seq.to_le_bytes());
        let digest = hasher.finalize();
        let mut suffix = String::with_capacity(16);
        for byte in &digest[..8] {
            use std::fmt::Write as _;
            let _ = write!(&mut suffix, "{byte:02x}");
        }

        let ephemeral_root = std::env::temp_dir().join(format!("readora-mem-{suffix}"));
        let data_dir = ephemeral_root.join("readora-data");
        let cache_dir = ephemeral_root.join("readora-cache");
        Self::with_storage_and_dirs(storage, data_dir, cache_dir, true)
    }

    fn with_storage_and_dirs(
        storage: Arc<SqliteStorage>,
        data_dir: PathBuf,
        cache_dir: PathBuf,
        is_ephemeral: bool,
    ) -> Result<Self, ApplicationError> {
        let initial_budget = match SettingsRepository::load(storage.as_ref()) {
            Ok(mut settings) => {
                let budget = settings.render_cache_budget_bytes;
                if settings.staged_update_version.is_some()
                    || settings.installed_version.as_deref() != Some(APP_VERSION)
                {
                    let upgraded_from_opt_in_era = match settings.installed_version.as_deref() {
                        Some(prev) => {
                            app_domain::compare_semver(prev, "1.1.2").is_lt()
                                && app_domain::compare_semver(APP_VERSION, prev).is_gt()
                        }
                        None => true,
                    };
                    if upgraded_from_opt_in_era {
                        settings.auto_check_updates = true;
                    }
                    settings.installed_version = Some(APP_VERSION.to_owned());
                    settings.staged_update_version = None;
                    SettingsRepository::save(storage.as_ref(), &settings)?;
                }
                budget
            }
            Err(err) => {
                tracing::warn!(
                    "failed to load persisted settings during startup; resetting to defaults: {err}"
                );
                let defaults = AppSettings {
                    installed_version: Some(APP_VERSION.to_owned()),
                    ..AppSettings::default()
                };
                if let Err(save_err) = SettingsRepository::save(storage.as_ref(), &defaults) {
                    tracing::warn!("failed to persist reset default settings: {save_err}");
                }
                DEFAULT_CACHE_BUDGET_BYTES
            }
        };
        let library_pdfs_dir = data_dir.join("library").join("pdfs");

        Ok(Self {
            pdf_engine: Arc::new(PdfiumEngineAdapter::new_with_fallback(None)),
            platform: Arc::new(NativePlatformAdapter::new()),
            storage,
            render_cache: Arc::new(MemoryRenderCache::new(initial_budget)),
            cancellation: Arc::new(GenerationCancellationRegistry::new()),
            sessions: RwLock::new(HashMap::new()),
            recent_persist_lock: Mutex::new(()),
            data_dir,
            cache_dir,
            library_pdfs_dir,
            is_ephemeral,
        })
    }

    fn effective_version(settings: &AppSettings) -> String {
        if let Some(installed) = settings
            .installed_version
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            && compare_semver(installed, APP_VERSION) == Ordering::Greater
        {
            return installed.to_owned();
        }
        APP_VERSION.to_owned()
    }

    /// Returns which PDF engine runtime is currently active (`pdfium_dynamic` or `pure_rust_fallback`).
    #[must_use]
    pub fn engine_kind(&self) -> PdfEngineKind {
        self.pdf_engine.kind()
    }

    /// Imports raw PDF bytes selected via a drag-and-drop or file-input workflow into Readora's
    /// local library directory, validates them, and opens a persistent document session.
    pub fn import_document_bytes(
        &self,
        file_name: &str,
        bytes: &[u8],
        password: Option<String>,
    ) -> Result<DocumentSessionDto, ApplicationError> {
        if bytes.is_empty() {
            return Err(ApplicationError::Platform("PDF file is empty".to_owned()));
        }
        let max_size = OpenDocumentOptions::default().effective_max_file_size();
        if (bytes.len() as u64) > max_size {
            return Err(ApplicationError::FileTooLarge {
                size_bytes: bytes.len() as u64,
                max_bytes: max_size,
            });
        }

        // Validate PDF structure & password in memory first so invalid uploads or wrong passwords
        // never write temporary files or interfere with an already-imported document.
        let open_opts = OpenDocumentOptions {
            password,
            max_file_size_bytes: max_size,
        };
        let document = self.pdf_engine.open_bytes(bytes, &open_opts)?;

        let safe_file_name = sanitize_pdf_filename(file_name);
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let digest = hasher.finalize();
        let mut hash_prefix = String::with_capacity(32);
        for byte in &digest[..16] {
            use std::fmt::Write as _;
            let _ = write!(&mut hash_prefix, "{byte:02x}");
        }

        let target_dir = self.library_pdfs_dir.join(&hash_prefix);
        let target_path = target_dir.join(&safe_file_name);
        let target_str = target_path.to_string_lossy().into_owned();
        if !target_path.exists() {
            self.platform.atomic_write_file(&target_str, bytes)?;
        }

        let file_info = self
            .platform
            .resolve_and_validate_pdf_path(&target_str, max_size)?;
        self.register_opened_document(file_info, document)
    }

    /// Reads the raw PDF bytes for a known open or persisted library document.
    pub fn read_document_bytes(&self, document_id: &str) -> Result<Vec<u8>, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let raw_path = if let Ok(entry) = self.lookup_session(&doc_id) {
            entry.canonical_path.clone()
        } else if let Some(recent) = self.storage.get(&doc_id)? {
            recent.file_path
        } else {
            return Err(ApplicationError::DocumentNotOpen(document_id.to_owned()));
        };

        let max_size = OpenDocumentOptions::default().effective_max_file_size();
        let resolved = self
            .platform
            .resolve_and_validate_pdf_path(&raw_path, max_size)?;
        self.platform
            .read_file_bytes(&resolved.canonical_path, max_size)
    }

    /// Reads the currently staged release manifest on disk, if present.
    pub fn read_staged_update_manifest(
        &self,
    ) -> Result<Option<ReleaseManifestDto>, ApplicationError> {
        NativePlatformAdapter::read_release_manifest_in(&self.data_dir)
    }

    /// Opens a local PDF document, invalidates any stale cached bitmaps from prior edits,
    /// restores its last reading state, and registers an active session.
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

        self.insert_opened_session(
            opened.file_info.canonical_path,
            opened.session,
            opened.document,
        )
    }

    fn register_opened_document(
        &self,
        file_info: app_application::ResolvedFileInfo,
        document: Box<dyn PdfDocument>,
    ) -> Result<DocumentSessionDto, ApplicationError> {
        use app_domain::FitMode;

        let engine_info = document.info().clone();
        let descriptor = DocumentDescriptor::new(
            file_info.document_id.clone(),
            file_info.display_name.clone(),
            file_info.file_size_bytes,
            engine_info.page_count,
            engine_info.metadata,
        )?;

        let settings = match SettingsRepository::load(self.storage.as_ref()) {
            Ok(loaded) => loaded,
            Err(err) => {
                tracing::warn!(
                    "failed to load persisted settings during register_opened_document; falling back to defaults: {err}"
                );
                AppSettings::default()
            }
        };

        let mut view_state = ViewState::new(file_info.document_id.clone(), descriptor.page_count)?;
        view_state.layout_mode = settings.default_layout;
        view_state.fit_mode = settings.default_fit_mode;
        view_state.zoom = settings.default_zoom;

        let previous =
            RecentDocumentRepository::get(self.storage.as_ref(), &file_info.document_id)?;
        if let Some(ref prev) = previous
            && settings.remember_page_position
        {
            let clamped_page = prev
                .last_page
                .zero_based()
                .min(descriptor.page_count.saturating_sub(1));
            let _ = view_state.go_to_page(PageIndex::new(clamped_page));
            view_state.zoom = prev.last_zoom;
            view_state.fit_mode = prev.last_fit_mode.unwrap_or_else(|| {
                if (prev.last_zoom.factor() - settings.default_zoom.factor()).abs() > f32::EPSILON {
                    FitMode::Manual
                } else {
                    settings.default_fit_mode
                }
            });
            if let Some(layout_mode) = prev.last_layout_mode {
                view_state.layout_mode = layout_mode;
            }
            view_state.rotation = prev.last_rotation;
        }

        let now_ms = self.platform.current_unix_ms();
        let mut recent_entry = RecentDocument::from_view_state(
            &file_info.canonical_path,
            &descriptor.file_name,
            &view_state,
            now_ms,
        );
        if let Some(prev) = previous {
            recent_entry.is_favorite = prev.is_favorite;
            recent_entry.is_archived = prev.is_archived;
        }
        RecentDocumentRepository::upsert(self.storage.as_ref(), &recent_entry)?;

        let raw_outline = match document.outline() {
            Ok(nodes) => nodes,
            Err(err) => {
                tracing::debug!("failed to extract PDF outline; falling back to empty: {err}");
                Vec::new()
            }
        };
        let outline = sanitize_outline_tree(raw_outline);
        let bookmarks =
            BookmarkRepository::list_for_document(self.storage.as_ref(), &file_info.document_id)?;

        let session = DocumentSessionDto {
            descriptor,
            view_state,
            outline,
            bookmarks,
            generation: 0,
        };

        self.insert_opened_session(file_info.canonical_path, session, document)
    }

    fn insert_opened_session(
        &self,
        canonical_path: String,
        mut session: DocumentSessionDto,
        document: Box<dyn PdfDocument>,
    ) -> Result<DocumentSessionDto, ApplicationError> {
        let doc_id = session.descriptor.id.clone();
        let doc_arc: Arc<dyn PdfDocument> = Arc::from(document);

        let entry = Arc::new(ActiveDocumentEntry {
            canonical_path,
            descriptor: RwLock::new(session.descriptor.clone()),
            outline: session.outline.clone(),
            view_state: Mutex::new(session.view_state.clone()),
            document: doc_arc,
            last_access_seq: AtomicU64::new(
                SESSION_ACCESS_SEQ.fetch_add(1, AtomicOrdering::Relaxed),
            ),
        });

        let mut evicted_ids = Vec::new();
        let generation = {
            let mut guard = self.sessions.write().map_err(|_| {
                ApplicationError::Platform("session registry lock poisoned".to_owned())
            })?;
            while guard.len() >= MAX_ACTIVE_SESSIONS && !guard.contains_key(&doc_id) {
                let oldest_id = guard
                    .iter()
                    .min_by_key(|(_, e)| e.last_access_seq.load(AtomicOrdering::Relaxed))
                    .map(|(id, _)| id.clone());
                if let Some(evict_id) = oldest_id {
                    guard.remove(&evict_id);
                    evicted_ids.push(evict_id);
                } else {
                    break;
                }
            }
            self.render_cache.invalidate_document(&doc_id);
            let assigned_gen = self.cancellation.next_generation(&doc_id);
            guard.insert(doc_id, entry);
            assigned_gen
        };

        for evict_id in &evicted_ids {
            self.cancellation.clear_document(evict_id);
            self.render_cache.invalidate_document(evict_id);
        }

        session.generation = generation;
        Ok(session)
    }

    /// Closes an open document session, invalidating its cached bitmaps and cancelling in-flight renders.
    pub fn close_document(&self, document_id: &str) -> Result<(), ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let mut guard = self
            .sessions
            .write()
            .map_err(|_| ApplicationError::Platform("session registry lock poisoned".to_owned()))?;
        guard.remove(&doc_id);
        drop(guard);
        self.cancellation.clear_document(&doc_id);
        self.render_cache.invalidate_document(&doc_id);
        Ok(())
    }

    /// Synchronizes an upward `page_count` discovered by the WebView `pdfjs-dist` renderer
    /// when Rust is running in `PureRustFallback` mode, eliminating page-bounds split-brain (`[CRIT-01]`).
    pub fn sync_document_page_count(
        &self,
        document_id: &str,
        reported_page_count: u32,
    ) -> Result<ViewState, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let entry = self.lookup_session(&doc_id)?;
        entry.touch();

        let clamped_reported = reported_page_count.clamp(1, 10_000);
        if self.pdf_engine.kind() != PdfEngineKind::PureRustFallback {
            let state = entry
                .view_state
                .lock()
                .map_err(|_| ApplicationError::Platform("view state lock poisoned".to_owned()))?
                .clone();
            return Ok(state);
        }

        {
            let mut desc_guard = entry
                .descriptor
                .write()
                .map_err(|_| ApplicationError::Platform("descriptor lock poisoned".to_owned()))?;
            if clamped_reported > desc_guard.page_count {
                desc_guard.page_count = clamped_reported;
            }
        }

        let updated_state = {
            let mut state_guard = entry
                .view_state
                .lock()
                .map_err(|_| ApplicationError::Platform("view state lock poisoned".to_owned()))?;
            if clamped_reported > state_guard.page_count {
                state_guard.page_count = clamped_reported;
            }
            state_guard.clone()
        };

        let _persist_guard = self
            .recent_persist_lock
            .lock()
            .map_err(|_| ApplicationError::Platform("recent persist lock poisoned".to_owned()))?;
        let still_open = self
            .sessions
            .read()
            .map(|g| g.contains_key(&doc_id))
            .unwrap_or(false);
        if still_open
            && let Ok(recent) = build_recent_snapshot_for_navigation(
                &entry.canonical_path,
                &entry
                    .descriptor
                    .read()
                    .map(|d| d.file_name.clone())
                    .unwrap_or_else(|_| "Document.pdf".to_owned()),
                &updated_state,
                self.storage.as_ref(),
                self.storage.as_ref(),
                self.platform.current_unix_ms(),
            )
        {
            RecentDocumentRepository::upsert(self.storage.as_ref(), &recent)?;
        }

        Ok(updated_state)
    }

    /// Returns the current session snapshot for an open document.
    pub fn get_document_session(
        &self,
        document_id: &str,
    ) -> Result<DocumentSessionDto, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let entry = self.lookup_session(&doc_id)?;
        entry.touch();
        let descriptor = entry
            .descriptor
            .read()
            .map_err(|_| ApplicationError::Platform("descriptor lock poisoned".to_owned()))?
            .clone();
        let view_state = entry
            .view_state
            .lock()
            .map_err(|_| ApplicationError::Platform("view state lock poisoned".to_owned()))?
            .clone();
        let bookmarks = BookmarkRepository::list_for_document(self.storage.as_ref(), &doc_id)?;
        let generation = self.cancellation.current_generation(&doc_id);

        Ok(DocumentSessionDto {
            descriptor,
            view_state,
            outline: entry.outline.clone(),
            bookmarks,
            generation,
        })
    }

    /// Applies a navigation or viewport mutation to an open document, cancels obsolete renders,
    /// and updates the persisted recent document position without holding the session mutex across disk I/O.
    pub fn navigate(
        &self,
        document_id: &str,
        action: NavigationAction,
    ) -> Result<ViewState, ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let entry = self.lookup_session(&doc_id)?;
        entry.touch();

        let (updated_state, changed) = {
            let mut state_guard = entry
                .view_state
                .lock()
                .map_err(|_| ApplicationError::Platform("view state lock poisoned".to_owned()))?;

            let (updated, _gen, changed) =
                apply_navigation_action(&mut state_guard, action, self.cancellation.as_ref())?;
            (updated, changed)
        };

        if !changed {
            return Ok(updated_state);
        }

        let display_name = entry
            .descriptor
            .read()
            .map(|d| d.file_name.clone())
            .unwrap_or_else(|_| "Document.pdf".to_owned());

        let _persist_guard = self
            .recent_persist_lock
            .lock()
            .map_err(|_| ApplicationError::Platform("recent persist lock poisoned".to_owned()))?;
        let still_open = self
            .sessions
            .read()
            .map(|g| g.contains_key(&doc_id))
            .unwrap_or(false);
        if still_open {
            let recent = build_recent_snapshot_for_navigation(
                &entry.canonical_path,
                &display_name,
                &updated_state,
                self.storage.as_ref(),
                self.storage.as_ref(),
                self.platform.current_unix_ms(),
            )?;
            RecentDocumentRepository::upsert(self.storage.as_ref(), &recent)?;
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
        entry.touch();

        let cancellation_port: Arc<dyn RenderCancellationPort> =
            Arc::clone(&self.cancellation) as Arc<dyn RenderCancellationPort>;
        execute_render_page_cancellable(
            &command,
            entry.document.as_ref(),
            self.render_cache.as_ref(),
            cancellation_port,
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
        entry.touch();
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
        entry.touch();
        let page_count = entry.effective_page_count();
        let validated = PageIndex::within(page_index, page_count)?;
        if page_index >= entry.document.info().page_count {
            return Ok(format!("Page {}", page_index + 1));
        }
        Ok(entry.document.extract_page_text(validated)?)
    }

    /// Lists recently opened documents ordered from most-recently-opened to oldest,
    /// always retaining favorited and archived library entries regardless of `limit`.
    pub fn list_recent_documents(
        &self,
        limit: usize,
    ) -> Result<Vec<RecentDocument>, ApplicationError> {
        RecentDocumentRepository::list_library(self.storage.as_ref(), limit)
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

    /// Permanently removes a document entry from recent/archived library records, closes any
    /// active session, cascades bookmarks/annotations via SQLite triggers, and deletes internal
    /// staged copies inside `library/pdfs` while never touching external user files.
    pub fn delete_recent_document(&self, document_id: &str) -> Result<(), ApplicationError> {
        let doc_id = DocumentId::new(document_id)?;
        let _persist_guard = self
            .recent_persist_lock
            .lock()
            .map_err(|_| ApplicationError::Platform("recent persist lock poisoned".to_owned()))?;
        let existing = self.storage.get(&doc_id)?;
        self.close_document(doc_id.as_str())?;
        self.storage.remove(&doc_id)?;

        if let Some(recent) = existing
            && !Path::new(&recent.file_path)
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            && self
                .platform
                .is_path_within_dir(&recent.file_path, &self.library_pdfs_dir)
        {
            let _ = self.platform.remove_file_if_exists(&recent.file_path);
            if let Some(parent) = Path::new(&recent.file_path).parent() {
                let parent_str = parent.to_string_lossy();
                if self
                    .platform
                    .is_path_within_dir(&parent_str, &self.library_pdfs_dir)
                {
                    let _ = self.platform.remove_empty_dir_if_exists(&parent_str);
                }
            }
        }

        Ok(())
    }

    /// Creates or updates a user bookmark on a page.
    pub fn upsert_bookmark(
        &self,
        command: UpsertBookmarkCommand,
    ) -> Result<Bookmark, ApplicationError> {
        let doc_id = DocumentId::new(&command.document_id)?;
        let page_count = if let Ok(entry) = self.lookup_session(&doc_id) {
            entry.effective_page_count()
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
            entry.effective_page_count()
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
            entry
                .descriptor
                .read()
                .map(|d| d.file_name.clone())
                .unwrap_or_else(|_| "Document.pdf".to_owned())
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
        let settings = self.get_settings()?;
        let app_version = Self::effective_version(&settings);
        let pdf_engine_kind = match self.pdf_engine.kind() {
            PdfEngineKind::PdfiumDynamic => "pdfium_dynamic".to_owned(),
            PdfEngineKind::PureRustFallback => "pure_rust_fallback".to_owned(),
        };
        Ok(SystemDiagnosticsDto {
            app_version,
            target_os: std::env::consts::OS.to_owned(),
            target_arch: std::env::consts::ARCH.to_owned(),
            pdf_engine_kind,
            sqlite_schema_version,
            redacted_data_dir: NativePlatformAdapter::redacted_data_dir_display().to_owned(),
            render_cache_usage_bytes: self.render_cache.current_usage_bytes(),
            third_party_notices: vec![
                ThirdPartyNoticeDto {
                    name: "PDFium".to_owned(),
                    version: "chromium/8165".to_owned(),
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
                    name: "tao + wry".to_owned(),
                    version: "0.31 / 0.48".to_owned(),
                    license: "Apache-2.0 OR MIT".to_owned(),
                    role: "Cross-platform native desktop windowing and OS WebView shell".to_owned(),
                },
                ThirdPartyNoticeDto {
                    name: "pdfjs-dist".to_owned(),
                    version: "6.5".to_owned(),
                    license: "Apache-2.0".to_owned(),
                    role: "Fallback WebView PDF canvas renderer when native PDFium is absent"
                        .to_owned(),
                },
                ThirdPartyNoticeDto {
                    name: "React + TypeScript".to_owned(),
                    version: "19.x / 5.9".to_owned(),
                    license: "MIT AND Apache-2.0".to_owned(),
                    role: "Presentation UI layer".to_owned(),
                },
            ],
        })
    }

    /// Cleans up all Readora-created application data (SQLite database tables/files, render cache,
    /// staged updates, and internal library copies) for uninstall preparation or complete local reset.
    ///
    /// Never modifies or deletes user PDF documents or unrelated files on disk.
    pub fn cleanup_application_data(&self) -> Result<AppCleanupReportDto, ApplicationError> {
        let open_ids: Vec<DocumentId> = {
            let guard = self.sessions.read().map_err(|_| {
                ApplicationError::Platform("session registry lock poisoned".to_owned())
            })?;
            guard.keys().cloned().collect()
        };

        for doc_id in &open_ids {
            self.cancellation.clear_document(doc_id);
            self.render_cache.invalidate_document(doc_id);
        }

        {
            let mut guard = self.sessions.write().map_err(|_| {
                ApplicationError::Platform("session registry lock poisoned".to_owned())
            })?;
            guard.clear();
        }

        self.storage.reset_all_application_tables()?;
        NativePlatformAdapter::cleanup_live_app_artifacts(
            &self.data_dir,
            &self.cache_dir,
            !self.is_ephemeral,
        )
    }

    /// Performs OS-level uninstall cleanup of Readora's default data and cache directories
    /// without opening a database connection first.
    pub fn cleanup_default_app_artifacts() -> Result<AppCleanupReportDto, ApplicationError> {
        NativePlatformAdapter::cleanup_default_app_artifacts()
    }

    /// Evaluates whether a verified application update is available by comparing the installed
    /// version against any staged release manifest on disk.
    pub fn check_for_updates(
        &self,
        include_dismissed: bool,
    ) -> Result<AppUpdateStatusDto, ApplicationError> {
        let settings = self.get_settings()?;
        let github_repo = settings.github_release_repo.clone();
        let current_version = Self::effective_version(&settings);
        let maybe_manifest = NativePlatformAdapter::read_release_manifest_in(&self.data_dir)?;
        let checked_at_unix_ms = self.platform.current_unix_ms();

        if let Some(manifest) = maybe_manifest {
            let is_newer = compare_semver(&manifest.version, &current_version) == Ordering::Greater;
            let is_dismissed = !include_dismissed
                && settings
                    .dismissed_update_version
                    .as_deref()
                    .is_some_and(|dismissed| {
                        compare_semver(dismissed, &manifest.version) == Ordering::Equal
                    });
            let verified = NativePlatformAdapter::is_hex_sha256(&manifest.sha256)
                && manifest.package_size_bytes > 0;

            if is_newer {
                return Ok(AppUpdateStatusDto {
                    current_version,
                    update_available: !is_dismissed && verified,
                    latest_version: Some(manifest.version),
                    release_title: Some(manifest.title),
                    release_notes: Some(manifest.notes),
                    package_size_bytes: if manifest.package_size_bytes > 0 {
                        Some(manifest.package_size_bytes)
                    } else {
                        None
                    },
                    sha256_checksum: if manifest.sha256.trim().is_empty() {
                        None
                    } else {
                        Some(manifest.sha256)
                    },
                    download_url: manifest
                        .download_url
                        .filter(|u| is_allowed_github_download_url(u)),
                    github_repo,
                    verified,
                    staged_for_restart: false,
                    checked_at_unix_ms,
                });
            }
        }

        let staged_for_restart = settings.staged_update_version.is_some();
        Ok(AppUpdateStatusDto {
            current_version: current_version.clone(),
            update_available: false,
            latest_version: Some(current_version),
            release_title: None,
            release_notes: None,
            package_size_bytes: None,
            sha256_checksum: None,
            download_url: None,
            github_repo,
            verified: true,
            staged_for_restart,
            checked_at_unix_ms,
        })
    }

    /// Parses a GitHub `/repos/{owner}/{repo}/releases/latest` JSON payload, stages the manifest
    /// if valid, and returns the updated `AppUpdateStatusDto`.
    pub fn stage_github_release_json(
        &self,
        raw_json: &str,
    ) -> Result<AppUpdateStatusDto, ApplicationError> {
        let manifest =
            NativePlatformAdapter::parse_github_release_json(raw_json, std::env::consts::OS)?;
        self.stage_update_manifest(manifest)
    }

    /// Stages a release manifest into the Readora updates directory and evaluates update status.
    pub fn stage_update_manifest(
        &self,
        manifest: ReleaseManifestDto,
    ) -> Result<AppUpdateStatusDto, ApplicationError> {
        let normalized_manifest_ver = manifest
            .version
            .trim()
            .trim_start_matches(['v', 'V'])
            .trim()
            .to_owned();
        let _ = SemVer::parse(&normalized_manifest_ver)?;
        if let Some(ref url) = manifest.download_url
            && !is_allowed_github_download_url(url)
        {
            return Err(ApplicationError::Platform(
                "release manifest download_url must be a valid https:// GitHub URL".to_owned(),
            ));
        }

        let adapter = NativePlatformAdapter::new();
        adapter.stage_release_manifest_in(&self.data_dir, &manifest)?;

        let _ = SettingsRepository::update(self.storage.as_ref(), &mut |settings| {
            if settings.dismissed_update_version.as_deref()
                == Some(normalized_manifest_ver.as_str())
            {
                settings.dismissed_update_version = None;
            }
            Ok(())
        })?;

        self.check_for_updates(true)
    }

    /// Applies a verified staged update by verifying that `release-manifest.json` matches
    /// `target_version` with a valid SHA-256 hex digest, recording the new installed version in
    /// SQLite settings, and cleaning up the staged manifest.
    pub fn install_update(
        &self,
        target_version: &str,
    ) -> Result<AppUpdateStatusDto, ApplicationError> {
        let trimmed = target_version.trim().trim_start_matches(['v', 'V']).trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::Platform(
                "target update version must not be empty".to_owned(),
            ));
        }
        let _ = SemVer::parse(trimmed)?;

        let staged_manifest = NativePlatformAdapter::read_release_manifest_in(&self.data_dir)?
            .ok_or_else(|| {
                ApplicationError::Platform(
                    "cannot install update: no staged release manifest found".to_owned(),
                )
            })?;

        let staged_version = staged_manifest
            .version
            .trim()
            .trim_start_matches(['v', 'V'])
            .trim();
        if staged_version != trimmed {
            return Err(ApplicationError::Platform(format!(
                "staged manifest version '{staged_version}' does not match requested version '{trimmed}'"
            )));
        }

        staged_manifest.validate()?;

        let updated_settings = SettingsRepository::update(
            self.storage.as_ref(),
            &mut |settings| {
                let current_version = Self::effective_version(settings);
                if compare_semver(trimmed, &current_version) != Ordering::Greater {
                    return Err(ApplicationError::Platform(format!(
                        "target version {trimmed} is not newer than current version {current_version}"
                    )));
                }
                settings.installed_version = Some(trimmed.to_owned());
                settings.staged_update_version = Some(trimmed.to_owned());
                settings.dismissed_update_version = None;
                Ok(())
            },
        )?;

        let _ = NativePlatformAdapter::clear_staged_release_manifest_in(&self.data_dir);

        Ok(AppUpdateStatusDto {
            current_version: trimmed.to_owned(),
            update_available: false,
            latest_version: Some(trimmed.to_owned()),
            release_title: None,
            release_notes: None,
            package_size_bytes: None,
            sha256_checksum: None,
            download_url: None,
            github_repo: updated_settings.github_release_repo,
            verified: true,
            staged_for_restart: true,
            checked_at_unix_ms: self.platform.current_unix_ms(),
        })
    }

    /// Defers notification for a specific update version until the user manually checks for updates
    /// or a newer release arrives.
    pub fn dismiss_update(&self, version: &str) -> Result<AppUpdateStatusDto, ApplicationError> {
        let raw_trimmed = version.trim();
        let next_dismissed = if raw_trimmed.is_empty() {
            None
        } else {
            let normalized = raw_trimmed.trim_start_matches(['v', 'V']).trim();
            let _ = SemVer::parse(normalized)?;
            Some(normalized.to_owned())
        };
        let _ = SettingsRepository::update(self.storage.as_ref(), &mut |settings| {
            settings.dismissed_update_version = next_dismissed.clone();
            Ok(())
        })?;
        self.check_for_updates(false)
    }

    /// Creates and opens Readora's built-in sample PDF inside the application's private `samples`
    /// data directory rather than a shared world-writable `/tmp` folder.
    pub fn open_sample_document(&self) -> Result<DocumentSessionDto, ApplicationError> {
        let sample_dir = self.data_dir.join("samples");
        let sample_path = self.create_sample_pdf(&sample_dir)?;
        self.open_document(OpenDocumentRequest {
            path: sample_path,
            password: None,
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

fn sanitize_pdf_filename(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("Document.pdf")
        .trim();
    let without_ext = if base.len() >= 4
        && base.is_char_boundary(base.len() - 4)
        && base[base.len() - 4..].eq_ignore_ascii_case(".pdf")
    {
        &base[..base.len() - 4]
    } else {
        base
    };
    let stem = sanitize_export_stem(without_ext);
    format!("{stem}.pdf")
}

#[cfg(test)]
mod tests {
    use app_domain::Rotation;

    use super::*;

    #[test]
    fn sanitize_pdf_filename_preserves_unicode_and_guards_windows_reserved_names() {
        assert_eq!(
            sanitize_pdf_filename("Imported Study.pdf"),
            "Imported Study.pdf"
        );
        assert_eq!(sanitize_pdf_filename("CON.pdf"), "doc_CON.pdf");
        assert_eq!(sanitize_pdf_filename("nul"), "doc_nul.pdf");
        assert_eq!(
            sanitize_pdf_filename("日本語の設計書.PDF"),
            "日本語の設計書.pdf"
        );

        let huge = format!("{}.pdf", "あ".repeat(100));
        let sanitized = sanitize_pdf_filename(&huge);
        assert!(sanitized.len() <= 128);
        assert!(sanitized.ends_with(".pdf"));
    }

    #[test]
    fn delete_recent_document_never_deletes_external_file_via_dotdot_traversal() {
        let ext_dir = tempfile::tempdir().unwrap();
        let outside_pdf = ext_dir.path().join("outside-victim.pdf");
        std::fs::write(
            &outside_pdf,
            build_synthetic_pdf_bytes("Victim", &["Important user file"], None),
        )
        .unwrap();

        let core = AppCore::new_in_memory().unwrap();
        // `library/pdfs` does NOT exist on disk yet!
        assert!(!core.library_pdfs_dir.exists());

        // Construct a malicious `file_path` starting with `library/pdfs` followed by `..` traversal
        // to `outside_pdf`.
        let depth = core.library_pdfs_dir.components().count();
        let up_segments = vec![".."; depth].join("/");
        let rel_outside = outside_pdf
            .to_string_lossy()
            .trim_start_matches('/')
            .to_owned();
        let traversal_path = format!(
            "{}/{up_segments}/{rel_outside}",
            core.library_pdfs_dir.to_string_lossy()
        );

        let fake_id = DocumentId::new("doc-traversal-attack").unwrap();
        let view = ViewState::new(fake_id.clone(), 1).unwrap();
        let malicious_recent =
            RecentDocument::from_view_state(&traversal_path, "victim.pdf", &view, 1_000);
        RecentDocumentRepository::upsert(core.storage.as_ref(), &malicious_recent).unwrap();

        core.delete_recent_document(fake_id.as_str()).unwrap();
        assert!(
            outside_pdf.exists(),
            "external file must NEVER be deleted via '..' traversal when library/pdfs is missing"
        );

        // Repeat when `library/pdfs` DOES exist on disk
        std::fs::create_dir_all(&core.library_pdfs_dir).unwrap();
        RecentDocumentRepository::upsert(core.storage.as_ref(), &malicious_recent).unwrap();
        core.delete_recent_document(fake_id.as_str()).unwrap();
        assert!(
            outside_pdf.exists(),
            "external file must NEVER be deleted via '..' traversal when library/pdfs exists"
        );
    }

    #[test]
    fn failed_encrypted_import_cleans_staged_file_and_cold_restart_reconciles_version() {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_dir = temp_dir.path().join("com.readora.desktop");
        let cache_dir = temp_dir.path().join("readora-cache");
        let db_path = data_dir.join("readora.sqlite");
        let storage = Arc::new(SqliteStorage::open(&db_path).unwrap());

        let core = AppCore::with_storage_and_dirs(
            Arc::clone(&storage),
            data_dir.clone(),
            cache_dir.clone(),
            false,
        )
        .unwrap();

        // 1. Importing encrypted PDF without password fails and leaves ZERO orphaned files in library/pdfs
        let enc_bytes =
            build_synthetic_pdf_bytes("Encrypted Import", &["Secret"], Some("correct-pw"));
        let err = core
            .import_document_bytes("confidential.pdf", &enc_bytes, None)
            .unwrap_err();
        assert!(err.to_string().contains("password-protected"));

        if core.library_pdfs_dir.exists() {
            let leftover: Vec<_> = std::fs::read_dir(&core.library_pdfs_dir)
                .unwrap()
                .flatten()
                .collect();
            assert!(
                leftover.is_empty(),
                "expected zero orphaned entries in library/pdfs after failed import, got {leftover:?}"
            );
        }

        // Importing with correct password succeeds, and a subsequent failed re-import preserves the owned file
        let imported = core
            .import_document_bytes(
                "confidential.pdf",
                &enc_bytes,
                Some("correct-pw".to_owned()),
            )
            .unwrap();
        let owned_path = core.list_recent_documents(5).unwrap()[0].file_path.clone();
        assert!(Path::new(&owned_path).is_file());
        assert!(
            core.import_document_bytes("confidential.pdf", &enc_bytes, None)
                .is_err()
        );
        assert!(Path::new(&owned_path).is_file());

        // 2. remember_page_position == false prevents navigate() from persisting page/zoom/rotation
        let sample_path = core.create_sample_pdf(temp_dir.path()).unwrap();
        let sample_session = core
            .open_document(OpenDocumentRequest {
                path: sample_path,
                password: None,
            })
            .unwrap();
        let sample_id = sample_session.descriptor.id.as_str().to_owned();
        core.update_settings(SettingsPatchDto {
            remember_page_position: Some(false),
            ..SettingsPatchDto::default()
        })
        .unwrap();
        let nav = core
            .navigate(&sample_id, NavigationAction::GoToPage(3))
            .unwrap();
        assert_eq!(nav.current_page.zero_based(), 3);
        let _ = core
            .navigate(&sample_id, NavigationAction::RotateClockwise)
            .unwrap();
        let sample_recent = core
            .list_recent_documents(10)
            .unwrap()
            .into_iter()
            .find(|r| r.document_id.as_str() == sample_id)
            .unwrap();
        assert_eq!(sample_recent.last_page, PageIndex::FIRST);
        assert_eq!(sample_recent.last_rotation, Rotation::Deg0);
        let _ = imported;

        // 3. dismiss_update strips leading 'v'/'V' and validates SemVer; install_update validates manifest
        core.stage_update_manifest(ReleaseManifestDto {
            version: "9.8.0".to_owned(),
            title: "Zero Size".to_owned(),
            notes: "Invalid zero size".to_owned(),
            package_size_bytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
            published_at: "2026-11-17T00:00:00Z".to_owned(),
            download_url: None,
        })
        .unwrap();
        assert!(core.install_update("9.8.0").is_err());

        core.stage_update_manifest(ReleaseManifestDto {
            version: "9.8.0".to_owned(),
            title: "Release 9.8.0".to_owned(),
            notes: "Valid".to_owned(),
            package_size_bytes: 2048,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
            published_at: "2026-11-17T00:00:00Z".to_owned(),
            download_url: Some(
                "https://github.com/smokeInCloud060201/readora/releases/tag/v9.8.0".to_owned(),
            ),
        })
        .unwrap();
        assert!(core.dismiss_update("not-a-semver").is_err());
        let dismissed = core.dismiss_update("v9.8.0").unwrap();
        assert!(!dismissed.update_available);

        let installed = core.install_update("v9.8.0").unwrap();
        assert_eq!(installed.current_version, "9.8.0");
        assert!(installed.staged_for_restart);
        assert!(core.check_for_updates(false).unwrap().staged_for_restart);
        assert_eq!(core.system_diagnostics().unwrap().app_version, "9.8.0");

        // 4. Cold restart (re-constructing AppCore over persisted storage) reconciles version to APP_VERSION!
        drop(core);
        let restarted =
            AppCore::with_storage_and_dirs(storage, data_dir, cache_dir, false).unwrap();
        assert_eq!(
            restarted.system_diagnostics().unwrap().app_version,
            APP_VERSION
        );
        let post_restart_update = restarted.check_for_updates(false).unwrap();
        assert_eq!(post_restart_update.current_version, APP_VERSION);
        assert!(!post_restart_update.staged_for_restart);

        // 5. Upgrading from pre-1.1.2 (e.g. 1.1.0) enables auto_check_updates once, while preserving future opt-outs
        let mut legacy_settings = SettingsRepository::load(restarted.storage.as_ref()).unwrap();
        legacy_settings.installed_version = Some("1.1.0".to_owned());
        legacy_settings.auto_check_updates = false;
        SettingsRepository::save(restarted.storage.as_ref(), &legacy_settings).unwrap();
        let storage_for_upgrade = Arc::clone(&restarted.storage);
        let data_for_upgrade = restarted.data_dir.clone();
        let cache_for_upgrade = restarted.cache_dir.clone();
        drop(restarted);

        let upgraded = AppCore::with_storage_and_dirs(
            Arc::clone(&storage_for_upgrade),
            data_for_upgrade.clone(),
            cache_for_upgrade.clone(),
            false,
        )
        .unwrap();
        assert!(upgraded.get_settings().unwrap().auto_check_updates);

        // Once on the current version, disabling auto_check_updates persists across restarts
        upgraded
            .update_settings(SettingsPatchDto {
                auto_check_updates: Some(false),
                ..SettingsPatchDto::default()
            })
            .unwrap();
        drop(upgraded);
        let opted_out = AppCore::with_storage_and_dirs(
            storage_for_upgrade,
            data_for_upgrade,
            cache_for_upgrade,
            false,
        )
        .unwrap();
        assert!(!opted_out.get_settings().unwrap().auto_check_updates);
    }
}
