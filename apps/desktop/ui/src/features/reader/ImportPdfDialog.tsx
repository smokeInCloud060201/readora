import React, { useRef, useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";

interface ImportPdfDialogProps {
  onImportFile: (file: File) => void;
  onClose: () => void;
}

export const ImportPdfDialog: React.FC<ImportPdfDialogProps> = ({
  onImportFile,
  onClose,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSelectedFile = (file: File) => {
    onImportFile(file);
    onClose();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      handleSelectedFile(droppedFile);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Import PDF Dialog"
    >
      <div
        className={`import-pdf-dialog-shell ${isDragging ? "dragging" : ""}`}
        data-node-id="5:260"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <button
          type="button"
          className="icon-close-btn import-close-btn"
          onClick={onClose}
          aria-label="Close import dialog"
          data-node-id="5:261"
        >
          <FocusIcon name="close" size={16} />
        </button>

        <div
          className="import-pdf-badge-box"
          aria-hidden="true"
          data-node-id="5:262"
        >
          <span className="import-pdf-badge-label">PDF</span>
        </div>

        <p className="eyebrow-label" data-node-id="5:264">
          ADD TO YOUR LIBRARY
        </p>
        <h2 className="import-pdf-title" data-node-id="5:265">
          Open a PDF document
        </h2>
        <p className="import-pdf-subtitle" data-node-id="5:266">
          Drag and drop a file here, or choose one from your computer.
        </p>

        <div className="import-pdf-form">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="sr-only"
            aria-label="Choose local PDF file"
            onChange={(e) => {
              const selected = e.target.files?.[0];
              if (selected) {
                handleSelectedFile(selected);
              }
            }}
          />

          <div className="import-pdf-actions">
            <button
              type="button"
              className="focus-btn primary import-choose-btn"
              onClick={() => fileInputRef.current?.click()}
              data-node-id="5:267"
            >
              Choose PDF file
            </button>
          </div>
        </div>

        <p className="import-pdf-footnote" data-node-id="5:269">
          PDF · Maximum file size 500 MB
        </p>
      </div>
    </div>
  );
};
