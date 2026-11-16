import { useEffect } from "react";
import { type DocumentSessionDto } from "../../types/ipc";
import { type SidebarTab } from "./ReaderToolbar";

interface GlobalReaderShortcutsParams {
  session: DocumentSessionDto | null;
  setActiveSidebar: React.Dispatch<React.SetStateAction<SidebarTab>>;
  setShowImportDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setShowPrintDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setShowRightPanel: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useGlobalReaderShortcuts({
  session,
  setActiveSidebar,
  setShowImportDialog,
  setShowPrintDialog,
  setShowRightPanel,
}: GlobalReaderShortcutsParams): void {
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const hasCommandOrSuperOrCtrl = event.metaKey || event.ctrlKey;
      if (!hasCommandOrSuperOrCtrl || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        if (session) {
          setActiveSidebar("search");
          const existingInput = document.querySelector<HTMLInputElement>(
            ".search-popover-input",
          );
          if (existingInput) {
            existingInput.focus();
            existingInput.select();
          }
        } else {
          const librarySearch = document.querySelector<HTMLInputElement>(
            'input[aria-label="Search library documents"]',
          );
          librarySearch?.focus();
          librarySearch?.select();
        }
        return;
      }

      if (key === "o") {
        event.preventDefault();
        setShowImportDialog(true);
        return;
      }

      if (key === "p" && session) {
        event.preventDefault();
        setShowPrintDialog(true);
        return;
      }

      if (event.key === "\\" && session) {
        event.preventDefault();
        if (event.shiftKey) {
          setShowRightPanel((prev) => !prev);
        } else {
          setActiveSidebar((prev) =>
            prev === "thumbnails" ? null : "thumbnails",
          );
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [
    session,
    setActiveSidebar,
    setShowImportDialog,
    setShowPrintDialog,
    setShowRightPanel,
  ]);
}
