//! Recent document record for session restore and quick reopen.

use serde::{Deserialize, Serialize};

use crate::model::document::sanitize_display_name;
use crate::model::view_state::ViewState;
use crate::value_objects::document_id::DocumentId;
use crate::value_objects::page_index::PageIndex;
use crate::value_objects::rotation::Rotation;
use crate::value_objects::zoom::ZoomLevel;

/// Persisted metadata about a recently opened document and its last reading state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentDocument {
    /// Stable document identifier derived from its canonical path.
    pub document_id: DocumentId,
    /// Platform path string used to reopen the file locally.
    pub file_path: String,
    /// Sanitized display filename.
    pub display_name: String,
    /// Last viewed zero-based page index.
    pub last_page: PageIndex,
    /// Total page count when last opened.
    pub page_count: u32,
    /// Last zoom level.
    pub last_zoom: ZoomLevel,
    /// Last page rotation.
    pub last_rotation: Rotation,
    /// Timestamp when the document was last opened/updated (Unix milliseconds).
    pub last_opened_unix_ms: i64,
    /// Whether the user has starred this document into Favorites.
    #[serde(default)]
    pub is_favorite: bool,
    /// Whether the user has moved this document to the Archive.
    #[serde(default)]
    pub is_archived: bool,
}

impl RecentDocument {
    /// Creates a `RecentDocument` snapshot from an active `ViewState`.
    #[must_use]
    pub fn from_view_state(
        file_path: impl Into<String>,
        display_name: impl Into<String>,
        view_state: &ViewState,
        last_opened_unix_ms: i64,
    ) -> Self {
        let page_count = view_state.page_count.max(1);
        let clamped_page = if view_state.current_page.zero_based() >= page_count {
            PageIndex::new(page_count - 1)
        } else {
            view_state.current_page
        };
        Self {
            document_id: view_state.document_id.clone(),
            file_path: file_path.into(),
            display_name: sanitize_display_name(&display_name.into()),
            last_page: clamped_page,
            page_count,
            last_zoom: view_state.zoom,
            last_rotation: view_state.rotation,
            last_opened_unix_ms,
            is_favorite: false,
            is_archived: false,
        }
    }
}
