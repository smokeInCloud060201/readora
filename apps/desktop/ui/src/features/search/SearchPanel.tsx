import React, { useState } from "react";
import { type SearchHitDto } from "../../types/ipc";

interface SearchPanelProps {
  hits: SearchHitDto[];
  onSearch: (query: string, caseSensitive: boolean) => void;
  onSelectHit: (zeroBasedPage: number) => void;
  onClose?: () => void;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({
  hits,
  onSearch,
  onSelectHit,
  onClose,
}) => {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeHitIdx, setActiveHitIdx] = useState(0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveHitIdx(0);
    onSearch(query, caseSensitive);
  };

  const stepHit = (delta: number) => {
    if (hits.length === 0) return;
    const nextIdx = (activeHitIdx + delta + hits.length) % hits.length;
    setActiveHitIdx(nextIdx);
    const target = hits[nextIdx];
    if (target) {
      onSelectHit(target.page_index);
    }
  };

  return (
    <aside className="search-popover-panel" aria-label="Find in Document">
      <form onSubmit={handleSubmit} className="search-popover-bar">
        <span className="search-popover-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search in document..."
          aria-label="Search query"
          className="search-popover-input"
        />
        <span className="search-hit-counter">
          {hits.length > 0 ? `${activeHitIdx + 1} / ${hits.length}` : "0 / 0"}
        </span>
        <button
          type="submit"
          className="focus-btn primary compact"
        >
          Search
        </button>
        <button
          type="button"
          className="search-step-btn"
          onClick={() => stepHit(-1)}
          disabled={hits.length === 0}
          aria-label="Previous search match"
        >
          ‹
        </button>
        <button
          type="button"
          className="search-step-btn"
          onClick={() => stepHit(1)}
          disabled={hits.length === 0}
          aria-label="Next search match"
        >
          ›
        </button>
        {onClose && (
          <button
            type="button"
            className="search-step-btn"
            onClick={onClose}
            aria-label="Close search popover"
          >
            ×
          </button>
        )}
      </form>

      <div className="search-popover-options">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          <span>Case-sensitive</span>
        </label>
      </div>

      {hits.length === 0 ? (
        <p className="search-empty-note">No search matches to display.</p>
      ) : (
        <ul className="search-hits-list">
          {hits.map((hit, idx) => (
            <li key={`${hit.page_index}-${hit.match_index}-${idx}`}>
              <button
                type="button"
                className={`search-hit-item ${
                  idx === activeHitIdx ? "active" : ""
                }`}
                onClick={() => {
                  setActiveHitIdx(idx);
                  onSelectHit(hit.page_index);
                }}
              >
                <span className="hit-snippet">{hit.snippet}</span>
                <span className="page-pill">p. {hit.page_index + 1}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
};
