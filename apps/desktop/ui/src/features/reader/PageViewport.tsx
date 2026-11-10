import React, { useEffect, useRef, useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import {
  rotationToDegrees,
  type AnnotationDto,
  type AnnotationKind,
  type RenderedPageResultDto,
  type ViewStateDto,
} from "../../types/ipc";

interface PageViewportProps {
  documentTitle?: string;
  viewState: ViewStateDto;
  renderedPage: RenderedPageResultDto | null;
  pageText: string;
  isLoading: boolean;
  annotations?: AnnotationDto[];
  onCopyText: () => void;
  onNextPage?: () => void;
  onPrevPage?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onQuickAddNote?: () => void;
  onCreateAnnotation?: (
    kind: AnnotationKind,
    colorHex: string,
    quoteText: string,
    noteText: string,
  ) => void;
}

const HIGHLIGHT_SWATCHES = [
  { id: "amber", label: "Amber", hex: "#f3d96b" },
  { id: "coral", label: "Coral", hex: "#f0a88f" },
  { id: "sage", label: "Sage", hex: "#a9d5b2" },
  { id: "sky", label: "Sky", hex: "#9bc8e0" },
  { id: "lavender", label: "Lavender", hex: "#c9afe2" },
] as const;

export const PageViewport: React.FC<PageViewportProps> = ({
  documentTitle,
  viewState,
  renderedPage,
  pageText,
  isLoading,
  annotations = [],
  onCopyText,
  onNextPage,
  onPrevPage,
  onZoomIn,
  onZoomOut,
  onQuickAddNote,
  onCreateAnnotation,
}) => {
  const rotationDeg = rotationToDegrees(viewState.rotation);
  const viewportRef = useRef<HTMLElement | null>(null);
  const overscrollDeltaRef = useRef<number>(0);
  const lastPageTurnTimeRef = useRef<number>(0);
  const lastWheelZoomTimeRef = useRef<number>(0);

  const [showHighlightPopover, setShowHighlightPopover] = useState(false);
  const [selectedColor, setSelectedColor] = useState<string>(
    HIGHLIGHT_SWATCHES[0].hex,
  );
  const [underlineInstead, setUnderlineInstead] = useState(false);

  useEffect(() => {
    overscrollDeltaRef.current = 0;
    if (viewportRef.current) {
      viewportRef.current.scrollTop = 0;
    }
  }, [viewState.current_page, viewState.document_id]);

  const aspect =
    renderedPage && renderedPage.width_px > 0
      ? renderedPage.height_px / renderedPage.width_px
      : rotationDeg === 90 || rotationDeg === 270
        ? 612 / 792
        : 792 / 612;
  const basePageWidth = aspect < 1 ? 760 : 608;
  const displayWidthPx = Math.max(
    180,
    Math.round(basePageWidth * viewState.zoom),
  );
  const displayHeightPx = Math.max(180, Math.round(displayWidthPx * aspect));
  const sheetWidthPx = displayWidthPx + 72;

  const handleViewportWheel = (e: React.WheelEvent<HTMLElement>) => {
    const now = Date.now();

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (now - lastWheelZoomTimeRef.current < 160) return;
      if (e.deltaY < 0 && onZoomIn) {
        lastWheelZoomTimeRef.current = now;
        onZoomIn();
      } else if (e.deltaY > 0 && onZoomOut) {
        lastWheelZoomTimeRef.current = now;
        onZoomOut();
      }
      return;
    }

    const el = viewportRef.current;
    if (!el || isLoading) return;

    const pixelDeltaY =
      e.deltaMode === 1
        ? e.deltaY * 18
        : e.deltaMode === 2
          ? e.deltaY * 120
          : e.deltaY;

    if (Math.abs(pixelDeltaY) < Math.abs(e.deltaX)) {
      return;
    }

    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const isAtBottom = maxScrollTop <= 2 || el.scrollTop >= maxScrollTop - 6;
    const isAtTop = maxScrollTop <= 2 || el.scrollTop <= 6;

    if (pixelDeltaY > 0 && isAtBottom) {
      if (
        onNextPage &&
        viewState.current_page + 1 < viewState.page_count &&
        now - lastPageTurnTimeRef.current >= 320
      ) {
        overscrollDeltaRef.current =
          Math.max(0, overscrollDeltaRef.current) + pixelDeltaY;
        if (overscrollDeltaRef.current >= 40) {
          overscrollDeltaRef.current = 0;
          lastPageTurnTimeRef.current = now;
          onNextPage();
        }
      }
    } else if (pixelDeltaY < 0 && isAtTop) {
      if (
        onPrevPage &&
        viewState.current_page > 0 &&
        now - lastPageTurnTimeRef.current >= 320
      ) {
        overscrollDeltaRef.current =
          Math.min(0, overscrollDeltaRef.current) + pixelDeltaY;
        if (overscrollDeltaRef.current <= -40) {
          overscrollDeltaRef.current = 0;
          lastPageTurnTimeRef.current = now;
          onPrevPage();
        }
      }
    } else {
      overscrollDeltaRef.current = 0;
    }
  };

  const pageAnnotations = annotations.filter(
    (ann) => ann.page_index === viewState.current_page,
  );
  const latestPageAnnotation = pageAnnotations[pageAnnotations.length - 1];
  const activeBorderColor = latestPageAnnotation
    ? latestPageAnnotation.color_hex
    : selectedColor;
  const activeUnderline = latestPageAnnotation
    ? latestPageAnnotation.kind === "underline"
    : underlineInstead;
  const displayTitle = (documentTitle || "PDF Document").replace(/\.pdf$/i, "");

  return (
    <main
      ref={viewportRef}
      className="document-canvas-viewport"
      aria-label="Document Page Viewport"
      onWheel={handleViewportWheel}
    >
      <div
        className="pdf-page-sheet"
        data-node-id="2:130"
        data-testid="pdf-page-sheet"
        style={{ width: `${sheetWidthPx}px` }}
      >
        <div className="pdf-sheet-running-header">
          <span className="pdf-sheet-kicker" data-node-id="2:131">
            {displayTitle.toUpperCase()}
          </span>
          <span className="pdf-sheet-meta" data-node-id="2:132">
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
              width={displayWidthPx}
              height={displayHeightPx}
              style={{
                width: `${displayWidthPx}px`,
                height: `${displayHeightPx}px`,
              }}
              className="rendered-page-img"
            />
          ) : (
            <div
              className="page-placeholder"
              style={{
                width: `${displayWidthPx}px`,
                minHeight: `${displayHeightPx}px`,
              }}
            >
              Preparing page surface...
            </div>
          )}
        </div>

        {pageText && (
          <section
            className="selectable-text-layer"
            aria-label="Selectable Page Text"
            style={{
              borderLeftColor: activeBorderColor,
              textDecoration: activeUnderline ? "underline" : "none",
            }}
          >
            <p className="text-layer-content">{pageText}</p>
          </section>
        )}

        <div className="pdf-sheet-running-footer">
          <span data-node-id="2:147">{displayTitle.toUpperCase()}</span>
          <span data-node-id="2:148">{viewState.current_page + 1}</span>
        </div>
      </div>

      {/* Figma Frame 24: Highlight Options Popover (254x116) */}
      {showHighlightPopover && (
        <div
          className="highlight-options-popover"
          role="dialog"
          aria-label="Highlight Options"
          data-node-id="7:943"
        >
          <div className="highlight-popover-header">
            <span className="highlight-popover-label">Highlight color</span>
            <div className="highlight-popover-actions">
              {onCreateAnnotation && (
                <button
                  type="button"
                  className="highlight-pin-link"
                  aria-label="Save page highlight"
                  onClick={() => {
                    onCreateAnnotation(
                      underlineInstead ? "underline" : "highlight",
                      selectedColor,
                      pageText || `Page ${viewState.current_page + 1} excerpt`,
                      underlineInstead
                        ? "Underlined passage"
                        : "Highlighted passage",
                    );
                    setShowHighlightPopover(false);
                  }}
                >
                  Save highlight
                </button>
              )}
              {onQuickAddNote && (
                <button
                  type="button"
                  className="highlight-pin-link"
                  onClick={() => {
                    setShowHighlightPopover(false);
                    onQuickAddNote();
                  }}
                >
                  + Add note
                </button>
              )}
            </div>
          </div>
          <div
            className="highlight-swatch-row"
            role="radiogroup"
            aria-label="Highlight color swatches"
          >
            {HIGHLIGHT_SWATCHES.map((swatch) => (
              <button
                key={swatch.id}
                type="button"
                role="radio"
                aria-checked={selectedColor === swatch.hex}
                aria-label={`Highlight color ${swatch.label}`}
                className={`highlight-swatch-btn ${
                  selectedColor === swatch.hex ? "selected" : ""
                }`}
                style={{ backgroundColor: swatch.hex }}
                onClick={() => setSelectedColor(swatch.hex)}
              />
            ))}
          </div>
          <div className="highlight-popover-divider" />
          <div className="highlight-underline-row">
            <span className="highlight-underline-label">Underline instead</span>
            <button
              type="button"
              role="switch"
              aria-checked={underlineInstead}
              aria-label="Underline instead"
              className={`focus-switch compact ${underlineInstead ? "on" : ""}`}
              onClick={() => setUnderlineInstead((v) => !v)}
            >
              <span className="focus-switch-thumb" />
            </button>
          </div>
        </div>
      )}

      {/* Bottom Floating Annotation & Selection Tools Bar (Figma Frame 01 & 24: 2:149, 246x45) */}
      <div
        className="floating-annotation-tools"
        role="toolbar"
        aria-label="Page Reading Tools"
        data-node-id="2:149"
      >
        <button
          type="button"
          className={`focus-icon-btn ${
            !showHighlightPopover && !underlineInstead ? "active" : ""
          }`}
          onClick={() => {
            setShowHighlightPopover(false);
            setUnderlineInstead(false);
          }}
          title="Select cursor"
          aria-label="Select cursor"
          data-node-id="2:150"
        >
          <FocusIcon name="arrow-right" size={15} />
        </button>
        <button
          type="button"
          className="focus-icon-btn"
          onClick={onCopyText}
          title="Copy Page Text"
          aria-label="Copy Page Text"
          data-node-id="2:152"
        >
          <FocusIcon name="text" size={16} />
        </button>
        <button
          type="button"
          className={`focus-icon-btn ${showHighlightPopover ? "active" : ""}`}
          onClick={() => setShowHighlightPopover((prev) => !prev)}
          title="Highlight Options"
          aria-label="Highlight Options"
          data-node-id="2:154"
        >
          <FocusIcon name="highlight" size={16} />
        </button>
        <button
          type="button"
          className={`focus-icon-btn ${underlineInstead ? "active" : ""}`}
          onClick={() => {
            setUnderlineInstead((prev) => !prev);
            setShowHighlightPopover(true);
          }}
          title="Underline Selection"
          aria-label="Underline Selection"
          data-node-id="2:156"
        >
          <FocusIcon name="pen" size={16} />
        </button>
        <button
          type="button"
          className="focus-icon-btn"
          onClick={() => {
            if (onQuickAddNote) {
              onQuickAddNote();
            } else {
              onCopyText();
            }
          }}
          title="Add Comment"
          aria-label="Add Comment"
          data-node-id="2:158"
        >
          <FocusIcon name="comment" size={16} />
        </button>
      </div>
    </main>
  );
};
