import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookmarksPanel } from "../features/bookmarks/BookmarksPanel";
import { OutlinePanel } from "../features/navigation/OutlinePanel";
import { ThumbnailsPanel } from "../features/navigation/ThumbnailsPanel";
import { AppNavigationRail } from "../features/reader/AppNavigationRail";
import {
  buildSafeQuoteExcerpt,
  getWindowSelectedText,
  MAX_HIGHLIGHT_EXCERPT_LEN,
} from "../features/reader/FloatingAnnotationTools";
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
import { useGlobalReaderShortcuts } from "../features/reader/useGlobalReaderShortcuts";
import { SearchPanel } from "../features/search/SearchPanel";
import {
  PreferencesDialog,
  type PreferencesSection,
} from "../features/settings/PreferencesDialog";
import { isJsdomEnvironment } from "../lib/pdf/indexedDbStore";
import { readoraApi } from "../lib/tauri/client";
import {
  EmptyWorkspace,
  type LibraryCollectionView,
} from "../shared/components/EmptyWorkspace";
import { FocusIcon } from "../shared/components/FocusIcon";
import {
  rotationToDegrees,
  type AnnotationDto,
  type AnnotationKind,
  type AppSettingsDto,
  type AppUpdateStatusDto,
  type CommandErrorDto,
  type DocumentSessionDto,
  type NavigationActionDto,
  type RecentDocumentDto,
  type RenderedPageResultDto,
  type RenderMode,
  type Rotation,
  type SearchHitDto,
  type SettingsPatchDto,
  type ViewStateDto,
} from "../types/ipc";

interface RenderedPageState {
  result: RenderedPageResultDto;
  zoom: number;
  rotation: Rotation;
  renderMode: RenderMode;
}

function isCommandError(err: unknown): err is CommandErrorDto {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err
  );
}

function triggerMarkdownDownload(
  fileName: string,
  markdownContent: string,
): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return;
  }
  const sanitizedFileName =
    fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "annotations.md";
  const blob = new Blob([markdownContent], {
    type: "text/markdown;charset=utf-8",
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = sanitizedFileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    if (typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export const App: React.FC = () => {
  const [session, setSession] = useState<DocumentSessionDto | null>(null);
  const [renderedState, setRenderedState] = useState<RenderedPageState | null>(
    null,
  );
  const [pageText, setPageText] = useState<string>("");
  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [recentDocs, setRecentDocs] = useState<RecentDocumentDto[]>([]);
  const [settings, setSettings] = useState<AppSettingsDto>({
    theme: "system",
    default_layout: "continuous",
    default_fit_mode: "fit_width",
    default_zoom: 1.0,
    render_cache_budget_bytes: 64 * 1024 * 1024,
    prefetch_window: 1,
    reopen_last_document: false,
    remember_page_position: true,
    confirm_before_delete: false,
    show_extracted_text_layer: false,
    auto_check_updates: false,
  });
  const [osPrefersDark, setOsPrefersDark] = useState<boolean>(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return Boolean(window.matchMedia("(prefers-color-scheme: dark)").matches);
  });
  const [programmaticScrollTrigger, setProgrammaticScrollTrigger] =
    useState<number>(0);

  const [activeSidebar, setActiveSidebar] = useState<SidebarTab>("thumbnails");
  const [showRightPanel, setShowRightPanel] = useState<boolean>(false);
  const [requestedNotesTab, setRequestedNotesTab] = useState<
    "notes" | "details"
  >("notes");
  const [requestedNotesTabTrigger, setRequestedNotesTabTrigger] =
    useState<number>(0);
  const [showHighlightPopover, setShowHighlightPopover] =
    useState<boolean>(false);
  const [printIncludeAnnotations, setPrintIncludeAnnotations] =
    useState<boolean>(true);
  const [searchHits, setSearchHits] = useState<SearchHitDto[]>([]);
  const [activeSearchHitIndex, setActiveSearchHitIndex] = useState<number>(0);
  const searchRequestGenRef = useRef<number>(0);
  const renderSeqRef = useRef<number>(0);
  const didInitialBootRef = useRef<boolean>(false);
  const [annotations, setAnnotations] = useState<AnnotationDto[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [pendingPasswordPath, setPendingPasswordPath] = useState<string | null>(
    null,
  );
  const [pendingPasswordFile, setPendingPasswordFile] = useState<File | null>(
    null,
  );
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [showPreferences, setShowPreferences] = useState<boolean>(false);
  const [preferencesSection, setPreferencesSection] =
    useState<PreferencesSection>("appearance");
  const [showPrintDialog, setShowPrintDialog] = useState<boolean>(false);
  const [showImportDialog, setShowImportDialog] = useState<boolean>(false);
  const [showShareDialog, setShowShareDialog] = useState<boolean>(false);
  const [updateStatus, setUpdateStatus] =
    useState<AppUpdateStatusDto | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState<boolean>(false);
  const [libraryCollection, setLibraryCollection] =
    useState<LibraryCollectionView>("all");

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    setOsPrefersDark(Boolean(mql.matches));
    const handleMediaChange = (event: MediaQueryListEvent) => {
      setOsPrefersDark(Boolean(event.matches));
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handleMediaChange);
      return () => mql.removeEventListener("change", handleMediaChange);
    }
    return undefined;
  }, []);

  const loadVisiblePageAndPrefetch = useCallback(
    async (docId: string, viewState: ViewStateDto, prefetchWindow: number) => {
      const seq = ++renderSeqRef.current;
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
        if (seq !== renderSeqRef.current) {
          return;
        }
        setRenderedState({
          result: renderResult,
          zoom: viewState.zoom,
          rotation: viewState.rotation,
          renderMode: viewState.render_mode,
        });
        setPageText(extractedText);

        // In single-page mode, prefetch adjacent pages within configured window.
        // In continuous mode, PageViewport renders neighbor sheets directly without duplicate loops.
        if (viewState.layout_mode === "single_page") {
          for (let offset = 1; offset <= prefetchWindow; offset += 1) {
            const nextIdx = viewState.current_page + offset;
            if (nextIdx < viewState.page_count) {
              void readoraApi
                .renderPage({
                  document_id: docId,
                  page_index: nextIdx,
                  scale: viewState.zoom,
                  rotation_degrees: rotationDegrees,
                  render_mode: viewState.render_mode,
                  generation: renderResult.generation,
                })
                .catch(() => {});
            }
            const prevIdx = viewState.current_page - offset;
            if (prevIdx >= 0) {
              void readoraApi
                .renderPage({
                  document_id: docId,
                  page_index: prevIdx,
                  scale: viewState.zoom,
                  rotation_degrees: rotationDegrees,
                  render_mode: viewState.render_mode,
                  generation: renderResult.generation,
                })
                .catch(() => {});
            }
          }
        }
      } catch (err) {
        if (seq !== renderSeqRef.current) {
          return;
        }
        if (isCommandError(err) && err.code === "cancelled") {
          return;
        }
        setErrorBanner(
          isCommandError(err) ? err.message : "Failed to render PDF page",
        );
      } finally {
        if (seq === renderSeqRef.current) {
          setIsRendering(false);
        }
      }
    },
    [],
  );

  const handleOpenPath = useCallback(
    async (
      path: string,
      password: string | null = null,
      prefetchOverride?: number,
    ) => {
      setErrorBanner(null);
      try {
        const opened = await readoraApi.openDocument({ path, password });
        setSession(opened);
        setRenderedState(null);
        setPendingPasswordPath(null);
        setPendingPasswordFile(null);
        setPasswordError(null);
        setSearchHits([]);
        await loadVisiblePageAndPrefetch(
          opened.descriptor.id,
          opened.view_state,
          prefetchOverride ?? settings.prefetch_window,
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
            setPendingPasswordFile(null);
            setPasswordError(null);
            return;
          }
          if (err.code === "incorrect_password") {
            setPendingPasswordPath(path);
            setPendingPasswordFile(null);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [recents, loadedSettings] = await Promise.all([
          readoraApi.listRecentDocuments(20),
          readoraApi.getSettings(),
        ]);
        if (cancelled) return;
        setRecentDocs(recents);
        setSettings(loadedSettings);

        if (loadedSettings.auto_check_updates === true) {
          const status = await readoraApi.checkForUpdates(false);
          if (!cancelled) {
            setUpdateStatus(status);
          }
        } else {
          setUpdateStatus(null);
        }

        if (!didInitialBootRef.current) {
          didInitialBootRef.current = true;
          if (loadedSettings.reopen_last_document === true) {
            const candidate = recents.find(
              (item) => !item.is_archived && item.file_path.trim().length > 0,
            );
            if (candidate && !cancelled) {
              await handleOpenPath(
                candidate.file_path,
                null,
                loadedSettings.prefetch_window,
              );
            }
          }
        }
      } catch {
        // Ignore startup load errors when initializing empty state
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleOpenPath]);

  const handleOpenFile = useCallback(
    async (file: File, password: string | null = null) => {
      setErrorBanner(null);
      try {
        const opened = await readoraApi.openDocumentFile(file, password);
        setSession(opened);
        setRenderedState(null);
        setPendingPasswordPath(null);
        setPendingPasswordFile(null);
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
          const fallbackPath = `/documents/${file.name}`;
          if (err.code === "password_required") {
            setPendingPasswordPath(fallbackPath);
            setPendingPasswordFile(file);
            setPasswordError(null);
            return;
          }
          if (err.code === "incorrect_password") {
            setPendingPasswordPath(fallbackPath);
            setPendingPasswordFile(file);
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

  const handleCloseDocument = useCallback(async () => {
    if (!session) return;
    renderSeqRef.current += 1;
    setIsRendering(false);
    await readoraApi.closeDocument(session.descriptor.id);
    setSession(null);
    setRenderedState(null);
    setShowHighlightPopover(false);
    setPageText("");
    setSearchHits([]);
    setAnnotations([]);
    const recents = await readoraApi.listRecentDocuments(20);
    setRecentDocs(recents);
  }, [session]);

  const handleShowLibrary = useCallback(() => {
    setLibraryCollection("all");
    if (session) {
      void handleCloseDocument();
    }
  }, [handleCloseDocument, session]);

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
        if (
          action.kind === "go_to_page" ||
          action.kind === "next_page" ||
          action.kind === "previous_page"
        ) {
          setProgrammaticScrollTrigger((prev) => prev + 1);
        }
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

  const handleVisiblePageChange = useCallback(
    async (zeroBasedPage: number) => {
      if (!session || session.view_state.current_page === zeroBasedPage) {
        return;
      }
      try {
        const updatedView = await readoraApi.navigate(session.descriptor.id, {
          kind: "go_to_page",
          value: zeroBasedPage,
        });
        setSession((prev) =>
          prev ? { ...prev, view_state: updatedView } : null,
        );
        await loadVisiblePageAndPrefetch(
          session.descriptor.id,
          updatedView,
          settings.prefetch_window,
        );
      } catch {
        // Ignore transient scroll-driven navigation sync errors
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

  const handleToggleNotesPanel = useCallback(() => {
    const isCurrentlyVisible =
      showRightPanel || activeSidebar === "bookmarks";
    if (isCurrentlyVisible) {
      setShowRightPanel(false);
      setActiveSidebar((prev) => (prev === "bookmarks" ? null : prev));
    } else {
      setRequestedNotesTab("notes");
      setRequestedNotesTabTrigger((c) => c + 1);
      setShowRightPanel(true);
    }
  }, [activeSidebar, showRightPanel]);

  const handleFocusCommentComposer = useCallback(() => {
    setRequestedNotesTab("notes");
    setRequestedNotesTabTrigger((c) => c + 1);
    setShowRightPanel(true);
    window.setTimeout(() => {
      const commentInput = document.querySelector<HTMLInputElement>(
        'input[aria-label="New comment"]',
      );
      commentInput?.focus();
    }, 0);
  }, []);

  const handleOpenDocumentDetails = useCallback(() => {
    setRequestedNotesTab("details");
    setRequestedNotesTabTrigger((c) => c + 1);
    setShowRightPanel(true);
  }, []);

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
      const safeQuote = quoteText.trim().slice(0, MAX_HIGHLIGHT_EXCERPT_LEN);
      const safeNote = noteText.trim().slice(0, 1000);
      const created = await readoraApi.upsertAnnotation({
        document_id: session.descriptor.id,
        page_index: session.view_state.current_page,
        kind,
        color_hex: colorHex,
        quote_text: safeQuote,
        note_text: safeNote,
      });
      setAnnotations((prev) =>
        [...prev, created].sort((a, b) => a.page_index - b.page_index),
      );
      setStatusMessage(
        kind === "comment" ? "Saved comment" : "Saved page highlight",
      );
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to save annotation",
      );
    }
  };

  const handleAddComment = (noteText: string) => {
    if (!session) return;
    const excerpt = buildSafeQuoteExcerpt(
      pageText,
      session.view_state.current_page,
    );
    void handleCreateAnnotation("comment", "#9bc8e0", excerpt, noteText);
  };

  const handleDeleteAnnotation = async (annotationId: string) => {
    if (!session) return;
    await readoraApi.deleteAnnotation(annotationId);
    setAnnotations((prev) => prev.filter((a) => a.id !== annotationId));
  };

  const handleSearch = async (query: string, caseSensitive: boolean) => {
    if (!session) return;
    const requestGen = ++searchRequestGenRef.current;
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchHits([]);
      setActiveSearchHitIndex(0);
      return;
    }
    const hits = await readoraApi.searchDocument({
      document_id: session.descriptor.id,
      query,
      case_sensitive: caseSensitive,
      max_hits: 100,
    });
    if (requestGen !== searchRequestGenRef.current) {
      return;
    }
    setSearchHits(hits);
    setActiveSearchHitIndex(0);
    setStatusMessage(`Found ${hits.length} match(es)`);
  };

  const handleSavePreferences = async (patch: SettingsPatchDto) => {
    const updated = await readoraApi.updateSettings(patch);
    setSettings(updated);
    if (patch.auto_check_updates === false) {
      setUpdateStatus((prev) =>
        prev ? { ...prev, update_available: false } : null,
      );
    } else if (patch.auto_check_updates === true) {
      const status = await readoraApi.checkForUpdates(false);
      setUpdateStatus(status);
    }
    setShowPreferences(false);
    setStatusMessage("Preferences saved");
  };

  const handleCheckForUpdates = async () => {
    try {
      const status = await readoraApi.checkForUpdates(true);
      setUpdateStatus(status);
      setShowUpdateDialog(true);
      setStatusMessage(
        status.update_available && status.latest_version
          ? `Update available: Focus Reader ${status.latest_version}`
          : `Focus Reader ${status.current_version} is up to date`,
      );
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to check for updates",
      );
    }
  };

  const handleInstallUpdate = async (version: string) => {
    try {
      const nextStatus = await readoraApi.installUpdate(version);
      const updatedSettings = await readoraApi.getSettings();
      setUpdateStatus(nextStatus);
      setSettings(updatedSettings);
      setShowUpdateDialog(false);
      setStatusMessage(
        `Focus Reader ${nextStatus.current_version} staged — will apply on next launch`,
      );
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to install update",
      );
    }
  };

  const handleDismissUpdate = async (version: string) => {
    try {
      const nextStatus = await readoraApi.dismissUpdate(version);
      setUpdateStatus(nextStatus);
      setShowUpdateDialog(false);
      setStatusMessage(`Deferred Focus Reader ${version} update`);
    } catch {
      setShowUpdateDialog(false);
    }
  };

  const handleCleanupAppData = async () => {
    renderSeqRef.current += 1;
    setIsRendering(false);
    const report = await readoraApi.cleanupApplicationData();
    const freshSettings = await readoraApi.getSettings();
    const freshUpdateStatus =
      freshSettings.auto_check_updates === true
        ? await readoraApi.checkForUpdates(false)
        : null;
    setSession(null);
    setRenderedState(null);
    setShowHighlightPopover(false);
    setPageText("");
    setSearchHits([]);
    setAnnotations([]);
    setRecentDocs([]);
    setSettings(freshSettings);
    setUpdateStatus(freshUpdateStatus);
    setShowPreferences(false);
    setStatusMessage(
      `Cleaned up Readora database (${report.removed_database_files} files) and cache (${report.removed_cache_entries} entries) — PDF files on disk untouched`,
    );
  };

  const resolvedTheme: "light" | "dark" =
    settings.theme === "system"
      ? osPrefersDark
        ? "dark"
        : "light"
      : settings.theme;

  const handleToggleTheme = async () => {
    const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
    const updated = await readoraApi.updateSettings({ theme: nextTheme });
    setSettings(updated);
  };

  const handleCopyText = async () => {
    const selected = getWindowSelectedText();
    const textToCopy = selected || pageText;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(textToCopy);
      } catch {
        // Ignore clipboard permission restrictions in headless test environments
      }
    }
    setStatusMessage(
      selected ? "Copied selected text" : "Copied current page text",
    );
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
      renderSeqRef.current += 1;
      await readoraApi.closeDocument(documentId);
      setSession(null);
      setRenderedState(null);
      setPageText("");
    }
    const recents = await readoraApi.listRecentDocuments(20);
    setRecentDocs(recents);
    setStatusMessage(
      isArchived ? "Moved document to archive" : "Restored document to library",
    );
  };

  const handleDeleteRecentDocument = async (documentId: string) => {
    if (settings.confirm_before_delete) {
      const confirmed =
        typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm(
              "Permanently remove this document from your library history?",
            )
          : true;
      if (!confirmed) {
        return;
      }
    }
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
      triggerMarkdownDownload(bundle.file_name, bundle.markdown_content);
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

  const handleCopyShareLink = async (citation: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(citation);
      } catch {
        // Ignore clipboard permission errors in test environment
      }
    }
    setStatusMessage(`Copied citation: ${citation}`);
  };

  const currentDocIsFavorite = Boolean(
    session &&
      recentDocs.find((r) => r.document_id === session.descriptor.id)
        ?.is_favorite,
  );

  const hasOpenModal = Boolean(
    showPrintDialog ||
      showImportDialog ||
      showShareDialog ||
      showUpdateDialog ||
      showPreferences ||
      pendingPasswordPath,
  );

  useGlobalReaderShortcuts({
    session,
    hasOpenModal,
    setActiveSidebar,
    setShowImportDialog,
    setShowPrintDialog,
    setShowShareDialog,
    onToggleNotesPanel: handleToggleNotesPanel,
    onNextPage: () => void dispatchNavigation({ kind: "next_page" }),
    onPrevPage: () => void dispatchNavigation({ kind: "previous_page" }),
    onZoomIn: () => void dispatchNavigation({ kind: "step_zoom_in" }),
    onZoomOut: () => void dispatchNavigation({ kind: "step_zoom_out" }),
    onSetZoom: (z) => void dispatchNavigation({ kind: "set_zoom", value: z }),
    onSetFitMode: (m) =>
      void dispatchNavigation({ kind: "set_fit_mode", value: m }),
    onRotateCw: () => void dispatchNavigation({ kind: "rotate_clockwise" }),
    onRotateCcw: () =>
      void dispatchNavigation({ kind: "rotate_counter_clockwise" }),
    onCloseDocument: () => void handleCloseDocument(),
    onShowLibrary: handleShowLibrary,
    onOpenPreferences: () => {
      setPreferencesSection("appearance");
      setShowPreferences(true);
    },
    onOpenDocumentDetails: handleOpenDocumentDetails,
    onToggleHighlightOptions: () => setShowHighlightPopover((prev) => !prev),
    onFocusCommentComposer: handleFocusCommentComposer,
  });

  const showBookmarksPanel = activeSidebar === "bookmarks" || showRightPanel;

  const activeRenderedPage: RenderedPageResultDto | null =
    session &&
    renderedState &&
    renderedState.result.document_id === session.descriptor.id &&
    Math.abs(renderedState.zoom - session.view_state.zoom) < 0.001 &&
    renderedState.rotation === session.view_state.rotation &&
    renderedState.renderMode === session.view_state.render_mode
      ? renderedState.result
      : null;

  return (
    <div
      className={`app-shell theme-${resolvedTheme}`}
      data-testid="app-shell"
      data-print-annotations={printIncludeAnnotations ? "true" : "false"}
    >
      <ReaderToolbar
        fileName={session?.descriptor.file_name ?? null}
        fileSizeBytes={session?.descriptor.file_size_bytes ?? null}
        viewState={session?.view_state ?? null}
        activeSidebar={activeSidebar}
        showRightPanel={showBookmarksPanel}
        onToggleSidebar={handleToggleSidebar}
        onToggleRightPanel={handleToggleNotesPanel}
        onCloseDocument={() => void handleCloseDocument()}
        onShowLibraryRecents={handleShowLibrary}
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
        onOpenAbout={() => {
          setPreferencesSection("about");
          setShowPreferences(true);
        }}
        onOpenImportDialog={() => setShowImportDialog(true)}
        onOpenShare={session ? () => setShowShareDialog(true) : undefined}
        onCopyPageText={() => void handleCopyText()}
        onFocusCommentComposer={
          session ? handleFocusCommentComposer : undefined
        }
        hasUpdateAvailable={Boolean(updateStatus?.update_available)}
        onOpenUpdateDialog={() => void handleCheckForUpdates()}
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
        onOpenDocumentDetails={session ? handleOpenDocumentDetails : undefined}
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
        <AppNavigationRail
          hasOpenSession={Boolean(session)}
          showBookmarksPanel={showBookmarksPanel}
          libraryCollection={libraryCollection}
          recentDocs={recentDocs}
          onOpenRecentPath={(path) => void handleOpenPath(path)}
          onOpenImportDialog={() => setShowImportDialog(true)}
          onToggleBookmarksSidebar={handleToggleNotesPanel}
          onSetLibraryCollection={setLibraryCollection}
          onCloseDocument={() => void handleCloseDocument()}
        />

        {session ? (
          <div className="reader-workspace">
            {activeSidebar === "thumbnails" && (
              <ThumbnailsPanel
                documentId={session.descriptor.id}
                documentTitle={
                  session.descriptor.metadata.title ||
                  session.descriptor.file_name
                }
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
                  activeHitIndex={activeSearchHitIndex}
                  onActiveHitChange={(idx) => setActiveSearchHitIndex(idx)}
                  onSearch={(q, cs) => void handleSearch(q, cs)}
                  onSelectHit={(p) =>
                    void dispatchNavigation({ kind: "go_to_page", value: p })
                  }
                  onClose={() => {
                    setSearchHits([]);
                    setActiveSearchHitIndex(0);
                    setActiveSidebar("thumbnails");
                  }}
                />
              )}

              <PageViewport
                viewState={session.view_state}
                renderedPage={activeRenderedPage}
                pageText={pageText}
                prefetchWindow={settings.prefetch_window}
                programmaticScrollTrigger={programmaticScrollTrigger}
                showExtractedTextLayer={Boolean(
                  settings.show_extracted_text_layer,
                )}
                documentTitle={
                  session.descriptor.metadata.title ||
                  session.descriptor.file_name
                }
                isLoading={isRendering}
                annotations={annotations}
                searchHits={searchHits}
                activeSearchHitIndex={activeSearchHitIndex}
                showHighlightPopover={showHighlightPopover}
                setShowHighlightPopover={setShowHighlightPopover}
                onCopyText={() => void handleCopyText()}
                onVisiblePageChange={(p) => void handleVisiblePageChange(p)}
                onNextPage={() =>
                  void dispatchNavigation({ kind: "next_page" })
                }
                onPrevPage={() =>
                  void dispatchNavigation({ kind: "previous_page" })
                }
                onZoomIn={() =>
                  void dispatchNavigation({ kind: "step_zoom_in" })
                }
                onZoomOut={() =>
                  void dispatchNavigation({ kind: "step_zoom_out" })
                }
                onQuickAddNote={handleFocusCommentComposer}
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
                requestedTab={requestedNotesTab}
                requestedTabTrigger={requestedNotesTabTrigger}
                onAddBookmark={(label) => void handleAddBookmark(label)}
                onAddComment={handleAddComment}
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
            onOpenImportDialog={() => setShowImportDialog(true)}
            onOpenRecent={(path) => void handleOpenPath(path)}
            onOpenFile={(file) => void handleOpenFile(file)}
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
          renderedPage={activeRenderedPage}
          onClose={() => setShowPrintDialog(false)}
          onConfirmPrint={(summary, includeAnn) => {
            setPrintIncludeAnnotations(includeAnn);
            setShowPrintDialog(false);
            setStatusMessage(summary);
            if (
              typeof window !== "undefined" &&
              typeof window.print === "function" &&
              !isJsdomEnvironment()
            ) {
              window.setTimeout(() => {
                window.print();
              }, 0);
            }
          }}
        />
      )}

      {showImportDialog && (
        <ImportPdfDialog
          onImportFile={(file) => {
            setShowImportDialog(false);
            void handleOpenFile(file);
          }}
          onClose={() => setShowImportDialog(false)}
        />
      )}

      {showShareDialog && session && (
        <ShareDialog
          descriptor={session.descriptor}
          onExportAnnotations={(inc) => void handleExportAnnotations(inc)}
          onCopyShareLink={(citation) => void handleCopyShareLink(citation)}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      {showUpdateDialog && updateStatus && (
        <UpdateDialog
          updateStatus={updateStatus}
          onConfirmInstall={(version) => void handleInstallUpdate(version)}
          onDismiss={(version) => void handleDismissUpdate(version)}
          onCheckAgain={() => void handleCheckForUpdates()}
          onClose={() => setShowUpdateDialog(false)}
        />
      )}

      {pendingPasswordPath && (
        <OpenPasswordDialog
          pendingPath={pendingPasswordPath}
          errorMessage={passwordError}
          onSubmitPassword={(pw) => {
            if (pendingPasswordFile) {
              void handleOpenFile(pendingPasswordFile, pw);
            } else {
              void handleOpenPath(pendingPasswordPath, pw);
            }
          }}
          onCancel={() => {
            setPendingPasswordPath(null);
            setPendingPasswordFile(null);
            setPasswordError(null);
          }}
        />
      )}

      {showPreferences && (
        <PreferencesDialog
          settings={settings}
          initialSection={preferencesSection}
          onSave={(patch) => void handleSavePreferences(patch)}
          onCleanupAppData={() => void handleCleanupAppData()}
          onClose={() => setShowPreferences(false)}
        />
      )}

      <StatusBar
        descriptor={session?.descriptor ?? null}
        viewState={session?.view_state ?? null}
        renderedPage={activeRenderedPage}
        statusMessage={statusMessage}
      />
    </div>
  );
};
