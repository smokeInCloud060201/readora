import React, { useState } from "react";
import { type RecentDocumentDto } from "../../types/ipc";

export type LibraryCollectionView = "all" | "favorites" | "archive";

interface EmptyWorkspaceProps {
  recentDocuments: RecentDocumentDto[];
  activeCollection?: LibraryCollectionView;
  onChangeCollection?: (collection: LibraryCollectionView) => void;
  onOpenSample: () => void;
  onOpenRecent: (filePath: string) => void;
  onToggleFavorite?: (documentId: string, nextFavorite: boolean) => void;
  onRestoreArchived?: (documentId: string) => void;
  onArchiveDocument?: (documentId: string) => void;
  onDeleteRecentDocument?: (documentId: string) => void;
}

const COVER_COLORS = ["#374231", "#bd9d6f", "#a8594d", "#343b42"];

export const EmptyWorkspace: React.FC<EmptyWorkspaceProps> = ({
  recentDocuments,
  activeCollection = "all",
  onChangeCollection,
  onOpenSample,
  onOpenRecent,
  onToggleFavorite,
  onRestoreArchived,
  onArchiveDocument,
  onDeleteRecentDocument,
}) => {
  const [libraryFilter, setLibraryFilter] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPathInput, setImportPathInput] = useState("");

  const searchNormalized = libraryFilter.trim().toLowerCase();

  const activeLibraryDocs = recentDocuments.filter((doc) => !doc.is_archived);
  const favoriteDocs = recentDocuments.filter(
    (doc) => Boolean(doc.is_favorite) && !doc.is_archived,
  );
  const archivedDocs = recentDocuments.filter((doc) => Boolean(doc.is_archived));

  const matchesSearch = (doc: RecentDocumentDto) =>
    doc.display_name.toLowerCase().includes(searchNormalized);

  const filteredAllDocs = activeLibraryDocs.filter(matchesSearch);
  const filteredFavorites = favoriteDocs.filter(matchesSearch);
  const filteredArchived = archivedDocs.filter(matchesSearch);

  const latestDocument = activeLibraryDocs[0] ?? null;

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (importPathInput.trim()) {
      onOpenRecent(importPathInput.trim());
      setImportPathInput("");
      setShowImportDialog(false);
    }
  };

  const headerTitle =
    activeCollection === "favorites"
      ? "Favorites"
      : activeCollection === "archive"
        ? "Archive"
        : "Your library";

  const headerSubtitle =
    activeCollection === "favorites"
      ? "Documents you want to keep close."
      : activeCollection === "archive"
        ? "Documents stay here until you restore or permanently delete them."
        : null;

  return (
    <main className="library-workspace" aria-label="Welcome Workspace">
      <div className="library-container">
        <header className="library-header">
          <div>
            <p className="eyebrow-label">FOCUS READER</p>
            <h1 className="library-title">{headerTitle}</h1>
            {headerSubtitle && (
              <p className="library-subtitle">{headerSubtitle}</p>
            )}
          </div>

          <div className="library-header-controls">
            {onChangeCollection && (
              <div
                className="library-collection-tabs"
                role="tablist"
                aria-label="Library Collections"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeCollection === "all"}
                  className={`collection-tab-btn ${
                    activeCollection === "all" ? "active" : ""
                  }`}
                  onClick={() => onChangeCollection("all")}
                >
                  Library
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeCollection === "favorites"}
                  className={`collection-tab-btn ${
                    activeCollection === "favorites" ? "active" : ""
                  }`}
                  onClick={() => onChangeCollection("favorites")}
                >
                  Favorites ({favoriteDocs.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeCollection === "archive"}
                  className={`collection-tab-btn ${
                    activeCollection === "archive" ? "active" : ""
                  }`}
                  onClick={() => onChangeCollection("archive")}
                >
                  Archive ({archivedDocs.length})
                </button>
              </div>
            )}

            <div className="library-search-box">
              <span className="search-glyph" aria-hidden="true">
                ⌕
              </span>
              <input
                type="search"
                value={libraryFilter}
                onChange={(e) => setLibraryFilter(e.target.value)}
                placeholder={
                  activeCollection === "favorites"
                    ? "Search favorites…"
                    : activeCollection === "archive"
                      ? "Search archive…"
                      : "Search library..."
                }
                aria-label="Search library"
                className="library-search-input"
              />
            </div>

            <button
              type="button"
              className="focus-btn primary"
              onClick={() => setShowImportDialog(true)}
            >
              + Import PDF
            </button>
            <button
              type="button"
              className="focus-btn secondary"
              onClick={onOpenSample}
            >
              Open Built-in Sample Guide
            </button>
          </div>
        </header>

        {activeCollection === "all" && latestDocument && (
          <section
            className="continue-reading-banner"
            aria-label="Continue Reading"
          >
            <div className="continue-cover-thumb">
              <span className="continue-cover-title">
                {latestDocument.display_name.slice(0, 18)}
              </span>
              <span className="continue-cover-dot" />
            </div>

            <div className="continue-banner-body">
              <p className="continue-eyebrow">CONTINUE READING</p>
              <h2 className="continue-doc-title">
                {latestDocument.display_name}
              </h2>
              <p className="continue-doc-meta">
                Page {latestDocument.last_page + 1} of{" "}
                {latestDocument.page_count} ·{" "}
                {Math.max(
                  1,
                  Math.round(
                    ((latestDocument.last_page + 1) /
                      Math.max(1, latestDocument.page_count)) *
                      100,
                  ),
                )}
                % completed
              </p>
              <div className="continue-progress-Row">
                <div className="continue-progress-track">
                  <div
                    className="continue-progress-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          6,
                          Math.round(
                            ((latestDocument.last_page + 1) /
                              Math.max(1, latestDocument.page_count)) *
                              100,
                          ),
                        ),
                      )}%`,
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="continue-resume-btn"
                  onClick={() => onOpenRecent(latestDocument.file_path)}
                >
                  Resume reading
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Frame 05: Favorites Grid */}
        {activeCollection === "favorites" && (
          <section
            className="recent-documents-section"
            aria-label="Favorite Documents"
          >
            <div className="section-heading-row">
              <h2 className="section-title">Favorite documents</h2>
              <span className="section-subtitle">
                {filteredFavorites.length} starred
              </span>
            </div>

            {filteredFavorites.length === 0 ? (
              <div className="library-empty-state">
                <h3 className="empty-state-title">No favorite documents yet</h3>
                <p className="empty-state-copy">
                  Star any document in your library or from the reader toolbar to
                  keep it pinned here for quick access.
                </p>
              </div>
            ) : (
              <ul className="recent-cards-grid">
                {filteredFavorites.map((doc, idx) => {
                  const coverColor = COVER_COLORS[idx % COVER_COLORS.length];
                  const progressPct = Math.min(
                    100,
                    Math.max(
                      5,
                      Math.round(
                        ((doc.last_page + 1) / Math.max(1, doc.page_count)) *
                          100,
                      ),
                    ),
                  );
                  return (
                    <li key={doc.document_id} className="recent-card-item">
                      <div className="recent-card-shell">
                        <button
                          type="button"
                          className="recent-doc-card"
                          onClick={() => onOpenRecent(doc.file_path)}
                        >
                          <div
                            className="recent-card-cover"
                            style={{ backgroundColor: coverColor }}
                          >
                            <span className="recent-card-badge">★ PDF</span>
                            <span className="recent-card-cover-text">
                              {doc.display_name}
                            </span>
                          </div>
                          <div className="recent-card-info">
                            <span className="recent-doc-name">
                              {doc.display_name}
                            </span>
                            <span className="recent-doc-meta">
                              Page {doc.last_page + 1} of {doc.page_count} ·{" "}
                              {progressPct}% read
                            </span>
                            <div className="recent-card-progress-track">
                              <div
                                className="recent-card-progress-fill"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          </div>
                        </button>
                        {onToggleFavorite && (
                          <button
                            type="button"
                            className="card-star-btn active"
                            onClick={() =>
                              onToggleFavorite(doc.document_id, false)
                            }
                            aria-label={`Remove ${doc.display_name} from favorites`}
                            title="Remove from favorites"
                          >
                            ★
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* Frame 06: Archive / List & Restore */}
        {activeCollection === "archive" && (
          <section
            className="recent-documents-section"
            aria-label="Archived Documents"
          >
            <div className="section-heading-row">
              <h2 className="section-title">Archived documents</h2>
              <span className="section-subtitle">
                {filteredArchived.length} archived
              </span>
            </div>

            {filteredArchived.length === 0 ? (
              <div className="library-empty-state">
                <h3 className="empty-state-title">Your archive is empty</h3>
                <p className="empty-state-copy">
                  Archived documents stay hidden from your main library view
                  until you restore them.
                </p>
              </div>
            ) : (
              <ul className="archive-list">
                {filteredArchived.map((doc) => (
                  <li key={doc.document_id} className="archive-row-card">
                    <div className="archive-row-left">
                      <div className="archive-pdf-badge">PDF</div>
                      <div className="archive-doc-info">
                        <span className="archive-doc-title">
                          {doc.display_name}
                        </span>
                        <span className="archive-doc-meta">
                          {doc.page_count} pages · Last read on page{" "}
                          {doc.last_page + 1}
                        </span>
                      </div>
                    </div>
                    <div className="archive-row-actions">
                      {onRestoreArchived && (
                        <button
                          type="button"
                          className="focus-btn secondary"
                          onClick={() => onRestoreArchived(doc.document_id)}
                          aria-label={`Restore ${doc.display_name}`}
                        >
                          Restore
                        </button>
                      )}
                      {onDeleteRecentDocument && (
                        <button
                          type="button"
                          className="focus-btn secondary danger-text"
                          onClick={() =>
                            onDeleteRecentDocument(doc.document_id)
                          }
                          aria-label={`Delete ${doc.display_name}`}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="archive-info-banner">
              Archived files remain available on this device. Restore a document
              to return it to your library.
            </div>
          </section>
        )}

        {/* Frame 03: Main Library Recent Documents */}
        {activeCollection === "all" && (
          <section
            className="recent-documents-section"
            aria-label="Recent Documents"
          >
            <div className="section-heading-row">
              <h2 className="section-title">Recent documents</h2>
              <span className="section-subtitle">Readora PDF Reader</span>
            </div>

            {filteredAllDocs.length === 0 ? (
              <div className="library-empty-state">
                <div className="empty-illustration" aria-hidden="true">
                  <div className="empty-page-card back" />
                  <div className="empty-page-card front">
                    <span className="empty-line accent" />
                    <span className="empty-line" />
                    <span className="empty-line short" />
                  </div>
                </div>
                <h3 className="empty-state-title">
                  Start your reading library
                </h3>
                <p className="empty-state-copy">
                  Import a local PDF document to read, highlight, search, and
                  keep your notes organized in one calm workspace.
                </p>
                <div className="empty-state-actions">
                  <button
                    type="button"
                    className="focus-btn primary large"
                    onClick={onOpenSample}
                  >
                    Import your first PDF
                  </button>
                  <button
                    type="button"
                    className="focus-btn secondary"
                    onClick={() => setShowImportDialog(true)}
                  >
                    Open by file path...
                  </button>
                </div>
              </div>
            ) : (
              <ul className="recent-cards-grid">
                {filteredAllDocs.map((doc, idx) => {
                  const coverColor = COVER_COLORS[idx % COVER_COLORS.length];
                  const progressPct = Math.min(
                    100,
                    Math.max(
                      5,
                      Math.round(
                        ((doc.last_page + 1) / Math.max(1, doc.page_count)) *
                          100,
                      ),
                    ),
                  );
                  return (
                    <li key={doc.document_id} className="recent-card-item">
                      <div className="recent-card-shell">
                        <button
                          type="button"
                          className="recent-doc-card"
                          onClick={() => onOpenRecent(doc.file_path)}
                        >
                          <div
                            className="recent-card-cover"
                            style={{ backgroundColor: coverColor }}
                          >
                            <span className="recent-card-badge">PDF</span>
                            <span className="recent-card-cover-text">
                              {doc.display_name}
                            </span>
                          </div>
                          <div className="recent-card-info">
                            <span className="recent-doc-name">
                              {doc.display_name}
                            </span>
                            <span className="recent-doc-meta">
                              Resume at page {doc.last_page + 1} of{" "}
                              {doc.page_count} ({Math.round(doc.last_zoom * 100)}
                              %)
                            </span>
                            <div className="recent-card-progress-track">
                              <div
                                className="recent-card-progress-fill"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          </div>
                        </button>
                        {onToggleFavorite && (
                          <button
                            type="button"
                            className={`card-star-btn ${
                              doc.is_favorite ? "active" : ""
                            }`}
                            onClick={() =>
                              onToggleFavorite(
                                doc.document_id,
                                !doc.is_favorite,
                              )
                            }
                            aria-label={
                              doc.is_favorite
                                ? `Remove ${doc.display_name} from favorites`
                                : `Add ${doc.display_name} to favorites`
                            }
                            title={
                              doc.is_favorite
                                ? "Remove from favorites"
                                : "Add to favorites"
                            }
                          >
                            {doc.is_favorite ? "★" : "☆"}
                          </button>
                        )}
                        {onArchiveDocument && (
                          <button
                            type="button"
                            className="card-archive-btn"
                            onClick={() => onArchiveDocument(doc.document_id)}
                            aria-label={`Archive ${doc.display_name}`}
                            title="Move to archive"
                          >
                            ⇣
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>

      {showImportDialog && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Open a PDF document"
        >
          <div className="import-dialog-card">
            <div className="import-dialog-header">
              <div>
                <p className="eyebrow-label">IMPORT PDF</p>
                <h2 className="import-dialog-title">Open a PDF document</h2>
              </div>
              <button
                type="button"
                className="icon-close-btn"
                onClick={() => setShowImportDialog(false)}
                aria-label="Close import dialog"
              >
                ×
              </button>
            </div>

            <div className="import-dropzone">
              <div className="dropzone-badge">PDF</div>
              <p className="dropzone-title">
                Select a local PDF file or open the built-in sample guide
              </p>
              <p className="dropzone-subtitle">
                Supports standard PDF 1.4 – 2.0 documents up to 250 MB · Local
                processing only
              </p>
            </div>

            <form onSubmit={handleImportSubmit} className="import-path-form">
              <input
                type="text"
                value={importPathInput}
                onChange={(e) => setImportPathInput(e.target.value)}
                placeholder="/path/to/document.pdf"
                aria-label="Import PDF file path"
                className="focus-input full-width"
              />
              <div className="import-dialog-footer">
                <button
                  type="button"
                  className="focus-btn secondary"
                  onClick={() => {
                    setShowImportDialog(false);
                    onOpenSample();
                  }}
                >
                  Use Sample PDF
                </button>
                <div className="import-dialog-actions">
                  <button
                    type="button"
                    className="focus-btn secondary"
                    onClick={() => setShowImportDialog(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="focus-btn primary">
                    Import file
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
};
