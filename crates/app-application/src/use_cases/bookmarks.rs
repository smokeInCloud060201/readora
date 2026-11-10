//! Use cases for creating, listing, and deleting user bookmarks and annotations.

use app_domain::{Annotation, AnnotationId, Bookmark, BookmarkId, DocumentId, PageIndex};

use crate::dto::{UpsertAnnotationCommand, UpsertBookmarkCommand};
use crate::error::ApplicationError;
use crate::ports::platform::PlatformPort;
use crate::ports::storage::{AnnotationRepository, BookmarkRepository};

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

/// Creates a persistent annotation (highlight, underline, or comment) on a validated page.
pub fn execute_upsert_annotation(
    command: &UpsertAnnotationCommand,
    page_count: u32,
    annotation_repo: &dyn AnnotationRepository,
    platform: &dyn PlatformPort,
) -> Result<Annotation, ApplicationError> {
    let doc_id = DocumentId::new(&command.document_id)?;
    let page_index = PageIndex::within(command.page_index, page_count)?;
    let annotation = Annotation::new(
        AnnotationId::generate(),
        doc_id,
        page_index,
        command.kind,
        &command.color_hex,
        &command.quote_text,
        &command.note_text,
        platform.current_unix_ms(),
    )?;
    annotation_repo.upsert(&annotation)
}

/// Lists all annotations for a document.
pub fn execute_list_annotations(
    document_id: &str,
    annotation_repo: &dyn AnnotationRepository,
) -> Result<Vec<Annotation>, ApplicationError> {
    let doc_id = DocumentId::new(document_id)?;
    annotation_repo.list_for_document(&doc_id)
}

/// Deletes an annotation by ID.
pub fn execute_delete_annotation(
    annotation_id: &str,
    annotation_repo: &dyn AnnotationRepository,
) -> Result<bool, ApplicationError> {
    let id = AnnotationId::new(annotation_id.trim());
    annotation_repo.delete(&id)
}
