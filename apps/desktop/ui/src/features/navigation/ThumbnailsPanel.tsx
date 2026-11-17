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
  const pages = Array.from({ length: pageCount }, (_, i) => i);

  useEffect(() => {
    thumbnailsRef.current = {};
    setThumbnails({});
    setScrollCenterPage(currentPage);
  }, [documentId]);

  useEffect(() => {
    setScrollCenterPage(currentPage);
  }, [currentPage]);

  useEffect(() => {
    if (!documentId || pageCount <= 0) {
      thumbnailsRef.current = {};
      setThumbnails({});
      return;
    }

    let cancelled = false;
    const candidateIndices = new Set<number>();
    const currentStart = Math.max(0, currentPage - 8);
    const currentEnd = Math.min(pageCount - 1, currentPage + 12);
    for (let i = currentStart; i <= currentEnd; i += 1) {
      candidateIndices.add(i);
    }

    const scrollStart = Math.max(0, scrollCenterPage - 8);
    const scrollEnd = Math.min(pageCount - 1, scrollCenterPage + 12);
    for (let i = scrollStart; i <= scrollEnd; i += 1) {
      candidateIndices.add(i);
    }

    const ordered = Array.from(candidateIndices).sort(
      (a, b) =>
        Math.abs(a - scrollCenterPage) - Math.abs(b - scrollCenterPage),
    );

    void (async () => {
      for (const idx of ordered) {
        if (cancelled) break;
        if (thumbnailsRef.current[idx] !== undefined) continue;
        try {
          const rendered = await readoraApi.renderPage({
            document_id: documentId,
            page_index: idx,
            scale: 0.35,
            rotation_degrees: 0,
            render_mode: "standard",
            generation: null,
          });
          if (cancelled) break;
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
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentPage, documentId, pageCount, scrollCenterPage]);

  const handlePanelScroll = () => {
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
  const minDomIdx = Math.min(currentPage, scrollCenterPage) - 20;
  const maxDomIdx = Math.max(currentPage, scrollCenterPage) + 25;

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
