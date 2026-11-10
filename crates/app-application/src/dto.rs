//! Application boundary DTOs for commands and queries.

use std::fmt;

use app_domain::{
    Bookmark, DocumentDescriptor, FitMode, LayoutMode, OutlineNode, RenderMode, ThemePreference,
    ViewState,
};
use serde::{Deserialize, Serialize};

/// Request to open a local PDF file.
#[derive(Clone, Deserialize)]
pub struct OpenDocumentRequest {
    /// Local path selected by the user via native dialog or recent files.
    pub path: String,
    /// Optional password for encrypted PDFs (never logged).
    pub password: Option<String>,
}

impl fmt::Debug for OpenDocumentRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenDocumentRequest")
            .field("has_path", &(!self.path.is_empty()))
            .field("has_password", &self.password.is_some())
            .finish()
    }
}

/// Complete initial snapshot returned when a document is opened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentSessionDto {
    /// Document metadata and page count descriptor.
    pub descriptor: DocumentDescriptor,
    /// Restored or default initial view state.
    pub view_state: ViewState,
    /// Document table of contents / outline tree.
    pub outline: Vec<OutlineNode>,
    /// User bookmarks saved for this document.
    pub bookmarks: Vec<Bookmark>,
}

/// Command to render a single page at a target scale and rotation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderPageCommand {
    /// Target document ID.
    pub document_id: String,
    /// Zero-based page index.
    pub page_index: u32,
    /// Effective scale factor (zoom * device pixel ratio).
    pub scale: f32,
    /// Rotation angle in degrees (`0`, `90`, `180`, `270`).
    pub rotation_degrees: u16,
    /// Color render mode.
    pub render_mode: RenderMode,
    /// Optional caller-supplied generation token for stale-render cancellation.
    pub generation: Option<u64>,
}

/// Result of a page render operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderedPageResultDto {
    /// Document ID.
    pub document_id: String,
    /// Rendered zero-based page index.
    pub page_index: u32,
    /// Rendered image width in pixels.
    pub width_px: u32,
    /// Rendered image height in pixels.
    pub height_px: u32,
    /// Compact PNG `data:image/png;base64,...` URL for direct `<img src=...>` rendering.
    pub data_url: String,
    /// Whether this result was served from the byte-bounded LRU cache.
    pub cache_hit: bool,
    /// Generation number active when the render completed.
    pub generation: u64,
}

/// Viewport navigation or view-state mutation command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum NavigationAction {
    /// Jump directly to a zero-based page index.
    GoToPage(u32),
    /// Advance to the next page.
    NextPage,
    /// Return to the previous page.
    PreviousPage,
    /// Set manual zoom factor (`0.25..=5.0`).
    SetZoom(f32),
    /// Step zoom in to the next preset.
    StepZoomIn,
    /// Step zoom out to the previous preset.
    StepZoomOut,
    /// Change fit mode (`manual`, `fit_width`, `fit_page`).
    SetFitMode(FitMode),
    /// Rotate 90 degrees clockwise.
    RotateClockwise,
    /// Rotate 90 degrees counter-clockwise.
    RotateCounterClockwise,
    /// Change layout mode (`single_page` or `continuous`).
    SetLayoutMode(LayoutMode),
    /// Change color render mode (`standard`, `grayscale`, `dark_inversion`).
    SetRenderMode(RenderMode),
}

/// Command to search text within an open document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchRequestDto {
    /// Target document ID.
    pub document_id: String,
    /// Search query string.
    pub query: String,
    /// Whether matching should be case-sensitive.
    pub case_sensitive: bool,
    /// Maximum number of hits to return.
    pub max_hits: usize,
}

/// Command to create or update a user bookmark on a page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpsertBookmarkCommand {
    /// Target document ID.
    pub document_id: String,
    /// Zero-based page index.
    pub page_index: u32,
    /// User-facing bookmark label.
    pub label: String,
}

/// Partial update patch for application settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SettingsPatchDto {
    /// Optional theme preference update.
    pub theme: Option<ThemePreference>,
    /// Optional default layout update.
    pub default_layout: Option<LayoutMode>,
    /// Optional default fit mode update.
    pub default_fit_mode: Option<FitMode>,
    /// Optional default zoom factor update.
    pub default_zoom_factor: Option<f32>,
    /// Optional render cache byte budget update.
    pub render_cache_budget_bytes: Option<usize>,
    /// Optional prefetch window update.
    pub prefetch_window: Option<u32>,
}
