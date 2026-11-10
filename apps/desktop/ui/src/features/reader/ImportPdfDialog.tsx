import React, { useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";

interface ImportPdfDialogProps {
  onImportPath: (path: string) => void;
  onOpenSample: () => void;
  onClose: () => void;
}

export const ImportPdfDialog: React.FC<ImportPdfDialogProps> = ({
  onImportPath,
  onOpenSample,
  onClose,
}) => {
  const [filePath, setFilePath] = useState("/samples/Readora-Welcome-Guide.pdf");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = filePath.trim();
    if (trimmed) {
      onImportPath(trimmed);
      onClose();
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Import PDF Dialog"
    >
      <div className="import-pdf-dialog-shell">
        <button
          type="button"
          className="icon-close-btn import-close-btn"
          onClick={onClose}
          aria-label="Close import dialog"
        >
          <FocusIcon name="close" size={16} />
        </button>

        <div className="import-pdf-badge-box" aria-hidden="true">
          <span className="import-pdf-badge-label">PDF</span>
        </div>

        <p className="eyebrow-label">ADD TO YOUR LIBRARY</p>
        <h2 className="import-pdf-title">Open a PDF document</h2>
        <p className="import-pdf-subtitle">
          Drag and drop a file here, or choose one from your computer.
        </p>

        <form onSubmit={handleSubmit} className="import-pdf-form">
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            placeholder="/path/to/document.pdf"
            aria-label="PDF file path to import"
            className="focus-input"
          />

          <div className="import-pdf-actions">
            <button type="submit" className="focus-btn primary">
              Choose PDF file
            </button>
            <button
              type="button"
              className="focus-btn secondary"
              onClick={() => {
                onOpenSample();
                onClose();
              }}
            >
              Open Sample Guide
            </button>
          </div>
        </form>

        <p className="import-pdf-footnote">PDF · Maximum file size 500 MB</p>
      </div>
    </div>
  );
};
