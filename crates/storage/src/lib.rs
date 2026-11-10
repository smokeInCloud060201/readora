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
}

#[cfg(test)]
mod tests {
    use app_application::{BookmarkRepository, RecentDocumentRepository, SettingsRepository};
    use app_domain::{
        AppSettings, Bookmark, BookmarkId, DocumentId, PageIndex, RecentDocument, ThemePreference,
        ViewState,
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

        let all_bms = storage.list_for_document(&doc_id).unwrap();
        assert_eq!(all_bms.len(), 1);
        assert!(storage.delete(&saved_bm.id).unwrap());
        assert!(storage.list_for_document(&doc_id).unwrap().is_empty());

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
    }
}
