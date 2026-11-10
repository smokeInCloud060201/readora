import React from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { ReadoraLogo } from "../../shared/components/ReadoraLogo";

interface UpdateDialogProps {
  version?: string;
  sizeLabel?: string;
  onConfirmInstall: (version: string) => void;
  onClose: () => void;
}

export const UpdateDialog: React.FC<UpdateDialogProps> = ({
  version = "1.1.0",
  sizeLabel = "42 MB · Downloaded and verified",
  onConfirmInstall,
  onClose,
}) => {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Update Available Dialog"
    >
      <div className="update-dialog-card" data-node-id="16:342">
        <button
          type="button"
          className="icon-close-btn update-dialog-close"
          onClick={onClose}
          aria-label="Close update dialog"
        >
          <FocusIcon name="close" size={16} />
        </button>

        <div className="update-app-mark-well" data-node-id="16:344">
          <ReadoraLogo size={62} />
        </div>

        <p className="eyebrow-label update-eyebrow" data-node-id="16:349">
          UPDATE AVAILABLE
        </p>
        <h2 className="update-dialog-title" data-node-id="16:350">
          Focus Reader 1.1 is ready
        </h2>
        <p className="update-dialog-subtitle" data-node-id="16:351">
          A faster reader, improved annotations, and accessibility updates are
          ready to install.
        </p>

        <div className="update-version-status-box" data-node-id="16:352">
          <div className="update-version-info">
            <span className="update-version-number" data-node-id="16:353">
              Version {version}
            </span>
            <span className="update-version-meta" data-node-id="16:354">
              {sizeLabel}
            </span>
          </div>
          <span className="update-verified-mark" aria-label="Verified">
            <FocusIcon name="check" size={16} />
          </span>
        </div>

        <div className="update-dialog-actions">
          <button
            type="button"
            className="focus-btn secondary"
            onClick={onClose}
          >
            Later
          </button>
          <button
            type="button"
            className="focus-btn primary"
            onClick={() => onConfirmInstall(version)}
          >
            Restart and install
          </button>
        </div>
      </div>
    </div>
  );
};
