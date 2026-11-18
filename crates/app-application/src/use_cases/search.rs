//! Use case for searching text within an open PDF document.

use std::sync::Arc;

use app_domain::SearchHit;
use pdf_engine::PdfDocument;

use crate::dto::SearchRequestDto;
use crate::error::ApplicationError;

/// Default maximum search matches returned per query.
pub const DEFAULT_MAX_SEARCH_HITS: usize = 250;
/// Maximum permitted UTF-8 byte length for a search query.
pub const MAX_SEARCH_QUERY_BYTES: usize = 1024;

/// Executes an in-document text search and returns matching page snippets.
pub fn execute_search_document(
    request: &SearchRequestDto,
    document: &dyn PdfDocument,
) -> Result<Vec<SearchHit>, ApplicationError> {
    execute_search_document_cancellable(request, document, Arc::new(|| false))
}

/// Executes an in-document text search with cancellation polling and bounded query length.
pub fn execute_search_document_cancellable(
    request: &SearchRequestDto,
    document: &dyn PdfDocument,
    is_cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<Vec<SearchHit>, ApplicationError> {
    let trimmed = request.query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    if trimmed.len() > MAX_SEARCH_QUERY_BYTES {
        return Err(ApplicationError::Platform(format!(
            "search query exceeds maximum length of {MAX_SEARCH_QUERY_BYTES} bytes"
        )));
    }
    let cap = if request.max_hits == 0 {
        DEFAULT_MAX_SEARCH_HITS
    } else {
        request.max_hits.min(1000)
    };
    let hits =
        document.search_text_cancellable(trimmed, request.case_sensitive, cap, is_cancelled)?;
    Ok(hits)
}
