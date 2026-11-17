import React, { useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { useModalDialog } from "../../shared/hooks/useModalDialog";
import {
  type DocumentDescriptorDto,
  type RenderedPageResultDto,
  type ViewStateDto,
} from "../../types/ipc";

interface PrintDialogProps {
  descriptor: DocumentDescriptorDto;
  viewState: ViewStateDto;
  renderedPage: RenderedPageResultDto | null;
  onClose: () => void;
  onExecutePrint?: (
    pageIndices: number[],
    summary: string,
    includeAnnotations: boolean,
  ) => Promise<void>;
  onConfirmPrint?: (summary: string, includeAnnotations: boolean) => void;
}

const PAGE_RANGE_PATTERN =
  /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;

export function validateCustomPageRange(
  rawInput: string,
  pageCount: number,
): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed || !PAGE_RANGE_PATTERN.test(trimmed)) {
    return `Enter valid page numbers between 1 and ${pageCount} (e.g. 1-${Math.min(3, pageCount)}).`;
  }
  const segments = trimmed.split(",");
  for (const segment of segments) {
    const parts = segment.trim().split("-");
    const start = Number.parseInt(parts[0] ?? "", 10);
    const end =
      parts.length > 1 ? Number.parseInt(parts[1] ?? "", 10) : start;
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 1 ||
      end < 1 ||
      start > pageCount ||
      end > pageCount ||
      start > end
    ) {
      return `Page range must stay within 1–${pageCount}.`;
    }
  }
  return null;
}

export function resolvePrintPageIndices(
  pageScope: "all" | "current" | "range",
  currentPage: number,
  pageCount: number,
  rawRange: string,
): number[] {
  if (pageScope === "current") {
    return [Math.min(Math.max(0, currentPage), Math.max(0, pageCount - 1))];
  }
  if (pageScope === "all") {
    return Array.from({ length: pageCount }, (_, idx) => idx);
  }
  const indices = new Set<number>();
  for (const segment of rawRange.trim().split(",")) {
    const parts = segment.trim().split("-");
    const start = Number.parseInt(parts[0] ?? "", 10);
    const end =
      parts.length > 1 ? Number.parseInt(parts[1] ?? "", 10) : start;
    if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end) {
      for (let p = start; p <= end; p += 1) {
        if (p >= 1 && p <= pageCount) {
          indices.add(p - 1);
        }
      }
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}

export const PrintDialog: React.FC<PrintDialogProps> = ({
  descriptor,
  viewState,
  renderedPage,
  onClose,
  onExecutePrint,
  onConfirmPrint,
}) => {
  const [printer, setPrinter] = useState("Default Printer");
  const [copies, setCopies] = useState(1);
  const [pageScope, setPageScope] = useState<"all" | "current" | "range">("all");
  const [pageRangeInput, setPageRangeInput] = useState(
    `1-${descriptor.page_count}`,
  );
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [isPreparingPrint, setIsPreparingPrint] = useState(false);
  const { dialogRef, handleBackdropMouseDown } = useModalDialog(() => {
    if (!isPreparingPrint) {
      onClose();
    }
  });

  const handlePrint = (e: React.FormEvent) => {
    e.preventDefault();
    if (isPreparingPrint) {
      return;
    }
    if (pageScope === "range") {
      const validationMessage = validateCustomPageRange(
        pageRangeInput,
        descriptor.page_count,
      );
      if (validationMessage) {
        setRangeError(validationMessage);
        return;
      }
    }
    setRangeError(null);
    const scopeLabel =
      pageScope === "all"
        ? `all ${descriptor.page_count} pages`
        : pageScope === "current"
          ? `page ${viewState.current_page + 1}`
          : `pages ${pageRangeInput.trim()}`;
    const annotationsLabel = includeAnnotations
      ? "with annotations"
      : "without annotations";
    const summary = `Sent ${descriptor.file_name} (${scopeLabel}, ${copies} cop${
      copies === 1 ? "y" : "ies"
    }, ${annotationsLabel}) to ${printer}`;
    const pageIndices = resolvePrintPageIndices(
      pageScope,
      viewState.current_page,
      descriptor.page_count,
      pageRangeInput,
    );

    if (onExecutePrint) {
      setIsPreparingPrint(true);
      void (async () => {
        try {
          await onExecutePrint(pageIndices, summary, includeAnnotations);
        } finally {
          setIsPreparingPrint(false);
        }
      })();
      return;
    }

    onConfirmPrint?.(summary, includeAnnotations);
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Print Document Dialog"
      onMouseDown={handleBackdropMouseDown}
    >
      <div ref={dialogRef} tabIndex={-1} className="print-dialog-card">
        <div className="print-dialog-header">
          <div>
            <p className="eyebrow-label">PRINT</p>
            <h2 className="print-dialog-title">
              {descriptor.metadata.title || descriptor.file_name}
            </h2>
          </div>
          <button
            type="button"
            className="icon-close-btn"
            disabled={isPreparingPrint}
            onClick={onClose}
            aria-label="Close print dialog"
          >
            <FocusIcon name="close" size={16} />
          </button>
        </div>

        <form onSubmit={handlePrint} className="print-dialog-body">
          <div className="print-preview-box" aria-label="Print Preview">
            <div className="print-preview-sheet">
              {renderedPage ? (
                <img
                  src={renderedPage.data_url}
                  alt={`Print preview of page ${viewState.current_page + 1}`}
                  className="print-preview-img"
                />
              ) : (
                <div className="print-preview-lines">
                  <span className="preview-line title" />
                  <span className="preview-line" />
                  <span className="preview-line short" />
                </div>
              )}
            </div>
            <span className="print-preview-caption">
              Page {viewState.current_page + 1} of {descriptor.page_count} ·{" "}
              {includeAnnotations ? "Annotations included" : "Clean page only"}
            </span>
          </div>

          <div className="print-settings-column">
            <div className="print-field-group">
              <label htmlFor="print-printer-select" className="print-label">
                Printer
              </label>
              <select
                id="print-printer-select"
                value={printer}
                onChange={(e) => setPrinter(e.target.value)}
                className="focus-select full-width"
              >
                <option value="Default Printer">Default Printer</option>
                <option value="Save as Local PDF">Save as Local PDF</option>
              </select>
            </div>

            <div className="print-field-group">
              <span className="print-label">Copies</span>
              <div className="print-copies-box">
                <span data-testid="print-copies-value">{copies}</span>
                <div className="print-copies-stepper">
                  <button
                    type="button"
                    className="focus-icon-btn"
                    onClick={() => setCopies((c) => Math.max(1, c - 1))}
                    aria-label="Decrease copies"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="focus-icon-btn"
                    onClick={() => setCopies((c) => Math.min(99, c + 1))}
                    aria-label="Increase copies"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            <div className="print-field-group">
              <span className="print-label">Pages</span>
              <div
                className="print-radio-list"
                role="radiogroup"
                aria-label="Pages to print"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={pageScope === "all"}
                  className={`print-radio-row ${
                    pageScope === "all" ? "selected" : ""
                  }`}
                  onClick={() => {
                    setPageScope("all");
                    setRangeError(null);
                  }}
                >
                  <span>
                    {pageScope === "all" ? "●" : "○"} &nbsp; All{" "}
                    {descriptor.page_count} pages
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={pageScope === "current"}
                  className={`print-radio-row ${
                    pageScope === "current" ? "selected" : ""
                  }`}
                  onClick={() => {
                    setPageScope("current");
                    setRangeError(null);
                  }}
                >
                  <span>
                    {pageScope === "current" ? "●" : "○"} &nbsp; Current page
                    (page {viewState.current_page + 1})
                  </span>
                </button>
                <div
                  className={`print-range-option ${
                    pageScope === "range" ? "selected" : ""
                  }`}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={pageScope === "range"}
                    className={`print-radio-row ${
                      pageScope === "range" ? "selected" : ""
                    }`}
                    onClick={() => {
                      setPageScope("range");
                      setRangeError(null);
                    }}
                  >
                    <span>
                      {pageScope === "range" ? "●" : "○"} &nbsp; Range…
                    </span>
                  </button>
                  {pageScope === "range" && (
                    <input
                      type="text"
                      value={pageRangeInput}
                      onChange={(e) => {
                        setPageRangeInput(e.target.value);
                        if (rangeError) {
                          setRangeError(null);
                        }
                      }}
                      aria-label="Custom page range"
                      aria-invalid={Boolean(rangeError)}
                      className="focus-input compact"
                    />
                  )}
                </div>
              </div>
              {rangeError && (
                <p className="print-validation-error" role="alert">
                  {rangeError}
                </p>
              )}
            </div>

            <div className="print-toggle-row">
              <span className="print-label">Include annotations</span>
              <button
                type="button"
                role="switch"
                aria-checked={includeAnnotations}
                aria-label="Include annotations"
                className={`focus-switch ${includeAnnotations ? "on" : ""}`}
                onClick={() => setIncludeAnnotations((v) => !v)}
              >
                <span className="focus-switch-thumb" />
              </button>
            </div>

            <div className="print-dialog-actions">
              <button
                type="button"
                className="focus-btn secondary"
                disabled={isPreparingPrint}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="focus-btn primary"
                disabled={isPreparingPrint}
              >
                {isPreparingPrint ? "Preparing pages..." : "Print"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
