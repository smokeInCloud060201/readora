//! Page rotation value object.

use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// Quarter-turn page rotation angle.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum Rotation {
    /// 0 degrees (upright).
    #[default]
    Deg0,
    /// 90 degrees clockwise.
    Deg90,
    /// 180 degrees upside-down.
    Deg180,
    /// 270 degrees clockwise (90 degrees counter-clockwise).
    Deg270,
}

impl Rotation {
    /// Constructs a `Rotation` from degrees (`0`, `90`, `180`, `270`).
    pub fn from_degrees(degrees: u16) -> Result<Self, DomainError> {
        match degrees % 360 {
            0 => Ok(Self::Deg0),
            90 => Ok(Self::Deg90),
            180 => Ok(Self::Deg180),
            270 => Ok(Self::Deg270),
            _ => Err(DomainError::InvalidRotationDegrees(degrees)),
        }
    }

    /// Returns the rotation angle in degrees (`0`, `90`, `180`, `270`).
    #[must_use]
    pub const fn degrees(self) -> u16 {
        match self {
            Self::Deg0 => 0,
            Self::Deg90 => 90,
            Self::Deg180 => 180,
            Self::Deg270 => 270,
        }
    }

    /// Rotates 90 degrees clockwise.
    #[must_use]
    pub const fn rotate_clockwise(self) -> Self {
        match self {
            Self::Deg0 => Self::Deg90,
            Self::Deg90 => Self::Deg180,
            Self::Deg180 => Self::Deg270,
            Self::Deg270 => Self::Deg0,
        }
    }

    /// Rotates 90 degrees counter-clockwise.
    #[must_use]
    pub const fn rotate_counter_clockwise(self) -> Self {
        match self {
            Self::Deg0 => Self::Deg270,
            Self::Deg90 => Self::Deg0,
            Self::Deg180 => Self::Deg90,
            Self::Deg270 => Self::Deg180,
        }
    }

    /// Combines two rotations (`self + other mod 360`).
    #[must_use]
    pub const fn combine(self, other: Self) -> Self {
        match (self.degrees() + other.degrees()) % 360 {
            90 => Self::Deg90,
            180 => Self::Deg180,
            270 => Self::Deg270,
            _ => Self::Deg0,
        }
    }
}
