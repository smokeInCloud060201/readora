//! Application-level errors combining domain, engine, storage, and platform errors.

use app_domain::DomainError;
use pdf_engine::PdfEngineError;
use thiserror::Error;

/// Unified error type returned by application use cases.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum ApplicationError {
    /// Domain validation or invariant failure.
    #[error("domain validation error: {0}")]
    Domain(#[from] DomainError),

    /// PDF engine failure.
    #[error("PDF error: {0}")]
    PdfEngine(#[from] PdfEngineError),

    /// Requested document session is not currently open.
    #[error("document session '{0}' is not open")]
    DocumentNotOpen(String),

    /// Storage / SQLite persistence error.
    #[error("storage error: {0}")]
    Storage(String),

    /// Platform / filesystem validation error.
    #[error("platform error: {0}")]
    Platform(String),

    /// Operation was superseded or cancelled.
    #[error("operation cancelled")]
    Cancelled,
}
