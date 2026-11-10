import React, { useState } from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { type DocumentDescriptorDto } from "../../types/ipc";

interface ShareDialogProps {
  descriptor: DocumentDescriptorDto;
  onExportAnnotations: (includeAnnotations: boolean) => void;
  onCopyShareLink: (shareUri: string) => void;
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
  const title = descriptor.metadata.title || descriptor.file_name;
  const localShareUri = `readora://document/${descriptor.id}`;

  const handleCopy = () => {
    onCopyShareLink(localShareUri);
    setCopied(true);
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Share Document Dialog"
    >
      <div className="share-dialog-shell" data-node-id="7:351">
        <div className="share-dialog-header">
          <div>
            <p className="eyebrow-label">SHARE DOCUMENT</p>
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
            <span className="share-doc-summary-name">{descriptor.file_name}</span>
            <span className="share-doc-summary-sub">
              {descriptor.page_count} {descriptor.page_count === 1 ? "page" : "pages"} · Local document
            </span>
          </div>
        </div>

        <div className="share-dialog-section">
          <div className="share-section-copy">
            <p className="share-section-heading">Local document reference</p>
            <p className="share-section-sub">
              Copy a local Readora deep link to open this document directly on your
              workstation.
            </p>
          </div>

          <div className="share-link-box">
            <span className="share-link-text" data-testid="share-uri-value">
              {localShareUri}
            </span>
            <button
              type="button"
              className="focus-btn primary compact share-copy-btn"
              onClick={handleCopy}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>

        <div className="preferences-divider" />

        <div className="share-toggle-row">
          <div className="share-section-copy">
            <p className="share-section-heading">Share annotations</p>
            <p className="share-section-sub">
              Include your highlights and comments.
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
            <p className="share-section-heading">Export instead</p>
            <p className="share-section-sub">
              Export your bookmarks, highlights, and reading notes to a local file.
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
              onClick={() => onExportAnnotations(includeAnnotations)}
            >
              Export annotated PDF
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
