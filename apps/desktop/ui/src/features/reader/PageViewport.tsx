import React from "react";
import {
  rotationToDegrees,
  type RenderedPageResultDto,
  type ViewStateDto,
} from "../../types/ipc";

interface PageViewportProps {
  viewState: ViewStateDto;
  renderedPage: RenderedPageResultDto | null;
  pageText: string;
  isLoading: boolean;
  onCopyText: () => void;
  onQuickAddNote?: () => void;
}

export const PageViewport: React.FC<PageViewportProps> = ({
  viewState,
  renderedPage,
  pageText,
  isLoading,
  onCopyText,
  onQuickAddNote,
}) => {
  const rotationDeg = rotationToDegrees(viewState.rotation);

  return (
    <main className="document-canvas-viewport" aria-label="Document Page Viewport">
      <div className="pdf-page-sheet">
        <div className="pdf-sheet-running-header">
          <span className="pdf-sheet-kicker">
            READORA · 0{Math.min(9, viewState.current_page + 1)}
          </span>
          <span className="pdf-sheet-meta">
            Page {viewState.current_page + 1} / {viewState.page_count} ·{" "}
            {Math.round(viewState.zoom * 100)}% · {rotationDeg}°
          </span>
        </div>

        <div className="page-image-frame">
          {isLoading && (
            <div className="render-loading-badge" role="status">
              Rendering page {viewState.current_page + 1}...
            </div>
          )}
          {renderedPage ? (
            <img
              src={renderedPage.data_url}
              alt={`Rendered PDF page ${viewState.current_page + 1}`}
              width={renderedPage.width_px}
              height={renderedPage.height_px}
              className="rendered-page-img"
            />
          ) : (
            <div className="page-placeholder">Preparing page surface...</div>
          )}
        </div>

        <section
          className="selectable-text-layer"
          aria-label="Selectable Page Text"
        >
          <p className="text-layer-content">{pageText}</p>
        </section>

        <div className="pdf-sheet-running-footer">
          <span>FOCUS READER WORKSPACE</span>
          <span>{viewState.current_page + 1}</span>
        </div>
      </div>

      {/* Bottom Floating Annotation & Selection Tools Bar (Figma Frame 01: 246x45) */}
      <div
        className="floating-annotation-tools"
        role="toolbar"
        aria-label="Page Reading Tools"
      >
        <button
          type="button"
          className="focus-icon-btn active"
          title="Select cursor"
          aria-label="Select cursor"
        >
          ↗
        </button>
        <button
          type="button"
          className="focus-icon-btn"
          onClick={onCopyText}
          title="Copy Page Text"
          aria-label="Copy Page Text"
        >
          T
        </button>
        <button
          type="button"
          className="focus-icon-btn"
          onClick={onQuickAddNote}
          title="Highlight or Bookmark Page"
          aria-label="Highlight or Bookmark Page"
        >
          ✎
        </button>
        <button
          type="button"
          className="focus-icon-btn"
          onClick={onCopyText}
          title="Copy Selection"
          aria-label="Copy Selection"
        >
          □
        </button>
      </div>
    </main>
  );
};
