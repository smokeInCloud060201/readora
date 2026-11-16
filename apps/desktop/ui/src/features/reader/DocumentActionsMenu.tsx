import React from "react";
import { FocusIcon } from "../../shared/components/FocusIcon";

interface DocumentActionsMenuProps {
  menuRef: React.RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  isFavorite: boolean;
  onOpenDocumentDetails?: () => void;
  onOpenPrint?: () => void;
  onRotateCw: () => void;
  onRotateCcw: () => void;
  onToggleFavorite?: () => void;
  onArchiveDocument?: () => void;
}

export const DocumentActionsMenu: React.FC<DocumentActionsMenuProps> = ({
  menuRef,
  isOpen,
  onToggleOpen,
  onClose,
  isFavorite,
  onOpenDocumentDetails,
  onOpenPrint,
  onRotateCw,
  onRotateCcw,
  onToggleFavorite,
  onArchiveDocument,
}) => {
  return (
    <div ref={menuRef} className="more-actions-wrapper">
      <button
        type="button"
        className={`focus-icon-btn ${isOpen ? "active" : ""}`}
        onClick={onToggleOpen}
        aria-label="More Document Actions"
        title="More Document Actions"
        data-node-id="2:61"
      >
        <FocusIcon name="more" size={16} />
      </button>

      {isOpen && (
        <div
          className="document-actions-menu"
          role="menu"
          aria-label="Document Actions Menu"
          data-node-id="6:1050"
        >
          <button
            type="button"
            role="menuitem"
            className="doc-action-menu-item"
            onClick={() => {
              onOpenDocumentDetails?.();
              onClose();
            }}
          >
            <span>Document properties…</span>
            <FocusIcon name="info" size={14} />
          </button>
          {onOpenPrint && (
            <button
              type="button"
              role="menuitem"
              className="doc-action-menu-item"
              onClick={() => {
                onOpenPrint();
                onClose();
              }}
            >
              <span>Print document…</span>
              <span className="zoom-shortcut">⌘P</span>
            </button>
          )}
          <div className="zoom-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="doc-action-menu-item"
            onClick={() => {
              onRotateCw();
              onClose();
            }}
          >
            <span>Rotate clockwise</span>
            <span className="zoom-shortcut">⌘]</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="doc-action-menu-item"
            onClick={() => {
              onRotateCcw();
              onClose();
            }}
          >
            <span>Rotate counterclockwise</span>
            <span className="zoom-shortcut">⌘[</span>
          </button>
          <div className="zoom-menu-divider" />
          {onToggleFavorite && (
            <button
              type="button"
              role="menuitem"
              className="doc-action-menu-item"
              onClick={() => {
                onToggleFavorite();
                onClose();
              }}
            >
              <span>
                {isFavorite ? "Remove from favorites" : "Add to favorites"}
              </span>
              <FocusIcon name="star" size={14} filled={Boolean(isFavorite)} />
            </button>
          )}
          {onArchiveDocument && (
            <button
              type="button"
              role="menuitem"
              className="doc-action-menu-item"
              onClick={() => {
                onArchiveDocument();
                onClose();
              }}
            >
              <span>Move to archive</span>
              <FocusIcon name="archive" size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
