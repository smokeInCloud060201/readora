import React, { useEffect, useRef, useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { type SearchHitDto } from "../../types/ipc";

interface SearchPanelProps {
  hits: SearchHitDto[];
  activeHitIndex?: number;
  onActiveHitChange?: (idx: number) => void;
  onSearch: (query: string, caseSensitive: boolean) => void;
  onSelectHit: (zeroBasedPage: number) => void;
  onClose?: () => void;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({
  hits,
  activeHitIndex = 0,
  onActiveHitChange,
  onSearch,
  onSelectHit,
  onClose,
}) => {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [internalHitIdx, setInternalHitIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastSearchedRef = useRef<{ query: string; caseSensitive: boolean }>({
    query: "",
    caseSensitive: false,
  });

  useEffect(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const currentHitIdx =
    hits.length > 0
      ? Math.min(
          onActiveHitChange ? activeHitIndex : internalHitIdx,
          hits.length - 1,
        )
      : 0;

  const updateActiveHitIdx = (idx: number) => {
    setInternalHitIdx(idx);
    onActiveHitChange?.(idx);
  };

  useEffect(() => {
    const trimmed = query.trim();
    if (
      lastSearchedRef.current.query === trimmed &&
      lastSearchedRef.current.caseSensitive === caseSensitive
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      lastSearchedRef.current = { query: trimmed, caseSensitive };
      updateActiveHitIdx(0);
      onSearch(query, caseSensitive);
    }, 120);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, caseSensitive]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (
      trimmed.length > 0 &&
      lastSearchedRef.current.query === trimmed &&
      lastSearchedRef.current.caseSensitive === caseSensitive &&
      hits.length > 0
    ) {
      stepHit(1);
      return;
    }
    lastSearchedRef.current = { query: trimmed, caseSensitive };
    updateActiveHitIdx(0);
    onSearch(query, caseSensitive);
  };

  const stepHit = (delta: number) => {
    if (hits.length === 0) return;
    const nextIdx = (currentHitIdx + delta + hits.length) % hits.length;
    updateActiveHitIdx(nextIdx);
    const target = hits[nextIdx];
    if (target) {
      onSelectHit(target.page_index);
    }
  };

  return (
    <aside className="search-popover-panel" aria-label="Find in Document">
      <form onSubmit={handleSubmit} className="search-popover-bar">
        <span className="search-popover-icon" aria-hidden="true">
          <FocusIcon name="search" size={14} />
        </span>
        <input
          ref={searchInputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && onClose) {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === "Enter" && e.shiftKey && hits.length > 0) {
              e.preventDefault();
              stepHit(-1);
            }
          }}
          placeholder="Search in document..."
          aria-label="Search query"
          className="search-popover-input"
        />
        <span className="search-hit-counter" data-testid="search-hit-counter">
          {hits.length > 0 ? `${currentHitIdx + 1} / ${hits.length}` : "0 / 0"}
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
          <FocusIcon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          className="search-step-btn"
          onClick={() => stepHit(1)}
          disabled={hits.length === 0}
          aria-label="Next search match"
        >
          <FocusIcon name="chevron-right" size={14} />
        </button>
        {onClose && (
          <button
            type="button"
            className="search-step-btn"
            onClick={onClose}
            aria-label="Close search popover"
          >
            <FocusIcon name="close" size={14} />
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
                  idx === currentHitIdx ? "active" : ""
                }`}
                onClick={() => {
                  updateActiveHitIdx(idx);
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
