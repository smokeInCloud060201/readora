import React, { useEffect, useState } from "react";
import { readoraApi } from "../../lib/tauri/client";

interface ThumbnailsPanelProps {
  documentId?: string;
  documentTitle?: string;
  pageCount: number;
  currentPage: number;
  onSelectPage: (zeroBasedPage: number) => void;
  onSwitchToOutline?: () => void;
}

export const ThumbnailsPanel: React.FC<ThumbnailsPanelProps> = ({
  documentId,
  documentTitle,
  pageCount,
  currentPage,
  onSelectPage,
  onSwitchToOutline,
}) => {
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const pages = Array.from({ length: pageCount }, (_, i) => i);

  useEffect(() => {
    if (!documentId) {
      setThumbnails({});
      return;
    }
    let cancelled = false;
    const maxPreviewPages = Math.min(pageCount, 24);

    void (async () => {
      for (let idx = 0; idx < maxPreviewPages; idx += 1) {
        if (cancelled) break;
        try {
          const rendered = await readoraApi.renderPage({
            document_id: documentId,
            page_index: idx,
            scale: 0.35,
            rotation_degrees: 0,
            render_mode: "standard",
            generation: null,
          });
          if (!cancelled) {
            setThumbnails((prev) => ({
              ...prev,
              [idx]: rendered.data_url,
            }));
          }
        } catch {
          // Ignore individual thumbnail render errors
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId, pageCount]);

  const cleanCoverTitle = (documentTitle || "PDF")
    .replace(/\.pdf$/i, "")
    .slice(0, 22)
    .toUpperCase();

  return (
    <aside className="page-sidebar-panel" aria-label="Page Thumbnails">
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
