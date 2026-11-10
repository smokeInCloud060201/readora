//! Use case for searching text within an open PDF document.

use app_domain::SearchHit;
use pdf_engine::PdfDocument;

use crate::dto::SearchRequestDto;
use crate::error::ApplicationError;

/// Default maximum search matches returned per query.
pub const DEFAULT_MAX_SEARCH_HITS: usize = 250;

/// Executes an in-document text search and returns matching page snippets.
pub fn execute_search_document(
    request: &SearchRequestDto,
    document: &dyn PdfDocument,
) -> Result<Vec<SearchHit>, ApplicationError> {
    let trimmed = request.query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let cap = if request.max_hits == 0 {
        DEFAULT_MAX_SEARCH_HITS
    } else {
        request.max_hits.min(1000)
    };
    let hits = document.search_text(trimmed, request.case_sensitive, cap)?;
    Ok(hits)
}
