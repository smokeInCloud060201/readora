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

    /// Input file exceeds the configured maximum byte limit.
    #[error("file size {size_bytes} bytes exceeds maximum allowed {max_bytes} bytes")]
    FileTooLarge {
        /// Actual or reported size in bytes.
        size_bytes: u64,
        /// Configured upper bound in bytes.
        max_bytes: u64,
    },

    /// Operation was superseded or cancelled.
    #[error("operation cancelled")]
    Cancelled,
}

impl ApplicationError {
    /// Returns a stable, machine-readable error code for IPC serialization.
    #[must_use]
    pub const fn error_code(&self) -> &'static str {
        match self {
            Self::PdfEngine(PdfEngineError::PasswordRequired) => "password_required",
            Self::PdfEngine(PdfEngineError::IncorrectPassword) => "incorrect_password",
            Self::PdfEngine(PdfEngineError::InvalidPdfFormat(_)) => "invalid_pdf",
            Self::PdfEngine(PdfEngineError::FileTooLarge { .. }) | Self::FileTooLarge { .. } => {
                "file_too_large"
            }
            Self::PdfEngine(PdfEngineError::Cancelled) | Self::Cancelled => "cancelled",
            Self::DocumentNotOpen(_) => "document_not_open",
            Self::Domain(_) => "validation_error",
            Self::Storage(_) => "storage_error",
            Self::Platform(_) => "platform_error",
            Self::PdfEngine(_) => "pdf_engine_error",
        }
    }
}
