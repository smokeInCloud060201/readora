//! Zero-based page index value object with bounds validation.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// Zero-based index of a page within a PDF document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PageIndex(u32);

impl PageIndex {
    /// First page index (`0`).
    pub const FIRST: Self = Self(0);

    /// Creates a zero-based page index without bounds checking against a specific document.
    #[must_use]
    pub const fn new(zero_based: u32) -> Self {
        Self(zero_based)
    }

    /// Creates a `PageIndex` from a 1-based user-facing page number.
    pub fn from_one_based(one_based: u32) -> Result<Self, DomainError> {
        if one_based == 0 {
            return Err(DomainError::InvalidOneBasedPage(one_based));
        }
        Ok(Self(one_based - 1))
    }

    /// Creates a zero-based `PageIndex` and validates that it falls within `page_count`.
    pub fn within(zero_based: u32, page_count: u32) -> Result<Self, DomainError> {
        if page_count == 0 {
            return Err(DomainError::InvalidPageCount(0));
        }
        if zero_based >= page_count {
            return Err(DomainError::PageOutOfBounds {
                page_index: zero_based,
                page_count,
            });
        }
        Ok(Self(zero_based))
    }

    /// Validates that this page index is within `page_count`.
    pub fn validate_within(self, page_count: u32) -> Result<Self, DomainError> {
        Self::within(self.0, page_count)
    }

    /// Returns the underlying zero-based page index.
    #[must_use]
    pub const fn zero_based(self) -> u32 {
        self.0
    }

    /// Returns the 1-based page number suitable for display in UI controls.
    #[must_use]
    pub const fn one_based(self) -> u32 {
        self.0.saturating_add(1)
    }
}

impl fmt::Display for PageIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.one_based())
    }
}
