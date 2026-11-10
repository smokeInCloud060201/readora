import React, { useEffect, useRef, useState } from "react";
import { readoraApi } from "../../lib/tauri/client";
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
  prefetchWindow?: number;
  programmaticScrollTrigger?: number;
  showExtractedTextLayer?: boolean;
  isLoading: boolean;
  annotations?: AnnotationDto[];
  onCopyText: () => void;
  onVisiblePageChange?: (zeroBasedPage: number) => void;
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
  prefetchWindow = 1,
  programmaticScrollTrigger = 0,
  showExtractedTextLayer = false,
  isLoading,
  annotations = [],
  onCopyText,
  onVisiblePageChange,
  onNextPage,
  onPrevPage,
  onZoomIn,
  onZoomOut,
  onQuickAddNote,
  onCreateAnnotation,
}) => {
  const rotationDeg = rotationToDegrees(viewState.rotation);
  const viewportRef = useRef<HTMLElement | null>(null);
  const pageSheetRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const isProgrammaticScrollRef = useRef<boolean>(false);
  const overscrollDeltaRef = useRef<number>(0);
  const lastPageTurnTimeRef = useRef<number>(0);
  const lastWheelZoomTimeRef = useRef<number>(0);
  const prevPageRef = useRef<number>(viewState.current_page);
  const [pageTurnDirection, setPageTurnDirection] = useState<
    "next" | "prev" | null
  >(null);
  const [renderedPagesMap, setRenderedPagesMap] = useState<
    Record<number, RenderedPageResultDto>
  >({});

  const [showHighlightPopover, setShowHighlightPopover] = useState(false);
  const [selectedColor, setSelectedColor] = useState<string>(
    HIGHLIGHT_SWATCHES[0].hex,
  );
  const [underlineInstead, setUnderlineInstead] = useState(false);

  const isContinuous = viewState.layout_mode === "continuous";

  const cancelProgrammaticScroll = () => {
    if (scrollAnimationFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
    isProgrammaticScrollRef.current = false;
  };

  useEffect(() => {
    return () => {
      cancelProgrammaticScroll();
    };
  }, []);

  // Keep renderedPagesMap updated when active renderedPage arrives
  useEffect(() => {
    if (
      renderedPage &&
      renderedPage.document_id === viewState.document_id
    ) {
      setRenderedPagesMap((prev) => ({
        ...prev,
        [renderedPage.page_index]: renderedPage,
      }));
    }
  }, [renderedPage, viewState.document_id]);

  // Reset cached page bitmaps when document, zoom, rotation, or render_mode changes
  useEffect(() => {
    setRenderedPagesMap(
      renderedPage && renderedPage.document_id === viewState.document_id
        ? { [renderedPage.page_index]: renderedPage }
        : {},
    );
  }, [
    viewState.document_id,
    viewState.zoom,
    viewState.rotation,
    viewState.render_mode,
  ]);

  // Render visible + neighbor pages in Continuous Scroll mode (bounded window per AGENTS.md Rule 5)
  useEffect(() => {
    if (!isContinuous) return;
    let cancelled = false;
    const radius = Math.max(2, prefetchWindow + 1);
    const startPage = Math.max(0, viewState.current_page - radius);
    const endPage = Math.min(
      viewState.page_count - 1,
      viewState.current_page + radius,
    );

    void (async () => {
      for (let idx = startPage; idx <= endPage; idx += 1) {
        if (cancelled) break;
        try {
          const result = await readoraApi.renderPage({
            document_id: viewState.document_id,
            page_index: idx,
            scale: viewState.zoom,
            rotation_degrees: rotationDeg,
            render_mode: viewState.render_mode,
            generation: null,
          });
          if (!cancelled) {
            setRenderedPagesMap((prev) => {
              const next: Record<number, RenderedPageResultDto> = {
                ...prev,
                [idx]: result,
              };
              // Evict pages far outside the visible window to bound memory
              for (const key of Object.keys(next)) {
                const pageNum = Number(key);
                if (Math.abs(pageNum - viewState.current_page) > radius + 2) {
                  delete next[pageNum];
                }
              }
              return next;
            });
          }
        } catch {
          // Ignore individual background page render errors
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isContinuous,
    prefetchWindow,
    rotationDeg,
    viewState.current_page,
    viewState.document_id,
    viewState.page_count,
    viewState.render_mode,
    viewState.zoom,
  ]);

  // Track direction for subtle transition feedback
  useEffect(() => {
    overscrollDeltaRef.current = 0;
    if (viewState.current_page > prevPageRef.current) {
      setPageTurnDirection("next");
    } else if (viewState.current_page < prevPageRef.current) {
      setPageTurnDirection("prev");
    }
    prevPageRef.current = viewState.current_page;

    if (!isContinuous) {
      const el = viewportRef.current;
      if (el) {
        el.scrollTop = 0;
      }
    }
  }, [isContinuous, viewState.current_page, viewState.document_id]);

  // Programmatic Ease-Out smooth scroll when user clicks Next/Prev, Thumbnail, Outline, Bookmark, or Search hit
  useEffect(() => {
    if (!isContinuous || programmaticScrollTrigger === 0) return;
    const container = viewportRef.current;
    const targetSheet = pageSheetRefs.current[viewState.current_page];
    if (!container || !targetSheet) return;

    const targetTop = Math.max(0, targetSheet.offsetTop - 24);
    const startTop = container.scrollTop;
    const distance = targetTop - startTop;

    if (Math.abs(distance) < 4 || container.clientHeight === 0) {
      container.scrollTop = targetTop;
      return;
    }

    cancelProgrammaticScroll();
    isProgrammaticScrollRef.current = true;
    const durationMs = 280;
    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, Math.max(0, elapsed / durationMs));
      // Cubic Ease-Out: 1 - (1 - t)^3
      const eased = 1 - Math.pow(1 - progress, 3);
      container.scrollTop = Math.round(startTop + distance * eased);

      if (progress < 1 && isProgrammaticScrollRef.current) {
        scrollAnimationFrameRef.current = requestAnimationFrame(step);
      } else {
        scrollAnimationFrameRef.current = null;
        isProgrammaticScrollRef.current = false;
      }
    };

    scrollAnimationFrameRef.current = requestAnimationFrame(step);
  }, [isContinuous, programmaticScrollTrigger, viewState.current_page]);

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

  const handleViewportScroll = () => {
    if (!isContinuous || isProgrammaticScrollRef.current) return;
    const el = viewportRef.current;
    if (!el || el.clientHeight === 0) return;

    const focusY = el.scrollTop + el.clientHeight * 0.38;
    let bestPage = viewState.current_page;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let idx = 0; idx < viewState.page_count; idx += 1) {
      const sheetEl = pageSheetRefs.current[idx];
      if (!sheetEl) continue;
      const top = sheetEl.offsetTop;
      const height = sheetEl.offsetHeight;
      const bottom = top + height;
      if (focusY >= top && focusY <= bottom) {
        bestPage = idx;
        break;
      }
      const center = top + height / 2;
      const dist = Math.abs(focusY - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = idx;
      }
    }

    if (bestPage !== viewState.current_page && onVisiblePageChange) {
      onVisiblePageChange(bestPage);
    }
  };

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

    // Cancel any programmatic ease-out scroll immediately so user scroll input has direct control
    if (isProgrammaticScrollRef.current) {
      cancelProgrammaticScroll();
    }

    const el = viewportRef.current;
    if (!el || isLoading) return;

    // In a real browser in Continuous Scroll mode, native scroll handles smooth continuous movement
    const isRealScrollableContainer = el.scrollHeight > el.clientHeight && el.clientHeight > 0;
    if (isContinuous && isRealScrollableContainer) {
      return;
    }

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
        now - lastPageTurnTimeRef.current >= 240
      ) {
        overscrollDeltaRef.current =
          Math.max(0, overscrollDeltaRef.current) + pixelDeltaY;
        if (overscrollDeltaRef.current >= 28) {
          overscrollDeltaRef.current = 0;
          lastPageTurnTimeRef.current = now;
          onNextPage();
        }
      }
    } else if (pixelDeltaY < 0 && isAtTop) {
      if (
        onPrevPage &&
        viewState.current_page > 0 &&
        now - lastPageTurnTimeRef.current >= 240
      ) {
        overscrollDeltaRef.current =
          Math.min(0, overscrollDeltaRef.current) + pixelDeltaY;
        if (overscrollDeltaRef.current <= -28) {
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
  const pageTurnClass =
    !isContinuous && pageTurnDirection === "next"
      ? "page-turn-next"
      : !isContinuous && pageTurnDirection === "prev"
        ? "page-turn-prev"
        : "";

  const pagesToRender = isContinuous
    ? Array.from({ length: viewState.page_count }, (_, idx) => idx)
    : [viewState.current_page];

  return (
    <main
      ref={viewportRef}
      className={`document-canvas-viewport ${
        isContinuous ? "continuous-scroll-mode" : "single-page-mode"
      }`}
      aria-label="Document Page Viewport"
      onScroll={handleViewportScroll}
      onWheel={handleViewportWheel}
    >
      <div className="continuous-pages-stack">
        {pagesToRender.map((pageIdx) => {
          const isCurrentPage = pageIdx === viewState.current_page;
          const pageBitmap =
            renderedPagesMap[pageIdx] ??
            (isCurrentPage ? renderedPage : null);

          return (
            <div
              key={`sheet-${viewState.document_id}-${pageIdx}`}
              ref={(node) => {
                pageSheetRefs.current[pageIdx] = node;
              }}
              data-page-index={pageIdx}
              className={`pdf-page-sheet ${
                isCurrentPage ? `active-page-sheet ${pageTurnClass}` : ""
              }`.trim()}
              data-node-id={isCurrentPage ? "2:130" : undefined}
              data-testid={
                isCurrentPage
                  ? "pdf-page-sheet"
                  : `pdf-page-sheet-${pageIdx + 1}`
              }
              style={{ width: `${sheetWidthPx}px` }}
            >
              <div className="pdf-sheet-running-header">
                <span
                  className="pdf-sheet-kicker"
                  data-node-id={isCurrentPage ? "2:131" : undefined}
                >
                  {displayTitle.toUpperCase()}
                </span>
                <span
                  className="pdf-sheet-meta"
                  data-node-id={isCurrentPage ? "2:132" : undefined}
                >
                  Page {pageIdx + 1} / {viewState.page_count} ·{" "}
                  {Math.round(viewState.zoom * 100)}% · {rotationDeg}°
                </span>
              </div>

              <div className="page-image-frame">
                {isCurrentPage && isLoading && (
                  <div className="render-loading-badge" role="status">
                    Rendering page {pageIdx + 1}...
                  </div>
                )}
                {pageBitmap ? (
                  <img
                    src={pageBitmap.data_url}
                    alt={`Rendered PDF page ${pageIdx + 1}`}
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
                    Preparing page {pageIdx + 1}...
                  </div>
                )}
              </div>

              {isCurrentPage &&
                pageText &&
                (showExtractedTextLayer ? (
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
                ) : (
                  <div className="sr-only" aria-label="Extracted Page Text">
                    {pageText}
                  </div>
                ))}

              <div className="pdf-sheet-running-footer">
                <span data-node-id={isCurrentPage ? "2:147" : undefined}>
                  {displayTitle.toUpperCase()}
                </span>
                <span data-node-id={isCurrentPage ? "2:148" : undefined}>
                  {pageIdx + 1}
                </span>
              </div>
            </div>
          );
        })}
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
