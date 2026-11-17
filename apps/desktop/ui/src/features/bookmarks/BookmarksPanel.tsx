import React, { useEffect, useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import {
  type AnnotationDto,
  type BookmarkDto,
  type DocumentDescriptorDto,
} from "../../types/ipc";
import {
  MAX_ANNOTATION_NOTE_LEN,
  sliceByUnicodeCodePoints,
} from "../reader/FloatingAnnotationTools";

interface BookmarksPanelProps {
  bookmarks: BookmarkDto[];
  annotations?: AnnotationDto[];
  currentPage: number;
  descriptor?: DocumentDescriptorDto | null;
  requestedTab?: "notes" | "details";
  requestedTabTrigger?: number;
  onAddBookmark: (label: string) => void;
  onAddComment?: (noteText: string) => void;
  onDeleteBookmark: (bookmarkId: string) => void;
  onDeleteAnnotation?: (annotationId: string) => void;
  onSelectPage: (zeroBasedPage: number) => void;
  onClosePanel?: () => void;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const BookmarksPanel: React.FC<BookmarksPanelProps> = ({
  bookmarks,
  annotations = [],
  currentPage,
  descriptor,
  requestedTab,
  requestedTabTrigger = 0,
  onAddBookmark,
  onAddComment,
  onDeleteBookmark,
  onDeleteAnnotation,
  onSelectPage,
  onClosePanel,
}) => {
  const [activeTab, setActiveTab] = useState<"notes" | "details">(
    requestedTab ?? "notes",
  );
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [commentText, setCommentText] = useState("");

  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab);
    }
  }, [requestedTab, requestedTabTrigger]);

  const handleBookmarkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed =
      bookmarkLabel.trim() || `Page ${currentPage + 1} Bookmark`;
    onAddBookmark(trimmed);
    setBookmarkLabel("");
  };

  const handleCommentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = sliceByUnicodeCodePoints(
      commentText.trim(),
      MAX_ANNOTATION_NOTE_LEN,
    );
    if (!trimmed || !onAddComment) {
      return;
    }
    onAddComment(trimmed);
    setCommentText("");
  };

  return (
    <aside className="notes-details-panel" aria-label="User Bookmarks">
      <div className="notes-panel-header">
        <div className="sidebar-tabs-header">
          <button
            type="button"
            className={`sidebar-tab-btn ${
              activeTab === "notes" ? "active" : ""
            }`}
            onClick={() => setActiveTab("notes")}
          >
            Notes
          </button>
          <button
            type="button"
            className={`sidebar-tab-btn ${
              activeTab === "details" ? "active" : ""
            }`}
            onClick={() => setActiveTab("details")}
          >
            Details
          </button>
        </div>
        {onClosePanel && (
          <button
            type="button"
            className="panel-close-btn"
            onClick={onClosePanel}
            aria-label="Close Notes Panel"
          >
            <FocusIcon name="close" size={14} />
          </button>
        )}
      </div>

      {activeTab === "notes" ? (
        <div className="notes-tab-body">
          {onAddComment && (
            <form
              onSubmit={handleCommentSubmit}
              className="comment-composer-card"
              aria-label="Add Comment Composer"
            >
              <div className="comment-composer-header">
                <span className="icon-inline-label">
                  <FocusIcon name="comment" size={14} />
                  <span>New comment</span>
                </span>
                <span className="comment-composer-page">
                  Page {currentPage + 1}
                </span>
              </div>
              <textarea
                rows={2}
                maxLength={MAX_ANNOTATION_NOTE_LEN}
                value={commentText}
                onChange={(e) =>
                  setCommentText(
                    sliceByUnicodeCodePoints(
                      e.target.value,
                      MAX_ANNOTATION_NOTE_LEN,
                    ),
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleCommentSubmit(e);
                  }
                }}
                placeholder={`Write a comment on page ${currentPage + 1}…`}
                aria-label="New comment"
                className="focus-input full-width comment-composer-input"
              />
              <div className="comment-composer-footer">
                <span className="comment-composer-hint">Enter to save</span>
                <button
                  type="submit"
                  className="add-comment-submit-btn"
                  disabled={!commentText.trim()}
                >
                  Add Comment on Page {currentPage + 1}
                </button>
              </div>
            </form>
          )}

          <form
            onSubmit={handleBookmarkSubmit}
            className="comment-composer-card"
            aria-label="Add Bookmark Form"
          >
            <div className="comment-composer-header">
              <span className="icon-inline-label">
                <FocusIcon name="bookmark" size={14} />
                <span>Page bookmark</span>
              </span>
              <span className="comment-composer-page">
                Page {currentPage + 1}
              </span>
            </div>
            <input
              type="text"
              value={bookmarkLabel}
              onChange={(e) => setBookmarkLabel(e.target.value)}
              placeholder={`Bookmark label for page ${currentPage + 1}…`}
              aria-label="New bookmark label"
              className="focus-input full-width"
            />
            <div className="comment-composer-footer">
              <span className="comment-composer-hint">Pins current page</span>
              <button type="submit" className="add-comment-submit-btn">
                Save Bookmark on Page {currentPage + 1}
              </button>
            </div>
          </form>

          <p className="notes-section-eyebrow">
            ON THIS DOCUMENT &nbsp; {bookmarks.length + annotations.length}
          </p>

          {bookmarks.length === 0 && annotations.length === 0 ? (
            <div className="note-card highlight-accent">
              <div className="note-card-header">
                <span className="icon-inline-label">
                  <FocusIcon name="highlight" size={13} />
                  <span>Reading Notes</span>
                </span>
                <span className="note-card-time">Page {currentPage + 1}</span>
              </div>
              <p className="sidebar-empty">
                No bookmarks or highlights saved for this document yet. Add a
                comment or bookmark above to pin this page.
              </p>
            </div>
          ) : (
            <ul className="notes-card-list">
              {annotations.map((ann) => {
                const kindLabel =
                  ann.kind === "comment"
                    ? "Comment"
                    : ann.kind === "underline"
                      ? "Underline"
                      : "Highlight";
                const accentClass =
                  ann.kind === "comment"
                    ? "comment-accent"
                    : "highlight-accent";
                return (
                  <li
                    key={ann.id}
                    className={`note-card ${accentClass}`}
                    style={{ borderLeftColor: ann.color_hex }}
                  >
                    <div className="note-card-header">
                      <span className="icon-inline-label">
                        <FocusIcon
                          name={ann.kind === "comment" ? "comment" : "highlight"}
                          size={13}
                        />
                        <span>
                          {kindLabel} · Page {ann.page_index + 1}
                        </span>
                      </span>
                      {onDeleteAnnotation && (
                        <button
                          type="button"
                          className="delete-icon-btn"
                          onClick={() => onDeleteAnnotation(ann.id)}
                          aria-label={`Delete annotation ${ann.note_text || ann.quote_text}`}
                        >
                          <FocusIcon name="trash" size={13} />
                        </button>
                      )}
                    </div>
                    {ann.quote_text && (
                      <blockquote className="note-quote-box">
                        “{ann.quote_text}”
                      </blockquote>
                    )}
                    <button
                      type="button"
                      className="note-card-jump-btn"
                      onClick={() => onSelectPage(ann.page_index)}
                    >
                      <span className="note-card-label">
                        {ann.note_text || "Highlighted excerpt"}
                      </span>
                      <span className="page-pill">p. {ann.page_index + 1}</span>
                    </button>
                  </li>
                );
              })}
              {bookmarks.map((bm) => (
                <li key={bm.id} className="note-card highlight-accent">
                  <div className="note-card-header">
                    <span className="icon-inline-label">
                      <FocusIcon name="bookmark" size={13} filled />
                      <span>Bookmark · Page {bm.page_index + 1}</span>
                    </span>
                    <button
                      type="button"
                      className="delete-icon-btn"
                      onClick={() => onDeleteBookmark(bm.id)}
                      aria-label={`Delete bookmark ${bm.label}`}
                    >
                      <FocusIcon name="trash" size={13} />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="note-card-jump-btn"
                    onClick={() => onSelectPage(bm.page_index)}
                  >
                    <span className="note-card-label">{bm.label}</span>
                    <span className="page-pill">p. {bm.page_index + 1}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="details-tab-body" aria-label="Document Details">
          <div className="details-file-preview">
            <span>PDF</span>
          </div>
          <h3 className="details-doc-title">
            {descriptor?.metadata.title ||
              descriptor?.file_name ||
              "PDF Document"}
          </h3>
          <p className="details-doc-subtitle">PDF Document</p>

          <dl className="details-meta-list">
            <div className="details-meta-row">
              <dt>Pages</dt>
              <dd>{descriptor?.page_count ?? 1}</dd>
            </div>
            <div className="details-meta-row">
              <dt>File size</dt>
              <dd>{formatBytes(descriptor?.file_size_bytes)}</dd>
            </div>
            <div className="details-meta-row">
              <dt>Author</dt>
              <dd>{descriptor?.metadata.author || "Unknown"}</dd>
            </div>
            <div className="details-meta-row">
              <dt>PDF Version</dt>
              <dd>{descriptor?.metadata.pdf_version || "1.7"}</dd>
            </div>
            <div className="details-meta-row">
              <dt>Security</dt>
              <dd>
                {descriptor?.metadata.is_encrypted
                  ? "Password Encrypted"
                  : "Standard Local"}
              </dd>
            </div>
            <div className="details-meta-row">
              <dt>Signatures</dt>
              <dd>
                {descriptor?.metadata.signature_status ===
                "signature_present_unverified"
                  ? "Signature field present (certificate trust not verified)"
                  : "No digital signature fields"}
              </dd>
            </div>
            <div className="details-meta-row">
              <dt>Forms</dt>
              <dd>
                {descriptor?.metadata.form_support === "unsupported_xfa"
                  ? "Unsupported XFA form (disabled)"
                  : descriptor?.metadata.form_support === "acro_form_read_only"
                    ? "AcroForm (read-only)"
                    : "No interactive forms"}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </aside>
  );
};
