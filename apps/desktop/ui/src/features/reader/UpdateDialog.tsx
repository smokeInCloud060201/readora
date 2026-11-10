import React from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { ReadoraLogo } from "../../shared/components/ReadoraLogo";
import type { AppUpdateStatusDto } from "../../types/ipc";

interface UpdateDialogProps {
  updateStatus: AppUpdateStatusDto;
  onConfirmInstall: (version: string) => void;
  onDismiss: (version: string) => void;
  onCheckAgain: () => void;
  onClose: () => void;
}

function formatPackageMeta(status: AppUpdateStatusDto): string {
  if (!status.update_available) {
    return status.staged_for_restart
      ? "Staged to apply on next application restart"
      : "Installed and verified";
  }
  const sizeBytes = status.package_size_bytes ?? 0;
  const mb = Math.max(1, Math.round(sizeBytes / (1024 * 1024)));
  const verificationLabel = status.verified
    ? "Downloaded and verified"
    : "Pending checksum verification";
  return `${mb} MB · ${verificationLabel}`;
}

export const UpdateDialog: React.FC<UpdateDialogProps> = ({
  updateStatus,
  onConfirmInstall,
  onDismiss,
  onCheckAgain,
  onClose,
}) => {
  const targetVersion =
    updateStatus.latest_version ?? updateStatus.current_version;
  const isAvailable = updateStatus.update_available;
  const titleText = isAvailable
    ? (updateStatus.release_title ??
      `Focus Reader ${targetVersion} is ready`)
    : `Focus Reader ${updateStatus.current_version} is up to date`;
  const subtitleText = isAvailable
    ? (updateStatus.release_notes ??
      `Version ${targetVersion} has been verified and is ready to install.`)
    : `You are running the latest verified build of Focus Reader (${updateStatus.current_version}).`;
  const metaLabel = formatPackageMeta(updateStatus);

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
          {isAvailable ? "UPDATE AVAILABLE" : "SOFTWARE UPDATE"}
        </p>
        <h2 className="update-dialog-title" data-node-id="16:350">
          {titleText}
        </h2>
        <p className="update-dialog-subtitle" data-node-id="16:351">
          {subtitleText}
        </p>

        <div className="update-version-status-box" data-node-id="16:352">
          <div className="update-version-info">
            <span className="update-version-number" data-node-id="16:353">
              Version {targetVersion}
            </span>
            <span className="update-version-meta" data-node-id="16:354">
              {metaLabel}
            </span>
          </div>
          {updateStatus.verified && (
            <span className="update-verified-mark" aria-label="Verified">
              <FocusIcon name="check" size={16} />
            </span>
          )}
        </div>

        <div className="update-dialog-actions">
          {isAvailable ? (
            <>
              <button
                type="button"
                className="focus-btn secondary"
                onClick={() => onDismiss(targetVersion)}
              >
                Later
              </button>
              <button
                type="button"
                className="focus-btn primary"
                onClick={() => onConfirmInstall(targetVersion)}
              >
                Restart and install
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="focus-btn secondary"
                onClick={onCheckAgain}
              >
                Check again
              </button>
              <button
                type="button"
                className="focus-btn primary"
                onClick={onClose}
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
