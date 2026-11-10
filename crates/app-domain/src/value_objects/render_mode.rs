//! Render color mode and page geometry value objects.

use serde::{Deserialize, Serialize};

use crate::error::DomainError;
use crate::value_objects::rotation::Rotation;

/// Hard security limit on maximum width or height of a rendered page bitmap in pixels.
pub const MAX_RENDER_DIMENSION_PX: u32 = 4096;

/// Color mode applied during page rendering.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum RenderMode {
    /// Normal full-color PDF rendering.
    #[default]
    Standard,
    /// Grayscale rendering.
    Grayscale,
    /// High-contrast dark-mode inversion for comfortable night reading.
    DarkInversion,
}

/// Physical dimensions of a PDF page in typographic points (1/72 inch).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageDimensions {
    width_pt: f32,
    height_pt: f32,
}

impl PageDimensions {
    /// Standard US Letter page size (612 x 792 pt).
    pub const US_LETTER: Self = Self {
        width_pt: 612.0,
        height_pt: 792.0,
    };

    /// Validates and constructs `PageDimensions`.
    pub fn new(width_pt: f32, height_pt: f32) -> Result<Self, DomainError> {
        if !width_pt.is_finite() || !height_pt.is_finite() || width_pt <= 0.0 || height_pt <= 0.0 {
            return Err(DomainError::InvalidPageDimensions {
                width_pt,
                height_pt,
            });
        }
        Ok(Self {
            width_pt,
            height_pt,
        })
    }

    /// Returns page width in points.
    #[must_use]
    pub const fn width_pt(self) -> f32 {
        self.width_pt
    }

    /// Returns page height in points.
    #[must_use]
    pub const fn height_pt(self) -> f32 {
        self.height_pt
    }

    /// Computes target pixel dimensions `(width_px, height_px)` for the given scale and rotation,
    /// enforcing `max_dimension_px` to prevent memory exhaustion on oversized pages.
    pub fn target_pixel_size(
        self,
        scale: f32,
        rotation: Rotation,
        max_dimension_px: u32,
    ) -> Result<(u32, u32), DomainError> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err(DomainError::InvalidZoomLevel(scale));
        }
        let (oriented_w, oriented_h) = match rotation {
            Rotation::Deg0 | Rotation::Deg180 => (self.width_pt, self.height_pt),
            Rotation::Deg90 | Rotation::Deg270 => (self.height_pt, self.width_pt),
        };
        let width_px = (oriented_w * scale).round().max(1.0) as u32;
        let height_px = (oriented_h * scale).round().max(1.0) as u32;
        let cap = max_dimension_px.min(MAX_RENDER_DIMENSION_PX);
        if width_px > cap || height_px > cap {
            return Err(DomainError::RenderDimensionsExceedLimit {
                width_px,
                height_px,
                max_px: cap,
            });
        }
        Ok((width_px, height_px))
    }
}
