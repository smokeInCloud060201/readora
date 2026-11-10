//! Application boundary DTOs for commands and queries.

use std::fmt;

use app_domain::{
    AnnotationKind, Bookmark, DocumentDescriptor, FitMode, LayoutMode, OutlineNode, RenderMode,
    ThemePreference, ViewState,
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

/// Command to create or update a persistent user annotation on a page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpsertAnnotationCommand {
    /// Target document ID.
    pub document_id: String,
    /// Zero-based page index.
    pub page_index: u32,
    /// Annotation primitive kind (`highlight`, `underline`, `comment`).
    pub kind: AnnotationKind,
    /// Hex color swatch (`#RRGGBB`).
    pub color_hex: String,
    /// Quoted excerpt from the page.
    pub quote_text: String,
    /// User note or comment attached to the annotation.
    pub note_text: String,
}

/// Exported annotations and bookmarks bundle for a document (Phase 5 Share / Export workflow).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportAnnotationsBundleDto {
    /// Sanitized export filename (e.g. `Readora-Welcome-Guide-annotations.md`).
    pub file_name: String,
    /// Local Readora deep link URI (`readora://document/<id>`).
    pub share_uri: String,
    /// Number of exported annotations.
    pub annotation_count: usize,
    /// Number of exported bookmarks.
    pub bookmark_count: usize,
    /// Formatted Markdown export content.
    pub markdown_content: String,
    /// Optional local file path where the bundle was atomically written.
    pub saved_path: Option<String>,
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
    /// Optional toggle for displaying extracted digital text below the page.
    pub show_extracted_text_layer: Option<bool>,
    /// Optional toggle for automatically checking for updates on launch.
    pub auto_check_updates: Option<bool>,
    /// Optional GitHub `owner/repo` slug for checking GitHub Releases.
    pub github_release_repo: Option<String>,
}

/// Verified release manifest describing an application update package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseManifestDto {
    /// Target semantic version (e.g. `"1.1.0"`).
    pub version: String,
    /// Headline release title (e.g. `"Focus Reader 1.1 is ready"`).
    pub title: String,
    /// Concise release summary notes.
    pub notes: String,
    /// Update bundle size in bytes.
    pub package_size_bytes: u64,
    /// Hex-encoded SHA-256 digest of the verified update bundle.
    pub sha256: String,
    /// ISO-8601 publication date string.
    pub published_at: String,
    /// Direct download URL or GitHub Release page URL.
    #[serde(default)]
    pub download_url: Option<String>,
}

/// Live application update status evaluated against the installed version and release manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppUpdateStatusDto {
    /// Currently installed application version (`major.minor.patch`).
    pub current_version: String,
    /// Whether a newer release is available to install.
    pub update_available: bool,
    /// Latest discovered version, if any.
    pub latest_version: Option<String>,
    /// Headline title for the available release.
    pub release_title: Option<String>,
    /// Release notes describing changes in the available release.
    pub release_notes: Option<String>,
    /// Bundle size in bytes of the available release.
    pub package_size_bytes: Option<u64>,
    /// SHA-256 checksum of the available release bundle.
    pub sha256_checksum: Option<String>,
    /// Direct download or GitHub release URL for the update package.
    pub download_url: Option<String>,
    /// Configured GitHub `owner/repo` release source.
    pub github_repo: String,
    /// Whether the release package integrity has been verified.
    pub verified: bool,
    /// Whether the update has been staged to apply on next restart.
    pub staged_for_restart: bool,
    /// Unix timestamp in milliseconds when the update check completed.
    pub checked_at_unix_ms: i64,
}

/// Third-party open-source component notice included in the SBOM and About view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThirdPartyNoticeDto {
    /// Component or crate name.
    pub name: String,
    /// Pinned version or version series.
    pub version: String,
    /// SPDX license expression.
    pub license: String,
    /// Role in Readora.
    pub role: String,
}

/// Privacy-safe support and packaging diagnostics (never includes file contents or user home paths).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemDiagnosticsDto {
    /// Application semantic version.
    pub app_version: String,
    /// Target operating system (`macos`, `windows`, `linux`).
    pub target_os: String,
    /// Target CPU architecture (`aarch64`, `x86_64`).
    pub target_arch: String,
    /// Active PDF engine identifier (`pdfium_dynamic` or `pure_rust_fallback`).
    pub pdf_engine_kind: String,
    /// Active SQLite schema migration version.
    pub sqlite_schema_version: i64,
    /// Privacy-redacted application data directory location.
    pub redacted_data_dir: String,
    /// Current render cache memory usage in bytes.
    pub render_cache_usage_bytes: usize,
    /// Third-party open-source component inventory (SBOM summary).
    pub third_party_notices: Vec<ThirdPartyNoticeDto>,
}

/// Summary of an application-scoped data and cache cleanup (for uninstall or local reset).
///
/// Only files and directories created by Readora (`readora.sqlite*`, Readora cache entries,
/// and Readora temporary files) are ever removed; user PDF documents and unrelated files
/// on the filesystem are strictly untouched.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppCleanupReportDto {
    /// Number of SQLite database files removed (`readora.sqlite`, `-wal`, `-shm`, `-journal`).
    pub removed_database_files: usize,
    /// Number of application cache entries removed from the Readora cache directory.
    pub removed_cache_entries: usize,
    /// Number of Readora temporary/staging files removed.
    pub removed_temp_entries: usize,
    /// Whether the empty Readora application data directory itself was removed.
    pub data_dir_removed: bool,
    /// Whether the empty Readora cache directory itself was removed.
    pub cache_dir_removed: bool,
    /// Privacy-redacted data directory that was cleaned.
    pub redacted_data_dir: String,
    /// Privacy-redacted cache directory that was cleaned.
    pub redacted_cache_dir: String,
}
