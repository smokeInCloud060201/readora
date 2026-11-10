//! Zoom level, scale bucket, and viewport fit mode value objects.

use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// Minimum supported zoom factor (25%).
pub const MIN_ZOOM_FACTOR: f32 = 0.25;
/// Maximum supported zoom factor (500%).
pub const MAX_ZOOM_FACTOR: f32 = 5.0;
/// Standard discrete zoom presets for stepping in and out.
pub const ZOOM_PRESETS: [f32; 11] = [0.25, 0.5, 0.75, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0, 4.0];

/// Discrete scale bucket in basis points / percentage points (e.g. `100` = 100%)
/// used as a deterministic component of the render cache key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ScaleBucket(u16);

impl ScaleBucket {
    /// Creates a `ScaleBucket` quantized to 5% increments from a scale factor.
    #[must_use]
    pub fn from_scale(scale: f32) -> Self {
        let clamped = scale.clamp(MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR);
        let pct = (clamped * 100.0).round() as u16;
        let quantized = ((pct + 2) / 5) * 5;
        Self(quantized.max(25))
    }

    /// Returns the bucket value in integer percentage points (e.g., `100` for 1.0x).
    #[must_use]
    pub const fn percentage(self) -> u16 {
        self.0
    }

    /// Converts the bucket back into a normalized floating-point scale factor.
    #[must_use]
    pub fn as_scale(self) -> f32 {
        f32::from(self.0) / 100.0
    }
}

/// Validated zoom factor between `0.25` and `5.0`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ZoomLevel(f32);

impl ZoomLevel {
    /// Default 100% zoom level (`1.0`).
    pub const ONE_HUNDRED_PERCENT: Self = Self(1.0);

    /// Validates and constructs a `ZoomLevel`.
    pub fn new(factor: f32) -> Result<Self, DomainError> {
        if !factor.is_finite() || !(MIN_ZOOM_FACTOR..=MAX_ZOOM_FACTOR).contains(&factor) {
            return Err(DomainError::InvalidZoomLevel(factor));
        }
        Ok(Self((factor * 100.0).round() / 100.0))
    }

    /// Constructs a `ZoomLevel` from basis points (where `100` = 1.0x).
    pub fn from_percentage(pct: u16) -> Result<Self, DomainError> {
        Self::new(f32::from(pct) / 100.0)
    }

    /// Returns the zoom factor (e.g. `1.25`).
    #[must_use]
    pub const fn factor(self) -> f32 {
        self.0
    }

    /// Returns the zoom percentage rounded to the nearest integer (e.g. `125`).
    #[must_use]
    pub fn percentage(self) -> u16 {
        (self.0 * 100.0).round() as u16
    }

    /// Returns the quantized `ScaleBucket` for render caching.
    #[must_use]
    pub fn scale_bucket(self) -> ScaleBucket {
        ScaleBucket::from_scale(self.0)
    }

    /// Steps up to the next zoom preset (or clamps at `MAX_ZOOM_FACTOR`).
    #[must_use]
    pub fn step_in(self) -> Self {
        for &preset in &ZOOM_PRESETS {
            if preset > self.0 + 0.01 {
                return Self(preset);
            }
        }
        Self(MAX_ZOOM_FACTOR)
    }

    /// Steps down to the previous zoom preset (or clamps at `MIN_ZOOM_FACTOR`).
    #[must_use]
    pub fn step_out(self) -> Self {
        for &preset in ZOOM_PRESETS.iter().rev() {
            if preset < self.0 - 0.01 {
                return Self(preset);
            }
        }
        Self(MIN_ZOOM_FACTOR)
    }
}

impl Default for ZoomLevel {
    fn default() -> Self {
        Self::ONE_HUNDRED_PERCENT
    }
}

/// How the viewport sizes pages relative to the container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FitMode {
    /// Manual zoom factor selected by user.
    Manual,
    /// Fit page width to viewport container.
    #[default]
    FitWidth,
    /// Fit entire page within viewport container.
    FitPage,
}
