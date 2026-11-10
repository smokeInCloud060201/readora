//! SQLite repository implementation for `BookmarkRepository`.

use app_application::{ApplicationError, BookmarkRepository};
use app_domain::{Bookmark, BookmarkId, DocumentId, PageIndex};
use rusqlite::params;

use crate::SqliteStorage;

impl BookmarkRepository for SqliteStorage {
    fn upsert(&self, bookmark: &Bookmark) -> Result<Bookmark, ApplicationError> {
        let conn = self.lock_connection()?;
        conn.execute(
            "INSERT INTO bookmarks (id, document_id, page_index, label, created_at_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(document_id, page_index) DO UPDATE SET
                 label = excluded.label,
                 created_at_unix_ms = excluded.created_at_unix_ms",
            params![
                bookmark.id.as_str(),
                bookmark.document_id.as_str(),
                bookmark.page_index.zero_based(),
                bookmark.label,
                bookmark.created_at_unix_ms,
            ],
        )
        .map_err(|e| ApplicationError::Storage(format!("failed to upsert bookmark: {e}")))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, document_id, page_index, label, created_at_unix_ms
                 FROM bookmarks
                 WHERE document_id = ?1 AND page_index = ?2",
            )
            .map_err(|e| ApplicationError::Storage(format!("prepare bookmark read failed: {e}")))?;

        let mut rows = stmt
            .query(params![
                bookmark.document_id.as_str(),
                bookmark.page_index.zero_based()
            ])
            .map_err(|e| ApplicationError::Storage(format!("query bookmark failed: {e}")))?;

        let row = rows
            .next()
            .map_err(|e| ApplicationError::Storage(format!("bookmark fetch failed: {e}")))?
            .ok_or_else(|| ApplicationError::Storage("upserted bookmark not found".to_owned()))?;

        map_bookmark_row(row)
    }

    fn list_for_document(
        &self,
        document_id: &DocumentId,
    ) -> Result<Vec<Bookmark>, ApplicationError> {
        let conn = self.lock_connection()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, document_id, page_index, label, created_at_unix_ms
                 FROM bookmarks
                 WHERE document_id = ?1
                 ORDER BY page_index ASC",
            )
            .map_err(|e| ApplicationError::Storage(format!("prepare bookmark list failed: {e}")))?;

        let mut rows = stmt
            .query(params![document_id.as_str()])
            .map_err(|e| ApplicationError::Storage(format!("query bookmark list failed: {e}")))?;

        let mut bookmarks = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|e| ApplicationError::Storage(format!("bookmark row iteration failed: {e}")))?
        {
            bookmarks.push(map_bookmark_row(row)?);
        }
        Ok(bookmarks)
    }

    fn delete(&self, bookmark_id: &BookmarkId) -> Result<bool, ApplicationError> {
        let conn = self.lock_connection()?;
        let affected = conn
            .execute(
                "DELETE FROM bookmarks WHERE id = ?1",
                params![bookmark_id.as_str()],
            )
            .map_err(|e| ApplicationError::Storage(format!("delete bookmark failed: {e}")))?;
        Ok(affected > 0)
    }
}

fn map_bookmark_row(row: &rusqlite::Row<'_>) -> Result<Bookmark, ApplicationError> {
    let raw_id: String = row
        .get(0)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let raw_doc_id: String = row
        .get(1)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let page_u32: u32 = row
        .get(2)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let label: String = row
        .get(3)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let created_at: i64 = row
        .get(4)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;

    let doc_id = DocumentId::new(raw_doc_id)?;
    Ok(Bookmark::new(
        BookmarkId::new(raw_id),
        doc_id,
        PageIndex::new(page_u32),
        label,
        created_at,
    )?)
}
