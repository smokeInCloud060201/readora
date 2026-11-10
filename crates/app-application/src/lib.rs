//! Application use cases, orchestration, ports, and boundary DTOs for Readora.
//!
//! This crate depends only on `app-domain` and `pdf-engine` contracts, never on
//! concrete storage, platform, PDFium, or UI implementations.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod dto;
pub mod error;
pub mod ports;
pub mod use_cases;

pub use dto::{
    DocumentSessionDto, NavigationAction, OpenDocumentRequest, RenderPageCommand,
    RenderedPageResultDto, SearchRequestDto, SettingsPatchDto, UpsertBookmarkCommand,
};
pub use error::ApplicationError;
pub use ports::platform::{PlatformPort, ResolvedFileInfo};
pub use ports::render_cache::{
    CachedPageEntry, RenderCacheKey, RenderCachePort, RenderCancellationPort,
};
pub use ports::storage::{BookmarkRepository, RecentDocumentRepository, SettingsRepository};
pub use use_cases::bookmarks::{
    execute_delete_bookmark, execute_list_bookmarks, execute_upsert_bookmark,
};
pub use use_cases::navigate_view::execute_navigation_action;
pub use use_cases::open_document::{OpenedDocumentSession, execute_open_document};
pub use use_cases::render_page::execute_render_page;
pub use use_cases::search::{DEFAULT_MAX_SEARCH_HITS, execute_search_document};
pub use use_cases::settings::{execute_get_settings, execute_update_settings};

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;

    use app_domain::{
        AppSettings, Bookmark, BookmarkId, DocumentId, DocumentMetadata, OutlineNode,
        PageDimensions, PageIndex, RecentDocument, RenderMode, Rotation, SearchHit,
        ThemePreference,
    };
    use pdf_engine::{
        EngineDocumentInfo, OpenDocumentOptions, PageGeometry, PdfDocument, PdfEngine,
        PdfEngineError, PdfEngineKind, RenderPageRequest, RenderedPage,
    };

    use super::*;

    struct FakePdfDocument {
        info: EngineDocumentInfo,
    }

    impl PdfDocument for FakePdfDocument {
        fn info(&self) -> &EngineDocumentInfo {
            &self.info
        }

        fn page_geometry(&self, page_index: PageIndex) -> Result<PageGeometry, PdfEngineError> {
            Ok(PageGeometry {
                page_index,
                dimensions: PageDimensions::US_LETTER,
                intrinsic_rotation: Rotation::Deg0,
            })
        }

        fn outline(&self) -> Result<Vec<OutlineNode>, PdfEngineError> {
            Ok(vec![OutlineNode {
                title: "Introduction".to_owned(),
                page_index: Some(PageIndex::FIRST),
                children: Vec::new(),
            }])
        }

        fn extract_page_text(&self, _page_index: PageIndex) -> Result<String, PdfEngineError> {
            Ok("Sample PDF page text".to_owned())
        }

        fn search_text(
            &self,
            query: &str,
            _case_sensitive: bool,
            _max_hits: usize,
        ) -> Result<Vec<SearchHit>, PdfEngineError> {
            Ok(vec![SearchHit {
                page_index: PageIndex::FIRST,
                match_index: 0,
                snippet: format!("Matched: {query}"),
            }])
        }

        fn render_page(&self, request: &RenderPageRequest) -> Result<RenderedPage, PdfEngineError> {
            Ok(RenderedPage {
                page_index: request.page_index,
                width_px: 612,
                height_px: 792,
                png_bytes: vec![137, 80, 78, 71],
            })
        }
    }

    struct FakePdfEngine;

    impl PdfEngine for FakePdfEngine {
        fn kind(&self) -> PdfEngineKind {
            PdfEngineKind::PureRustFallback
        }

        fn open_path(
            &self,
            _path: &Path,
            _options: &OpenDocumentOptions,
        ) -> Result<Box<dyn PdfDocument>, PdfEngineError> {
            Ok(Box::new(FakePdfDocument {
                info: EngineDocumentInfo {
                    page_count: 10,
                    metadata: DocumentMetadata {
                        title: Some("Architecture Guide".to_owned()),
                        author: Some("Readora".to_owned()),
                        subject: None,
                        creator: None,
                        pdf_version: "1.7".to_owned(),
                        is_encrypted: false,
                    },
                },
            }))
        }

        fn open_bytes(
            &self,
            _bytes: &[u8],
            options: &OpenDocumentOptions,
        ) -> Result<Box<dyn PdfDocument>, PdfEngineError> {
            self.open_path(Path::new("memory.pdf"), options)
        }
    }

    #[derive(Default)]
    struct FakePlatform;

    impl PlatformPort for FakePlatform {
        fn resolve_and_validate_pdf_path(
            &self,
            raw_path: &str,
            _max_size_bytes: u64,
        ) -> Result<ResolvedFileInfo, ApplicationError> {
            Ok(ResolvedFileInfo {
                document_id: DocumentId::new("doc-fake-1").unwrap(),
                canonical_path: raw_path.to_owned(),
                display_name: "guide.pdf".to_owned(),
                file_size_bytes: 4096,
            })
        }

        fn current_unix_ms(&self) -> i64 {
            1_700_000_000_000
        }

        fn atomic_write_file(
            &self,
            _target_path: &str,
            _bytes: &[u8],
        ) -> Result<(), ApplicationError> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeStorage {
        recents: Mutex<HashMap<DocumentId, RecentDocument>>,
        bookmarks: Mutex<Vec<Bookmark>>,
        settings: Mutex<AppSettings>,
    }

    impl RecentDocumentRepository for FakeStorage {
        fn upsert(&self, record: &RecentDocument) -> Result<(), ApplicationError> {
            self.recents
                .lock()
                .unwrap()
                .insert(record.document_id.clone(), record.clone());
            Ok(())
        }

        fn get(
            &self,
            document_id: &DocumentId,
        ) -> Result<Option<RecentDocument>, ApplicationError> {
            Ok(self.recents.lock().unwrap().get(document_id).cloned())
        }

        fn list(&self, _limit: usize) -> Result<Vec<RecentDocument>, ApplicationError> {
            Ok(self.recents.lock().unwrap().values().cloned().collect())
        }

        fn remove(&self, document_id: &DocumentId) -> Result<(), ApplicationError> {
            self.recents.lock().unwrap().remove(document_id);
            Ok(())
        }
    }

    impl BookmarkRepository for FakeStorage {
        fn upsert(&self, bookmark: &Bookmark) -> Result<Bookmark, ApplicationError> {
            self.bookmarks.lock().unwrap().push(bookmark.clone());
            Ok(bookmark.clone())
        }

        fn list_for_document(
            &self,
            document_id: &DocumentId,
        ) -> Result<Vec<Bookmark>, ApplicationError> {
            Ok(self
                .bookmarks
                .lock()
                .unwrap()
                .iter()
                .filter(|b| &b.document_id == document_id)
                .cloned()
                .collect())
        }

        fn delete(&self, bookmark_id: &BookmarkId) -> Result<bool, ApplicationError> {
            let mut guard = self.bookmarks.lock().unwrap();
            let before = guard.len();
            guard.retain(|b| &b.id != bookmark_id);
            Ok(guard.len() < before)
        }
    }

    impl SettingsRepository for FakeStorage {
        fn load(&self) -> Result<AppSettings, ApplicationError> {
            Ok(self.settings.lock().unwrap().clone())
        }

        fn save(&self, settings: &AppSettings) -> Result<(), ApplicationError> {
            *self.settings.lock().unwrap() = settings.clone();
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeRenderInfra {
        cache: Mutex<HashMap<RenderCacheKey, CachedPageEntry>>,
        generations: Mutex<HashMap<DocumentId, u64>>,
        budget: Mutex<usize>,
    }

    impl RenderCachePort for FakeRenderInfra {
        fn get(&self, key: &RenderCacheKey) -> Option<CachedPageEntry> {
            self.cache.lock().unwrap().get(key).cloned()
        }

        fn put(&self, key: RenderCacheKey, entry: CachedPageEntry) {
            self.cache.lock().unwrap().insert(key, entry);
        }

        fn invalidate_document(&self, document_id: &DocumentId) {
            self.cache
                .lock()
                .unwrap()
                .retain(|k, _| &k.document_id != document_id);
        }

        fn set_budget_bytes(&self, budget_bytes: usize) {
            *self.budget.lock().unwrap() = budget_bytes;
        }

        fn current_usage_bytes(&self) -> usize {
            self.cache
                .lock()
                .unwrap()
                .values()
                .map(|v| v.byte_size)
                .sum()
        }
    }

    impl RenderCancellationPort for FakeRenderInfra {
        fn next_generation(&self, document_id: &DocumentId) -> u64 {
            let mut guard = self.generations.lock().unwrap();
            let entry = guard.entry(document_id.clone()).or_insert(0);
            *entry += 1;
            *entry
        }

        fn current_generation(&self, document_id: &DocumentId) -> u64 {
            *self
                .generations
                .lock()
                .unwrap()
                .get(document_id)
                .unwrap_or(&0)
        }

        fn is_current(&self, document_id: &DocumentId, generation: u64) -> bool {
            self.current_generation(document_id) == generation
        }

        fn clear_document(&self, document_id: &DocumentId) {
            self.generations.lock().unwrap().remove(document_id);
        }
    }

    #[test]
    fn open_navigate_render_and_reopen_restores_position() {
        let engine = FakePdfEngine;
        let platform = FakePlatform;
        let storage = FakeStorage::default();
        let infra = FakeRenderInfra::default();

        let opened = execute_open_document(
            &OpenDocumentRequest {
                path: "/tmp/guide.pdf".to_owned(),
                password: None,
            },
            &engine,
            &platform,
            &storage,
            &storage,
            &storage,
        )
        .unwrap();

        assert_eq!(opened.session.descriptor.page_count, 10);
        assert_eq!(opened.session.view_state.current_page.zero_based(), 0);

        let mut view_state = opened.session.view_state.clone();
        let (updated_state, generation) = execute_navigation_action(
            &mut view_state,
            &opened.file_info.canonical_path,
            &opened.session.descriptor.file_name,
            NavigationAction::GoToPage(4),
            &infra,
            &storage,
            &platform,
        )
        .unwrap();
        assert_eq!(updated_state.current_page.zero_based(), 4);
        assert_eq!(generation, 1);

        // Rendering with stale generation 0 should fail with Cancelled.
        let stale_cmd = RenderPageCommand {
            document_id: "doc-fake-1".to_owned(),
            page_index: 4,
            scale: 1.0,
            rotation_degrees: 0,
            render_mode: RenderMode::Standard,
            generation: Some(0),
        };
        assert_eq!(
            execute_render_page(&stale_cmd, opened.document.as_ref(), &infra, &infra, |_| {
                "data:image/png;base64,AAAA".to_owned()
            }),
            Err(ApplicationError::Cancelled)
        );

        // Rendering with current generation 1 succeeds and caches.
        let valid_cmd = RenderPageCommand {
            generation: Some(1),
            ..stale_cmd
        };
        let first_render =
            execute_render_page(&valid_cmd, opened.document.as_ref(), &infra, &infra, |_| {
                "data:image/png;base64,AAAA".to_owned()
            })
            .unwrap();
        assert!(!first_render.cache_hit);

        let second_render =
            execute_render_page(&valid_cmd, opened.document.as_ref(), &infra, &infra, |_| {
                "data:image/png;base64,BBBB".to_owned()
            })
            .unwrap();
        assert!(second_render.cache_hit);

        // Reopening the document restores page 4 from RecentDocumentRepository.
        let reopened = execute_open_document(
            &OpenDocumentRequest {
                path: "/tmp/guide.pdf".to_owned(),
                password: None,
            },
            &engine,
            &platform,
            &storage,
            &storage,
            &storage,
        )
        .unwrap();
        assert_eq!(reopened.session.view_state.current_page.zero_based(), 4);
    }

    #[test]
    fn settings_and_bookmarks_use_cases_work() {
        let platform = FakePlatform;
        let storage = FakeStorage::default();
        let infra = FakeRenderInfra::default();

        let bm = execute_upsert_bookmark(
            &UpsertBookmarkCommand {
                document_id: "doc-fake-1".to_owned(),
                page_index: 2,
                label: "Key Architecture Diagram".to_owned(),
            },
            10,
            &storage,
            &platform,
        )
        .unwrap();
        assert_eq!(bm.page_index.zero_based(), 2);

        let listed = execute_list_bookmarks("doc-fake-1", &storage).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(execute_delete_bookmark(bm.id.as_str(), &storage).unwrap());

        let updated_settings = execute_update_settings(
            SettingsPatchDto {
                theme: Some(ThemePreference::Dark),
                render_cache_budget_bytes: Some(32 * 1024 * 1024),
                ..SettingsPatchDto::default()
            },
            &storage,
            &infra,
        )
        .unwrap();
        assert_eq!(updated_settings.theme, ThemePreference::Dark);
        assert_eq!(*infra.budget.lock().unwrap(), 32 * 1024 * 1024);
    }
}
