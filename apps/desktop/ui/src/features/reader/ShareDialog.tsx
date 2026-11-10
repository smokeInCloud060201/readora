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
  const title = descriptor.metadata.title || descriptor.file_name;
  const localShareUri = `readora://document/${descriptor.id}`;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Share Document Dialog"
    >
      <div className="share-dialog-shell">
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

        <div className="share-dialog-section">
          <p className="share-section-heading">Local document reference</p>
          <p className="share-section-sub">
            Copy a local Readora deep link to open this document directly on your
            workstation.
          </p>

          <div className="share-link-box">
            <span className="share-link-text" data-testid="share-uri-value">
              {localShareUri}
            </span>
            <button
              type="button"
              className="focus-btn primary compact"
              onClick={() => onCopyShareLink(localShareUri)}
            >
              Copy link
            </button>
          </div>
        </div>

        <div className="preferences-divider" />

        <div className="share-toggle-row">
          <div>
            <p className="share-section-heading">Share annotations</p>
            <p className="share-section-sub">
              Include your highlights and comments.
            </p>
          </div>
          <input
            type="checkbox"
            aria-label="Include your highlights and comments"
            checked={includeAnnotations}
            onChange={(e) => setIncludeAnnotations(e.target.checked)}
          />
        </div>

        <div className="share-export-section">
          <p className="share-section-heading">Export instead</p>
          <div className="share-dialog-footer">
            <button
              type="button"
              className="focus-btn secondary"
              onClick={() => onExportAnnotations(includeAnnotations)}
            >
              Export annotated PDF
            </button>
            <button
              type="button"
              className="focus-btn secondary"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
