import React, { useRef, useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";

interface ImportPdfDialogProps {
  onImportPath: (path: string) => void;
  onClose: () => void;
}

export const ImportPdfDialog: React.FC<ImportPdfDialogProps> = ({
  onImportPath,
  onClose,
}) => {
  const [filePath, setFilePath] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const importSelectedFile = (file: File) => {
    const maybeFileWithPath = file as File & { path?: string };
    const resolvedPath =
      typeof maybeFileWithPath.path === "string" &&
      maybeFileWithPath.path.trim().length > 0
        ? maybeFileWithPath.path.trim()
        : `/documents/${file.name}`;
    onImportPath(resolvedPath);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = filePath.trim();
    if (trimmed) {
      onImportPath(trimmed);
      onClose();
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      importSelectedFile(droppedFile);
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

        <form onSubmit={handleSubmit} className="import-pdf-form">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="sr-only"
            aria-label="Choose local PDF file"
            onChange={(e) => {
              const selected = e.target.files?.[0];
              if (selected) {
                importSelectedFile(selected);
              }
            }}
          />

          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            placeholder="/path/to/document.pdf"
            aria-label="PDF file path to import"
            className="focus-input import-pdf-path-input"
          />

          <div className="import-pdf-actions">
            <button
              type="submit"
              className="focus-btn primary import-choose-btn"
              data-node-id="5:267"
            >
              Choose PDF file
            </button>
          </div>
        </form>

        <p className="import-pdf-footnote" data-node-id="5:269">
          PDF · Maximum file size 500 MB
        </p>
      </div>
    </div>
  );
};
