//! Theme preference and page layout mode value objects.

use serde::{Deserialize, Serialize};

/// Application appearance theme preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThemePreference {
    /// Follow the operating system theme.
    #[default]
    System,
    /// Light theme.
    Light,
    /// Dark theme.
    Dark,
}

/// Page scrolling layout in the reader viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LayoutMode {
    /// Display a single page at a time.
    SinglePage,
    /// Display pages in a vertical continuous scroll container.
    #[default]
    Continuous,
}
