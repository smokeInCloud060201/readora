//! Application preferences and resource budget settings.

use std::cmp::Ordering;

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

const fn default_auto_check_updates() -> bool {
    true
}

fn default_github_release_repo() -> String {
    "karsontang/readora".to_owned()
}

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
    /// Whether to display the embedded digital text layer below the rendered page.
    #[serde(default)]
    pub show_extracted_text_layer: bool,
    /// Whether Readora should automatically check for staged/available updates on launch.
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    /// GitHub `owner/repo` slug used to query `/repos/{owner}/{repo}/releases/latest`.
    #[serde(default = "default_github_release_repo")]
    pub github_release_repo: String,
    /// Active installed semantic version if an update has been applied/staged.
    #[serde(default)]
    pub installed_version: Option<String>,
    /// Semantic version of an update the user chose to defer with "Later".
    #[serde(default)]
    pub dismissed_update_version: Option<String>,
}

/// Compares two semantic version strings (`major.minor.patch`, optionally prefixed with `v`).
#[must_use]
pub fn compare_semver(left: &str, right: &str) -> Ordering {
    fn parse_parts(raw: &str) -> [u64; 3] {
        let cleaned = raw.trim().trim_start_matches(['v', 'V']);
        let core = cleaned.split(['-', '+']).next().unwrap_or("");
        let mut out = [0_u64; 3];
        for (idx, part) in core.split('.').take(3).enumerate() {
            out[idx] = part.parse::<u64>().unwrap_or(0);
        }
        out
    }

    let l = parse_parts(left);
    let r = parse_parts(right);
    l.cmp(&r)
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
            show_extracted_text_layer: false,
            auto_check_updates: true,
            github_release_repo: default_github_release_repo(),
            installed_version: None,
            dismissed_update_version: None,
        }
    }
}
