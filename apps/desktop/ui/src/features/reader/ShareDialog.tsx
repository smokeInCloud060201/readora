import React, { useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { useModalDialog } from "../../shared/hooks/useModalDialog";
import { type DocumentDescriptorDto } from "../../types/ipc";

interface ShareDialogProps {
  descriptor: DocumentDescriptorDto;
  onExportAnnotations: (includeAnnotations: boolean) => void;
  onCopyShareLink: (citation: string) => void;
  onClose: () => void;
}

export const ShareDialog: React.FC<ShareDialogProps> = ({
  descriptor,
  onExportAnnotations,
  onCopyShareLink,
  onClose,
}) => {
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [copied, setCopied] = useState(false);
  const { dialogRef, handleBackdropMouseDown } = useModalDialog(onClose);
  const title = descriptor.metadata.title || descriptor.file_name;
  const localCitation = `${descriptor.file_name} (Document ID: ${descriptor.id})`;

  const handleCopy = () => {
    onCopyShareLink(localCitation);
    setCopied(true);
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Share Document Dialog"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="share-dialog-shell"
        data-node-id="7:351"
      >
        <div className="share-dialog-header">
          <div>
            <p className="eyebrow-label">SHARE &amp; EXPORT</p>
            <h2 className="share-dialog-title">Share {title}</h2>
          </div>
          <button
            type="button"
            className="icon-close-btn"
            onClick={onClose}
            aria-label="Close share dialog"
          >
            <FocusIcon name="close" size={16} />
          </button>
        </div>

        <div className="share-doc-summary-card">
          <span className="pdf-badge">PDF</span>
          <div className="share-doc-summary-meta">
            <span className="share-doc-summary-name">
              {descriptor.file_name}
            </span>
            <span className="share-doc-summary-sub">
              {descriptor.page_count}{" "}
              {descriptor.page_count === 1 ? "page" : "pages"} · Local document
            </span>
          </div>
        </div>

        <div className="share-dialog-section">
          <div className="share-section-copy">
            <p className="share-section-heading">Document citation</p>
            <p className="share-section-sub">
              Copy a local Markdown citation and document identifier for your
              reading notes.
            </p>
          </div>

          <div className="share-link-box">
            <span className="share-link-text" data-testid="share-uri-value">
              {localCitation}
            </span>
            <button
              type="button"
              className="focus-btn primary compact share-copy-btn"
              onClick={handleCopy}
            >
              {copied ? "Copied" : "Copy citation"}
            </button>
          </div>
        </div>

        <div className="preferences-divider" />

        <div className="share-toggle-row">
          <div className="share-section-copy">
            <p className="share-section-heading">Include annotations</p>
            <p className="share-section-sub">
              Include your highlights and comments in the exported Markdown
              bundle.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={includeAnnotations}
            aria-label="Include your highlights and comments"
            className={`focus-switch ${includeAnnotations ? "on" : ""}`}
            onClick={() => setIncludeAnnotations((v) => !v)}
          >
            <span className="focus-switch-thumb" />
          </button>
        </div>

        <div className="preferences-divider" />

        <div className="share-export-section">
          <div className="share-section-copy">
            <p className="share-section-heading">Export reading notes</p>
            <p className="share-section-sub">
              Download your bookmarks, highlights, and comments as a Markdown
              file (<code>.md</code>).
            </p>
          </div>
          <div className="share-dialog-footer">
            <button
              type="button"
              className="focus-btn secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="focus-btn primary"
              aria-label="Export reading notes as Markdown"
              onClick={() => onExportAnnotations(includeAnnotations)}
            >
              Export notes (.md)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
