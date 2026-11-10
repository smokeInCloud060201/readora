import React from "react";

interface ThumbnailsPanelProps {
  pageCount: number;
  currentPage: number;
  onSelectPage: (zeroBasedPage: number) => void;
  onSwitchToOutline?: () => void;
}

export const ThumbnailsPanel: React.FC<ThumbnailsPanelProps> = ({
  pageCount,
  currentPage,
  onSelectPage,
  onSwitchToOutline,
}) => {
  const pages = Array.from({ length: pageCount }, (_, i) => i);

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
                    idx === 0 ? "cover-sheet" : isCurrent ? "current-sheet" : ""
                  }`}
                >
                  {idx === 0 ? (
                    <>
                      <span className="thumb-cover-heading">
                        FIELD
                        <br />
                        NOTES
                      </span>
                      <span className="thumb-cover-dot" />
                    </>
                  ) : (
                    <>
                      <span className="thumb-sheet-tag">
                        0{Math.min(9, idx)}
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
