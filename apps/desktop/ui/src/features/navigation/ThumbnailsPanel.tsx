import React, { useEffect, useRef, useState } from "react";
import { readoraApi } from "../../lib/tauri/client";

interface ThumbnailsPanelProps {
  documentId?: string;
  documentTitle?: string;
  pageCount: number;
  currentPage: number;
  onSelectPage: (zeroBasedPage: number) => void;
  onSwitchToOutline?: () => void;
}

const ESTIMATED_THUMB_ROW_HEIGHT = 136;
const MAX_CACHED_THUMBNAILS = 64;
const MAX_CONCURRENT_THUMB_RENDERS = 2;

export const ThumbnailsPanel: React.FC<ThumbnailsPanelProps> = ({
  documentId,
  documentTitle,
  pageCount,
  currentPage,
  onSelectPage,
  onSwitchToOutline,
}) => {
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [scrollCenterPage, setScrollCenterPage] = useState<number>(currentPage);
  const thumbnailsRef = useRef<Record<number, string>>({});
  const panelRef = useRef<HTMLElement | null>(null);
  const prevCurrentPageRef = useRef<number>(currentPage);
  const prevDocumentIdRef = useRef<string | undefined>(documentId);
  const isProgrammaticScrollRef = useRef<boolean>(false);
  const activeRendersRef = useRef<number>(0);
  const slotWaitersRef = useRef<Array<() => void>>([]);
  const pages = Array.from({ length: pageCount }, (_, i) => i);

  const syncPanelScrollToPage = (targetPage: number, forceTopReset = false) => {
    const el = panelRef.current;
    if (!el) return;
    const itemTop = targetPage * ESTIMATED_THUMB_ROW_HEIGHT;
    const itemBottom = itemTop + ESTIMATED_THUMB_ROW_HEIGHT;

    let nextScrollTop: number | null = null;
    if (forceTopReset && targetPage === 0) {
      nextScrollTop = 0;
    } else if (el.clientHeight > 0) {
      const viewTop = el.scrollTop;
      const viewBottom = el.scrollTop + el.clientHeight;
      if (itemTop < viewTop + 24 || itemBottom > viewBottom - 24) {
        nextScrollTop = Math.max(
          0,
          itemTop - Math.round(el.clientHeight * 0.35),
        );
      }
    } else {
      nextScrollTop =
        targetPage === 0 ? 0 : Math.max(0, itemTop - ESTIMATED_THUMB_ROW_HEIGHT);
    }

    if (nextScrollTop !== null && nextScrollTop !== el.scrollTop) {
      isProgrammaticScrollRef.current = true;
      el.scrollTop = nextScrollTop;
      queueMicrotask(() => {
        isProgrammaticScrollRef.current = false;
      });
    }
  };

  useEffect(() => {
    const docChanged = prevDocumentIdRef.current !== documentId;
    const pageChanged = prevCurrentPageRef.current !== currentPage;

    if (docChanged) {
      prevDocumentIdRef.current = documentId;
      prevCurrentPageRef.current = currentPage;
      thumbnailsRef.current = {};
      setThumbnails({});
      setScrollCenterPage(currentPage);
      syncPanelScrollToPage(currentPage, true);
      return;
    }

    if (pageChanged) {
      prevCurrentPageRef.current = currentPage;
      setScrollCenterPage(currentPage);
      syncPanelScrollToPage(currentPage, false);
    }
  }, [currentPage, documentId]);

  useEffect(() => {
    if (!documentId || pageCount <= 0) {
      thumbnailsRef.current = {};
      setThumbnails({});
      return;
    }

    let cancelled = false;
    const scrollStart = Math.max(0, scrollCenterPage - 8);
    const scrollEnd = Math.min(pageCount - 1, scrollCenterPage + 12);
    const candidateIndices: number[] = [];
    for (let i = scrollStart; i <= scrollEnd; i += 1) {
      candidateIndices.push(i);
    }
    candidateIndices.sort(
      (a, b) =>
        Math.abs(a - scrollCenterPage) - Math.abs(b - scrollCenterPage),
    );

    const acquireSlot = async (): Promise<boolean> => {
      while (activeRendersRef.current >= MAX_CONCURRENT_THUMB_RENDERS) {
        if (cancelled) return false;
        await new Promise<void>((resolve) => {
          slotWaitersRef.current.push(resolve);
        });
      }
      if (cancelled) return false;
      activeRendersRef.current += 1;
      return true;
    };

    const releaseSlot = () => {
      activeRendersRef.current = Math.max(0, activeRendersRef.current - 1);
      const nextWaiter = slotWaitersRef.current.shift();
      nextWaiter?.();
    };

    let nextCursor = 0;
    const workerCount = Math.min(
      MAX_CONCURRENT_THUMB_RENDERS,
      candidateIndices.length,
    );

    const runWorker = async () => {
      while (!cancelled) {
        const cursor = nextCursor;
        nextCursor += 1;
        if (cursor >= candidateIndices.length) {
          break;
        }
        const idx = candidateIndices[cursor];
        if (idx === undefined || thumbnailsRef.current[idx] !== undefined) {
          continue;
        }
        const acquired = await acquireSlot();
        if (!acquired) {
          break;
        }
        try {
          if (thumbnailsRef.current[idx] !== undefined) {
            continue;
          }
          const rendered = await readoraApi.renderPage({
            document_id: documentId,
            page_index: idx,
            scale: 0.35,
            rotation_degrees: 0,
            render_mode: "standard",
            generation: null,
          });
          if (cancelled || rendered.document_id !== documentId) {
            continue;
          }
          setThumbnails((prev) => {
            const next: Record<number, string> = {
              ...prev,
              [idx]: rendered.data_url,
            };
            const keys = Object.keys(next).map(Number);
            if (keys.length > MAX_CACHED_THUMBNAILS) {
              keys.sort(
                (a, b) =>
                  Math.abs(b - scrollCenterPage) -
                  Math.abs(a - scrollCenterPage),
              );
              for (const evictIdx of keys.slice(
                0,
                keys.length - MAX_CACHED_THUMBNAILS,
              )) {
                delete next[evictIdx];
              }
            }
            thumbnailsRef.current = next;
            return next;
          });
        } catch {
          // Ignore individual thumbnail render errors
        } finally {
          releaseSlot();
        }
      }
    };

    for (let w = 0; w < workerCount; w += 1) {
      void runWorker();
    }

    return () => {
      cancelled = true;
      const waiters = slotWaitersRef.current.splice(0);
      for (const wake of waiters) {
        wake();
      }
    };
  }, [documentId, pageCount, scrollCenterPage]);

  const handlePanelScroll = () => {
    if (isProgrammaticScrollRef.current) return;
    const el = panelRef.current;
    if (!el || pageCount <= 0) return;
    const approxIdx = Math.min(
      pageCount - 1,
      Math.max(
        0,
        Math.floor(
          (el.scrollTop + el.clientHeight * 0.4) / ESTIMATED_THUMB_ROW_HEIGHT,
        ),
      ),
    );
    if (Math.abs(approxIdx - scrollCenterPage) >= 3) {
      setScrollCenterPage(approxIdx);
    }
  };

  const cleanCoverTitle = (documentTitle || "PDF")
    .replace(/\.pdf$/i, "")
    .slice(0, 22)
    .toUpperCase();

  const shouldVirtualizeDom = pageCount > 60;
  const minDomIdx = shouldVirtualizeDom
    ? Math.max(0, scrollCenterPage - 20)
    : 0;
  const maxDomIdx = shouldVirtualizeDom
    ? Math.min(pageCount - 1, scrollCenterPage + 25)
    : pageCount - 1;

  return (
    <aside
      ref={panelRef}
      className="page-sidebar-panel"
      aria-label="Page Thumbnails"
      onScroll={handlePanelScroll}
    >
      <div className="sidebar-tabs-header">
        <button
          type="button"
          className="sidebar-tab-btn active"
          aria-current="true"
        >
          Pages
        </button>
        {onSwitchToOutline && (
          <button
            type="button"
            className="sidebar-tab-btn"
            onClick={onSwitchToOutline}
          >
            Outline
          </button>
        )}
      </div>

      <ul className="focus-thumbnail-list">
        {pages.map((idx) => {
          if (shouldVirtualizeDom && (idx < minDomIdx || idx > maxDomIdx)) {
            return (
              <li
                key={idx}
                className="focus-thumbnail-spacer"
                style={{ height: "126px" }}
                aria-hidden="true"
              />
            );
          }

          const isCurrent = idx === currentPage;
          const thumbUrl = thumbnails[idx];
          return (
            <li key={idx}>
              <button
                type="button"
                className={`focus-thumbnail-card ${isCurrent ? "active" : ""}`}
                onClick={() => onSelectPage(idx)}
                aria-current={isCurrent ? "page" : undefined}
              >
                <span className="focus-thumbnail-number">{idx + 1}</span>
                <div
                  className={`focus-thumbnail-preview ${
                    thumbUrl
                      ? "rendered-thumb-sheet"
                      : idx === 0
                        ? "cover-sheet"
                        : isCurrent
                          ? "current-sheet"
                          : ""
                  }`}
                >
                  {thumbUrl ? (
                    <img
                      src={thumbUrl}
                      alt={`Thumbnail for page ${idx + 1}`}
                      className="focus-thumbnail-image"
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        display: "block",
                        borderRadius: "4px",
                      }}
                    />
                  ) : idx === 0 ? (
                    <>
                      <span className="thumb-cover-heading">
                        {cleanCoverTitle}
                      </span>
                      <span className="thumb-cover-dot" />
                    </>
                  ) : (
                    <>
                      <span className="thumb-sheet-tag">
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                      <span className="thumb-sheet-line" />
                      <span className="thumb-sheet-line" />
                      <span className="thumb-sheet-line short" />
                      <span className="thumb-sheet-caption">
                        Page {idx + 1}
                      </span>
                    </>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
