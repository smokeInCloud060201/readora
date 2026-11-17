//! Use cases for creating, listing, and deleting user bookmarks and annotations.

use std::path::{Component, Path};

use app_domain::{
    Annotation, AnnotationId, Bookmark, BookmarkId, DocumentId, PageIndex, sanitize_display_name,
    sanitize_export_stem,
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
    let id = BookmarkId::try_new(bookmark_id)?;
    bookmark_repo.delete(&id)
}

/// Creates or updates a persistent annotation (highlight, underline, or comment) on a validated page.
pub fn execute_upsert_annotation(
    command: &UpsertAnnotationCommand,
    page_count: u32,
    annotation_repo: &dyn AnnotationRepository,
    platform: &dyn PlatformPort,
) -> Result<Annotation, ApplicationError> {
    let doc_id = DocumentId::new(&command.document_id)?;
    let page_index = PageIndex::within(command.page_index, page_count)?;
    let annotation_id = match command.id.as_deref().map(str::trim) {
        Some(existing) if !existing.is_empty() => AnnotationId::new(existing),
        _ => AnnotationId::generate(),
    };
    let annotation = Annotation::new(
        annotation_id,
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
    let id = AnnotationId::try_new(annotation_id)?;
    annotation_repo.delete(&id)
}

fn validate_markdown_export_destination(raw_dest: &str) -> Result<&str, ApplicationError> {
    let trimmed = raw_dest.trim();
    if trimmed.is_empty() {
        return Err(ApplicationError::Platform(
            "export destination path must not be empty".to_owned(),
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(ApplicationError::Platform(
            "export destination path contains control characters".to_owned(),
        ));
    }
    let path = Path::new(trimmed);
    if path.components().any(|c| matches!(c, Component::ParentDir))
        || trimmed.split(['/', '\\']).any(|seg| seg == "..")
    {
        return Err(ApplicationError::Platform(
            "export destination path must not contain '..' traversal segments".to_owned(),
        ));
    }
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return Err(ApplicationError::Platform(
            "export destination path must include a valid file name".to_owned(),
        ));
    };
    if file_name.starts_with('.') {
        return Err(ApplicationError::Platform(
            "export destination file name must not start with '.'".to_owned(),
        ));
    }
    let has_md_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    if !has_md_ext {
        return Err(ApplicationError::Platform(
            "export destination path must have a .md extension".to_owned(),
        ));
    }
    Ok(trimmed)
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
    let validated_dest = match destination_path {
        Some(raw) => Some(validate_markdown_export_destination(raw)?),
        None => None,
    };

    let bookmarks = bookmark_repo.list_for_document(&doc_id)?;
    let annotations = if include_annotations {
        annotation_repo.list_for_document(&doc_id)?
    } else {
        Vec::new()
    };

    let clean_title = sanitize_display_name(document_title);
    let raw_stem = if clean_title.len() >= 4
        && clean_title.is_char_boundary(clean_title.len() - 4)
        && clean_title[clean_title.len() - 4..].eq_ignore_ascii_case(".pdf")
    {
        &clean_title[..clean_title.len() - 4]
    } else {
        &clean_title
    };
    let safe_stem = sanitize_export_stem(raw_stem);
    let file_name = format!("{safe_stem}-annotations.md");
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

    let saved_path = if let Some(dest) = validated_dest {
        platform.atomic_write_file(dest, md.as_bytes())?;
        Some(dest.to_owned())
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
