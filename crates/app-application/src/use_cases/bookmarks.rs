//! Use cases for creating, listing, and deleting user bookmarks.

use app_domain::{Bookmark, BookmarkId, DocumentId, PageIndex};

use crate::dto::UpsertBookmarkCommand;
use crate::error::ApplicationError;
use crate::ports::platform::PlatformPort;
use crate::ports::storage::BookmarkRepository;

/// Creates or updates a bookmark on a validated page of an open or known document.
pub fn execute_upsert_bookmark(
    command: &UpsertBookmarkCommand,
    page_count: u32,
    bookmark_repo: &dyn BookmarkRepository,
    platform: &dyn PlatformPort,
) -> Result<Bookmark, ApplicationError> {
    let doc_id = DocumentId::new(&command.document_id)?;
    let page_index = PageIndex::within(command.page_index, page_count)?;
    let bookmark = Bookmark::new(
        BookmarkId::generate(),
        doc_id,
        page_index,
        &command.label,
        platform.current_unix_ms(),
    )?;
    bookmark_repo.upsert(&bookmark)
}

/// Lists all bookmarks for a document.
pub fn execute_list_bookmarks(
    document_id: &str,
    bookmark_repo: &dyn BookmarkRepository,
) -> Result<Vec<Bookmark>, ApplicationError> {
    let doc_id = DocumentId::new(document_id)?;
    bookmark_repo.list_for_document(&doc_id)
}

/// Deletes a bookmark by ID.
pub fn execute_delete_bookmark(
    bookmark_id: &str,
    bookmark_repo: &dyn BookmarkRepository,
) -> Result<bool, ApplicationError> {
    let id = BookmarkId::new(bookmark_id.trim());
    bookmark_repo.delete(&id)
}
