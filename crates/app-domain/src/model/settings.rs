//! Application preferences and resource budget settings.

use serde::{Deserialize, Serialize};

use crate::error::DomainError;
use crate::value_objects::theme::{LayoutMode, ThemePreference};
use crate::value_objects::zoom::{FitMode, ZoomLevel};

/// Minimum allowed render cache byte budget (8 MiB).
pub const MIN_CACHE_BUDGET_BYTES: usize = 8 * 1024 * 1024;
/// Default render cache byte budget (64 MiB).
pub const DEFAULT_CACHE_BUDGET_BYTES: usize = 64 * 1024 * 1024;
/// Maximum allowed render cache byte budget (512 MiB).
pub const MAX_CACHE_BUDGET_BYTES: usize = 512 * 1024 * 1024;
/// Maximum allowed prefetch window (5 pages ahead/behind).
pub const MAX_PREFETCH_WINDOW: u32 = 5;

/// User-configurable application preferences and performance budgets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppSettings {
    /// UI theme preference.
    pub theme: ThemePreference,
    /// Default layout mode for newly opened documents.
    pub default_layout: LayoutMode,
    /// Default viewport fit mode for newly opened documents.
    pub default_fit_mode: FitMode,
    /// Default zoom level when `default_fit_mode` is `Manual`.
    pub default_zoom: ZoomLevel,
    /// Maximum byte budget for the rendered-page LRU cache.
    pub render_cache_budget_bytes: usize,
    /// Number of adjacent pages to prefetch around the current page.
    pub prefetch_window: u32,
}

impl AppSettings {
    /// Validates that all settings invariants hold.
    pub fn validate(&self) -> Result<(), DomainError> {
        if !(MIN_CACHE_BUDGET_BYTES..=MAX_CACHE_BUDGET_BYTES)
            .contains(&self.render_cache_budget_bytes)
        {
            return Err(DomainError::InvalidCacheBudget {
                budget_bytes: self.render_cache_budget_bytes,
                min_bytes: MIN_CACHE_BUDGET_BYTES,
                max_bytes: MAX_CACHE_BUDGET_BYTES,
            });
        }
        if self.prefetch_window > MAX_PREFETCH_WINDOW {
            return Err(DomainError::InvalidPrefetchWindow {
                window: self.prefetch_window,
                max_window: MAX_PREFETCH_WINDOW,
            });
        }
        Ok(())
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            default_layout: LayoutMode::SinglePage,
            default_fit_mode: FitMode::FitWidth,
            default_zoom: ZoomLevel::ONE_HUNDRED_PERCENT,
            render_cache_budget_bytes: DEFAULT_CACHE_BUDGET_BYTES,
            prefetch_window: 1,
        }
    }
}
