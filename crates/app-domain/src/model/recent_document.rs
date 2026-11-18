//! Recent document record for session restore and quick reopen.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::model::document::sanitize_display_name;
use crate::model::view_state::ViewState;
use crate::value_objects::document_id::DocumentId;
use crate::value_objects::page_index::PageIndex;
use crate::value_objects::rotation::Rotation;
use crate::value_objects::theme::LayoutMode;
use crate::value_objects::zoom::{FitMode, ZoomLevel};

/// Persisted metadata about a recently opened document and its last reading state.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
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
    /// Last viewport fit mode (`manual`, `fit_width`, `fit_page`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fit_mode: Option<FitMode>,
    /// Last viewport layout mode (`single_page`, `continuous`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_layout_mode: Option<LayoutMode>,
}

impl fmt::Debug for RecentDocument {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RecentDocument")
            .field("document_id", &self.document_id)
            .field("file_path", &"<redacted>")
            .field("display_name", &self.display_name)
            .field("last_page", &self.last_page)
            .field("page_count", &self.page_count)
            .field("last_zoom", &self.last_zoom)
            .field("last_rotation", &self.last_rotation)
            .field("last_opened_unix_ms", &self.last_opened_unix_ms)
            .field("is_favorite", &self.is_favorite)
            .field("is_archived", &self.is_archived)
            .field("last_fit_mode", &self.last_fit_mode)
            .field("last_layout_mode", &self.last_layout_mode)
            .finish()
    }
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
            last_fit_mode: Some(view_state.fit_mode),
            last_layout_mode: Some(view_state.layout_mode),
        }
    }
}
