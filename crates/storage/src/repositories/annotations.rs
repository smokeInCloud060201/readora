//! SQLite repository implementation for `AnnotationRepository`.

use app_application::{AnnotationRepository, ApplicationError};
use app_domain::{Annotation, AnnotationId, AnnotationKind, DocumentId, PageIndex};
use rusqlite::params;

use crate::SqliteStorage;

impl AnnotationRepository for SqliteStorage {
    fn upsert(&self, annotation: &Annotation) -> Result<Annotation, ApplicationError> {
        let conn = self.lock_connection()?;
        conn.execute(
            "INSERT INTO annotations (
                 id, document_id, page_index, kind, color_hex, quote_text, note_text, created_at_unix_ms
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 kind = excluded.kind,
                 color_hex = excluded.color_hex,
                 quote_text = excluded.quote_text,
                 note_text = excluded.note_text,
                 created_at_unix_ms = excluded.created_at_unix_ms",
            params![
                annotation.id.as_str(),
                annotation.document_id.as_str(),
                annotation.page_index.zero_based(),
                annotation.kind.as_str(),
                annotation.color_hex,
                annotation.quote_text,
                annotation.note_text,
                annotation.created_at_unix_ms,
            ],
        )
        .map_err(|e| ApplicationError::Storage(format!("failed to upsert annotation: {e}")))?;

        Ok(annotation.clone())
    }

    fn list_for_document(
        &self,
        document_id: &DocumentId,
    ) -> Result<Vec<Annotation>, ApplicationError> {
        let conn = self.lock_connection()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, document_id, page_index, kind, color_hex, quote_text, note_text, created_at_unix_ms
                 FROM annotations
                 WHERE document_id = ?1
                 ORDER BY page_index ASC, created_at_unix_ms ASC",
            )
            .map_err(|e| {
                ApplicationError::Storage(format!("prepare annotation list failed: {e}"))
            })?;

        let mut rows = stmt
            .query(params![document_id.as_str()])
            .map_err(|e| ApplicationError::Storage(format!("query annotation list failed: {e}")))?;

        let mut annotations = Vec::new();
        while let Some(row) = rows.next().map_err(|e| {
            ApplicationError::Storage(format!("annotation row iteration failed: {e}"))
        })? {
            annotations.push(map_annotation_row(row)?);
        }
        Ok(annotations)
    }

    fn delete(&self, annotation_id: &AnnotationId) -> Result<bool, ApplicationError> {
        let conn = self.lock_connection()?;
        let affected = conn
            .execute(
                "DELETE FROM annotations WHERE id = ?1",
                params![annotation_id.as_str()],
            )
            .map_err(|e| ApplicationError::Storage(format!("delete annotation failed: {e}")))?;
        Ok(affected > 0)
    }
}

fn map_annotation_row(row: &rusqlite::Row<'_>) -> Result<Annotation, ApplicationError> {
    let raw_id: String = row
        .get(0)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let raw_doc_id: String = row
        .get(1)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let page_u32: u32 = row
        .get(2)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let raw_kind: String = row
        .get(3)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let color_hex: String = row
        .get(4)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let quote_text: String = row
        .get(5)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let note_text: String = row
        .get(6)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let created_at: i64 = row
        .get(7)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;

    let doc_id = DocumentId::new(raw_doc_id)?;
    Ok(Annotation::new(
        AnnotationId::new(raw_id),
        doc_id,
        PageIndex::new(page_u32),
        AnnotationKind::from_storage(&raw_kind),
        color_hex,
        quote_text,
        note_text,
        created_at,
    )?)
}
