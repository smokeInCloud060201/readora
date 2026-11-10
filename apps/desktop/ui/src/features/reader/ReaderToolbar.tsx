import React, { useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
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
  onOpenAbout?: () => void;
  onToggleTheme?: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onArchiveDocument?: () => void;
  onOpenPrint?: () => void;
  onOpenDocumentDetails?: () => void;
  onOpenImportDialog?: () => void;
  onOpenShare?: () => void;
  onOpenShortcuts?: () => void;
  onCopyPageText?: () => void;
  hasUpdateAvailable?: boolean;
  onOpenUpdateDialog?: () => void;
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
  onOpenAbout,
  onToggleTheme,
  isFavorite = false,
  onToggleFavorite,
  onArchiveDocument,
  onOpenPrint,
  onOpenDocumentDetails,
  onOpenImportDialog,
  onOpenShare,
  onOpenShortcuts,
  onCopyPageText,
  hasUpdateAvailable = false,
  onOpenUpdateDialog,
}) => {
  const [pageInput, setPageInput] = useState("");
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [showMoreActionsMenu, setShowMoreActionsMenu] = useState(false);
  const [activeAppMenu, setActiveAppMenu] = useState<
    "file" | "edit" | "view" | "window" | "help" | null
  >(null);

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
      setIsEditingPage(false);
    }
  };

  const zoomPercent = viewState ? Math.round(viewState.zoom * 100) : 100;

  return (
    <header
      className="focus-header-stack"
      role="toolbar"
      aria-label="PDF Reader Toolbar"
    >
      {/* Desktop Application Menu Bar (Figma Frames 11–15: File, Edit, View, Window, Help) */}
      <div
        className="desktop-menu-bar"
        role="menubar"
        aria-label="Application Menu Bar"
      >
        <div className="desktop-menu-left">
          <span className="desktop-menu-brand">● &nbsp; Focus Reader</span>

          <div className="desktop-menu-item-wrapper">
            <button
              type="button"
              role="menuitem"
              className={`desktop-menu-trigger ${
                activeAppMenu === "file" ? "active" : ""
              }`}
              onClick={() =>
                setActiveAppMenu((prev) => (prev === "file" ? null : "file"))
              }
            >
              File
            </button>
            {activeAppMenu === "file" && (
              <div
                className="desktop-dropdown-menu"
                role="menu"
                aria-label="File Menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onOpenImportDialog?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Open PDF…</span>
                  <span className="zoom-shortcut">⌘O</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onCloseDocument();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Open Recent</span>
                  <span className="zoom-shortcut">›</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onCloseDocument();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Close Document</span>
                  <span className="zoom-shortcut">⌘W</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onOpenShare?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Export Annotations…</span>
                  <span className="zoom-shortcut">⇧⌘S</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onOpenDocumentDetails?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Document Properties…</span>
                  <span className="zoom-shortcut">⌘I</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onOpenPrint?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Print…</span>
                  <span className="zoom-shortcut">⌘P</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onOpenPreferences();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Preferences…</span>
                  <span className="zoom-shortcut">⌘,</span>
                </button>
              </div>
            )}
          </div>

          <div className="desktop-menu-item-wrapper">
            <button
              type="button"
              role="menuitem"
              className={`desktop-menu-trigger ${
                activeAppMenu === "edit" ? "active" : ""
              }`}
              onClick={() =>
                setActiveAppMenu((prev) => (prev === "edit" ? null : "edit"))
              }
            >
              Edit
            </button>
            {activeAppMenu === "edit" && (
              <div
                className="desktop-dropdown-menu"
                role="menu"
                aria-label="Edit Menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onCopyPageText?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Copy</span>
                  <span className="zoom-shortcut">⌘C</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onToggleSidebar("search");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Find in Document…</span>
                  <span className="zoom-shortcut">⌘F</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onToggleSidebar("bookmarks");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Add Comment</span>
                  <span className="zoom-shortcut">⌥⌘M</span>
                </button>
              </div>
            )}
          </div>

          <div className="desktop-menu-item-wrapper">
            <button
              type="button"
              role="menuitem"
              className={`desktop-menu-trigger ${
                activeAppMenu === "view" ? "active" : ""
              }`}
              onClick={() =>
                setActiveAppMenu((prev) => (prev === "view" ? null : "view"))
              }
            >
              View
            </button>
            {activeAppMenu === "view" && (
              <div
                className="desktop-dropdown-menu"
                role="menu"
                aria-label="View Menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onToggleSidebar("thumbnails");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Show Page Sidebar</span>
                  <span className="zoom-shortcut">⌘\</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onToggleSidebar("outline");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Show Document Outline</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onToggleRightPanel?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Show Notes Panel</span>
                  <span className="zoom-shortcut">⇧⌘\</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetLayoutMode("single_page");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>
                    {viewState?.layout_mode === "single_page" ? "✓ " : ""}Single
                    Page
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetLayoutMode("continuous");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>
                    {viewState?.layout_mode === "continuous" ? "✓ " : ""}
                    Continuous Scroll
                  </span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetFitMode("fit_width");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Fit Width</span>
                  <span className="zoom-shortcut">⌘2</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetFitMode("fit_page");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Fit Page</span>
                  <span className="zoom-shortcut">⌘1</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetZoom?.(1.0);
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Actual Size</span>
                  <span className="zoom-shortcut">⌘0</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetRenderMode("standard");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>
                    {viewState?.render_mode === "standard" ? "✓ " : ""}Standard
                    Color
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetRenderMode("grayscale");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>
                    {viewState?.render_mode === "grayscale" ? "✓ " : ""}
                    Grayscale
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  disabled={!viewState}
                  onClick={() => {
                    onSetRenderMode("dark_inversion");
                    setActiveAppMenu(null);
                  }}
                >
                  <span>
                    {viewState?.render_mode === "dark_inversion" ? "✓ " : ""}
                    Night Inversion
                  </span>
                </button>
              </div>
            )}
          </div>

          <div className="desktop-menu-item-wrapper">
            <button
              type="button"
              role="menuitem"
              className={`desktop-menu-trigger ${
                activeAppMenu === "window" ? "active" : ""
              }`}
              onClick={() =>
                setActiveAppMenu((prev) =>
                  prev === "window" ? null : "window",
                )
              }
            >
              Window
            </button>
            {activeAppMenu === "window" && (
              <div
                className="desktop-dropdown-menu"
                role="menu"
                aria-label="Window Menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onCloseDocument();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Show Library</span>
                  <span className="zoom-shortcut">⇧⌘L</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onToggleTheme?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Toggle Light / Dark Theme</span>
                </button>
                {fileName && (
                  <>
                    <div className="zoom-menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      className="doc-action-menu-item"
                      onClick={() => setActiveAppMenu(null)}
                    >
                      <span>✓ &nbsp; {fileName}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="desktop-menu-item-wrapper">
            <button
              type="button"
              role="menuitem"
              className={`desktop-menu-trigger ${
                activeAppMenu === "help" ? "active" : ""
              }`}
              onClick={() =>
                setActiveAppMenu((prev) => (prev === "help" ? null : "help"))
              }
            >
              Help
            </button>
            {activeAppMenu === "help" && (
              <div
                className="desktop-dropdown-menu"
                role="menu"
                aria-label="Help Menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onOpenShortcuts?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Keyboard Shortcuts</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onOpenAbout?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>About Focus Reader</span>
                </button>
                <div className="zoom-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="doc-action-menu-item"
                  onClick={() => {
                    onOpenUpdateDialog?.();
                    setActiveAppMenu(null);
                  }}
                >
                  <span>Check for Updates…</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <span className="desktop-menu-clock">Tue 9:41 AM</span>
      </div>

      {/* Window Title Bar (Figma Frame 01/02/03/27: 2:8, 1440x46) */}
      <div className="window-title-bar" data-node-id="2:8">
        <div className="window-title-left" data-node-id="2:9">
          <div
            className="traffic-lights"
            aria-hidden="true"
            data-node-id="2:10"
          >
            <span className="traffic-dot close" />
            <span className="traffic-dot minimize" />
            <span className="traffic-dot maximize" />
          </div>

          <div className="window-history-nav" role="group" aria-label="History">
            <button
              type="button"
              className="focus-icon-btn window-nav-btn"
              onClick={viewState ? onPrevPage : undefined}
              disabled={!viewState || viewState.current_page <= 0}
              aria-label="Navigate Back"
              data-node-id="2:11"
            >
              <FocusIcon name="chevron-left" size={15} />
            </button>
            <button
              type="button"
              className="focus-icon-btn window-nav-btn"
              onClick={viewState ? onNextPage : undefined}
              disabled={
                !viewState || viewState.current_page + 1 >= viewState.page_count
              }
              aria-label="Navigate Forward"
              data-node-id="2:13"
            >
              <FocusIcon name="chevron-right" size={15} />
            </button>
          </div>

          {viewState && fileName ? (
            <div className="document-tab" data-node-id="2:15">
              <div className="pdf-badge" data-node-id="2:16">
                PDF
              </div>
              <div className="document-tab-info" data-node-id="2:18">
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
                <FocusIcon name="close" size={14} />
              </button>
            </div>
          ) : (
            <div className="document-tab library-tab" data-node-id="2:173">
              <div className="pdf-badge">PDF</div>
              <div className="document-tab-info">
                <span className="document-tab-title">Library</span>
                <span className="document-tab-size">All documents</span>
              </div>
            </div>
          )}
        </div>

        <div className="window-title-right" data-node-id="2:22">
          {hasUpdateAvailable && onOpenUpdateDialog && (
            <button
              type="button"
              className="update-available-btn"
              onClick={onOpenUpdateDialog}
              aria-label="Update available"
              data-node-id="16:175"
            >
              <span
                className="update-notification-dot"
                aria-hidden="true"
                data-node-id="16:176"
              />
              <FocusIcon name="download" size={13} />
              <span>Update available</span>
            </button>
          )}

          {viewState && (
            <span
              className="saved-indicator"
              aria-live="polite"
              data-node-id="2:23"
            >
              <FocusIcon name="check" size={13} />
              <span>Saved</span>
            </span>
          )}

          {onToggleTheme && (
            <button
              type="button"
              className="focus-icon-btn"
              onClick={onToggleTheme}
              aria-label="Toggle theme"
              title="Toggle theme"
              data-node-id="2:26"
            >
              <FocusIcon name="moon" size={16} />
            </button>
          )}

          <button
            type="button"
            className="focus-icon-btn"
            onClick={onOpenPreferences}
            aria-label="Preferences"
            title="Preferences"
            data-node-id="2:28"
          >
            <FocusIcon name="settings" size={16} />
          </button>
        </div>
      </div>

      {/* Reader Action Toolbar (Figma Frame 01: 2:37, 1382x50, visible when a document is open) */}
      {viewState && (
        <div className="reader-action-bar" data-node-id="2:37">
          {/* Left Group (2:38): Sidebar toggle & Find */}
          <div
            className="toolbar-group toolbar-group-left"
            role="group"
            aria-label="Sidebar and Search"
            data-node-id="2:38"
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
              data-node-id="2:39"
            >
              <FocusIcon name="panel-left" size={16} />
            </button>
            <button
              type="button"
              className={`focus-icon-btn ${
                activeSidebar === "search" ? "active" : ""
              }`}
              onClick={() => onToggleSidebar("search")}
              title="Find in Document"
              aria-label="Find in Document"
              data-node-id="2:41"
            >
              <FocusIcon name="search" size={16} />
            </button>
          </div>

          {/* Center Group (2:42): Page navigation + Zoom controls */}
          <div
            className="toolbar-group toolbar-group-center"
            role="group"
            aria-label="Page and Zoom Controls"
            data-node-id="2:42"
          >
            <button
              type="button"
              className="focus-icon-btn"
              onClick={onPrevPage}
              disabled={viewState.current_page <= 0}
              aria-label="Previous Page"
              data-node-id="2:43"
            >
              <FocusIcon name="chevron-left" size={16} />
            </button>

            {isEditingPage ? (
              <form onSubmit={handlePageSubmit} className="goto-page-form">
                <input
                  type="number"
                  min={1}
                  max={viewState.page_count}
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={() => setIsEditingPage(false)}
                  placeholder={`${viewState.current_page + 1} / ${viewState.page_count}`}
                  aria-label="Jump to page number"
                  className="focus-input page-num-input"
                  autoFocus
                />
              </form>
            ) : (
              <button
                type="button"
                className="page-field-pill"
                aria-live="polite"
                onClick={() => {
                  setPageInput(String(viewState.current_page + 1));
                  setIsEditingPage(true);
                }}
                title="Click to jump to a page"
                data-node-id="2:45"
              >
                <span className="sr-only">
                  Page {viewState.current_page + 1} of {viewState.page_count}
                </span>
                <span aria-hidden="true">
                  {viewState.current_page + 1} / {viewState.page_count}
                </span>
              </button>
            )}

            <button
              type="button"
              className="focus-icon-btn"
              onClick={onNextPage}
              disabled={viewState.current_page + 1 >= viewState.page_count}
              aria-label="Next Page"
              data-node-id="2:47"
            >
              <FocusIcon name="chevron-right" size={16} />
            </button>

            <span
              className="toolbar-vertical-divider"
              aria-hidden="true"
              data-node-id="2:48"
            />

            <button
              type="button"
              className="focus-icon-btn"
              onClick={onZoomOut}
              aria-label="Zoom Out"
              data-node-id="2:49"
            >
              <FocusIcon name="zoom-out" size={16} />
            </button>

            <div className="zoom-menu-wrapper">
              <button
                type="button"
                className="zoom-pill-btn"
                data-testid="zoom-indicator"
                onClick={() => setShowZoomMenu((prev) => !prev)}
                aria-label="Zoom presets"
                data-node-id="2:51"
              >
                <span>{zoomPercent}%</span>
                <FocusIcon name="chevron-down" size={12} />
              </button>

              {showZoomMenu && (
                <div
                  className="zoom-dropdown-menu"
                  role="menu"
                  aria-label="Zoom Menu"
                  data-node-id="6:1223"
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
              data-node-id="2:53"
            >
              <FocusIcon name="zoom-in" size={16} />
            </button>
          </div>

          {/* Right Group (2:54): Print, Share, More Actions, Notes Panel */}
          <div
            className="toolbar-group toolbar-group-right"
            role="group"
            aria-label="Document Actions"
            data-node-id="2:54"
          >
            {onOpenPrint && (
              <button
                type="button"
                className="focus-icon-btn"
                onClick={onOpenPrint}
                aria-label="Print Document"
                title="Print Document"
                data-node-id="2:57"
              >
                <FocusIcon name="print" size={16} />
              </button>
            )}

            {onOpenShare && (
              <button
                type="button"
                className="focus-icon-btn"
                onClick={onOpenShare}
                aria-label="Share Document"
                title="Share Document"
                data-node-id="2:59"
              >
                <FocusIcon name="share" size={16} />
              </button>
            )}

            {/* Figma Frame 16: Toolbar / More Actions Menu (6:1050) */}
            <div className="more-actions-wrapper">
              <button
                type="button"
                className={`focus-icon-btn ${
                  showMoreActionsMenu ? "active" : ""
                }`}
                onClick={() => setShowMoreActionsMenu((prev) => !prev)}
                aria-label="More Document Actions"
                title="More Document Actions"
                data-node-id="2:61"
              >
                <FocusIcon name="more" size={16} />
              </button>

              {showMoreActionsMenu && (
                <div
                  className="document-actions-menu"
                  role="menu"
                  aria-label="Document Actions Menu"
                  data-node-id="6:1050"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-action-menu-item"
                    onClick={() => {
                      onOpenDocumentDetails?.();
                      setShowMoreActionsMenu(false);
                    }}
                  >
                    <span>Document properties…</span>
                    <FocusIcon name="info" size={14} />
                  </button>
                  {onOpenPrint && (
                    <button
                      type="button"
                      role="menuitem"
                      className="doc-action-menu-item"
                      onClick={() => {
                        onOpenPrint();
                        setShowMoreActionsMenu(false);
                      }}
                    >
                      <span>Print document…</span>
                      <span className="zoom-shortcut">⌘P</span>
                    </button>
                  )}
                  <div className="zoom-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-action-menu-item"
                    onClick={() => {
                      onRotateCw();
                      setShowMoreActionsMenu(false);
                    }}
                  >
                    <span>Rotate clockwise</span>
                    <span className="zoom-shortcut">⌘]</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-action-menu-item"
                    onClick={() => {
                      onRotateCcw();
                      setShowMoreActionsMenu(false);
                    }}
                  >
                    <span>Rotate counterclockwise</span>
                    <span className="zoom-shortcut">⌘[</span>
                  </button>
                  <div className="zoom-menu-divider" />
                  {onToggleFavorite && (
                    <button
                      type="button"
                      role="menuitem"
                      className="doc-action-menu-item"
                      onClick={() => {
                        onToggleFavorite();
                        setShowMoreActionsMenu(false);
                      }}
                    >
                      <span>
                        {isFavorite
                          ? "Remove from favorites"
                          : "Add to favorites"}
                      </span>
                      <FocusIcon
                        name="star"
                        size={14}
                        filled={Boolean(isFavorite)}
                      />
                    </button>
                  )}
                  {onArchiveDocument && (
                    <button
                      type="button"
                      role="menuitem"
                      className="doc-action-menu-item"
                      onClick={() => {
                        onArchiveDocument();
                        setShowMoreActionsMenu(false);
                      }}
                    >
                      <span>Move to archive</span>
                      <FocusIcon name="archive" size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>

            {onToggleRightPanel && (
              <button
                type="button"
                className={`focus-icon-btn ${showRightPanel ? "active" : ""}`}
                onClick={onToggleRightPanel}
                aria-label="Toggle Notes and Details Panel"
                title="Toggle Notes and Details Panel"
                data-node-id="2:63"
              >
                <FocusIcon name="panel-right" size={16} />
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
