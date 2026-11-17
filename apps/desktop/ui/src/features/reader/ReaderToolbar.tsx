import React, { useEffect, useRef, useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import {
  type FitMode,
  type LayoutMode,
  type RenderMode,
  type ViewStateDto,
} from "../../types/ipc";
import { ApplicationMenuBar, type AppMenuKey } from "./ApplicationMenuBar";
import { DocumentActionsMenu } from "./DocumentActionsMenu";

export type SidebarTab = "thumbnails" | "outline" | "bookmarks" | null;

interface ReaderToolbarProps {
  fileName: string | null;
  fileSizeBytes?: number | null;
  viewState: ViewStateDto | null;
  displayZoom?: number;
  activeSidebar: SidebarTab;
  isSearchOpen?: boolean;
  hasOpenModal?: boolean;
  showRightPanel?: boolean;
  onToggleSidebar: (tab: Exclude<SidebarTab, null>) => void;
  onToggleSearch?: () => void;
  onOpenSearch?: () => void;
  onToggleRightPanel?: () => void;
  onCloseDocument: () => void;
  onShowLibraryRecents?: () => void;
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
  onFocusCommentComposer?: () => void;
  hasUpdateAvailable?: boolean;
  onOpenUpdateDialog?: () => void;
}

function formatFileSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return "Local PDF";
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const ReaderToolbar: React.FC<ReaderToolbarProps> = ({
  fileName,
  fileSizeBytes,
  viewState,
  displayZoom,
  activeSidebar,
  isSearchOpen = false,
  hasOpenModal = false,
  showRightPanel = true,
  onToggleSidebar,
  onToggleSearch,
  onOpenSearch,
  onToggleRightPanel,
  onCloseDocument,
  onShowLibraryRecents,
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
  onFocusCommentComposer,
  hasUpdateAvailable = false,
  onOpenUpdateDialog,
}) => {
  const [pageInput, setPageInput] = useState("");
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [showMoreActionsMenu, setShowMoreActionsMenu] = useState(false);
  const [activeAppMenu, setActiveAppMenu] = useState<AppMenuKey>(null);

  const appMenuBarRef = useRef<HTMLDivElement | null>(null);
  const zoomMenuRef = useRef<HTMLDivElement | null>(null);
  const moreActionsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hasOpenModal) {
      setActiveAppMenu(null);
      setShowZoomMenu(false);
      setShowMoreActionsMenu(false);
    }
  }, [hasOpenModal]);

  useEffect(() => {
    if (!activeAppMenu && !showZoomMenu && !showMoreActionsMenu) {
      return;
    }

    const handlePointerDownOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      if (
        activeAppMenu &&
        appMenuBarRef.current &&
        !appMenuBarRef.current.contains(target)
      ) {
        setActiveAppMenu(null);
      }

      if (
        showZoomMenu &&
        zoomMenuRef.current &&
        !zoomMenuRef.current.contains(target)
      ) {
        setShowZoomMenu(false);
      }

      if (
        showMoreActionsMenu &&
        moreActionsRef.current &&
        !moreActionsRef.current.contains(target)
      ) {
        setShowMoreActionsMenu(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveAppMenu(null);
        setShowZoomMenu(false);
        setShowMoreActionsMenu(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDownOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeAppMenu, showZoomMenu, showMoreActionsMenu]);

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

  const effectiveZoom = displayZoom ?? viewState?.zoom ?? 1.0;
  const zoomPercent = viewState ? Math.round(effectiveZoom * 100) : 100;

  return (
    <header
      className="focus-header-stack"
      role="toolbar"
      aria-label="PDF Reader Toolbar"
    >
      <ApplicationMenuBar
        menuBarRef={appMenuBarRef}
        activeAppMenu={activeAppMenu}
        setActiveAppMenu={(next) => {
          setShowZoomMenu(false);
          setShowMoreActionsMenu(false);
          setActiveAppMenu(next);
        }}
        fileName={fileName}
        viewState={viewState}
        onToggleSidebar={onToggleSidebar}
        onOpenSearch={onOpenSearch ?? onToggleSearch}
        onToggleRightPanel={onToggleRightPanel}
        onCloseDocument={onCloseDocument}
        onShowLibraryRecents={onShowLibraryRecents}
        onSetZoom={onSetZoom}
        onSetFitMode={onSetFitMode}
        onSetLayoutMode={onSetLayoutMode}
        onSetRenderMode={onSetRenderMode}
        onOpenPreferences={onOpenPreferences}
        onOpenAbout={onOpenAbout}
        onToggleTheme={onToggleTheme}
        onOpenPrint={onOpenPrint}
        onOpenDocumentDetails={onOpenDocumentDetails}
        onOpenImportDialog={onOpenImportDialog}
        onOpenShare={onOpenShare}
        onOpenShortcuts={onOpenShortcuts}
        onCopyPageText={onCopyPageText}
        onFocusCommentComposer={onFocusCommentComposer}
        onOpenUpdateDialog={onOpenUpdateDialog}
      />

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

      {viewState && (
        <div className="reader-action-bar" data-node-id="2:37">
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
              className={`focus-icon-btn ${isSearchOpen ? "active" : ""}`}
              onClick={() => onToggleSearch?.()}
              title="Find in Document"
              aria-label="Find in Document"
              data-node-id="2:41"
            >
              <FocusIcon name="search" size={16} />
            </button>
          </div>

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
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      const resetVal = String(viewState.current_page + 1);
                      setPageInput(resetVal);
                      e.currentTarget.value = resetVal;
                      e.currentTarget.blur();
                    }
                  }}
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

            <div ref={zoomMenuRef} className="zoom-menu-wrapper">
              <button
                type="button"
                className="zoom-pill-btn"
                data-testid="zoom-indicator"
                onClick={() => {
                  setActiveAppMenu(null);
                  setShowMoreActionsMenu(false);
                  setShowZoomMenu((prev) => !prev);
                }}
                aria-label="Zoom presets"
                aria-haspopup="menu"
                aria-expanded={showZoomMenu}
                data-node-id="2:51"
              >
                <span>{zoomPercent}%</span>
                <FocusIcon name="chevron-down" size={12} />
              </button>

              {showZoomMenu && (
                <div
                  className="zoom-dropdown-menu toolbar-dropdown-menu"
                  role="menu"
                  aria-label="Zoom Menu"
                  data-node-id="6:1223"
                >
                  <button
                    type="button"
                    role="menuitem"
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
                    role="menuitem"
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
                    role="menuitem"
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
                      role="menuitem"
                      className={`zoom-menu-item ${
                        viewState.fit_mode === "manual" &&
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

            <DocumentActionsMenu
              menuRef={moreActionsRef}
              isOpen={showMoreActionsMenu}
              onToggleOpen={() => {
                setActiveAppMenu(null);
                setShowZoomMenu(false);
                setShowMoreActionsMenu((prev) => !prev);
              }}
              onClose={() => setShowMoreActionsMenu(false)}
              isFavorite={isFavorite}
              onOpenDocumentDetails={onOpenDocumentDetails}
              onOpenPrint={onOpenPrint}
              onRotateCw={onRotateCw}
              onRotateCcw={onRotateCcw}
              onToggleFavorite={onToggleFavorite}
              onArchiveDocument={onArchiveDocument}
            />

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
