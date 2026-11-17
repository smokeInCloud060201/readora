import React from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { type AnnotationKind } from "../../types/ipc";

export const MAX_HIGHLIGHT_EXCERPT_LEN = 400;
export const MAX_ANNOTATION_NOTE_LEN = 4000;

export function sliceByUnicodeCodePoints(
  text: string,
  maxCodePoints = MAX_ANNOTATION_NOTE_LEN,
): string {
  return Array.from(text).slice(0, maxCodePoints).join("");
}

export const HIGHLIGHT_SWATCHES = [
  { id: "amber", label: "Amber", hex: "#f3d96b" },
  { id: "coral", label: "Coral", hex: "#f0a88f" },
  { id: "sage", label: "Sage", hex: "#a9d5b2" },
  { id: "sky", label: "Sky", hex: "#9bc8e0" },
  { id: "lavender", label: "Lavender", hex: "#c9afe2" },
] as const;

function isNodeInsideReaderStage(node: Node | null | undefined): boolean {
  if (!node) {
    return false;
  }
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(".reader-stage"));
}

export function getWindowSelectedText(): string {
  if (
    typeof window === "undefined" ||
    typeof window.getSelection !== "function"
  ) {
    return "";
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed === true) {
    return "";
  }
  if (!isNodeInsideReaderStage(selection.anchorNode)) {
    return "";
  }
  if (selection.focusNode && !isNodeInsideReaderStage(selection.focusNode)) {
    return "";
  }
  return selection.toString().trim();
}

export function buildSafeQuoteExcerpt(
  pageText: string,
  currentPage: number,
  maxLen = MAX_HIGHLIGHT_EXCERPT_LEN,
): string {
  const selected = getWindowSelectedText();
  const raw =
    selected || pageText.trim() || `Page ${currentPage + 1} excerpt`;
  return sliceByUnicodeCodePoints(raw, maxLen);
}

interface FloatingAnnotationToolsProps {
  currentPage: number;
  pageText: string;
  showHighlightPopover: boolean;
  setShowHighlightPopover: React.Dispatch<React.SetStateAction<boolean>>;
  selectedColor: string;
  setSelectedColor: React.Dispatch<React.SetStateAction<string>>;
  underlineInstead: boolean;
  setUnderlineInstead: React.Dispatch<React.SetStateAction<boolean>>;
  highlightPopoverRef: React.RefObject<HTMLDivElement | null>;
  floatingToolsRef: React.RefObject<HTMLDivElement | null>;
  onCopyText: () => void;
  onQuickAddNote?: () => void;
  onCreateAnnotation?: (
    kind: AnnotationKind,
    colorHex: string,
    quoteText: string,
    noteText: string,
  ) => void;
}

export const FloatingAnnotationTools: React.FC<
  FloatingAnnotationToolsProps
> = ({
  currentPage,
  pageText,
  showHighlightPopover,
  setShowHighlightPopover,
  selectedColor,
  setSelectedColor,
  underlineInstead,
  setUnderlineInstead,
  highlightPopoverRef,
  floatingToolsRef,
  onCopyText,
  onQuickAddNote,
  onCreateAnnotation,
}) => {
  return (
    <>
      {showHighlightPopover && (
        <div
          ref={highlightPopoverRef}
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
                    const safeExcerpt = buildSafeQuoteExcerpt(
                      pageText,
                      currentPage,
                    );
                    onCreateAnnotation(
                      underlineInstead ? "underline" : "highlight",
                      selectedColor,
                      safeExcerpt,
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

      <div
        ref={floatingToolsRef}
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
    </>
  );
};
