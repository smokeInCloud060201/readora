//! Use cases for creating, listing, and deleting user bookmarks and annotations.

use app_domain::{
    Annotation, AnnotationId, Bookmark, BookmarkId, DocumentId, PageIndex, sanitize_display_name,
};

use crate::dto::{ExportAnnotationsBundleDto, UpsertAnnotationCommand, UpsertBookmarkCommand};
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

/// Generates a portable Markdown export bundle of a document's bookmarks and annotations,
/// optionally writing it atomically to `destination_path`.
pub fn execute_export_annotations_bundle(
    document_id: &str,
    document_title: &str,
    include_annotations: bool,
    destination_path: Option<&str>,
    bookmark_repo: &dyn BookmarkRepository,
    annotation_repo: &dyn AnnotationRepository,
    platform: &dyn PlatformPort,
) -> Result<ExportAnnotationsBundleDto, ApplicationError> {
    let doc_id = DocumentId::new(document_id)?;
    let bookmarks = bookmark_repo.list_for_document(&doc_id)?;
    let annotations = if include_annotations {
        annotation_repo.list_for_document(&doc_id)?
    } else {
        Vec::new()
    };

    let clean_title = sanitize_display_name(document_title);
    let stem = clean_title
        .strip_suffix(".pdf")
        .or_else(|| clean_title.strip_suffix(".PDF"))
        .unwrap_or(&clean_title);
    let file_name = format!("{stem}-annotations.md");
    let share_uri = format!("readora://document/{}", doc_id.as_str());

    let mut md = format!("# {clean_title} — Reading Notes & Annotations\n\n");
    md.push_str(&format!("- **Document ID:** `{}`\n", doc_id.as_str()));
    md.push_str(&format!("- **Bookmarks:** {}\n", bookmarks.len()));
    md.push_str(&format!("- **Annotations:** {}\n\n", annotations.len()));

    if !bookmarks.is_empty() {
        md.push_str("## Bookmarks\n\n");
        for bm in &bookmarks {
            md.push_str(&format!(
                "- **Page {}:** {}\n",
                bm.page_index.one_based(),
                bm.label
            ));
        }
        md.push('\n');
    }

    if !annotations.is_empty() {
        md.push_str("## Highlights & Comments\n\n");
        for ann in &annotations {
            md.push_str(&format!(
                "### Page {} · {:?} ({})\n",
                ann.page_index.one_based(),
                ann.kind,
                ann.color_hex
            ));
            if !ann.quote_text.is_empty() {
                md.push_str(&format!("> “{}”\n\n", ann.quote_text));
            }
            if !ann.note_text.is_empty() {
                md.push_str(&format!("{}\n\n", ann.note_text));
            }
        }
    }

    let saved_path = if let Some(path) = destination_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            platform.atomic_write_file(trimmed, md.as_bytes())?;
            Some(trimmed.to_owned())
        } else {
            None
        }
    } else {
        None
    };

    Ok(ExportAnnotationsBundleDto {
        file_name,
        share_uri,
        annotation_count: annotations.len(),
        bookmark_count: bookmarks.len(),
        markdown_content: md,
        saved_path,
    })
}
