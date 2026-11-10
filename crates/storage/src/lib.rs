//! SQLite metadata storage adapter and migration runner for Readora.
//!
//! All SQL queries and database interactions are confined to this crate.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use app_application::ApplicationError;
use rusqlite::{Connection, OptionalExtension, params};

pub mod repositories;

const MIGRATION_0001: &str = include_str!("../migrations/0001_initial.sql");
const MIGRATION_0002: &str =
    include_str!("../migrations/0002_library_collections_and_annotations.sql");
const MIGRATION_0003: &str = include_str!("../migrations/0003_annotations.sql");

/// Current append-only SQLite schema version shipped with this release.
pub const CURRENT_SCHEMA_VERSION: i64 = 3;

/// Thread-safe SQLite storage adapter implementing `RecentDocumentRepository`,
/// `BookmarkRepository`, and `SettingsRepository`.
pub struct SqliteStorage {
    conn: Mutex<Connection>,
}

impl SqliteStorage {
    /// Opens or creates a SQLite database at `db_path`, enables WAL mode, and applies
    /// any pending append-only migrations.
    pub fn open(db_path: &Path) -> Result<Self, ApplicationError> {
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    ApplicationError::Storage(format!("failed to create storage directory: {e}"))
                })?;
            }
        }
        let conn = Connection::open(db_path)
            .map_err(|e| ApplicationError::Storage(format!("failed to open SQLite DB: {e}")))?;
        Self::initialize_connection(conn)
    }

    /// Creates an in-memory SQLite storage instance (useful for tests and ephemeral sessions).
    pub fn open_in_memory() -> Result<Self, ApplicationError> {
        let conn = Connection::open_in_memory().map_err(|e| {
            ApplicationError::Storage(format!("failed to open in-memory SQLite DB: {e}"))
        })?;
        Self::initialize_connection(conn)
    }

    fn initialize_connection(mut conn: Connection) -> Result<Self, ApplicationError> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| ApplicationError::Storage(format!("failed to enable WAL mode: {e}")))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| {
                ApplicationError::Storage(format!("failed to enable foreign_keys: {e}"))
            })?;

        let tx = conn.transaction().map_err(|e| {
            ApplicationError::Storage(format!("failed to start migration transaction: {e}"))
        })?;
        tx.execute_batch(MIGRATION_0001).map_err(|e| {
            ApplicationError::Storage(format!("failed to apply migration 0001: {e}"))
        })?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at_unix_ms) VALUES (1, 0)",
            params![],
        )
        .map_err(|e| {
            ApplicationError::Storage(format!("failed to record schema migration 1: {e}"))
        })?;

        let has_m2: Option<i64> = tx
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = 2",
                params![],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| ApplicationError::Storage(format!("failed to query migration 2: {e}")))?;

        if has_m2.is_none() {
            tx.execute_batch(MIGRATION_0002).map_err(|e| {
                ApplicationError::Storage(format!("failed to apply migration 0002: {e}"))
            })?;
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at_unix_ms) VALUES (2, 0)",
                params![],
            )
            .map_err(|e| {
                ApplicationError::Storage(format!("failed to record schema migration 2: {e}"))
            })?;
        }

        let has_m3: Option<i64> = tx
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = 3",
                params![],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| ApplicationError::Storage(format!("failed to query migration 3: {e}")))?;

        if has_m3.is_none() {
            tx.execute_batch(MIGRATION_0003).map_err(|e| {
                ApplicationError::Storage(format!("failed to apply migration 0003: {e}"))
            })?;
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at_unix_ms) VALUES (3, 0)",
                params![],
            )
            .map_err(|e| {
                ApplicationError::Storage(format!("failed to record schema migration 3: {e}"))
            })?;
        }

        tx.commit().map_err(|e| {
            ApplicationError::Storage(format!("failed to commit migration transaction: {e}"))
        })?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub(crate) fn lock_connection(&self) -> Result<MutexGuard<'_, Connection>, ApplicationError> {
        self.conn
            .lock()
            .map_err(|_| ApplicationError::Storage("SQLite connection mutex poisoned".to_owned()))
    }

    /// Returns the highest applied append-only schema migration version.
    pub fn schema_version(&self) -> Result<i64, ApplicationError> {
        let conn = self.lock_connection()?;
        let version: Option<i64> = conn
            .query_row(
                "SELECT MAX(version) FROM schema_migrations",
                params![],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| {
                ApplicationError::Storage(format!("failed to read schema_migrations version: {e}"))
            })?
            .flatten();
        Ok(version.unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use app_application::{
        AnnotationRepository, BookmarkRepository, RecentDocumentRepository, SettingsRepository,
    };
    use app_domain::{
        Annotation, AnnotationId, AnnotationKind, AppSettings, Bookmark, BookmarkId, DocumentId,
        PageIndex, RecentDocument, ThemePreference, ViewState,
    };

    use super::*;

    #[test]
    fn sqlite_storage_contract_tests_for_recents_bookmarks_and_settings() {
        let storage = SqliteStorage::open_in_memory().unwrap();

        let doc_id = DocumentId::new("doc-sqlite-1").unwrap();
        let mut view = ViewState::new(doc_id.clone(), 20).unwrap();
        view.go_to_page(PageIndex::new(7)).unwrap();

        let recent =
            RecentDocument::from_view_state("/path/to/test.pdf", "test.pdf", &view, 1_700_000_100);
        RecentDocumentRepository::upsert(&storage, &recent).unwrap();

        let loaded_recent = storage.get(&doc_id).unwrap().unwrap();
        assert_eq!(loaded_recent.last_page.zero_based(), 7);
        assert_eq!(loaded_recent.display_name, "test.pdf");
        assert!(!loaded_recent.is_favorite);
        assert!(!loaded_recent.is_archived);
        assert_eq!(storage.list(10).unwrap().len(), 1);

        // Favorite and Archive flags persist across updates
        let fav = storage.set_favorite(&doc_id, true).unwrap().unwrap();
        assert!(fav.is_favorite);
        let arch = storage.set_archived(&doc_id, true).unwrap().unwrap();
        assert!(arch.is_archived);

        // Bookmark upsert on same (document_id, page_index) updates label in place
        let bm1 = Bookmark::new(
            BookmarkId::generate(),
            doc_id.clone(),
            PageIndex::new(3),
            "Initial Note",
            100,
        )
        .unwrap();
        BookmarkRepository::upsert(&storage, &bm1).unwrap();

        let bm2 = Bookmark::new(
            BookmarkId::generate(),
            doc_id.clone(),
            PageIndex::new(3),
            "Updated Note",
            200,
        )
        .unwrap();
        let saved_bm = BookmarkRepository::upsert(&storage, &bm2).unwrap();
        assert_eq!(saved_bm.label, "Updated Note");

        let all_bms = BookmarkRepository::list_for_document(&storage, &doc_id).unwrap();
        assert_eq!(all_bms.len(), 1);
        assert!(BookmarkRepository::delete(&storage, &saved_bm.id).unwrap());
        assert!(
            BookmarkRepository::list_for_document(&storage, &doc_id)
                .unwrap()
                .is_empty()
        );

        // Annotation persistence (Highlight, Underline, Comment)
        let ann = Annotation::new(
            AnnotationId::generate(),
            doc_id.clone(),
            PageIndex::new(2),
            AnnotationKind::Highlight,
            "#a9d5b2",
            "Hexagonal Architecture keeps domain rules pure.",
            "Core architecture invariant",
            500,
        )
        .unwrap();
        AnnotationRepository::upsert(&storage, &ann).unwrap();
        let all_anns = AnnotationRepository::list_for_document(&storage, &doc_id).unwrap();
        assert_eq!(all_anns.len(), 1);
        assert_eq!(all_anns[0].color_hex, "#a9d5b2");
        assert!(AnnotationRepository::delete(&storage, &ann.id).unwrap());
        assert!(
            AnnotationRepository::list_for_document(&storage, &doc_id)
                .unwrap()
                .is_empty()
        );

        // Settings default and persistence
        let default_settings = storage.load().unwrap();
        assert_eq!(default_settings.theme, ThemePreference::System);

        let updated = AppSettings {
            theme: ThemePreference::Dark,
            ..default_settings
        };
        storage.save(&updated).unwrap();
        assert_eq!(storage.load().unwrap().theme, ThemePreference::Dark);

        storage.remove(&doc_id).unwrap();
        assert!(storage.get(&doc_id).unwrap().is_none());
        assert_eq!(storage.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn sqlite_storage_upgrades_from_v1_schema_preserving_user_data() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("readora.sqlite");

        // Simulate a v0.1.0 installation with only migration 0001 applied
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(MIGRATION_0001).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at_unix_ms) VALUES (1, 1000)",
                params![],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO app_settings (singleton_id, settings_json)
                 VALUES (1, '{\"theme\":\"dark\",\"default_layout\":\"continuous\",\"default_fit_mode\":\"fit_page\",\"default_zoom\":1.25,\"render_cache_budget_bytes\":67108864,\"prefetch_window\":2}')",
                params![],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO recent_documents (document_id, file_path, display_name, last_page, page_count, zoom_pct, rotation_deg, last_opened_unix_ms)
                 VALUES ('doc-legacy-1', '/docs/legacy.pdf', 'legacy.pdf', 4, 12, 125, 0, 123456)",
                params![],
            )
            .unwrap();
        }

        // Upgrade by opening with current SqliteStorage
        let upgraded = SqliteStorage::open(&db_path).unwrap();
        assert_eq!(upgraded.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);

        // Verify user preferences and recent documents were preserved across upgrade
        let settings = upgraded.load().unwrap();
        assert_eq!(settings.theme, ThemePreference::Dark);
        assert_eq!(settings.prefetch_window, 2);

        let doc_id = DocumentId::new("doc-legacy-1").unwrap();
        let recent = upgraded.get(&doc_id).unwrap().unwrap();
        assert_eq!(recent.display_name, "legacy.pdf");
        assert_eq!(recent.last_page.zero_based(), 4);
        assert!(!recent.is_favorite);
        assert!(!recent.is_archived);
    }
}
