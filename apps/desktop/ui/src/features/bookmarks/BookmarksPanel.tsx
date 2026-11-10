import React, { useState } from "react";
import { type BookmarkDto, type DocumentDescriptorDto } from "../../types/ipc";

interface BookmarksPanelProps {
  bookmarks: BookmarkDto[];
  currentPage: number;
  descriptor?: DocumentDescriptorDto | null;
  onAddBookmark: (label: string) => void;
  onDeleteBookmark: (bookmarkId: string) => void;
  onSelectPage: (zeroBasedPage: number) => void;
  onClosePanel?: () => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "12.4 KB";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const BookmarksPanel: React.FC<BookmarksPanelProps> = ({
  bookmarks,
  currentPage,
  descriptor,
  onAddBookmark,
  onDeleteBookmark,
  onSelectPage,
  onClosePanel,
}) => {
  const [activeTab, setActiveTab] = useState<"notes" | "details">("notes");
  const [label, setLabel] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = label.trim() || `Page ${currentPage + 1} Bookmark`;
    onAddBookmark(trimmed);
    setLabel("");
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
            ×
          </button>
        )}
      </div>

      {activeTab === "notes" ? (
        <div className="notes-tab-body">
          <form
            onSubmit={handleSubmit}
            className="comment-composer-card"
            aria-label="Add Comment Composer"
          >
            <div className="comment-composer-header">
              <span>□ &nbsp; New comment</span>
              <span className="comment-composer-page">
                Page {currentPage + 1}
              </span>
            </div>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`Write a comment on page ${currentPage + 1}…`}
              aria-label="New bookmark label"
              className="focus-input full-width"
            />
            <div className="comment-composer-footer">
              <span className="comment-composer-hint">Enter to save</span>
              <button type="submit" className="add-comment-submit-btn">
                Save Bookmark on Page {currentPage + 1}
              </button>
            </div>
          </form>

          <p className="notes-section-eyebrow">
            ON THIS DOCUMENT &nbsp; {bookmarks.length}
          </p>

          {bookmarks.length === 0 ? (
            <div className="note-card highlight-accent">
              <div className="note-card-header">
                <span>✎ Reading Note</span>
                <span className="note-card-time">Page {currentPage + 1}</span>
              </div>
              <blockquote className="note-quote-box">
                “Focus rarely arrives by accident. It is cultivated through
                deliberate choices.”
              </blockquote>
              <p className="sidebar-empty">
                No bookmarks saved for this document yet. Add a note above to
                pin this page.
              </p>
            </div>
          ) : (
            <ul className="notes-card-list">
              {bookmarks.map((bm, idx) => (
                <li
                  key={bm.id}
                  className={`note-card ${
                    idx % 2 === 0 ? "highlight-accent" : "comment-accent"
                  }`}
                >
                  <div className="note-card-header">
                    <span>
                      {idx % 2 === 0 ? "✎ Bookmark" : "□ Note"} · Page{" "}
                      {bm.page_index + 1}
                    </span>
                    <button
                      type="button"
                      className="delete-icon-btn"
                      onClick={() => onDeleteBookmark(bm.id)}
                      aria-label={`Delete bookmark ${bm.label}`}
                    >
                      ×
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
                  <div className="note-card-author">MK &nbsp; You</div>
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
              <dd>{descriptor?.metadata.author || "Local Author"}</dd>
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
          </dl>
        </div>
      )}
    </aside>
  );
};
