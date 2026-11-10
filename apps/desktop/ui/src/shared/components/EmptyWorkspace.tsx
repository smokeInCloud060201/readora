import React, { useState } from "react";
import { type RecentDocumentDto } from "../../types/ipc";

interface EmptyWorkspaceProps {
  recentDocuments: RecentDocumentDto[];
  onOpenSample: () => void;
  onOpenRecent: (filePath: string) => void;
}

const COVER_COLORS = ["#374231", "#bd9d6f", "#a8594d", "#343b42"];

export const EmptyWorkspace: React.FC<EmptyWorkspaceProps> = ({
  recentDocuments,
  onOpenSample,
  onOpenRecent,
}) => {
  const [libraryFilter, setLibraryFilter] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPathInput, setImportPathInput] = useState("");

  const filteredRecents = recentDocuments.filter((doc) =>
    doc.display_name.toLowerCase().includes(libraryFilter.trim().toLowerCase()),
  );

  const latestDocument = recentDocuments[0] ?? null;

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (importPathInput.trim()) {
      onOpenRecent(importPathInput.trim());
      setImportPathInput("");
      setShowImportDialog(false);
    }
  };

  return (
    <main className="library-workspace" aria-label="Welcome Workspace">
      <div className="library-container">
        <header className="library-header">
          <div>
            <p className="eyebrow-label">FOCUS READER</p>
            <h1 className="library-title">Your library</h1>
          </div>

          <div className="library-header-controls">
            <div className="library-search-box">
              <span className="search-glyph" aria-hidden="true">
                ⌕
              </span>
              <input
                type="search"
                value={libraryFilter}
                onChange={(e) => setLibraryFilter(e.target.value)}
                placeholder="Search library..."
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

        {latestDocument && (
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

        <section
          className="recent-documents-section"
          aria-label="Recent Documents"
        >
          <div className="section-heading-row">
            <h2 className="section-title">Recent documents</h2>
            <span className="section-subtitle">Readora PDF Reader</span>
          </div>

          {filteredRecents.length === 0 ? (
            <div className="library-empty-state">
              <div className="empty-illustration" aria-hidden="true">
                <div className="empty-page-card back" />
                <div className="empty-page-card front">
                  <span className="empty-line accent" />
                  <span className="empty-line" />
                  <span className="empty-line short" />
                </div>
              </div>
              <h3 className="empty-state-title">Start your reading library</h3>
              <p className="empty-state-copy">
                Import a local PDF document to read, highlight, search, and keep
                your notes organized in one calm workspace.
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
              {filteredRecents.map((doc, idx) => {
                const coverColor = COVER_COLORS[idx % COVER_COLORS.length];
                const progressPct = Math.min(
                  100,
                  Math.max(
                    5,
                    Math.round(
                      ((doc.last_page + 1) / Math.max(1, doc.page_count)) * 100,
                    ),
                  ),
                );
                return (
                  <li key={doc.document_id} className="recent-card-item">
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
                          Resume at page {doc.last_page + 1} of {doc.page_count}{" "}
                          ({Math.round(doc.last_zoom * 100)}%)
                        </span>
                        <div className="recent-card-progress-track">
                          <div
                            className="recent-card-progress-fill"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
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
