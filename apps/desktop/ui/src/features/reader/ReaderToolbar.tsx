import React, { useState } from "react";
import {
  type FitMode,
  type LayoutMode,
  type RenderMode,
  type ViewStateDto,
} from "../../types/ipc";

export type SidebarTab =
  | "thumbnails"
  | "outline"
  | "bookmarks"
  | "search"
  | null;

interface ReaderToolbarProps {
  fileName: string | null;
  fileSizeBytes?: number | null;
  viewState: ViewStateDto | null;
  activeSidebar: SidebarTab;
  showRightPanel?: boolean;
  onToggleSidebar: (tab: Exclude<SidebarTab, null>) => void;
  onToggleRightPanel?: () => void;
  onOpenPathSubmit: (path: string) => void;
  onOpenSample: () => void;
  onCloseDocument: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onGoToPage: (zeroBasedPage: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetZoom?: (zoom: number) => void;
  onSetFitMode: (mode: FitMode) => void;
  onRotateCw: () => void;
  onRotateCcw: () => void;
  onSetLayoutMode: (mode: LayoutMode) => void;
  onSetRenderMode: (mode: RenderMode) => void;
  onOpenPreferences: () => void;
  onToggleTheme?: () => void;
}

function formatFileSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "Local PDF";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const ReaderToolbar: React.FC<ReaderToolbarProps> = ({
  fileName,
  fileSizeBytes,
  viewState,
  activeSidebar,
  showRightPanel = true,
  onToggleSidebar,
  onToggleRightPanel,
  onOpenPathSubmit,
  onOpenSample,
  onCloseDocument,
  onPrevPage,
  onNextPage,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onSetZoom,
  onSetFitMode,
  onRotateCw,
  onRotateCcw,
  onSetLayoutMode,
  onSetRenderMode,
  onOpenPreferences,
  onToggleTheme,
}) => {
  const [pathInput, setPathInput] = useState("");
  const [pageInput, setPageInput] = useState("");
  const [showZoomMenu, setShowZoomMenu] = useState(false);

  const handleOpenFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      onOpenPathSubmit(pathInput.trim());
      setPathInput("");
    }
  };

  const handlePageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!viewState) return;
    const parsed = Number.parseInt(pageInput, 10);
    if (
      !Number.isNaN(parsed) &&
      parsed >= 1 &&
      parsed <= viewState.page_count
    ) {
      onGoToPage(parsed - 1);
      setPageInput("");
    }
  };

  const zoomPercent = viewState ? Math.round(viewState.zoom * 100) : 100;

  return (
    <header
      className="focus-header-stack"
      role="toolbar"
      aria-label="PDF Reader Toolbar"
    >
      {/* Window Title Bar (Figma Frame 01/02/03) */}
      <div className="window-title-bar">
        <div className="window-title-left">
          <div className="traffic-lights" aria-hidden="true">
            <span className="traffic-dot close" />
            <span className="traffic-dot minimize" />
            <span className="traffic-dot maximize" />
          </div>

          {viewState && fileName ? (
            <div className="document-tab">
              <div className="pdf-badge">PDF</div>
              <div className="document-tab-info">
                <span className="document-tab-title" title={fileName}>
                  {fileName}
                </span>
                <span className="document-tab-size">
                  {formatFileSize(fileSizeBytes)}
                </span>
              </div>
              <button
                type="button"
                className="document-tab-close"
                onClick={onCloseDocument}
                aria-label="Close document"
                title="Close document"
              >
                ×
              </button>
            </div>
          ) : (
            <span className="window-app-title">Focus Reader · Library</span>
          )}
        </div>

        <div className="window-title-right">
          <form onSubmit={handleOpenFormSubmit} className="open-path-form">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="Local PDF path..."
              aria-label="Local PDF file path"
              className="focus-input compact"
            />
            <button type="submit" className="focus-btn secondary compact">
              Open Path
            </button>
          </form>

          <button
            type="button"
            className="focus-btn primary compact"
            onClick={onOpenSample}
          >
            Open Sample PDF
          </button>

          {viewState && (
            <span className="saved-indicator" aria-live="polite">
              ✓ Saved
            </span>
          )}

          {onToggleTheme && (
            <button
              type="button"
              className="focus-icon-btn"
              onClick={onToggleTheme}
              aria-label="Toggle theme"
              title="Toggle theme"
            >
              ◐
            </button>
          )}

          <button
            type="button"
            className="focus-icon-btn"
            onClick={onOpenPreferences}
            aria-label="Preferences"
            title="Preferences"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Reader Action Toolbar (50px height, visible when a document is open) */}
      {viewState && (
        <div className="reader-action-bar">
          <div
            className="toolbar-group"
            role="group"
            aria-label="Sidebar Panels"
          >
            <button
              type="button"
              className={`focus-icon-btn ${
                activeSidebar === "thumbnails" || activeSidebar === "outline"
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                onToggleSidebar(
                  activeSidebar === "outline" ? "outline" : "thumbnails",
                )
              }
              title="Toggle Page Sidebar"
              aria-label="Toggle Page Sidebar"
            >
              ▥
            </button>
            <button
              type="button"
              className={`focus-btn compact ${
                activeSidebar === "thumbnails" ? "active" : ""
              }`}
              onClick={() => onToggleSidebar("thumbnails")}
            >
              Thumbnails
            </button>
            <button
              type="button"
              className={`focus-btn compact ${
                activeSidebar === "outline" ? "active" : ""
              }`}
              onClick={() => onToggleSidebar("outline")}
            >
              Outline
            </button>
            <button
              type="button"
              className={`focus-btn compact ${
                activeSidebar === "bookmarks" ? "active" : ""
              }`}
              onClick={() => onToggleSidebar("bookmarks")}
            >
              Bookmarks
            </button>
            <button
              type="button"
              className={`focus-btn compact ${
                activeSidebar === "search" ? "active" : ""
              }`}
              onClick={() => onToggleSidebar("search")}
            >
              Find
            </button>
          </div>

          <div
            className="toolbar-group"
            role="group"
            aria-label="Page Navigation"
          >
            <button
              type="button"
              className="focus-icon-btn"
              onClick={onPrevPage}
              disabled={viewState.current_page <= 0}
              aria-label="Previous Page"
            >
              ‹
            </button>
            <div className="page-field-pill" aria-live="polite">
              <span className="sr-only">
                Page {viewState.current_page + 1} of {viewState.page_count}
              </span>
              <span aria-hidden="true">
                {viewState.current_page + 1} / {viewState.page_count}
              </span>
            </div>
            <button
              type="button"
              className="focus-icon-btn"
              onClick={onNextPage}
              disabled={viewState.current_page + 1 >= viewState.page_count}
              aria-label="Next Page"
            >
              ›
            </button>
            <form onSubmit={handlePageSubmit} className="goto-page-form">
              <input
                type="number"
                min={1}
                max={viewState.page_count}
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                placeholder="Go #"
                aria-label="Jump to page number"
                className="focus-input page-num-input"
              />
            </form>
          </div>

          <div
            className="toolbar-group zoom-toolbar-group"
            role="group"
            aria-label="Zoom and Rotation"
          >
            <button
              type="button"
              className="focus-icon-btn"
              onClick={onZoomOut}
              aria-label="Zoom Out"
            >
              −
            </button>

            <div className="zoom-menu-wrapper">
              <button
                type="button"
                className="zoom-pill-btn"
                data-testid="zoom-indicator"
                onClick={() => setShowZoomMenu((prev) => !prev)}
                aria-label="Zoom presets"
              >
                {zoomPercent}%
              </button>

              {showZoomMenu && (
                <div
                  className="zoom-dropdown-menu"
                  role="menu"
                  aria-label="Zoom Menu"
                >
                  <button
                    type="button"
                    className={`zoom-menu-item ${
                      viewState.fit_mode === "fit_page" ? "selected" : ""
                    }`}
                    onClick={() => {
                      onSetFitMode("fit_page");
                      setShowZoomMenu(false);
                    }}
                  >
                    <span>Fit Page</span>
                    <span className="zoom-shortcut">⌘1</span>
                  </button>
                  <button
                    type="button"
                    className={`zoom-menu-item ${
                      viewState.fit_mode === "fit_width" ? "selected" : ""
                    }`}
                    onClick={() => {
                      onSetFitMode("fit_width");
                      setShowZoomMenu(false);
                    }}
                  >
                    <span>Fit Width</span>
                    <span className="zoom-shortcut">⌘2</span>
                  </button>
                  <button
                    type="button"
                    className="zoom-menu-item"
                    onClick={() => {
                      onSetZoom?.(1.0);
                      setShowZoomMenu(false);
                    }}
                  >
                    <span>Actual Size</span>
                    <span className="zoom-shortcut">⌘0</span>
                  </button>
                  <div className="zoom-menu-divider" />
                  {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`zoom-menu-item ${
                        Math.abs(viewState.zoom - preset) < 0.02
                          ? "selected"
                          : ""
                      }`}
                      onClick={() => {
                        onSetZoom?.(preset);
                        setShowZoomMenu(false);
                      }}
                    >
                      <span>{Math.round(preset * 100)}%</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="focus-icon-btn"
              onClick={onZoomIn}
              aria-label="Zoom In"
            >
              +
            </button>

            <select
              aria-label="Fit Mode"
              value={viewState.fit_mode}
              onChange={(e) => onSetFitMode(e.target.value as FitMode)}
              className="focus-select"
            >
              <option value="fit_width">Fit Width</option>
              <option value="fit_page">Fit Page</option>
              <option value="manual">Manual Zoom</option>
            </select>

            <button
              type="button"
              className="focus-icon-btn"
              onClick={onRotateCcw}
              aria-label="Rotate Counter-Clockwise"
              title="Rotate Counter-Clockwise"
            >
              ⟲
            </button>
            <button
              type="button"
              className="focus-icon-btn"
              onClick={onRotateCw}
              aria-label="Rotate Clockwise"
              title="Rotate Clockwise"
            >
              ⟳
            </button>

            <select
              aria-label="Layout Mode"
              value={viewState.layout_mode}
              onChange={(e) => onSetLayoutMode(e.target.value as LayoutMode)}
              className="focus-select"
            >
              <option value="single_page">Single Page</option>
              <option value="continuous">Continuous</option>
            </select>

            <select
              aria-label="Color Render Mode"
              value={viewState.render_mode}
              onChange={(e) => onSetRenderMode(e.target.value as RenderMode)}
              className="focus-select"
            >
              <option value="standard">Standard Color</option>
              <option value="grayscale">Grayscale</option>
              <option value="dark_inversion">Night Inversion</option>
            </select>

            {onToggleRightPanel && (
              <button
                type="button"
                className={`focus-icon-btn ${showRightPanel ? "active" : ""}`}
                onClick={onToggleRightPanel}
                aria-label="Toggle Notes and Details Panel"
                title="Toggle Notes and Details Panel"
              >
                ▤
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
