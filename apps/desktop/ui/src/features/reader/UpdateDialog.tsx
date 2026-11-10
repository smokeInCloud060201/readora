import React from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";

interface UpdateDialogProps {
  version?: string;
  sizeLabel?: string;
  onConfirmInstall: (version: string) => void;
  onClose: () => void;
}

/**
 * Readora App Mark SVG from Figma Frame `26 · App Icon / 1024 Master` (`16:3`)
 * and Frame `28 · Update Available / Install Dialog` (`16:345`).
 */
export const ReadoraAppMark: React.FC<{ size?: number }> = ({ size = 62 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 62 62"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M6.78125 10.8984C6.78125 9.26367 8.53711 8.23437 9.99023 9.02148L26.3379 17.8008C27.9727 18.709 28.9414 20.4043 28.9414 22.2812V51.8281L7.99219 40.8086C7.62127 40.6091 7.31221 40.3117 7.09868 39.9487C6.88516 39.5857 6.77536 39.1711 6.78125 38.75V10.8984Z"
      fill="#2F6B5D"
    />
    <path
      d="M55.2188 10.8984C55.2188 9.26367 53.4629 8.23437 52.0098 9.02148L35.6621 17.8008C34.0273 18.709 33.0586 20.4043 33.0586 22.2812V51.8281L54.0078 40.8086C54.3787 40.6091 54.6878 40.3117 54.9013 39.9487C55.1148 39.5857 55.2246 39.1711 55.2188 38.75V10.8984Z"
      fill="#A7BE7E"
    />
    <path
      d="M29.5469 23.7344H32.4531V41.5352L31 40.3242L29.5469 41.5352V23.7344Z"
      fill="#E4765B"
    />
  </svg>
);

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
          <ReadoraAppMark size={62} />
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
