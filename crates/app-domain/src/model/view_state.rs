//! Reader session view state and visible/prefetch page calculation.

use serde::{Deserialize, Serialize};

use crate::error::DomainError;
use crate::value_objects::document_id::DocumentId;
use crate::value_objects::page_index::PageIndex;
use crate::value_objects::render_mode::RenderMode;
use crate::value_objects::rotation::Rotation;
use crate::value_objects::theme::LayoutMode;
use crate::value_objects::zoom::{FitMode, ZoomLevel};

/// Active reading state for an open document session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewState {
    /// Document identifier.
    pub document_id: DocumentId,
    /// Currently active zero-based page index.
    pub current_page: PageIndex,
    /// Total number of pages in the document.
    pub page_count: u32,
    /// Current zoom level.
    pub zoom: ZoomLevel,
    /// Current viewport fit mode.
    pub fit_mode: FitMode,
    /// User-applied rotation delta.
    pub rotation: Rotation,
    /// Single-page or continuous scroll layout.
    pub layout_mode: LayoutMode,
    /// Color render mode.
    pub render_mode: RenderMode,
}

impl ViewState {
    /// Creates an initial `ViewState` for a newly opened document.
    pub fn new(document_id: DocumentId, page_count: u32) -> Result<Self, DomainError> {
        if page_count == 0 {
            return Err(DomainError::InvalidPageCount(0));
        }
        Ok(Self {
            document_id,
            current_page: PageIndex::FIRST,
            page_count,
            zoom: ZoomLevel::default(),
            fit_mode: FitMode::default(),
            rotation: Rotation::default(),
            layout_mode: LayoutMode::default(),
            render_mode: RenderMode::default(),
        })
    }

    /// Navigates to a specific zero-based page index if within bounds.
    pub fn go_to_page(&mut self, page: PageIndex) -> Result<PageIndex, DomainError> {
        let validated = page.validate_within(self.page_count)?;
        self.current_page = validated;
        Ok(self.current_page)
    }

    /// Advances to the next page if not already at the last page.
    #[must_use]
    pub fn next_page(&mut self) -> PageIndex {
        let next = self.current_page.zero_based().saturating_add(1);
        if next < self.page_count {
            self.current_page = PageIndex::new(next);
        }
        self.current_page
    }

    /// Moves to the previous page if not already on the first page.
    #[must_use]
    pub fn previous_page(&mut self) -> PageIndex {
        let prev = self.current_page.zero_based().saturating_sub(1);
        self.current_page = PageIndex::new(prev);
        self.current_page
    }

    /// Updates the zoom level and switches fit mode to `FitMode::Manual`.
    pub fn set_manual_zoom(&mut self, zoom: ZoomLevel) {
        self.zoom = zoom;
        self.fit_mode = FitMode::Manual;
    }

    /// Rotates the document view 90 degrees clockwise.
    pub fn rotate_clockwise(&mut self) -> Rotation {
        self.rotation = self.rotation.rotate_clockwise();
        self.rotation
    }

    /// Rotates the document view 90 degrees counter-clockwise.
    pub fn rotate_counter_clockwise(&mut self) -> Rotation {
        self.rotation = self.rotation.rotate_counter_clockwise();
        self.rotation
    }

    /// Computes the ordered list of page indexes to render: the current visible page first,
    /// followed by up to `prefetch_window` pages ahead and behind.
    #[must_use]
    pub fn prioritized_render_pages(&self, prefetch_window: u32) -> Vec<PageIndex> {
        let current = self.current_page.zero_based();
        let mut pages = Vec::with_capacity((prefetch_window as usize * 2) + 1);
        pages.push(self.current_page);

        for offset in 1..=prefetch_window {
            if let Some(forward) = current.checked_add(offset) {
                if forward < self.page_count {
                    pages.push(PageIndex::new(forward));
                }
            }
            if let Some(backward) = current.checked_sub(offset) {
                pages.push(PageIndex::new(backward));
            }
        }
        pages
    }
}
