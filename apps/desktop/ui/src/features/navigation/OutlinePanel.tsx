import React from "react";
import { type OutlineNodeDto } from "../../types/ipc";

interface OutlinePanelProps {
  outline: OutlineNodeDto[];
  currentPage: number;
  onSelectPage: (zeroBasedPage: number) => void;
  onSwitchToPages?: () => void;
}

export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  outline,
  currentPage,
  onSelectPage,
  onSwitchToPages,
}) => {
  return (
    <aside className="page-sidebar-panel" aria-label="Document Outline">
      <div className="sidebar-tabs-header">
        {onSwitchToPages && (
          <button
            type="button"
            className="sidebar-tab-btn"
            onClick={onSwitchToPages}
          >
            Pages
          </button>
        )}
        <button
          type="button"
          className="sidebar-tab-btn active"
          aria-current="true"
        >
          Outline
        </button>
      </div>

      {outline.length === 0 ? (
        <p className="sidebar-empty">No outline entries in this PDF.</p>
      ) : (
        <ul className="focus-outline-list">
          {outline.map((item, idx) => {
            const isCurrent = item.page_index === currentPage;
            return (
              <li key={`${item.title}-${idx}`} className="focus-outline-row">
                <button
                  type="button"
                  className={`focus-outline-btn ${isCurrent ? "active" : ""}`}
                  onClick={() => {
                    if (item.page_index !== null) {
                      onSelectPage(item.page_index);
                    }
                  }}
                >
                  <span className="focus-outline-title">{item.title}</span>
                  {item.page_index !== null && (
                    <span className="focus-outline-page">
                      {item.page_index + 1}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
};
