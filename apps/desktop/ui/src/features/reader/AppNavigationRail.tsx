import React from "react";
import { type LibraryCollectionView } from "../../shared/components/EmptyWorkspace";
import { FocusIcon } from "../../shared/components/FocusIcon";
import { ReadoraLogo } from "../../shared/components/ReadoraLogo";
import { type RecentDocumentDto } from "../../types/ipc";

interface AppNavigationRailProps {
  hasOpenSession: boolean;
  showBookmarksPanel: boolean;
  libraryCollection: LibraryCollectionView;
  recentDocs: RecentDocumentDto[];
  onOpenRecentPath: (path: string) => void;
  onOpenImportDialog: () => void;
  onToggleBookmarksSidebar: () => void;
  onSetLibraryCollection: React.Dispatch<
    React.SetStateAction<LibraryCollectionView>
  >;
  onCloseDocument: () => void;
}

export const AppNavigationRail: React.FC<AppNavigationRailProps> = ({
  hasOpenSession,
  showBookmarksPanel,
  libraryCollection,
  recentDocs,
  onOpenRecentPath,
  onOpenImportDialog,
  onToggleBookmarksSidebar,
  onSetLibraryCollection,
  onCloseDocument,
}) => {
  return (
    <nav className="app-rail" aria-label="Application Navigation Rail">
      <div className="app-rail-top">
        <div className="app-rail-logo" title="Focus Reader · Readora">
          <ReadoraLogo size={22} />
        </div>
        <button
          type="button"
          className={`app-rail-btn ${hasOpenSession ? "active" : ""}`}
          onClick={() => {
            if (!hasOpenSession) {
              const firstActive = recentDocs.find((d) => !d.is_archived);
              if (firstActive) {
                onOpenRecentPath(firstActive.file_path);
              } else {
                onOpenImportDialog();
              }
            }
          }}
          title="Reader / Documents"
          aria-label="Reader Workspace"
        >
          <FocusIcon name="file" size={16} />
        </button>
        <button
          type="button"
          className={`app-rail-btn ${
            (hasOpenSession && showBookmarksPanel) ||
            (!hasOpenSession && libraryCollection === "favorites")
              ? "active"
              : ""
          }`}
          onClick={() => {
            if (hasOpenSession) {
              onToggleBookmarksSidebar();
            } else {
              onSetLibraryCollection((prev) =>
                prev === "favorites" ? "all" : "favorites",
              );
            }
          }}
          title="Notes & Favorites"
          aria-label="Notes and Bookmarks Rail"
        >
          <FocusIcon name="star" size={16} />
        </button>
        <button
          type="button"
          className={`app-rail-btn ${
            !hasOpenSession && libraryCollection === "all" ? "active" : ""
          }`}
          onClick={() => {
            onSetLibraryCollection("all");
            if (hasOpenSession) {
              onCloseDocument();
            }
          }}
          title="Library Home"
          aria-label="Library Home"
        >
          <FocusIcon name="grid" size={16} />
        </button>
      </div>

      <div className="app-rail-bottom">
        <div className="app-rail-avatar" title="Local Reader Profile">
          MK
        </div>
      </div>
    </nav>
  );
};
