//! SQLite repository implementation for `RecentDocumentRepository`.

use app_application::{ApplicationError, RecentDocumentRepository};
use app_domain::{DocumentId, FitMode, LayoutMode, PageIndex, RecentDocument, Rotation, ZoomLevel};
use rusqlite::params;

use crate::SqliteStorage;

fn fit_mode_to_str(mode: Option<FitMode>) -> Option<&'static str> {
    match mode {
        Some(FitMode::Manual) => Some("manual"),
        Some(FitMode::FitWidth) => Some("fit_width"),
        Some(FitMode::FitPage) => Some("fit_page"),
        None => None,
    }
}

fn fit_mode_from_str(raw: Option<&str>) -> Option<FitMode> {
    match raw {
        Some("manual") => Some(FitMode::Manual),
        Some("fit_width") => Some(FitMode::FitWidth),
        Some("fit_page") => Some(FitMode::FitPage),
        _ => None,
    }
}

fn layout_mode_to_str(mode: Option<LayoutMode>) -> Option<&'static str> {
    match mode {
        Some(LayoutMode::SinglePage) => Some("single_page"),
        Some(LayoutMode::Continuous) => Some("continuous"),
        None => None,
    }
}

fn layout_mode_from_str(raw: Option<&str>) -> Option<LayoutMode> {
    match raw {
        Some("single_page") => Some(LayoutMode::SinglePage),
        Some("continuous") => Some(LayoutMode::Continuous),
        _ => None,
    }
}

impl RecentDocumentRepository for SqliteStorage {
    fn upsert(&self, record: &RecentDocument) -> Result<(), ApplicationError> {
        let conn = self.lock_connection()?;
        conn.execute(
            "INSERT INTO recent_documents (
                document_id, file_path, display_name, last_page, page_count,
                zoom_pct, rotation_deg, last_opened_unix_ms, is_favorite, is_archived,
                fit_mode, layout_mode
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(document_id) DO UPDATE SET
                file_path = excluded.file_path,
                display_name = excluded.display_name,
                last_page = excluded.last_page,
                page_count = excluded.page_count,
                zoom_pct = excluded.zoom_pct,
                rotation_deg = excluded.rotation_deg,
                last_opened_unix_ms = excluded.last_opened_unix_ms,
                fit_mode = excluded.fit_mode,
                layout_mode = excluded.layout_mode",
            params![
                record.document_id.as_str(),
                record.file_path,
                record.display_name,
                record.last_page.zero_based(),
                record.page_count,
                record.last_zoom.percentage(),
                record.last_rotation.degrees(),
                record.last_opened_unix_ms,
                i32::from(record.is_favorite),
                i32::from(record.is_archived),
                fit_mode_to_str(record.last_fit_mode),
                layout_mode_to_str(record.last_layout_mode),
            ],
        )
        .map_err(|e| ApplicationError::Storage(format!("failed to upsert recent document: {e}")))?;
        Ok(())
    }

    fn get(&self, document_id: &DocumentId) -> Result<Option<RecentDocument>, ApplicationError> {
        let conn = self.lock_connection()?;
        query_recent_by_id(&conn, document_id)
    }

    fn list(&self, limit: usize) -> Result<Vec<RecentDocument>, ApplicationError> {
        let conn = self.lock_connection()?;
        let capped_limit = i64::try_from(limit.clamp(1, 200)).unwrap_or(50);
        let mut stmt = conn
            .prepare_cached(
                "SELECT document_id, file_path, display_name, last_page, page_count,
                        zoom_pct, rotation_deg, last_opened_unix_ms, is_favorite, is_archived,
                        fit_mode, layout_mode
                  FROM recent_documents
                  ORDER BY last_opened_unix_ms DESC
                  LIMIT ?1",
            )
            .map_err(|e| ApplicationError::Storage(format!("prepare recent list failed: {e}")))?;

        let mut rows = stmt
            .query(params![capped_limit])
            .map_err(|e| ApplicationError::Storage(format!("query recent list failed: {e}")))?;

        let mut results = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|e| ApplicationError::Storage(format!("row iteration failed: {e}")))?
        {
            results.push(map_recent_row(row)?);
        }
        Ok(results)
    }

    fn list_library(&self, recent_limit: usize) -> Result<Vec<RecentDocument>, ApplicationError> {
        let conn = self.lock_connection()?;
        let capped_limit = i64::try_from(recent_limit.clamp(1, 200)).unwrap_or(50);
        let mut stmt = conn
            .prepare_cached(
                "SELECT document_id, file_path, display_name, last_page, page_count,
                        zoom_pct, rotation_deg, last_opened_unix_ms, is_favorite, is_archived,
                        fit_mode, layout_mode
                 FROM (
                     SELECT * FROM (
                         SELECT document_id, file_path, display_name, last_page, page_count,
                                zoom_pct, rotation_deg, last_opened_unix_ms, is_favorite, is_archived,
                                fit_mode, layout_mode
                         FROM recent_documents
                         ORDER BY last_opened_unix_ms DESC
                         LIMIT ?1
                     )
                     UNION
                     SELECT document_id, file_path, display_name, last_page, page_count,
                            zoom_pct, rotation_deg, last_opened_unix_ms, is_favorite, is_archived,
                            fit_mode, layout_mode
                     FROM recent_documents
                     WHERE is_favorite = 1 OR is_archived = 1
                 )
                 ORDER BY last_opened_unix_ms DESC",
            )
            .map_err(|e| ApplicationError::Storage(format!("prepare library list failed: {e}")))?;

        let mut rows = stmt
            .query(params![capped_limit])
            .map_err(|e| ApplicationError::Storage(format!("query library list failed: {e}")))?;

        let mut results = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|e| ApplicationError::Storage(format!("library row iteration failed: {e}")))?
        {
            results.push(map_recent_row(row)?);
        }
        Ok(results)
    }

    fn set_favorite(
        &self,
        document_id: &DocumentId,
        is_favorite: bool,
    ) -> Result<Option<RecentDocument>, ApplicationError> {
        let mut conn = self.lock_connection()?;
        let tx = conn
            .transaction()
            .map_err(|e| ApplicationError::Storage(format!("favorite tx begin failed: {e}")))?;
        tx.execute(
            "UPDATE recent_documents SET is_favorite = ?1 WHERE document_id = ?2",
            params![i32::from(is_favorite), document_id.as_str()],
        )
        .map_err(|e| ApplicationError::Storage(format!("update favorite status failed: {e}")))?;
        let found = query_recent_by_id(&tx, document_id)?;
        tx.commit()
            .map_err(|e| ApplicationError::Storage(format!("favorite tx commit failed: {e}")))?;
        Ok(found)
    }

    fn set_archived(
        &self,
        document_id: &DocumentId,
        is_archived: bool,
    ) -> Result<Option<RecentDocument>, ApplicationError> {
        let mut conn = self.lock_connection()?;
        let tx = conn
            .transaction()
            .map_err(|e| ApplicationError::Storage(format!("archive tx begin failed: {e}")))?;
        tx.execute(
            "UPDATE recent_documents SET is_archived = ?1 WHERE document_id = ?2",
            params![i32::from(is_archived), document_id.as_str()],
        )
        .map_err(|e| ApplicationError::Storage(format!("update archived status failed: {e}")))?;
        let found = query_recent_by_id(&tx, document_id)?;
        tx.commit()
            .map_err(|e| ApplicationError::Storage(format!("archive tx commit failed: {e}")))?;
        Ok(found)
    }

    fn remove(&self, document_id: &DocumentId) -> Result<(), ApplicationError> {
        let conn = self.lock_connection()?;
        conn.execute(
            "DELETE FROM recent_documents WHERE document_id = ?1",
            params![document_id.as_str()],
        )
        .map_err(|e| ApplicationError::Storage(format!("delete recent document failed: {e}")))?;
        Ok(())
    }
}

fn query_recent_by_id(
    conn: &rusqlite::Connection,
    document_id: &DocumentId,
) -> Result<Option<RecentDocument>, ApplicationError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT document_id, file_path, display_name, last_page, page_count,
                    zoom_pct, rotation_deg, last_opened_unix_ms, is_favorite, is_archived,
                    fit_mode, layout_mode
              FROM recent_documents
              WHERE document_id = ?1",
        )
        .map_err(|e| ApplicationError::Storage(format!("prepare recent lookup failed: {e}")))?;

    let mut rows = stmt
        .query(params![document_id.as_str()])
        .map_err(|e| ApplicationError::Storage(format!("query recent lookup failed: {e}")))?;

    if let Some(row) = rows
        .next()
        .map_err(|e| ApplicationError::Storage(format!("row fetch failed: {e}")))?
    {
        Ok(Some(map_recent_row(row)?))
    } else {
        Ok(None)
    }
}

fn map_recent_row(row: &rusqlite::Row<'_>) -> Result<RecentDocument, ApplicationError> {
    let raw_id: String = row
        .get(0)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let file_path: String = row
        .get(1)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let display_name: String = row
        .get(2)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let last_page_u32: u32 = row
        .get(3)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let page_count: u32 = row
        .get(4)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let zoom_pct: u16 = row
        .get(5)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let rotation_deg: u16 = row
        .get(6)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let last_opened_unix_ms: i64 = row
        .get(7)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let is_favorite_int: i32 = row
        .get(8)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let is_archived_int: i32 = row
        .get(9)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let raw_fit: Option<String> = row
        .get(10)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;
    let raw_layout: Option<String> = row
        .get(11)
        .map_err(|e| ApplicationError::Storage(e.to_string()))?;

    let document_id = DocumentId::new(raw_id)?;
    let last_zoom = ZoomLevel::from_percentage(zoom_pct).unwrap_or_default();
    let last_rotation = Rotation::from_degrees(rotation_deg).unwrap_or_default();

    Ok(RecentDocument {
        document_id,
        file_path,
        display_name,
        last_page: PageIndex::new(last_page_u32),
        page_count: page_count.max(1),
        last_zoom,
        last_rotation,
        last_opened_unix_ms,
        is_favorite: is_favorite_int != 0,
        is_archived: is_archived_int != 0,
        last_fit_mode: fit_mode_from_str(raw_fit.as_deref()),
        last_layout_mode: layout_mode_from_str(raw_layout.as_deref()),
    })
}
