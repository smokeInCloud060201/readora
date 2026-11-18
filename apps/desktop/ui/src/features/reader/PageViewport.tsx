import React, { useEffect, useRef, useState } from "react";
import { readoraApi } from "../../lib/tauri/client";
import {
  rotationToDegrees,
  type AnnotationDto,
  type AnnotationKind,
  type RenderedPageResultDto,
  type RenderMode,
  type SearchBoundingBoxDto,
  type SearchHitDto,
  type ViewStateDto,
} from "../../types/ipc";
import {
  FloatingAnnotationTools,
  HIGHLIGHT_SWATCHES,
} from "./FloatingAnnotationTools";

interface PageViewportProps {
  documentTitle?: string;
  viewState: ViewStateDto;
  effectiveRenderMode?: RenderMode;
  renderedPage: RenderedPageResultDto | null;
  pageText: string;
  prefetchWindow?: number;
  programmaticScrollTrigger?: number;
  showExtractedTextLayer?: boolean;
  isLoading: boolean;
  annotations?: AnnotationDto[];
  searchHits?: SearchHitDto[];
  activeSearchHitIndex?: number;
  showHighlightPopover?: boolean;
  setShowHighlightPopover?: React.Dispatch<React.SetStateAction<boolean>>;
  onEffectiveZoomChange?: (effectiveZoom: number) => void;
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

const VIRTUALIZATION_PAGE_THRESHOLD = 30;
const VIRTUALIZATION_WINDOW_RADIUS = 6;

interface PageDisplayMetrics {
  displayWidthPx: number;
  displayHeightPx: number;
  sheetWidthPx: number;
  basePageWidth: number;
}

function computePageDisplayMetrics(
  aspect: number,
  containerSize: { width: number; height: number },
  fitMode: ViewStateDto["fit_mode"],
  zoom: number,
): PageDisplayMetrics {
  const basePageWidth = aspect < 1 ? 760 : 608;
  let displayWidthPx: number;
  if (containerSize.width > 0 && fitMode !== "manual") {
    const availableWidth = Math.max(180, containerSize.width - 156);
    if (fitMode === "fit_page" && containerSize.height > 0) {
      const availableHeight = Math.max(180, containerSize.height - 182);
      const widthForHeight = Math.round(
        availableHeight / Math.max(0.1, aspect),
      );
      displayWidthPx = Math.max(180, Math.min(availableWidth, widthForHeight));
    } else {
      displayWidthPx = availableWidth;
    }
  } else {
    // Preserves 608px + 72px = 680px at 100% and 760px + 72px = 832px at 125% when containerWidth === 0 in jsdom
    displayWidthPx = Math.max(180, Math.round(basePageWidth * zoom));
  }
  const displayHeightPx = Math.max(180, Math.round(displayWidthPx * aspect));
  return {
    displayWidthPx,
    displayHeightPx,
    sheetWidthPx: displayWidthPx + 72,
    basePageWidth,
  };
}

function rotateBoundingBox(
  box: SearchBoundingBoxDto,
  rotationDeg: number,
): SearchBoundingBoxDto {
  const normalized = ((rotationDeg % 360) + 360) % 360;
  if (normalized === 90) {
    return {
      x_ratio: Math.max(0, 1 - box.y_ratio - box.height_ratio),
      y_ratio: box.x_ratio,
      width_ratio: box.height_ratio,
      height_ratio: box.width_ratio,
    };
  }
  if (normalized === 180) {
    return {
      x_ratio: Math.max(0, 1 - box.x_ratio - box.width_ratio),
      y_ratio: Math.max(0, 1 - box.y_ratio - box.height_ratio),
      width_ratio: box.width_ratio,
      height_ratio: box.height_ratio,
    };
  }
  if (normalized === 270) {
    return {
      x_ratio: box.y_ratio,
      y_ratio: Math.max(0, 1 - box.x_ratio - box.width_ratio),
      width_ratio: box.height_ratio,
      height_ratio: box.width_ratio,
    };
  }
  return box;
}

export const PageViewport: React.FC<PageViewportProps> = ({
  viewState,
  effectiveRenderMode,
  renderedPage,
  pageText,
  prefetchWindow = 1,
  programmaticScrollTrigger = 0,
  showExtractedTextLayer = false,
  isLoading,
  annotations = [],
  searchHits = [],
  activeSearchHitIndex = 0,
  showHighlightPopover: controlledShowHighlightPopover,
  setShowHighlightPopover: controlledSetShowHighlightPopover,
  onEffectiveZoomChange,
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
  const initializedDocScrollRef = useRef<string | null>(null);
  const overscrollDeltaRef = useRef<number>(0);
  const lastPageTurnTimeRef = useRef<number>(0);
  const lastWheelZoomTimeRef = useRef<number>(0);
  const prevPageRef = useRef<number>(viewState.current_page);
  const [scrollCenterPage, setScrollCenterPage] = useState<number>(
    viewState.current_page,
  );
  const scrollCenterPageRef = useRef<number>(viewState.current_page);
  const viewGenerationRef = useRef<number | null>(viewState.generation ?? null);
  viewGenerationRef.current = viewState.generation ?? null;
  const measuredRectsRef = useRef<
    Record<number, { top: number; height: number }>
  >({});
  const [pageTurnDirection, setPageTurnDirection] = useState<
    "next" | "prev" | null
  >(null);
  const [renderedPagesMap, setRenderedPagesMap] = useState<
    Record<number, RenderedPageResultDto>
  >({});
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });

  const [internalShowHighlightPopover, setInternalShowHighlightPopover] =
    useState(false);
  const showHighlightPopover =
    controlledShowHighlightPopover ?? internalShowHighlightPopover;
  const setShowHighlightPopover =
    controlledSetShowHighlightPopover ?? setInternalShowHighlightPopover;

  const [selectedColor, setSelectedColor] = useState<string>(
    HIGHLIGHT_SWATCHES[0].hex,
  );
  const [underlineInstead, setUnderlineInstead] = useState(false);
  const highlightPopoverRef = useRef<HTMLDivElement | null>(null);
  const floatingToolsRef = useRef<HTMLDivElement | null>(null);

  // Measure real viewport container dimensions via ResizeObserver (0 in jsdom -> safe 680px fallback)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const measure = () => {
      setContainerSize((prev) => {
        const nextW = el.clientWidth;
        const nextH = el.clientHeight;
        if (prev.width === nextW && prev.height === nextH) {
          return prev;
        }
        return { width: nextW, height: nextH };
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!showHighlightPopover) {
      return;
    }

    const handlePointerDownOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (
        !highlightPopoverRef.current?.contains(target) &&
        !floatingToolsRef.current?.contains(target)
      ) {
        setShowHighlightPopover(false);
      }
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowHighlightPopover(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDownOutside);
    document.addEventListener("keydown", handleEscapeKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
      document.removeEventListener("keydown", handleEscapeKey);
    };
  }, [setShowHighlightPopover, showHighlightPopover]);

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

  const aspect =
    renderedPage && renderedPage.width_px > 0
      ? renderedPage.height_px / renderedPage.width_px
      : rotationDeg === 90 || rotationDeg === 270
        ? 612 / 792
        : 792 / 612;
  const {
    displayWidthPx,
    displayHeightPx,
    sheetWidthPx,
    basePageWidth,
  } = computePageDisplayMetrics(
    aspect,
    containerSize,
    viewState.fit_mode,
    viewState.zoom,
  );
  const estimatedSheetHeightPx = displayHeightPx + 86;
  const effectiveRenderScale =
    containerSize.width > 0 && viewState.fit_mode !== "manual"
      ? Number(
          Math.min(5.0, Math.max(0.25, displayWidthPx / basePageWidth)).toFixed(
            2,
          ),
        )
      : viewState.zoom;

  useEffect(() => {
    scrollCenterPageRef.current = viewState.current_page;
    setScrollCenterPage(viewState.current_page);
  }, [viewState.current_page, viewState.document_id]);

  useEffect(() => {
    measuredRectsRef.current = {};
  }, [
    containerSize.height,
    containerSize.width,
    effectiveRenderScale,
    viewState.document_id,
    viewState.rotation,
  ]);

  useEffect(() => {
    onEffectiveZoomChange?.(effectiveRenderScale);
  }, [
    effectiveRenderScale,
    onEffectiveZoomChange,
    viewState.document_id,
    viewState.fit_mode,
  ]);

  const activeRenderMode: RenderMode =
    effectiveRenderMode ?? viewState.render_mode;

  // Clear cached page bitmaps whenever document, effective scale, rotation, or render_mode changes
  useEffect(() => {
    setRenderedPagesMap({});
  }, [
    activeRenderMode,
    effectiveRenderScale,
    viewState.document_id,
    viewState.rotation,
  ]);

  // Insert active renderedPage when its document_id and scale match
  useEffect(() => {
    if (
      renderedPage &&
      renderedPage.document_id === viewState.document_id &&
      (Boolean(onEffectiveZoomChange) ||
        Math.abs(effectiveRenderScale - viewState.zoom) < 0.02)
    ) {
      setRenderedPagesMap((prev) => ({
        ...prev,
        [renderedPage.page_index]: renderedPage,
      }));
    }
  }, [
    effectiveRenderScale,
    onEffectiveZoomChange,
    renderedPage,
    viewState.document_id,
    viewState.zoom,
  ]);

  // Render neighbor pages in Continuous Scroll mode centered around scrollCenterPage
  useEffect(() => {
    if (!isContinuous) return;
    let cancelled = false;
    const radius = Math.max(1, prefetchWindow + 1);
    const startPage = Math.max(0, scrollCenterPage - radius);
    const endPage = Math.min(
      viewState.page_count - 1,
      scrollCenterPage + radius,
    );
    const parentRendersAtEffectiveScale =
      Boolean(onEffectiveZoomChange) ||
      Math.abs(effectiveRenderScale - viewState.zoom) < 0.02;

    void (async () => {
      for (let idx = startPage; idx <= endPage; idx += 1) {
        if (cancelled) break;
        if (idx === viewState.current_page && parentRendersAtEffectiveScale) {
          continue;
        }
        try {
          const result = await readoraApi.renderPage({
            document_id: viewState.document_id,
            page_index: idx,
            scale: effectiveRenderScale,
            rotation_degrees: rotationDeg,
            render_mode: activeRenderMode,
            generation: viewGenerationRef.current,
          });
          if (!cancelled && result.document_id === viewState.document_id) {
            setRenderedPagesMap((prev) => {
              const next: Record<number, RenderedPageResultDto> = {
                ...prev,
                [idx]: result,
              };
              for (const key of Object.keys(next)) {
                const pageNum = Number(key);
                if (
                  Math.abs(pageNum - scrollCenterPage) > radius + 2 &&
                  pageNum !== viewState.current_page
                ) {
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
    activeRenderMode,
    effectiveRenderScale,
    isContinuous,
    onEffectiveZoomChange,
    prefetchWindow,
    rotationDeg,
    scrollCenterPage,
    viewState.current_page,
    viewState.document_id,
    viewState.page_count,
    viewState.zoom,
  ]);

  // Restore saved scroll position when opening/switching to a document in Continuous Scroll mode
  useEffect(() => {
    if (!isContinuous) {
      initializedDocScrollRef.current = null;
      return;
    }
    if (initializedDocScrollRef.current === viewState.document_id) {
      return;
    }
    initializedDocScrollRef.current = viewState.document_id;
    const targetPage = viewState.current_page;
    const container = viewportRef.current;
    if (targetPage <= 0) {
      if (container) {
        container.scrollTop = 0;
      }
      return;
    }

    cancelProgrammaticScroll();
    isProgrammaticScrollRef.current = true;
    let settleRafId: number | null = null;
    const initialRafId = requestAnimationFrame(() => {
      const el = viewportRef.current;
      if (el) {
        const targetSheet = pageSheetRefs.current[targetPage];
        const targetTop =
          targetSheet && targetSheet.offsetTop > 0
            ? Math.max(0, targetSheet.offsetTop - 24)
            : targetPage * (estimatedSheetHeightPx + 28);
        el.scrollTop = targetTop;
      }
      settleRafId = requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
    });

    return () => {
      cancelAnimationFrame(initialRafId);
      if (settleRafId !== null) {
        cancelAnimationFrame(settleRafId);
      }
      isProgrammaticScrollRef.current = false;
    };
  }, [
    estimatedSheetHeightPx,
    isContinuous,
    viewState.current_page,
    viewState.document_id,
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

    const targetTop =
      targetSheet.offsetTop > 0 || viewState.current_page === 0
        ? Math.max(0, targetSheet.offsetTop - 24)
        : viewState.current_page * (estimatedSheetHeightPx + 28);
    const startTop = container.scrollTop;
    const distance = targetTop - startTop;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (
      prefersReducedMotion ||
      Math.abs(distance) < 4 ||
      container.clientHeight === 0
    ) {
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
  }, [
    estimatedSheetHeightPx,
    isContinuous,
    programmaticScrollTrigger,
    viewState.current_page,
  ]);

  const handleViewportScroll = () => {
    if (!isContinuous || isProgrammaticScrollRef.current) return;
    const el = viewportRef.current;
    if (!el || el.clientHeight === 0 || viewState.page_count <= 0) return;

    const getSheetMetrics = (
      idx: number,
    ): { top: number; height: number } | null => {
      const sheetEl = pageSheetRefs.current[idx];
      if (sheetEl && sheetEl.offsetHeight > 0) {
        const rect = { top: sheetEl.offsetTop, height: sheetEl.offsetHeight };
        measuredRectsRef.current[idx] = rect;
        return rect;
      }
      return measuredRectsRef.current[idx] ?? null;
    };

    const focusY = el.scrollTop + el.clientHeight * 0.38;
    const currentCenter = scrollCenterPageRef.current;
    let bestPage: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    const considerCandidate = (idx: number): boolean => {
      const rect = getSheetMetrics(idx);
      if (!rect) return false;
      const bottom = rect.top + rect.height;
      if (focusY >= rect.top && focusY <= bottom) {
        bestPage = idx;
        bestDist = 0;
        return true;
      }
      const dist = Math.abs(focusY - (rect.top + rect.height / 2));
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = idx;
      }
      return false;
    };

    const fastStart = Math.max(0, currentCenter - 2);
    const fastEnd = Math.min(viewState.page_count - 1, currentCenter + 2);
    let hitFast = false;
    for (let idx = fastStart; idx <= fastEnd; idx += 1) {
      if (considerCandidate(idx)) {
        hitFast = true;
        break;
      }
    }

    if (!hitFast) {
      let lo = 0;
      let hi = viewState.page_count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rect = getSheetMetrics(mid);
        if (!rect) {
          // Sparse unmeasured regions fall back safely without infinite loops
          let probe = mid - 1;
          while (probe >= lo && !getSheetMetrics(probe)) {
            probe -= 1;
          }
          const probeRect = probe >= lo ? getSheetMetrics(probe) : null;
          if (probeRect) {
            considerCandidate(probe);
            if (focusY < probeRect.top) {
              hi = probe - 1;
              continue;
            }
          }
          lo = mid + 1;
          continue;
        }
        if (considerCandidate(mid)) {
          break;
        }
        if (focusY < rect.top) {
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
    }

    const resolvedPage = bestPage ?? viewState.current_page;

    // Cache layout metrics around the target before virtualization remounts spacers into sheets
    const snapStart = Math.max(
      0,
      resolvedPage - VIRTUALIZATION_WINDOW_RADIUS - 2,
    );
    const snapEnd = Math.min(
      viewState.page_count - 1,
      resolvedPage + VIRTUALIZATION_WINDOW_RADIUS + 2,
    );
    for (let k = snapStart; k <= snapEnd; k += 1) {
      getSheetMetrics(k);
    }

    if (resolvedPage !== scrollCenterPageRef.current) {
      scrollCenterPageRef.current = resolvedPage;
      setScrollCenterPage(resolvedPage);
    }
    if (resolvedPage !== viewState.current_page && onVisiblePageChange) {
      onVisiblePageChange(resolvedPage);
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

    if (isProgrammaticScrollRef.current) {
      cancelProgrammaticScroll();
    }

    const el = viewportRef.current;
    if (!el || isLoading) return;

    const isRealScrollableContainer =
      el.scrollHeight > el.clientHeight && el.clientHeight > 0;
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
  const pageTurnClass =
    !isContinuous && pageTurnDirection === "next"
      ? "page-turn-next"
      : !isContinuous && pageTurnDirection === "prev"
        ? "page-turn-prev"
        : "";

  const pagesToRender = isContinuous
    ? Array.from({ length: viewState.page_count }, (_, idx) => idx)
    : [viewState.current_page];

  const shouldVirtualizeSheets =
    isContinuous && viewState.page_count > VIRTUALIZATION_PAGE_THRESHOLD;

  return (
    <main
      ref={viewportRef}
      className={`document-canvas-viewport reader-stage ${
        isContinuous ? "continuous-scroll-mode" : "single-page-mode"
      }`}
      aria-label="Document Page Viewport"
      onScroll={handleViewportScroll}
      onWheel={handleViewportWheel}
    >
      <div className="continuous-pages-stack">
        {pagesToRender.map((pageIdx) => {
          const isCurrentPage = pageIdx === viewState.current_page;
          if (
            shouldVirtualizeSheets &&
            !isCurrentPage &&
            Math.abs(pageIdx - scrollCenterPage) > VIRTUALIZATION_WINDOW_RADIUS
          ) {
            return (
              <div
                key={`spacer-${viewState.document_id}-${pageIdx}`}
                ref={(node) => {
                  pageSheetRefs.current[pageIdx] = node;
                }}
                data-page-index={pageIdx}
                data-testid={`pdf-page-spacer-${pageIdx + 1}`}
                className="pdf-page-sheet-spacer"
                style={{
                  width: `${sheetWidthPx}px`,
                  height: `${estimatedSheetHeightPx}px`,
                }}
                aria-hidden="true"
              />
            );
          }

          const matchingCurrentRendered =
            isCurrentPage &&
            renderedPage &&
            renderedPage.document_id === viewState.document_id
              ? renderedPage
              : null;
          const pageBitmap =
            renderedPagesMap[pageIdx] ?? matchingCurrentRendered;
          const pageDims =
            pageBitmap && pageBitmap.width_px > 0 && pageBitmap.height_px > 0
              ? computePageDisplayMetrics(
                  pageBitmap.height_px / pageBitmap.width_px,
                  containerSize,
                  viewState.fit_mode,
                  viewState.zoom,
                )
              : {
                  displayWidthPx,
                  displayHeightPx,
                  sheetWidthPx,
                  basePageWidth,
                };
          const pageSearchEntries = searchHits
            .map((hit, globalIdx) => ({ hit, globalIdx }))
            .filter((entry) => entry.hit.page_index === pageIdx);
          const sheetAnnotations = annotations.filter(
            (ann) => ann.page_index === pageIdx,
          );

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
              style={{ width: `${pageDims.sheetWidthPx}px` }}
            >
              <div className="page-image-frame">
                {isCurrentPage && isLoading && (
                  <div className="render-loading-badge" role="status">
                    Rendering page {pageIdx + 1}...
                  </div>
                )}
                {pageBitmap ? (
                  <div
                    className="rendered-page-stage"
                    style={{
                      width: `${pageDims.displayWidthPx}px`,
                      height: `${pageDims.displayHeightPx}px`,
                    }}
                  >
                    <img
                      src={pageBitmap.data_url}
                      alt={`Rendered PDF page ${pageIdx + 1}`}
                      width={pageDims.displayWidthPx}
                      height={pageDims.displayHeightPx}
                      style={{
                        width: `${pageDims.displayWidthPx}px`,
                        height: `${pageDims.displayHeightPx}px`,
                      }}
                      className="rendered-page-img"
                    />
                    {sheetAnnotations.length > 0 && (
                      <div
                        className="pdf-annotation-markers-layer"
                        aria-label={`Saved annotations on page ${pageIdx + 1}`}
                        data-testid={`page-annotations-${pageIdx + 1}`}
                      >
                        {sheetAnnotations.map((ann) => (
                          <span
                            key={ann.id}
                            className={`pdf-annotation-pill kind-${ann.kind}`}
                            style={{
                              borderLeftColor: ann.color_hex,
                            }}
                            title={ann.note_text || ann.quote_text}
                          >
                            <span className="pdf-annotation-pill-kind">
                              {ann.kind === "comment"
                                ? "Comment"
                                : ann.kind === "underline"
                                  ? "Underline"
                                  : "Highlight"}
                            </span>
                            <span className="pdf-annotation-pill-text">
                              {(ann.note_text || ann.quote_text).slice(0, 44)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    {pageSearchEntries.length > 0 && (
                      <div
                        className="pdf-search-highlight-layer"
                        aria-label={`Search highlights on page ${pageIdx + 1}`}
                        data-testid={`search-highlights-page-${pageIdx + 1}`}
                      >
                        {pageSearchEntries.flatMap(({ hit, globalIdx }) => {
                          const rawBoxes =
                            hit.bounding_boxes && hit.bounding_boxes.length > 0
                              ? hit.bounding_boxes
                              : [
                                  hit.bounding_box ?? {
                                    x_ratio: 0.08,
                                    y_ratio: 0.16,
                                    width_ratio: 0.18,
                                    height_ratio: 0.026,
                                  },
                                ];
                          const isFocusedMatch =
                            globalIdx === activeSearchHitIndex;
                          return rawBoxes.map((rawBox, lineIdx) => {
                            const box = rotateBoundingBox(rawBox, rotationDeg);
                            return (
                              <mark
                                key={`hl-${pageIdx}-${hit.match_index}-${globalIdx}-${lineIdx}`}
                                className={`pdf-search-highlight-box ${
                                  isFocusedMatch ? "active" : ""
                                }`}
                                data-testid={
                                  isFocusedMatch && lineIdx === 0
                                    ? "active-search-highlight"
                                    : "search-highlight"
                                }
                                title={hit.snippet}
                                style={{
                                  left: `${(box.x_ratio * 100).toFixed(2)}%`,
                                  top: `${(box.y_ratio * 100).toFixed(2)}%`,
                                  width: `${(box.width_ratio * 100).toFixed(2)}%`,
                                  height: `${(box.height_ratio * 100).toFixed(2)}%`,
                                }}
                              >
                                {lineIdx === 0 && (
                                  <span className="sr-only">
                                    {hit.match_text || hit.snippet}
                                  </span>
                                )}
                              </mark>
                            );
                          });
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    className="page-placeholder"
                    style={{
                      width: `${pageDims.displayWidthPx}px`,
                      minHeight: `${pageDims.displayHeightPx}px`,
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
            </div>
          );
        })}
      </div>

      <FloatingAnnotationTools
        currentPage={viewState.current_page}
        pageText={pageText}
        showHighlightPopover={showHighlightPopover}
        setShowHighlightPopover={setShowHighlightPopover}
        selectedColor={selectedColor}
        setSelectedColor={setSelectedColor}
        underlineInstead={underlineInstead}
        setUnderlineInstead={setUnderlineInstead}
        highlightPopoverRef={highlightPopoverRef}
        floatingToolsRef={floatingToolsRef}
        onCopyText={onCopyText}
        onQuickAddNote={onQuickAddNote}
        onCreateAnnotation={onCreateAnnotation}
      />
    </main>
  );
};
