import React, { useState } from "react";
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
  onConfirmPrint: (summary: string) => void;
}

export const PrintDialog: React.FC<PrintDialogProps> = ({
  descriptor,
  viewState,
  renderedPage,
  onClose,
  onConfirmPrint,
}) => {
  const [printer, setPrinter] = useState("Default Printer");
  const [copies, setCopies] = useState(1);
  const [pageScope, setPageScope] = useState<"all" | "current" | "range">("all");
  const [pageRangeInput, setPageRangeInput] = useState(
    `1-${descriptor.page_count}`,
  );
  const [includeAnnotations, setIncludeAnnotations] = useState(true);

  const handlePrint = (e: React.FormEvent) => {
    e.preventDefault();
    const scopeLabel =
      pageScope === "all"
        ? `all ${descriptor.page_count} pages`
        : pageScope === "current"
          ? `page ${viewState.current_page + 1}`
          : `pages ${pageRangeInput}`;
    onConfirmPrint(
      `Sent ${descriptor.file_name} (${scopeLabel}, ${copies} cop${
        copies === 1 ? "y" : "ies"
      }) to ${printer}`,
    );
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Print Document Dialog"
    >
      <div className="print-dialog-card">
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
            onClick={onClose}
            aria-label="Close print dialog"
          >
            ×
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
              Page {viewState.current_page + 1} of {descriptor.page_count}
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
              <div className="print-radio-list" role="radiogroup" aria-label="Pages to print">
                <button
                  type="button"
                  role="radio"
                  aria-checked={pageScope === "all"}
                  className={`print-radio-row ${
                    pageScope === "all" ? "selected" : ""
                  }`}
                  onClick={() => setPageScope("all")}
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
                  onClick={() => setPageScope("current")}
                >
                  <span>
                    {pageScope === "current" ? "●" : "○"} &nbsp; Current page
                    (page {viewState.current_page + 1})
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={pageScope === "range"}
                  className={`print-radio-row ${
                    pageScope === "range" ? "selected" : ""
                  }`}
                  onClick={() => setPageScope("range")}
                >
                  <span>{pageScope === "range" ? "●" : "○"} &nbsp; Range…</span>
                  {pageScope === "range" && (
                    <input
                      type="text"
                      value={pageRangeInput}
                      onChange={(e) => setPageRangeInput(e.target.value)}
                      aria-label="Custom page range"
                      className="focus-input compact"
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </button>
              </div>
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
                onClick={onClose}
              >
                Cancel
              </button>
              <button type="submit" className="focus-btn primary">
                Print
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
