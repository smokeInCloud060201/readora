//! Render cache and stale-request cancellation ports.

use app_domain::{DocumentId, PageIndex, RenderMode, Rotation, ScaleBucket};

/// Composite key uniquely identifying a rendered page bitmap in the cache.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RenderCacheKey {
    /// Document identifier.
    pub document_id: DocumentId,
    /// Zero-based page index.
    pub page_index: PageIndex,
    /// Quantized scale bucket (percentage points).
    pub scale_bucket: ScaleBucket,
    /// Page rotation angle.
    pub rotation: Rotation,
    /// Color render mode.
    pub render_mode: RenderMode,
}

/// Cached rendered page payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedPageEntry {
    /// Bitmap width in pixels.
    pub width_px: u32,
    /// Bitmap height in pixels.
    pub height_px: u32,
    /// Encoded PNG data URL (`data:image/png;base64,...`).
    pub data_url: String,
    /// Memory cost accounted against the cache's byte budget.
    pub byte_size: usize,
}

/// Port for a memory-bounded LRU rendered page cache.
pub trait RenderCachePort: Send + Sync {
    /// Retrieves a cached page entry if present and promotes it as most-recently-used.
    fn get(&self, key: &RenderCacheKey) -> Option<CachedPageEntry>;

    /// Inserts a rendered page into the cache, evicting least-recently-used entries
    /// until total usage fits within the configured byte budget.
    fn put(&self, key: RenderCacheKey, entry: CachedPageEntry);

    /// Removes all cached pages belonging to `document_id`.
    fn invalidate_document(&self, document_id: &DocumentId);

    /// Updates the maximum byte budget and evicts entries if necessary.
    fn set_budget_bytes(&self, budget_bytes: usize);

    /// Returns the current total bytes stored in the cache.
    fn current_usage_bytes(&self) -> usize;
}

/// Port for tracking active render generations per document and cancelling obsolete work.
pub trait RenderCancellationPort: Send + Sync {
    /// Advances and returns the latest render generation counter for `document_id`.
    fn next_generation(&self, document_id: &DocumentId) -> u64;

    /// Returns the current generation counter for `document_id` without advancing it.
    fn current_generation(&self, document_id: &DocumentId) -> u64;

    /// Checks whether `generation` is still current for `document_id`.
    fn is_current(&self, document_id: &DocumentId, generation: u64) -> bool;

    /// Cancels all in-flight renders and clears state when `document_id` is closed.
    fn clear_document(&self, document_id: &DocumentId);
}
