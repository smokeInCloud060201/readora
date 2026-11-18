import type React from "react";
import { useEffect, useRef } from "react";
import { type DocumentSessionDto, type FitMode } from "../../types/ipc";
import { type SidebarTab } from "./ReaderToolbar";

interface GlobalReaderShortcutsParams {
  session: DocumentSessionDto | null;
  hasOpenModal: boolean;
  setActiveSidebar: React.Dispatch<React.SetStateAction<SidebarTab>>;
  onToggleSearch: () => void;
  onOpenImportDialog: () => void;
  onOpenPrintDialog: () => void;
  onOpenShareDialog: () => void;
  onToggleNotesPanel: () => void;
  onNextPage: () => void;
  onPrevPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetZoom: (zoom: number) => void;
  onSetFitMode: (mode: FitMode) => void;
  onRotateCw: () => void;
  onRotateCcw: () => void;
  onCloseDocument: () => void;
  onShowLibrary: () => void;
  onOpenPreferences: () => void;
  onOpenDocumentDetails: () => void;
  onToggleHighlightOptions: () => void;
  onFocusCommentComposer: () => void;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (
    target.isContentEditable ||
    target.getAttribute("contenteditable") === "true" ||
    Boolean(target.closest('[contenteditable="true"]'))
  ) {
    return true;
  }
  return false;
}

function shouldSkipWidgetShortcut(
  target: EventTarget | null,
  key: string,
): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (
    target.closest(
      '[role="menu"], [role="menuitem"], [role="radiogroup"], [role="radio"]',
    )
  ) {
    return true;
  }
  if (
    (key === " " || key === "Spacebar" || key === "Enter") &&
    target.closest("button, a, summary")
  ) {
    return true;
  }
  return false;
}

export function useGlobalReaderShortcuts(
  params: GlobalReaderShortcutsParams,
): void {
  const paramsRef = useRef<GlobalReaderShortcutsParams>(params);
  paramsRef.current = params;

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const {
        session,
        hasOpenModal,
        setActiveSidebar,
        onToggleSearch,
        onOpenImportDialog,
        onOpenPrintDialog,
        onOpenShareDialog,
        onToggleNotesPanel,
        onNextPage,
        onPrevPage,
        onZoomIn,
        onZoomOut,
        onSetZoom,
        onSetFitMode,
        onRotateCw,
        onRotateCcw,
        onCloseDocument,
        onShowLibrary,
        onOpenPreferences,
        onOpenDocumentDetails,
        onToggleHighlightOptions,
        onFocusCommentComposer,
      } = paramsRef.current;

      if (hasOpenModal) {
        return;
      }

      if (shouldSkipWidgetShortcut(event.target, event.key)) {
        return;
      }

      const hasMod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      // Alt + Meta/Ctrl + M -> Open Notes panel & focus comment input
      if (
        hasMod &&
        event.altKey &&
        !event.shiftKey &&
        (key === "m" || event.code === "KeyM")
      ) {
        if (session) {
          event.preventDefault();
          onFocusCommentComposer();
        }
        return;
      }

      // Single-key & Arrow shortcuts (only when not typing in an input/editable element)
      if (!hasMod && !event.altKey) {
        if (!session || isEditableElement(event.target)) {
          return;
        }

        const isContinuousLayout =
          session.view_state.layout_mode === "continuous";

        if (
          event.key === "ArrowRight" ||
          (!isContinuousLayout && event.key === "ArrowDown")
        ) {
          event.preventDefault();
          onNextPage();
          return;
        }

        if (
          event.key === "ArrowLeft" ||
          (!isContinuousLayout && event.key === "ArrowUp")
        ) {
          event.preventDefault();
          onPrevPage();
          return;
        }

        if (!event.shiftKey && key === "h") {
          event.preventDefault();
          onToggleHighlightOptions();
          return;
        }

        if (!event.shiftKey && key === "c") {
          event.preventDefault();
          onFocusCommentComposer();
          return;
        }

        return;
      }

      if (!hasMod || event.altKey) {
        return;
      }

      // Meta/Ctrl + , -> Preferences
      if (event.key === "," && !event.shiftKey) {
        event.preventDefault();
        onOpenPreferences();
        return;
      }

      // Meta/Ctrl + O -> Open PDF Dialog
      if (key === "o" && !event.shiftKey) {
        event.preventDefault();
        onOpenImportDialog();
        return;
      }

      // Shift + Meta/Ctrl + L -> Close document / Show Library
      if (key === "l" && event.shiftKey) {
        event.preventDefault();
        onShowLibrary();
        return;
      }

      // Meta/Ctrl + F -> Search document or library
      if (key === "f" && !event.shiftKey) {
        event.preventDefault();
        if (session) {
          onToggleSearch();
        } else {
          const librarySearch = document.querySelector<HTMLInputElement>(
            'input[aria-label="Search library"]',
          );
          librarySearch?.focus();
          librarySearch?.select();
        }
        return;
      }

      if (!session) {
        return;
      }

      // Meta/Ctrl + W -> Close open document
      if (key === "w" && !event.shiftKey) {
        event.preventDefault();
        onCloseDocument();
        return;
      }

      // Meta/Ctrl + P -> Print dialog
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        onOpenPrintDialog();
        return;
      }

      // Shift + Meta/Ctrl + S -> Share / Export dialog
      if (key === "s" && event.shiftKey) {
        event.preventDefault();
        onOpenShareDialog();
        return;
      }

      // Meta/Ctrl + I -> Document Details panel
      if (key === "i" && !event.shiftKey) {
        event.preventDefault();
        onOpenDocumentDetails();
        return;
      }

      // Meta/Ctrl + 1 -> Fit Page; Meta/Ctrl + 2 -> Fit Width; Meta/Ctrl + 0 -> Actual Size (1.0)
      if (!event.shiftKey && event.key === "1") {
        event.preventDefault();
        onSetFitMode("fit_page");
        return;
      }

      if (!event.shiftKey && event.key === "2") {
        event.preventDefault();
        onSetFitMode("fit_width");
        return;
      }

      if (!event.shiftKey && event.key === "0") {
        event.preventDefault();
        onSetZoom(1.0);
        return;
      }

      // Meta/Ctrl + = / + -> Zoom In; Meta/Ctrl + - -> Zoom Out
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        onZoomIn();
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        onZoomOut();
        return;
      }

      // Meta/Ctrl + ] -> Rotate Clockwise; Meta/Ctrl + [ -> Rotate Counterclockwise
      if (!event.shiftKey && event.key === "]") {
        event.preventDefault();
        onRotateCw();
        return;
      }

      if (!event.shiftKey && event.key === "[") {
        event.preventDefault();
        onRotateCcw();
        return;
      }

      // Shift + Meta/Ctrl + \ -> Toggle Notes panel; Meta/Ctrl + \ -> Toggle left sidebar
      if (event.shiftKey && (event.key === "\\" || event.key === "|")) {
        event.preventDefault();
        onToggleNotesPanel();
        return;
      }

      if (!event.shiftKey && event.key === "\\") {
        event.preventDefault();
        setActiveSidebar((prev) =>
          prev === "thumbnails" || prev === "outline" ? null : "thumbnails",
        );
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);
}
