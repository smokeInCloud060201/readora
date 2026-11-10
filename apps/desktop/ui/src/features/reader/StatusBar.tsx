import React from "react";
import {
  rotationToDegrees,
  type DocumentDescriptorDto,
  type RenderedPageResultDto,
  type ViewStateDto,
} from "../../types/ipc";

interface StatusBarProps {
  descriptor: DocumentDescriptorDto | null;
  viewState: ViewStateDto | null;
  renderedPage: RenderedPageResultDto | null;
  statusMessage: string | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  descriptor,
  viewState,
  renderedPage,
  statusMessage,
}) => {
  return (
    <footer className="status-bar" role="contentinfo" aria-label="Reader Status Bar">
      <div className="status-left">
        {descriptor ? (
          <span>
            {descriptor.file_name} • PDF v{descriptor.metadata.pdf_version} •{" "}
            {descriptor.page_count} pages
            {descriptor.metadata.is_encrypted ? " • Encrypted" : ""}
          </span>
        ) : (
          <span>Ready — Open a local PDF to begin reading</span>
        )}
      </div>
      <div className="status-right">
        {statusMessage && <span className="status-notice">{statusMessage}</span>}
        {viewState && (
          <span>
            {viewState.layout_mode === "continuous" ? "Continuous" : "Single Page"} •{" "}
            {rotationToDegrees(viewState.rotation)}° •{" "}
            {renderedPage?.cache_hit ? "Cache Hit" : "Rendered"}
          </span>
        )}
      </div>
    </footer>
  );
};
