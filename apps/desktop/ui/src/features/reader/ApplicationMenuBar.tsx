import React, { useEffect, useState } from "react";
import {
  type FitMode,
  type LayoutMode,
  type RenderMode,
  type ViewStateDto,
} from "../../types/ipc";
import { type SidebarTab } from "./ReaderToolbar";

export type AppMenuKey = "file" | "edit" | "view" | "window" | "help" | null;

function formatLocalClock(date: Date): string {
  try {
    return date.toLocaleTimeString([], {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return date.toTimeString().slice(0, 5);
  }
}

interface ApplicationMenuBarProps {
  menuBarRef: React.RefObject<HTMLDivElement | null>;
  activeAppMenu: AppMenuKey;
  setActiveAppMenu: React.Dispatch<React.SetStateAction<AppMenuKey>>;
  fileName: string | null;
  viewState: ViewStateDto | null;
  onToggleSidebar: (tab: Exclude<SidebarTab, null>) => void;
  onToggleRightPanel?: () => void;
  onCloseDocument: () => void;
  onShowLibraryRecents?: () => void;
  onSetZoom?: (zoom: number) => void;
  onSetFitMode: (mode: FitMode) => void;
  onSetLayoutMode: (mode: LayoutMode) => void;
  onSetRenderMode: (mode: RenderMode) => void;
  onOpenPreferences: () => void;
  onOpenAbout?: () => void;
  onToggleTheme?: () => void;
  onOpenPrint?: () => void;
  onOpenDocumentDetails?: () => void;
  onOpenImportDialog?: () => void;
  onOpenShare?: () => void;
  onOpenShortcuts?: () => void;
  onCopyPageText?: () => void;
  onFocusCommentComposer?: () => void;
  onOpenUpdateDialog?: () => void;
}

export const ApplicationMenuBar: React.FC<ApplicationMenuBarProps> = ({
  menuBarRef,
  activeAppMenu,
  setActiveAppMenu,
  fileName,
  viewState,
  onToggleSidebar,
  onToggleRightPanel,
  onCloseDocument,
  onShowLibraryRecents,
  onSetZoom,
  onSetFitMode,
  onSetLayoutMode,
  onSetRenderMode,
  onOpenPreferences,
  onOpenAbout,
  onToggleTheme,
  onOpenPrint,
  onOpenDocumentDetails,
  onOpenImportDialog,
  onOpenShare,
  onOpenShortcuts,
  onCopyPageText,
  onFocusCommentComposer,
  onOpenUpdateDialog,
}) => {
  const [clockLabel, setClockLabel] = useState<string>(() =>
    formatLocalClock(new Date()),
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClockLabel(formatLocalClock(new Date()));
    }, 30_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div
      className="desktop-menu-bar"
      role="menubar"
      aria-label="Application Menu Bar"
    >
      <div className="desktop-menu-left" ref={menuBarRef}>
        <span className="desktop-menu-brand">● &nbsp; Focus Reader</span>

        <div className="desktop-menu-item-wrapper">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeAppMenu === "file"}
            className={`desktop-menu-trigger ${
              activeAppMenu === "file" ? "active" : ""
            }`}
            onClick={() =>
              setActiveAppMenu((prev) => (prev === "file" ? null : "file"))
            }
            onMouseEnter={() => {
              if (activeAppMenu && activeAppMenu !== "file") {
                setActiveAppMenu("file");
              }
            }}
          >
            File
          </button>
          {activeAppMenu === "file" && (
            <div
              className="desktop-dropdown-menu"
              role="menu"
              aria-label="File Menu"
            >
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  onOpenImportDialog?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Open PDF…</span>
                <span className="zoom-shortcut">⌘O</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  if (onShowLibraryRecents) {
                    onShowLibraryRecents();
                  } else {
                    onCloseDocument();
                  }
                  setActiveAppMenu(null);
                }}
              >
                <span>Show Library &amp; Recents</span>
                <span className="zoom-shortcut">⇧⌘L</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onCloseDocument();
                  setActiveAppMenu(null);
                }}
              >
                <span>Close Document</span>
                <span className="zoom-shortcut">⌘W</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onOpenShare?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Export Annotations…</span>
                <span className="zoom-shortcut">⇧⌘S</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onOpenDocumentDetails?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Document Properties…</span>
                <span className="zoom-shortcut">⌘I</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onOpenPrint?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Print…</span>
                <span className="zoom-shortcut">⌘P</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  onOpenPreferences();
                  setActiveAppMenu(null);
                }}
              >
                <span>Preferences…</span>
                <span className="zoom-shortcut">⌘,</span>
              </button>
            </div>
          )}
        </div>

        <div className="desktop-menu-item-wrapper">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeAppMenu === "edit"}
            className={`desktop-menu-trigger ${
              activeAppMenu === "edit" ? "active" : ""
            }`}
            onClick={() =>
              setActiveAppMenu((prev) => (prev === "edit" ? null : "edit"))
            }
            onMouseEnter={() => {
              if (activeAppMenu && activeAppMenu !== "edit") {
                setActiveAppMenu("edit");
              }
            }}
          >
            Edit
          </button>
          {activeAppMenu === "edit" && (
            <div
              className="desktop-dropdown-menu"
              role="menu"
              aria-label="Edit Menu"
            >
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onCopyPageText?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Copy</span>
                <span className="zoom-shortcut">⌘C</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onToggleSidebar("search");
                  setActiveAppMenu(null);
                }}
              >
                <span>Find in Document…</span>
                <span className="zoom-shortcut">⌘F</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  if (onFocusCommentComposer) {
                    onFocusCommentComposer();
                  } else {
                    onToggleSidebar("bookmarks");
                  }
                  setActiveAppMenu(null);
                }}
              >
                <span>Add Comment</span>
                <span className="zoom-shortcut">⌥⌘M</span>
              </button>
            </div>
          )}
        </div>

        <div className="desktop-menu-item-wrapper">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeAppMenu === "view"}
            className={`desktop-menu-trigger ${
              activeAppMenu === "view" ? "active" : ""
            }`}
            onClick={() =>
              setActiveAppMenu((prev) => (prev === "view" ? null : "view"))
            }
            onMouseEnter={() => {
              if (activeAppMenu && activeAppMenu !== "view") {
                setActiveAppMenu("view");
              }
            }}
          >
            View
          </button>
          {activeAppMenu === "view" && (
            <div
              className="desktop-dropdown-menu"
              role="menu"
              aria-label="View Menu"
            >
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onToggleSidebar("thumbnails");
                  setActiveAppMenu(null);
                }}
              >
                <span>Show Page Sidebar</span>
                <span className="zoom-shortcut">⌘\</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onToggleSidebar("outline");
                  setActiveAppMenu(null);
                }}
              >
                <span>Show Document Outline</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onToggleRightPanel?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Show Notes Panel</span>
                <span className="zoom-shortcut">⇧⌘\</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetLayoutMode("single_page");
                  setActiveAppMenu(null);
                }}
              >
                <span>
                  {viewState?.layout_mode === "single_page" ? "✓ " : ""}Single
                  Page
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetLayoutMode("continuous");
                  setActiveAppMenu(null);
                }}
              >
                <span>
                  {viewState?.layout_mode === "continuous" ? "✓ " : ""}
                  Continuous Scroll
                </span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetFitMode("fit_width");
                  setActiveAppMenu(null);
                }}
              >
                <span>Fit Width</span>
                <span className="zoom-shortcut">⌘2</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetFitMode("fit_page");
                  setActiveAppMenu(null);
                }}
              >
                <span>Fit Page</span>
                <span className="zoom-shortcut">⌘1</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetZoom?.(1.0);
                  setActiveAppMenu(null);
                }}
              >
                <span>Actual Size</span>
                <span className="zoom-shortcut">⌘0</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetRenderMode("standard");
                  setActiveAppMenu(null);
                }}
              >
                <span>
                  {viewState?.render_mode === "standard" ? "✓ " : ""}Standard
                  Color
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetRenderMode("grayscale");
                  setActiveAppMenu(null);
                }}
              >
                <span>
                  {viewState?.render_mode === "grayscale" ? "✓ " : ""}
                  Grayscale
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                disabled={!viewState}
                onClick={() => {
                  onSetRenderMode("dark_inversion");
                  setActiveAppMenu(null);
                }}
              >
                <span>
                  {viewState?.render_mode === "dark_inversion" ? "✓ " : ""}
                  Night Inversion
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="desktop-menu-item-wrapper">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeAppMenu === "window"}
            className={`desktop-menu-trigger ${
              activeAppMenu === "window" ? "active" : ""
            }`}
            onClick={() =>
              setActiveAppMenu((prev) => (prev === "window" ? null : "window"))
            }
            onMouseEnter={() => {
              if (activeAppMenu && activeAppMenu !== "window") {
                setActiveAppMenu("window");
              }
            }}
          >
            Window
          </button>
          {activeAppMenu === "window" && (
            <div
              className="desktop-dropdown-menu"
              role="menu"
              aria-label="Window Menu"
            >
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  if (onShowLibraryRecents) {
                    onShowLibraryRecents();
                  } else {
                    onCloseDocument();
                  }
                  setActiveAppMenu(null);
                }}
              >
                <span>Show Library</span>
                <span className="zoom-shortcut">⇧⌘L</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  onToggleTheme?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Toggle Light / Dark Theme</span>
              </button>
              {fileName && (
                <>
                  <div className="zoom-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="doc-action-menu-item"
                    onClick={() => setActiveAppMenu(null)}
                  >
                    <span>✓ &nbsp; {fileName}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="desktop-menu-item-wrapper">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeAppMenu === "help"}
            className={`desktop-menu-trigger ${
              activeAppMenu === "help" ? "active" : ""
            }`}
            onClick={() =>
              setActiveAppMenu((prev) => (prev === "help" ? null : "help"))
            }
            onMouseEnter={() => {
              if (activeAppMenu && activeAppMenu !== "help") {
                setActiveAppMenu("help");
              }
            }}
          >
            Help
          </button>
          {activeAppMenu === "help" && (
            <div
              className="desktop-dropdown-menu"
              role="menu"
              aria-label="Help Menu"
            >
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  onOpenShortcuts?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Keyboard Shortcuts</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  onOpenAbout?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>About Focus Reader</span>
              </button>
              <div className="zoom-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-action-menu-item"
                onClick={() => {
                  onOpenUpdateDialog?.();
                  setActiveAppMenu(null);
                }}
              >
                <span>Check for Updates…</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <span className="desktop-menu-clock" aria-label="Local time">
        {clockLabel}
      </span>
    </div>
  );
};
