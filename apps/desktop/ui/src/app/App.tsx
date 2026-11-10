import React, { useCallback, useEffect, useState } from "react";
import { BookmarksPanel } from "../features/bookmarks/BookmarksPanel";
import { OutlinePanel } from "../features/navigation/OutlinePanel";
import { ThumbnailsPanel } from "../features/navigation/ThumbnailsPanel";
import { ImportPdfDialog } from "../features/reader/ImportPdfDialog";
import { OpenPasswordDialog } from "../features/reader/OpenPasswordDialog";
import { PageViewport } from "../features/reader/PageViewport";
import { PrintDialog } from "../features/reader/PrintDialog";
import {
  ReaderToolbar,
  type SidebarTab,
} from "../features/reader/ReaderToolbar";
import { ShareDialog } from "../features/reader/ShareDialog";
import { StatusBar } from "../features/reader/StatusBar";
import { UpdateDialog } from "../features/reader/UpdateDialog";
import { SearchPanel } from "../features/search/SearchPanel";
import {
  PreferencesDialog,
  type PreferencesSection,
} from "../features/settings/PreferencesDialog";
import { readoraApi } from "../lib/tauri/client";
import {
  EmptyWorkspace,
  type LibraryCollectionView,
} from "../shared/components/EmptyWorkspace";
import { FocusIcon } from "../shared/components/FocusIcon";
import { ReadoraLogo } from "../shared/components/ReadoraLogo";
import {
  rotationToDegrees,
  type AnnotationDto,
  type AnnotationKind,
  type AppSettingsDto,
  type CommandErrorDto,
  type DocumentSessionDto,
  type NavigationActionDto,
  type RecentDocumentDto,
  type RenderedPageResultDto,
  type SearchHitDto,
  type SettingsPatchDto,
  type ViewStateDto,
} from "../types/ipc";

function isCommandError(err: unknown): err is CommandErrorDto {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err
  );
}

export const App: React.FC = () => {
  const [session, setSession] = useState<DocumentSessionDto | null>(null);
  const [renderedPage, setRenderedPage] =
    useState<RenderedPageResultDto | null>(null);
  const [pageText, setPageText] = useState<string>("");
  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [recentDocs, setRecentDocs] = useState<RecentDocumentDto[]>([]);
  const [settings, setSettings] = useState<AppSettingsDto>({
    theme: "system",
    default_layout: "single_page",
    default_fit_mode: "fit_width",
    default_zoom: 1.0,
    render_cache_budget_bytes: 64 * 1024 * 1024,
    prefetch_window: 1,
  });

  const [activeSidebar, setActiveSidebar] = useState<SidebarTab>("thumbnails");
  const [showRightPanel, setShowRightPanel] = useState<boolean>(false);
  const [searchHits, setSearchHits] = useState<SearchHitDto[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationDto[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [pendingPasswordPath, setPendingPasswordPath] = useState<string | null>(
    null,
  );
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [showPreferences, setShowPreferences] = useState<boolean>(false);
  const [preferencesSection, setPreferencesSection] =
    useState<PreferencesSection>("appearance");
  const [showPrintDialog, setShowPrintDialog] = useState<boolean>(false);
  const [showImportDialog, setShowImportDialog] = useState<boolean>(false);
  const [showShareDialog, setShowShareDialog] = useState<boolean>(false);
  const [hasUpdateAvailable, setHasUpdateAvailable] = useState<boolean>(true);
  const [showUpdateDialog, setShowUpdateDialog] = useState<boolean>(false);
  const [libraryCollection, setLibraryCollection] =
    useState<LibraryCollectionView>("all");

  const refreshRecentsAndSettings = useCallback(async () => {
    try {
      const [recents, loadedSettings] = await Promise.all([
        readoraApi.listRecentDocuments(20),
        readoraApi.getSettings(),
      ]);
      setRecentDocs(recents);
      setSettings(loadedSettings);
    } catch {
      // Ignore startup load errors when initializing empty state
    }
  }, []);

  useEffect(() => {
    void refreshRecentsAndSettings();
  }, [refreshRecentsAndSettings]);

  const loadVisiblePageAndPrefetch = useCallback(
    async (docId: string, viewState: ViewStateDto, prefetchWindow: number) => {
      setIsRendering(true);
      try {
        const rotationDegrees = rotationToDegrees(viewState.rotation);
        const [renderResult, extractedText] = await Promise.all([
          readoraApi.renderPage({
            document_id: docId,
            page_index: viewState.current_page,
            scale: viewState.zoom,
            rotation_degrees: rotationDegrees,
            render_mode: viewState.render_mode,
            generation: null,
          }),
          readoraApi.extractPageText(docId, viewState.current_page),
        ]);
        setRenderedPage(renderResult);
        setPageText(extractedText);

        // Trigger background prefetch for adjacent pages within configured window
        for (let offset = 1; offset <= prefetchWindow; offset += 1) {
          const nextIdx = viewState.current_page + offset;
          if (nextIdx < viewState.page_count) {
            void readoraApi.renderPage({
              document_id: docId,
              page_index: nextIdx,
              scale: viewState.zoom,
              rotation_degrees: rotationDegrees,
              render_mode: viewState.render_mode,
              generation: renderResult.generation,
            });
          }
        }
      } catch (err) {
        if (isCommandError(err) && err.code === "cancelled") {
          return;
        }
        setErrorBanner(
          isCommandError(err) ? err.message : "Failed to render PDF page",
        );
      } finally {
        setIsRendering(false);
      }
    },
    [],
  );

  const handleOpenPath = useCallback(
    async (path: string, password: string | null = null) => {
      setErrorBanner(null);
      try {
        const opened = await readoraApi.openDocument({ path, password });
        setSession(opened);
        setPendingPasswordPath(null);
        setPasswordError(null);
        setSearchHits([]);
        await loadVisiblePageAndPrefetch(
          opened.descriptor.id,
          opened.view_state,
          settings.prefetch_window,
        );
        const [recents, loadedAnnotations] = await Promise.all([
          readoraApi.listRecentDocuments(20),
          readoraApi.listAnnotations(opened.descriptor.id),
        ]);
        setRecentDocs(recents);
        setAnnotations(loadedAnnotations);
      } catch (err) {
        if (isCommandError(err)) {
          if (err.code === "password_required") {
            setPendingPasswordPath(path);
            setPasswordError(null);
            return;
          }
          if (err.code === "incorrect_password") {
            setPendingPasswordPath(path);
            setPasswordError(err.message);
            return;
          }
          setErrorBanner(err.message);
        } else {
          setErrorBanner("Failed to open PDF document");
        }
      }
    },
    [loadVisiblePageAndPrefetch, settings.prefetch_window],
  );

  const handleOpenSample = useCallback(async () => {
    setErrorBanner(null);
    try {
      const opened = await readoraApi.openSampleDocument();
      setSession(opened);
      setSearchHits([]);
      await loadVisiblePageAndPrefetch(
        opened.descriptor.id,
        opened.view_state,
        settings.prefetch_window,
      );
      const [recents, loadedAnnotations] = await Promise.all([
        readoraApi.listRecentDocuments(20),
        readoraApi.listAnnotations(opened.descriptor.id),
      ]);
      setRecentDocs(recents);
      setAnnotations(loadedAnnotations);
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to open sample PDF",
      );
    }
  }, [loadVisiblePageAndPrefetch, settings.prefetch_window]);

  const handleCloseDocument = useCallback(async () => {
    if (!session) return;
    await readoraApi.closeDocument(session.descriptor.id);
    setSession(null);
    setRenderedPage(null);
    setPageText("");
    setSearchHits([]);
    setAnnotations([]);
    const recents = await readoraApi.listRecentDocuments(20);
    setRecentDocs(recents);
  }, [session]);

  const dispatchNavigation = useCallback(
    async (action: NavigationActionDto) => {
      if (!session) return;
      try {
        const updatedView = await readoraApi.navigate(
          session.descriptor.id,
          action,
        );
        setSession((prev) =>
          prev ? { ...prev, view_state: updatedView } : null,
        );
        await loadVisiblePageAndPrefetch(
          session.descriptor.id,
          updatedView,
          settings.prefetch_window,
        );
      } catch (err) {
        setErrorBanner(
          isCommandError(err) ? err.message : "Navigation update failed",
        );
      }
    },
    [loadVisiblePageAndPrefetch, session, settings.prefetch_window],
  );

  const handleToggleSidebar = (tab: Exclude<SidebarTab, null>) => {
    if (tab === "bookmarks") {
      setShowRightPanel(false);
    }
    setActiveSidebar((prev) => (prev === tab ? null : tab));
  };

  const handleAddBookmark = async (label: string) => {
    if (!session) return;
    try {
      const created = await readoraApi.upsertBookmark({
        document_id: session.descriptor.id,
        page_index: session.view_state.current_page,
        label,
      });
      setSession((prev) => {
        if (!prev) return null;
        const filtered = prev.bookmarks.filter(
          (b) => b.page_index !== created.page_index,
        );
        const nextBookmarks = [...filtered, created].sort(
          (a, b) => a.page_index - b.page_index,
        );
        return { ...prev, bookmarks: nextBookmarks };
      });
      setStatusMessage(`Saved bookmark "${created.label}"`);
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to save bookmark",
      );
    }
  };

  const handleDeleteBookmark = async (bookmarkId: string) => {
    if (!session) return;
    await readoraApi.deleteBookmark(bookmarkId);
    setSession((prev) =>
      prev
        ? {
            ...prev,
            bookmarks: prev.bookmarks.filter((b) => b.id !== bookmarkId),
          }
        : null,
    );
  };

  const handleCreateAnnotation = async (
    kind: AnnotationKind,
    colorHex: string,
    quoteText: string,
    noteText: string,
  ) => {
    if (!session) return;
    try {
      const created = await readoraApi.upsertAnnotation({
        document_id: session.descriptor.id,
        page_index: session.view_state.current_page,
        kind,
        color_hex: colorHex,
        quote_text: quoteText,
        note_text: noteText,
      });
      setAnnotations((prev) =>
        [...prev, created].sort((a, b) => a.page_index - b.page_index),
      );
      setStatusMessage("Saved page highlight");
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to save annotation",
      );
    }
  };

  const handleDeleteAnnotation = async (annotationId: string) => {
    if (!session) return;
    await readoraApi.deleteAnnotation(annotationId);
    setAnnotations((prev) => prev.filter((a) => a.id !== annotationId));
  };

  const handleSearch = async (query: string, caseSensitive: boolean) => {
    if (!session) return;
    const hits = await readoraApi.searchDocument({
      document_id: session.descriptor.id,
      query,
      case_sensitive: caseSensitive,
      max_hits: 100,
    });
    setSearchHits(hits);
    setStatusMessage(`Found ${hits.length} match(es)`);
  };

  const handleSavePreferences = async (patch: SettingsPatchDto) => {
    const updated = await readoraApi.updateSettings(patch);
    setSettings(updated);
    setShowPreferences(false);
    setStatusMessage("Preferences saved");
  };

  const handleToggleTheme = async () => {
    const nextTheme = settings.theme === "dark" ? "light" : "dark";
    const updated = await readoraApi.updateSettings({ theme: nextTheme });
    setSettings(updated);
  };

  const handleCopyText = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(pageText);
      } catch {
        // Ignore clipboard permission restrictions in headless test environments
      }
    }
    setStatusMessage("Copied current page text");
  };

  const handleToggleFavorite = async (
    documentId: string,
    isFavorite: boolean,
  ) => {
    await readoraApi.setFavoriteDocument(documentId, isFavorite);
    const recents = await readoraApi.listRecentDocuments(20);
    setRecentDocs(recents);
    setStatusMessage(
      isFavorite ? "Added document to favorites" : "Removed from favorites",
    );
  };

  const handleSetDocumentArchived = async (
    documentId: string,
    isArchived: boolean,
  ) => {
    await readoraApi.setDocumentArchived(documentId, isArchived);
    if (isArchived && session?.descriptor.id === documentId) {
      await readoraApi.closeDocument(documentId);
      setSession(null);
      setRenderedPage(null);
      setPageText("");
    }
    const recents = await readoraApi.listRecentDocuments(20);
    setRecentDocs(recents);
    setStatusMessage(
      isArchived ? "Moved document to archive" : "Restored document to library",
    );
  };

  const handleDeleteRecentDocument = async (documentId: string) => {
    await readoraApi.deleteRecentDocument(documentId);
    const recents = await readoraApi.listRecentDocuments(20);
    setRecentDocs(recents);
    setStatusMessage("Removed document from library");
  };

  const handleExportAnnotations = async (includeAnnotations: boolean) => {
    if (!session) return;
    try {
      const bundle = await readoraApi.exportAnnotations(
        session.descriptor.id,
        includeAnnotations,
        null,
      );
      setShowShareDialog(false);
      setStatusMessage(
        `Exported ${bundle.file_name} (${bundle.annotation_count} annotations)`,
      );
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to export annotations",
      );
    }
  };

  const handleCopyShareLink = async (shareUri: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(shareUri);
      } catch {
        // Ignore clipboard permission errors in test environment
      }
    }
    setStatusMessage(`Copied link ${shareUri}`);
  };

  const currentDocIsFavorite = Boolean(
    session &&
      recentDocs.find((r) => r.document_id === session.descriptor.id)
        ?.is_favorite,
  );

  const showBookmarksPanel =
    activeSidebar === "bookmarks" || showRightPanel;

  return (
    <div
      className={`app-shell theme-${settings.theme}`}
      data-testid="app-shell"
    >
      <ReaderToolbar
        fileName={session?.descriptor.file_name ?? null}
        fileSizeBytes={session?.descriptor.file_size_bytes ?? null}
        viewState={session?.view_state ?? null}
        activeSidebar={activeSidebar}
        showRightPanel={showBookmarksPanel}
        onToggleSidebar={handleToggleSidebar}
        onToggleRightPanel={() => setShowRightPanel((prev) => !prev)}
        onOpenPathSubmit={(p) => void handleOpenPath(p)}
        onOpenSample={() => void handleOpenSample()}
        onCloseDocument={() => void handleCloseDocument()}
        onPrevPage={() => void dispatchNavigation({ kind: "previous_page" })}
        onNextPage={() => void dispatchNavigation({ kind: "next_page" })}
        onGoToPage={(p) =>
          void dispatchNavigation({ kind: "go_to_page", value: p })
        }
        onZoomIn={() => void dispatchNavigation({ kind: "step_zoom_in" })}
        onZoomOut={() => void dispatchNavigation({ kind: "step_zoom_out" })}
        onSetZoom={(z) =>
          void dispatchNavigation({ kind: "set_zoom", value: z })
        }
        onSetFitMode={(m) =>
          void dispatchNavigation({ kind: "set_fit_mode", value: m })
        }
        onRotateCw={() => void dispatchNavigation({ kind: "rotate_clockwise" })}
        onRotateCcw={() =>
          void dispatchNavigation({ kind: "rotate_counter_clockwise" })
        }
        onSetLayoutMode={(m) =>
          void dispatchNavigation({ kind: "set_layout_mode", value: m })
        }
        onSetRenderMode={(m) =>
          void dispatchNavigation({ kind: "set_render_mode", value: m })
        }
        onOpenPreferences={() => {
          setPreferencesSection("appearance");
          setShowPreferences(true);
        }}
        onOpenShortcuts={() => {
          setPreferencesSection("shortcuts");
          setShowPreferences(true);
        }}
        onOpenImportDialog={() => setShowImportDialog(true)}
        onOpenShare={session ? () => setShowShareDialog(true) : undefined}
        onCopyPageText={() => void handleCopyText()}
        hasUpdateAvailable={hasUpdateAvailable}
        onOpenUpdateDialog={() => setShowUpdateDialog(true)}
        onToggleTheme={() => void handleToggleTheme()}
        isFavorite={currentDocIsFavorite}
        onToggleFavorite={
          session
            ? () =>
                void handleToggleFavorite(
                  session.descriptor.id,
                  !currentDocIsFavorite,
                )
            : undefined
        }
        onArchiveDocument={
          session
            ? () => void handleSetDocumentArchived(session.descriptor.id, true)
            : undefined
        }
        onOpenPrint={session ? () => setShowPrintDialog(true) : undefined}
        onOpenDocumentDetails={
          session
            ? () => {
                setShowRightPanel(true);
                setActiveSidebar("bookmarks");
              }
            : undefined
        }
      />

      {errorBanner && (
        <div className="error-banner" role="alert">
          <span>{errorBanner}</span>
          <button
            type="button"
            className="dismiss-btn"
            onClick={() => setErrorBanner(null)}
            aria-label="Dismiss error"
          >
            <FocusIcon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="app-body-frame">
        {/* Left 58px App Rail (Figma Frame 01/02/03) */}
        <nav className="app-rail" aria-label="Application Navigation Rail">
          <div className="app-rail-top">
            <div className="app-rail-logo" title="Focus Reader · Readora">
              <ReadoraLogo size={22} />
            </div>
            <button
              type="button"
              className={`app-rail-btn ${session ? "active" : ""}`}
              onClick={() => {
                if (!session) {
                  void handleOpenSample();
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
                (session && showBookmarksPanel) ||
                (!session && libraryCollection === "favorites")
                  ? "active"
                  : ""
              }`}
              onClick={() => {
                if (session) {
                  handleToggleSidebar("bookmarks");
                } else {
                  setLibraryCollection((prev) =>
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
                !session && libraryCollection === "all" ? "active" : ""
              }`}
              onClick={() => {
                setLibraryCollection("all");
                if (session) {
                  void handleCloseDocument();
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

        {session ? (
          <div className="reader-workspace">
            {activeSidebar === "thumbnails" && (
              <ThumbnailsPanel
                pageCount={session.descriptor.page_count}
                currentPage={session.view_state.current_page}
                onSelectPage={(p) =>
                  void dispatchNavigation({ kind: "go_to_page", value: p })
                }
                onSwitchToOutline={() => setActiveSidebar("outline")}
              />
            )}
            {activeSidebar === "outline" && (
              <OutlinePanel
                outline={session.outline}
                currentPage={session.view_state.current_page}
                onSelectPage={(p) =>
                  void dispatchNavigation({ kind: "go_to_page", value: p })
                }
                onSwitchToPages={() => setActiveSidebar("thumbnails")}
              />
            )}

            <div className="canvas-stage-wrapper">
              {activeSidebar === "search" && (
                <SearchPanel
                  hits={searchHits}
                  onSearch={(q, cs) => void handleSearch(q, cs)}
                  onSelectHit={(p) =>
                    void dispatchNavigation({ kind: "go_to_page", value: p })
                  }
                  onClose={() => setActiveSidebar("thumbnails")}
                />
              )}

              <PageViewport
                viewState={session.view_state}
                renderedPage={renderedPage}
                pageText={pageText}
                isLoading={isRendering}
                annotations={annotations}
                onCopyText={() => void handleCopyText()}
                onQuickAddNote={() => setActiveSidebar("bookmarks")}
                onCreateAnnotation={(kind, color, quote, note) =>
                  void handleCreateAnnotation(kind, color, quote, note)
                }
              />
            </div>

            {showBookmarksPanel && (
              <BookmarksPanel
                bookmarks={session.bookmarks}
                annotations={annotations}
                currentPage={session.view_state.current_page}
                descriptor={session.descriptor}
                onAddBookmark={(label) => void handleAddBookmark(label)}
                onDeleteBookmark={(id) => void handleDeleteBookmark(id)}
                onDeleteAnnotation={(id) => void handleDeleteAnnotation(id)}
                onSelectPage={(p) =>
                  void dispatchNavigation({ kind: "go_to_page", value: p })
                }
                onClosePanel={() => {
                  setShowRightPanel(false);
                  if (activeSidebar === "bookmarks") {
                    setActiveSidebar("thumbnails");
                  }
                }}
              />
            )}
          </div>
        ) : (
          <EmptyWorkspace
            recentDocuments={recentDocs}
            activeCollection={libraryCollection}
            onChangeCollection={setLibraryCollection}
            onOpenSample={() => void handleOpenSample()}
            onOpenRecent={(path) => void handleOpenPath(path)}
            onToggleFavorite={(docId, nextFav) =>
              void handleToggleFavorite(docId, nextFav)
            }
            onArchiveDocument={(docId) =>
              void handleSetDocumentArchived(docId, true)
            }
            onRestoreArchived={(docId) =>
              void handleSetDocumentArchived(docId, false)
            }
            onDeleteRecentDocument={(docId) =>
              void handleDeleteRecentDocument(docId)
            }
          />
        )}
      </div>

      {showPrintDialog && session && (
        <PrintDialog
          descriptor={session.descriptor}
          viewState={session.view_state}
          renderedPage={renderedPage}
          onClose={() => setShowPrintDialog(false)}
          onConfirmPrint={(summary) => {
            setShowPrintDialog(false);
            setStatusMessage(summary);
          }}
        />
      )}

      {showImportDialog && (
        <ImportPdfDialog
          onImportPath={(p) => {
            setShowImportDialog(false);
            void handleOpenPath(p);
          }}
          onOpenSample={() => {
            setShowImportDialog(false);
            void handleOpenSample();
          }}
          onClose={() => setShowImportDialog(false)}
        />
      )}

      {showShareDialog && session && (
        <ShareDialog
          descriptor={session.descriptor}
          onExportAnnotations={(inc) => void handleExportAnnotations(inc)}
          onCopyShareLink={(uri) => void handleCopyShareLink(uri)}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      {showUpdateDialog && (
        <UpdateDialog
          version="1.1.0"
          sizeLabel="42 MB · Downloaded and verified"
          onConfirmInstall={(version) => {
            setShowUpdateDialog(false);
            setHasUpdateAvailable(false);
            setStatusMessage(
              `Focus Reader ${version} staged — will apply on next launch`,
            );
          }}
          onClose={() => setShowUpdateDialog(false)}
        />
      )}

      {pendingPasswordPath && (
        <OpenPasswordDialog
          pendingPath={pendingPasswordPath}
          errorMessage={passwordError}
          onSubmitPassword={(pw) =>
            void handleOpenPath(pendingPasswordPath, pw)
          }
          onCancel={() => {
            setPendingPasswordPath(null);
            setPasswordError(null);
          }}
        />
      )}

      {showPreferences && (
        <PreferencesDialog
          settings={settings}
          initialSection={preferencesSection}
          onSave={(patch) => void handleSavePreferences(patch)}
          onClose={() => setShowPreferences(false)}
        />
      )}

      <StatusBar
        descriptor={session?.descriptor ?? null}
        viewState={session?.view_state ?? null}
        renderedPage={renderedPage}
        statusMessage={statusMessage}
      />
    </div>
  );
};
