import React, { useState } from "react";
import { type RecentDocumentDto } from "../../types/ipc";
import { FocusIcon } from "./FocusIcon";

export type LibraryCollectionView = "all" | "favorites" | "archive";

interface EmptyWorkspaceProps {
  recentDocuments: RecentDocumentDto[];
  activeCollection?: LibraryCollectionView;
  onChangeCollection?: (collection: LibraryCollectionView) => void;
  onOpenImportDialog: () => void;
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
  onOpenImportDialog,
  onOpenRecent,
  onToggleFavorite,
  onRestoreArchived,
  onArchiveDocument,
  onDeleteRecentDocument,
}) => {
  const [libraryFilter, setLibraryFilter] = useState("");

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

  const handleWorkspaceDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      const maybeFileWithPath = droppedFile as File & { path?: string };
      const resolvedPath =
        typeof maybeFileWithPath.path === "string" &&
        maybeFileWithPath.path.trim().length > 0
          ? maybeFileWithPath.path.trim()
          : `/documents/${droppedFile.name}`;
      onOpenRecent(resolvedPath);
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
    <main
      className="library-workspace"
      aria-label="Welcome Workspace"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleWorkspaceDrop}
    >
      {/* Figma Frame 02/05/06/22: 50px Library Toolbar (2:183, 1382x50) */}
      <div className="library-toolbar" data-node-id="2:183">
        <div className="library-toolbar-left">
          <div className="library-search-box" data-node-id="2:184">
            <span className="search-glyph" aria-hidden="true">
              <FocusIcon name="search" size={14} />
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
                    : "Search your library…"
              }
              aria-label="Search library"
              className="library-search-input"
            />
          </div>

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
        </div>

        <button
          type="button"
          className="focus-btn primary icon-inline-label library-import-btn"
          onClick={onOpenImportDialog}
          data-node-id="2:187"
        >
          <FocusIcon name="plus" size={14} />
          <span>Import PDF</span>
        </button>
      </div>

      <div className="library-container" data-node-id="2:190">
        <header className="library-header">
          <div>
            <p className="eyebrow-label" data-node-id="2:191">
              FOCUS READER
            </p>
            <h1 className="library-title" data-node-id="2:192">
              {headerTitle}
            </h1>
            {headerSubtitle && (
              <p className="library-subtitle">{headerSubtitle}</p>
            )}
          </div>
        </header>

        {activeCollection === "all" && latestDocument && (
          <section
            className="continue-reading-banner"
            aria-label="Continue Reading"
            data-node-id="2:193"
            onClick={() => onOpenRecent(latestDocument.file_path)}
          >
            <div className="continue-banner-body" data-node-id="2:194">
              <p className="continue-eyebrow" data-node-id="2:195">
                CONTINUE READING
              </p>
              <h2 className="continue-doc-title" data-node-id="2:196">
                {latestDocument.display_name}
              </h2>
              <p className="continue-doc-subtitle" data-node-id="2:197">
                Chapter 1 · Designing for focus
              </p>
              <div className="continue-progress-track" data-node-id="2:198">
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
              <p className="continue-doc-meta" data-node-id="2:199">
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
                % complete
              </p>
            </div>

            <button
              type="button"
              className="continue-page-preview"
              onClick={(e) => {
                e.stopPropagation();
                onOpenRecent(latestDocument.file_path);
              }}
              aria-label={`Resume reading ${latestDocument.display_name}`}
              data-node-id="2:200"
            >
              <span className="continue-preview-num" data-node-id="2:201">
                01
              </span>
              <span className="continue-preview-title" data-node-id="2:202">
                Designing for focus.
              </span>
              <span
                className="continue-preview-accent"
                aria-hidden="true"
                data-node-id="2:203"
              />
            </button>
          </section>
        )}

        {/* Frame 05: Favorites Grid */}
        {activeCollection === "favorites" && (
          <section
            className="recent-documents-section"
            aria-label="Favorite Documents"
          >
            <div className="section-heading-row">
              <h2 className="section-title">Starred documents</h2>
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
                            <span className="recent-card-edition">
                              FOCUS READER · EDITION 0{(idx % 9) + 1}
                            </span>
                            <span className="recent-card-cover-text">
                              {doc.display_name.toUpperCase()}
                            </span>
                            <span
                              className="recent-card-corner-mark"
                              aria-hidden="true"
                            />
                          </div>
                          <div className="recent-card-info">
                            <span className="recent-doc-name">
                              {doc.display_name}
                            </span>
                            <span className="recent-doc-meta">
                              {doc.page_count} pages · Page {doc.last_page + 1}
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
                            <FocusIcon name="star" size={14} filled />
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
                          className="focus-btn secondary danger-text icon-inline-label"
                          onClick={() =>
                            onDeleteRecentDocument(doc.document_id)
                          }
                          aria-label={`Delete ${doc.display_name}`}
                        >
                          <FocusIcon name="trash" size={14} />
                          <span>Delete</span>
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

        {/* Frame 02 & Frame 22: Main Library Recent Documents / Empty State */}
        {activeCollection === "all" && (
          <section
            className="recent-documents-section"
            aria-label="Recent Documents"
          >
            {filteredAllDocs.length > 0 && (
              <div className="section-heading-row">
                <h2 className="section-title" data-node-id="2:204">
                  Recent documents
                </h2>
              </div>
            )}

            {filteredAllDocs.length === 0 ? (
              <div className="library-empty-state" data-node-id="7:664">
                <div
                  className="empty-illustration"
                  aria-hidden="true"
                  data-node-id="7:665"
                >
                  <div className="empty-page-card back" data-node-id="7:666" />
                  <div className="empty-page-card front" data-node-id="7:667">
                    <span
                      className="empty-line accent"
                      data-node-id="7:668"
                    />
                    <span className="empty-line" data-node-id="7:669" />
                    <span className="empty-line short" data-node-id="7:670" />
                  </div>
                </div>
                <h3 className="empty-state-title" data-node-id="7:671">
                  Start your reading library
                </h3>
                <p className="empty-state-copy" data-node-id="7:672">
                  Import a PDF to read, highlight, and keep your notes in one
                  calm place.
                </p>
                <div className="empty-state-actions">
                  <button
                    type="button"
                    className="focus-btn primary large"
                    onClick={onOpenImportDialog}
                    data-node-id="7:673"
                  >
                    Import your first PDF
                  </button>
                </div>
                <p className="empty-state-drop-hint" data-node-id="7:675">
                  or drag and drop a file anywhere in this window
                </p>
              </div>
            ) : (
              <ul className="recent-cards-grid" data-node-id="2:205">
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
                      <div className="recent-card-shell" data-node-id="2:206">
                        <button
                          type="button"
                          className="recent-doc-card"
                          onClick={() => onOpenRecent(doc.file_path)}
                        >
                          <div
                            className="recent-card-cover"
                            style={{ backgroundColor: coverColor }}
                            data-node-id="2:207"
                          >
                            <span
                              className="recent-card-edition"
                              data-node-id="2:208"
                            >
                              FOCUS READER · EDITION 0{(idx % 9) + 1}
                            </span>
                            <span
                              className="recent-card-cover-text"
                              data-node-id="2:209"
                            >
                              {doc.display_name.toUpperCase()}
                            </span>
                            <span
                              className="recent-card-corner-mark"
                              aria-hidden="true"
                              data-node-id="2:210"
                            />
                          </div>
                          <div className="recent-card-info">
                            <span
                              className="recent-doc-name"
                              data-node-id="2:211"
                            >
                              {doc.display_name}
                            </span>
                            <span
                              className="recent-doc-meta"
                              data-node-id="2:212"
                            >
                              {doc.page_count} pages · Page {doc.last_page + 1}
                            </span>
                            <div
                              className="recent-card-progress-track"
                              data-node-id="2:213"
                            >
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
                            <FocusIcon
                              name="star"
                              size={14}
                              filled={Boolean(doc.is_favorite)}
                            />
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
                            <FocusIcon name="archive" size={14} />
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
    </main>
  );
};
