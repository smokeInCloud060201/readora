//! Storage repository ports for recent documents, bookmarks, and application settings.

use app_domain::{
    Annotation, AnnotationId, AppSettings, Bookmark, BookmarkId, DocumentId, RecentDocument,
};

use crate::error::ApplicationError;

/// Port for persisting and querying recently opened documents.
pub trait RecentDocumentRepository: Send + Sync {
    /// Inserts or updates a recent document entry.
    fn upsert(&self, record: &RecentDocument) -> Result<(), ApplicationError>;

    /// Looks up a recent document record by its `DocumentId`.
    fn get(&self, document_id: &DocumentId) -> Result<Option<RecentDocument>, ApplicationError>;

    /// Lists up to `limit` recent documents ordered by `last_opened_unix_ms` descending.
    fn list(&self, limit: usize) -> Result<Vec<RecentDocument>, ApplicationError>;

    /// Lists up to `recent_limit` recent documents alongside all favorited and archived library
    /// entries, deduplicated and ordered by `last_opened_unix_ms` descending.
    fn list_library(&self, recent_limit: usize) -> Result<Vec<RecentDocument>, ApplicationError> {
        self.list(recent_limit)
    }

    /// Updates the favorite status of a recent document entry.
    fn set_favorite(
        &self,
        document_id: &DocumentId,
        is_favorite: bool,
    ) -> Result<Option<RecentDocument>, ApplicationError>;

    /// Updates the archived status of a recent document entry.
    fn set_archived(
        &self,
        document_id: &DocumentId,
        is_archived: bool,
    ) -> Result<Option<RecentDocument>, ApplicationError>;

    /// Removes a recent document entry by ID.
    fn remove(&self, document_id: &DocumentId) -> Result<(), ApplicationError>;

    /// Resets persisted per-document reading positions (`last_page`, zoom, rotation, fit, layout)
    /// back to `default_settings` when `remember_page_position` is disabled.
    fn reset_reading_positions(
        &self,
        _default_settings: &AppSettings,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }
}

/// Port for persisting and querying user bookmarks.
pub trait BookmarkRepository: Send + Sync {
    /// Inserts or updates a bookmark for `(document_id, page_index)`.
    fn upsert(&self, bookmark: &Bookmark) -> Result<Bookmark, ApplicationError>;

    /// Lists all bookmarks for `document_id` ordered by `page_index` ascending.
    fn list_for_document(
        &self,
        document_id: &DocumentId,
    ) -> Result<Vec<Bookmark>, ApplicationError>;

    /// Deletes a bookmark by ID, returning `true` if a record was removed.
    fn delete(&self, bookmark_id: &BookmarkId) -> Result<bool, ApplicationError>;
}

/// Port for persisting and querying user annotations (highlights, underlines, comments).
pub trait AnnotationRepository: Send + Sync {
    /// Inserts or updates an annotation.
    fn upsert(&self, annotation: &Annotation) -> Result<Annotation, ApplicationError>;

    /// Lists all annotations for `document_id` ordered by `page_index` ascending.
    fn list_for_document(
        &self,
        document_id: &DocumentId,
    ) -> Result<Vec<Annotation>, ApplicationError>;

    /// Deletes an annotation by ID, returning `true` if a record was removed.
    fn delete(&self, annotation_id: &AnnotationId) -> Result<bool, ApplicationError>;
}

/// Port for loading and saving durable application preferences.
pub trait SettingsRepository: Send + Sync {
    /// Loads persisted settings, returning `AppSettings::default()` if none are stored yet.
    fn load(&self) -> Result<AppSettings, ApplicationError>;

    /// Persists validated application settings.
    fn save(&self, settings: &AppSettings) -> Result<(), ApplicationError>;

    /// Atomically loads, mutates, validates, and saves application settings.
    fn update(
        &self,
        mutator: &mut dyn FnMut(&mut AppSettings) -> Result<(), ApplicationError>,
    ) -> Result<AppSettings, ApplicationError> {
        let mut settings = self.load()?;
        mutator(&mut settings)?;
        settings.validate()?;
        self.save(&settings)?;
        Ok(settings)
    }
}
