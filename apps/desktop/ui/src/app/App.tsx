import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookmarksPanel } from "../features/bookmarks/BookmarksPanel";
import { OutlinePanel } from "../features/navigation/OutlinePanel";
import { ThumbnailsPanel } from "../features/navigation/ThumbnailsPanel";
import { AppNavigationRail } from "../features/reader/AppNavigationRail";
import {
  buildSafeQuoteExcerpt,
  getWindowSelectedText,
  MAX_ANNOTATION_NOTE_LEN,
  MAX_HIGHLIGHT_EXCERPT_LEN,
  sliceByUnicodeCodePoints,
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
import { ZOOM_PRESETS } from "../lib/pdf/textSearch";
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

interface PreparedPrintPage {
  pageIndex: number;
  dataUrl: string;
}

const SCROLL_NAV_DEBOUNCE_MS = 100;

function isCommandError(err: unknown): err is CommandErrorDto {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err
  );
}

function formatUpdateOutcomeBanner(
  version: string,
  outcome: AppUpdateStatusDto["install_outcome"],
): string {
  switch (outcome) {
    case "restarting":
      return `Applying verified update ${version} — restarting...`;
    case "downloaded_installer":
      return `Verified update ${version} downloaded — run installer from Updates folder`;
    case "opened_release":
      return `Opened GitHub release page for ${version}`;
    case "staged":
    default:
      return `Focus Reader ${version} staged — will apply on next launch`;
  }
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
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = sanitizedFileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => {
    if (typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(objectUrl);
    }
  }, 10_000);
}

export const App: React.FC = () => {
  const [session, setSession] = useState<DocumentSessionDto | null>(null);
  const [effectiveZoom, setEffectiveZoom] = useState<number>(1.0);
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
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);
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
  const [printPages, setPrintPages] = useState<PreparedPrintPage[] | null>(
    null,
  );
  const [searchHits, setSearchHits] = useState<SearchHitDto[]>([]);
  const [activeSearchHitIndex, setActiveSearchHitIndex] = useState<number>(0);
  const searchRequestGenRef = useRef<number>(0);
  const renderSeqRef = useRef<number>(0);
  const scrollNavTimerRef = useRef<number | null>(null);
  const scrollNavSeqRef = useRef<number>(0);
  const effectiveZoomRef = useRef<number>(1.0);
  const sessionRef = useRef<DocumentSessionDto | null>(null);
  const settingsRef = useRef<AppSettingsDto>(settings);
  const bootstrappedRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const printRootRef = useRef<HTMLDivElement | null>(null);
  const printCacheRef = useRef<Map<string, string>>(new Map());

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

  sessionRef.current = session;
  settingsRef.current = settings;

  const cancelPendingScrollNav = useCallback(() => {
    scrollNavSeqRef.current += 1;
    if (scrollNavTimerRef.current !== null) {
      window.clearTimeout(scrollNavTimerRef.current);
      scrollNavTimerRef.current = null;
    }
  }, []);

  const closeAllModals = useCallback(() => {
    setShowPrintDialog(false);
    setShowImportDialog(false);
    setShowShareDialog(false);
    setShowUpdateDialog(false);
    setShowPreferences(false);
    setPendingPasswordPath(null);
    setPendingPasswordFile(null);
    setPasswordError(null);
    setShowHighlightPopover(false);
  }, []);

  const openPreferencesModal = useCallback(
    (section: PreferencesSection) => {
      closeAllModals();
      setPreferencesSection(section);
      setShowPreferences(true);
    },
    [closeAllModals],
  );

  const openImportModal = useCallback(() => {
    closeAllModals();
    setShowImportDialog(true);
  }, [closeAllModals]);

  const openPrintModal = useCallback(() => {
    closeAllModals();
    setShowPrintDialog(true);
  }, [closeAllModals]);

  const openShareModal = useCallback(() => {
    closeAllModals();
    setShowShareDialog(true);
  }, [closeAllModals]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (scrollNavTimerRef.current !== null) {
        window.clearTimeout(scrollNavTimerRef.current);
        scrollNavTimerRef.current = null;
      }
    };
  }, []);

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
    async (
      docId: string,
      viewState: ViewStateDto,
      prefetchWindow: number,
      targetScale?: number,
      quietBackground = false,
    ) => {
      const renderScale = targetScale ?? effectiveZoomRef.current ?? viewState.zoom;
      const seq = ++renderSeqRef.current;
      if (!quietBackground) {
        setIsRendering(true);
      }
      try {
        const rotationDegrees = rotationToDegrees(viewState.rotation);
        const [renderResult, extractedText] = await Promise.all([
          readoraApi.renderPage({
            document_id: docId,
            page_index: viewState.current_page,
            scale: renderScale,
            rotation_degrees: rotationDegrees,
            render_mode: viewState.render_mode,
            generation: null,
          }),
          readoraApi.extractPageText(docId, viewState.current_page),
        ]);
        if (seq !== renderSeqRef.current || !isMountedRef.current) {
          return;
        }
        setRenderedState({
          result: renderResult,
          zoom: renderScale,
          rotation: viewState.rotation,
          renderMode: viewState.render_mode,
        });
        setPageText(extractedText);

        // In single-page mode, prefetch adjacent pages within configured window at effectiveZoom.
        // In continuous mode, PageViewport renders neighbor sheets directly without duplicate loops.
        if (viewState.layout_mode === "single_page") {
          for (let offset = 1; offset <= prefetchWindow; offset += 1) {
            const nextIdx = viewState.current_page + offset;
            if (nextIdx < viewState.page_count) {
              void readoraApi
                .renderPage({
                  document_id: docId,
                  page_index: nextIdx,
                  scale: renderScale,
                  rotation_degrees: rotationDegrees,
                  render_mode: viewState.render_mode,
                  generation: null,
                })
                .catch(() => {});
            }
            const prevIdx = viewState.current_page - offset;
            if (prevIdx >= 0) {
              void readoraApi
                .renderPage({
                  document_id: docId,
                  page_index: prevIdx,
                  scale: renderScale,
                  rotation_degrees: rotationDegrees,
                  render_mode: viewState.render_mode,
                  generation: null,
                })
                .catch(() => {});
            }
          }
        }
      } catch (err) {
        if (seq !== renderSeqRef.current || !isMountedRef.current) {
          return;
        }
        if (isCommandError(err) && err.code === "cancelled") {
          return;
        }
        if (!quietBackground) {
          setErrorBanner(
            isCommandError(err) ? err.message : "Failed to render PDF page",
          );
        }
      } finally {
        if (seq === renderSeqRef.current && isMountedRef.current) {
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
      silentStartup = false,
    ) => {
      cancelPendingScrollNav();
      if (!silentStartup) {
        setErrorBanner(null);
      }
      try {
        const opened = await readoraApi.openDocument({ path, password });
        if (!isMountedRef.current) return;
        if (silentStartup && sessionRef.current !== null) {
          return;
        }
        effectiveZoomRef.current = opened.view_state.zoom;
        setEffectiveZoom(opened.view_state.zoom);
        setSession(opened);
        setRenderedState(null);
        setPendingPasswordPath(null);
        setPendingPasswordFile(null);
        setPasswordError(null);
        setIsSearchOpen(false);
        setSearchHits([]);
        setActiveSearchHitIndex(0);
        printCacheRef.current.clear();
        await loadVisiblePageAndPrefetch(
          opened.descriptor.id,
          opened.view_state,
          prefetchOverride ?? settingsRef.current.prefetch_window,
          opened.view_state.zoom,
        );
        const [recents, loadedAnnotations] = await Promise.all([
          readoraApi.listRecentDocuments(20),
          readoraApi.listAnnotations(opened.descriptor.id),
        ]);
        if (!isMountedRef.current) return;
        setRecentDocs(recents);
        setAnnotations(loadedAnnotations);
      } catch (err) {
        if (!isMountedRef.current) return;
        if (silentStartup) {
          try {
            const refreshedRecents = await readoraApi.listRecentDocuments(20);
            if (isMountedRef.current) {
              setRecentDocs(refreshedRecents);
            }
          } catch {
            // Ignore background refresh error during silent startup
          }
          return;
        }
        if (isCommandError(err)) {
          if (err.code === "password_required") {
            closeAllModals();
            setPendingPasswordPath(path);
            setPendingPasswordFile(null);
            setPasswordError(null);
            return;
          }
          if (err.code === "incorrect_password") {
            closeAllModals();
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
    [cancelPendingScrollNav, closeAllModals, loadVisiblePageAndPrefetch],
  );

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    void (async () => {
      try {
        const [recents, loadedSettings] = await Promise.all([
          readoraApi.listRecentDocuments(20),
          readoraApi.getSettings(),
        ]);
        if (!isMountedRef.current) return;
        setRecentDocs(recents);
        setSettings(loadedSettings);

        if (loadedSettings.auto_check_updates === true) {
          const status = await readoraApi.checkForUpdates(false);
          if (isMountedRef.current) {
            setUpdateStatus(status);
          }
        } else {
          setUpdateStatus(null);
        }

        if (loadedSettings.reopen_last_document === true) {
          const candidate = recents.find(
            (item) => !item.is_archived && item.file_path.trim().length > 0,
          );
          if (candidate && isMountedRef.current && sessionRef.current === null) {
            await handleOpenPath(
              candidate.file_path,
              null,
              loadedSettings.prefetch_window,
              true,
            );
          }
        }
      } catch {
        // Ignore startup load errors when initializing empty state
      }
    })();
  }, [handleOpenPath]);

  const handleOpenFile = useCallback(
    async (file: File, password: string | null = null) => {
      cancelPendingScrollNav();
      setErrorBanner(null);
      try {
        const opened = await readoraApi.openDocumentFile(file, password);
        if (!isMountedRef.current) return;
        effectiveZoomRef.current = opened.view_state.zoom;
        setEffectiveZoom(opened.view_state.zoom);
        setSession(opened);
        setRenderedState(null);
        setPendingPasswordPath(null);
        setPendingPasswordFile(null);
        setPasswordError(null);
        setIsSearchOpen(false);
        setSearchHits([]);
        setActiveSearchHitIndex(0);
        printCacheRef.current.clear();
        await loadVisiblePageAndPrefetch(
          opened.descriptor.id,
          opened.view_state,
          settingsRef.current.prefetch_window,
          opened.view_state.zoom,
        );
        const [recents, loadedAnnotations] = await Promise.all([
          readoraApi.listRecentDocuments(20),
          readoraApi.listAnnotations(opened.descriptor.id),
        ]);
        if (!isMountedRef.current) return;
        setRecentDocs(recents);
        setAnnotations(loadedAnnotations);
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isCommandError(err)) {
          const fallbackPath = `/documents/${file.name}`;
          if (err.code === "password_required") {
            closeAllModals();
            setPendingPasswordPath(fallbackPath);
            setPendingPasswordFile(file);
            setPasswordError(null);
            return;
          }
          if (err.code === "incorrect_password") {
            closeAllModals();
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
    [cancelPendingScrollNav, closeAllModals, loadVisiblePageAndPrefetch],
  );

  const handleCloseDocument = useCallback(async () => {
    if (!session) return;
    cancelPendingScrollNav();
    renderSeqRef.current += 1;
    setIsRendering(false);
    await readoraApi.closeDocument(session.descriptor.id);
    setSession(null);
    effectiveZoomRef.current = 1.0;
    setEffectiveZoom(1.0);
    setRenderedState(null);
    setShowHighlightPopover(false);
    setIsSearchOpen(false);
    setPageText("");
    setSearchHits([]);
    setActiveSearchHitIndex(0);
    setAnnotations([]);
    setPrintPages(null);
    printCacheRef.current.clear();
    const recents = await readoraApi.listRecentDocuments(20);
    setRecentDocs(recents);
  }, [cancelPendingScrollNav, session]);

  const handleShowLibrary = useCallback(() => {
    setLibraryCollection("all");
    if (session) {
      void handleCloseDocument();
    }
  }, [handleCloseDocument, session]);

  const handleEffectiveZoomChange = useCallback(
    (nextEffectiveZoom: number) => {
      if (Math.abs(nextEffectiveZoom - effectiveZoomRef.current) < 0.005) {
        return;
      }
      effectiveZoomRef.current = nextEffectiveZoom;
      setEffectiveZoom(nextEffectiveZoom);
      const currentSession = sessionRef.current;
      if (currentSession) {
        void loadVisiblePageAndPrefetch(
          currentSession.descriptor.id,
          currentSession.view_state,
          settingsRef.current.prefetch_window,
          nextEffectiveZoom,
        );
      }
    },
    [loadVisiblePageAndPrefetch],
  );

  const dispatchNavigation = useCallback(
    async (action: NavigationActionDto) => {
      if (!session) return;
      cancelPendingScrollNav();
      try {
        const updatedView = await readoraApi.navigate(
          session.descriptor.id,
          action,
        );
        let targetScale = effectiveZoomRef.current;
        if (updatedView.fit_mode === "manual") {
          targetScale = updatedView.zoom;
          effectiveZoomRef.current = updatedView.zoom;
          setEffectiveZoom(updatedView.zoom);
        } else if (
          action.kind === "set_fit_mode" &&
          Math.abs(effectiveZoomRef.current - session.view_state.zoom) < 0.005
        ) {
          targetScale = updatedView.zoom;
          effectiveZoomRef.current = updatedView.zoom;
          setEffectiveZoom(updatedView.zoom);
        }
        setSession((prev) =>
          prev && prev.descriptor.id === session.descriptor.id
            ? { ...prev, view_state: updatedView }
            : prev,
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
          targetScale,
        );
      } catch (err) {
        setErrorBanner(
          isCommandError(err) ? err.message : "Navigation update failed",
        );
      }
    },
    [
      cancelPendingScrollNav,
      loadVisiblePageAndPrefetch,
      session,
      settings.prefetch_window,
    ],
  );

  const handleZoomIn = useCallback(() => {
    if (!session) return;
    if (
      session.view_state.fit_mode !== "manual" &&
      Math.abs(effectiveZoom - session.view_state.zoom) > 0.02
    ) {
      const targetZoom =
        ZOOM_PRESETS.find((p) => p > effectiveZoom + 0.01) ?? 5.0;
      void dispatchNavigation({ kind: "set_zoom", value: targetZoom });
      return;
    }
    void dispatchNavigation({ kind: "step_zoom_in" });
  }, [dispatchNavigation, effectiveZoom, session]);

  const handleZoomOut = useCallback(() => {
    if (!session) return;
    if (
      session.view_state.fit_mode !== "manual" &&
      Math.abs(effectiveZoom - session.view_state.zoom) > 0.02
    ) {
      const targetZoom =
        [...ZOOM_PRESETS].reverse().find((p) => p < effectiveZoom - 0.01) ??
        0.25;
      void dispatchNavigation({ kind: "set_zoom", value: targetZoom });
      return;
    }
    void dispatchNavigation({ kind: "step_zoom_out" });
  }, [dispatchNavigation, effectiveZoom, session]);

  const handleVisiblePageChange = useCallback(
    (zeroBasedPage: number) => {
      const currentSession = sessionRef.current;
      if (
        !currentSession ||
        currentSession.view_state.current_page === zeroBasedPage
      ) {
        return;
      }
      const docId = currentSession.descriptor.id;
      if (scrollNavTimerRef.current !== null) {
        window.clearTimeout(scrollNavTimerRef.current);
      }
      const seq = ++scrollNavSeqRef.current;
      scrollNavTimerRef.current = window.setTimeout(() => {
        scrollNavTimerRef.current = null;
        void (async () => {
          const liveSession = sessionRef.current;
          if (
            !isMountedRef.current ||
            seq !== scrollNavSeqRef.current ||
            !liveSession ||
            liveSession.descriptor.id !== docId ||
            liveSession.view_state.current_page === zeroBasedPage
          ) {
            return;
          }
          try {
            const updatedView = await readoraApi.navigate(docId, {
              kind: "go_to_page",
              value: zeroBasedPage,
            });
            if (
              !isMountedRef.current ||
              seq !== scrollNavSeqRef.current ||
              sessionRef.current?.descriptor.id !== docId
            ) {
              return;
            }
            setSession((prev) =>
              prev && prev.descriptor.id === docId
                ? { ...prev, view_state: updatedView }
                : prev,
            );
            await loadVisiblePageAndPrefetch(
              docId,
              updatedView,
              settingsRef.current.prefetch_window,
              effectiveZoomRef.current,
              true,
            );
          } catch {
            // Ignore transient scroll-driven navigation sync errors
          }
        })();
      }, SCROLL_NAV_DEBOUNCE_MS);
    },
    [loadVisiblePageAndPrefetch],
  );

  const handleToggleSidebar = (tab: Exclude<SidebarTab, null>) => {
    if (tab === "bookmarks") {
      setShowRightPanel(false);
    }
    setActiveSidebar((prev) => (prev === tab ? null : tab));
  };

  const handleCloseSearch = useCallback(() => {
    searchRequestGenRef.current += 1;
    setSearchHits([]);
    setActiveSearchHitIndex(0);
    setIsSearchOpen(false);
  }, []);

  const handleToggleSearch = useCallback(() => {
    setIsSearchOpen((prev) => {
      if (prev) {
        searchRequestGenRef.current += 1;
        setSearchHits([]);
        setActiveSearchHitIndex(0);
        return false;
      }
      return true;
    });
  }, []);

  const handleOpenSearch = useCallback(() => {
    setIsSearchOpen(true);
    window.setTimeout(() => {
      const existingInput = document.querySelector<HTMLInputElement>(
        ".search-popover-input",
      );
      existingInput?.focus();
      existingInput?.select();
    }, 0);
  }, []);

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
      const commentInput = document.querySelector<HTMLElement>(
        '[aria-label="New comment"]',
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
      const safeQuote = sliceByUnicodeCodePoints(
        quoteText.trim(),
        MAX_HIGHLIGHT_EXCERPT_LEN,
      );
      const safeNote = sliceByUnicodeCodePoints(
        noteText.trim(),
        MAX_ANNOTATION_NOTE_LEN,
      );
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
      closeAllModals();
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

  const handleInstallUpdate = async (version: string): Promise<void> => {
    try {
      const nextStatus = await readoraApi.installUpdate(version);
      const updatedSettings = await readoraApi.getSettings();
      setUpdateStatus(nextStatus);
      setSettings(updatedSettings);
      setShowUpdateDialog(false);
      setStatusMessage(
        formatUpdateOutcomeBanner(version, nextStatus.install_outcome),
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
    cancelPendingScrollNav();
    renderSeqRef.current += 1;
    setIsRendering(false);
    const report = await readoraApi.cleanupApplicationData();
    const freshSettings = await readoraApi.getSettings();
    const freshUpdateStatus =
      freshSettings.auto_check_updates === true
        ? await readoraApi.checkForUpdates(false)
        : null;
    setSession(null);
    effectiveZoomRef.current = 1.0;
    setEffectiveZoom(1.0);
    setRenderedState(null);
    setShowHighlightPopover(false);
    setIsSearchOpen(false);
    setPageText("");
    setSearchHits([]);
    setActiveSearchHitIndex(0);
    setAnnotations([]);
    setRecentDocs([]);
    setPrintPages(null);
    printCacheRef.current.clear();
    setSettings(freshSettings);
    setUpdateStatus(freshUpdateStatus);
    setShowPreferences(false);
    setStatusMessage(
      `Cleaned up Readora database (${report.removed_database_files} files) and cache (${report.removed_cache_entries} entries) — PDF files on disk untouched`,
    );
  };

  const handleExecutePrint = useCallback(
    async (
      pageIndices: number[],
      summary: string,
      includeAnn: boolean,
    ): Promise<void> => {
      if (!session) return;
      const docId = session.descriptor.id;
      const rotationDegrees = rotationToDegrees(session.view_state.rotation);
      setErrorBanner(null);

      try {
        const prepared: PreparedPrintPage[] = [];
        for (const pageIndex of pageIndices) {
          const cacheKey = `${docId}:${pageIndex}:${rotationDegrees}:1.50:standard`;
          const cachedUrl = printCacheRef.current.get(cacheKey);
          if (cachedUrl) {
            prepared.push({ pageIndex, dataUrl: cachedUrl });
            continue;
          }
          const rendered = await readoraApi.renderPage({
            document_id: docId,
            page_index: pageIndex,
            scale: 1.5,
            rotation_degrees: rotationDegrees,
            render_mode: "standard",
            generation: null,
          });
          printCacheRef.current.set(cacheKey, rendered.data_url);
          prepared.push({ pageIndex, dataUrl: rendered.data_url });
        }

        if (!isMountedRef.current) return;
        setPrintIncludeAnnotations(includeAnn);
        setPrintPages(prepared);

        // Wait one animation frame for React DOM commit and image decode
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        const rootEl = printRootRef.current;
        if (rootEl) {
          const imgs = Array.from(rootEl.querySelectorAll("img"));
          await Promise.race([
            Promise.allSettled(
              imgs.map((img) =>
                typeof img.decode === "function"
                  ? img.decode()
                  : Promise.resolve(),
              ),
            ),
            new Promise<void>((resolve) => setTimeout(resolve, 120)),
          ]);
        }

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        if (!isMountedRef.current) return;
        setShowPrintDialog(false);
        setStatusMessage(summary);

        const isMockedPrint =
          typeof window !== "undefined" &&
          typeof window.print === "function" &&
          "mock" in (window.print as unknown as Record<string, unknown>);
        if (
          typeof window !== "undefined" &&
          typeof window.print === "function" &&
          (!isJsdomEnvironment() || isMockedPrint)
        ) {
          window.print();
        }
      } catch (err) {
        if (isMountedRef.current) {
          setErrorBanner(
            isCommandError(err) ? err.message : "Failed to prepare pages for printing",
          );
        }
      } finally {
        if (isMountedRef.current) {
          setPrintPages(null);
        }
      }
    },
    [session],
  );

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
      cancelPendingScrollNav();
      renderSeqRef.current += 1;
      await readoraApi.closeDocument(documentId);
      setSession(null);
      effectiveZoomRef.current = 1.0;
      setEffectiveZoom(1.0);
      setRenderedState(null);
      setIsSearchOpen(false);
      setPageText("");
      setPrintPages(null);
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
        true,
      );
      if (!bundle.saved_path) {
        triggerMarkdownDownload(bundle.file_name, bundle.markdown_content);
      }
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
    onToggleSearch: handleToggleSearch,
    onOpenImportDialog: openImportModal,
    onOpenPrintDialog: openPrintModal,
    onOpenShareDialog: openShareModal,
    onToggleNotesPanel: handleToggleNotesPanel,
    onNextPage: () => void dispatchNavigation({ kind: "next_page" }),
    onPrevPage: () => void dispatchNavigation({ kind: "previous_page" }),
    onZoomIn: handleZoomIn,
    onZoomOut: handleZoomOut,
    onSetZoom: (z) => void dispatchNavigation({ kind: "set_zoom", value: z }),
    onSetFitMode: (m) =>
      void dispatchNavigation({ kind: "set_fit_mode", value: m }),
    onRotateCw: () => void dispatchNavigation({ kind: "rotate_clockwise" }),
    onRotateCcw: () =>
      void dispatchNavigation({ kind: "rotate_counter_clockwise" }),
    onCloseDocument: () => void handleCloseDocument(),
    onShowLibrary: handleShowLibrary,
    onOpenPreferences: () => openPreferencesModal("appearance"),
    onOpenDocumentDetails: handleOpenDocumentDetails,
    onToggleHighlightOptions: () => setShowHighlightPopover((prev) => !prev),
    onFocusCommentComposer: handleFocusCommentComposer,
  });

  const showBookmarksPanel = activeSidebar === "bookmarks" || showRightPanel;

  const activeRenderedPage: RenderedPageResultDto | null =
    session &&
    renderedState &&
    renderedState.result.document_id === session.descriptor.id &&
    Math.abs(renderedState.zoom - effectiveZoom) < 0.02 &&
    renderedState.rotation === session.view_state.rotation &&
    renderedState.renderMode === session.view_state.render_mode
      ? renderedState.result
      : null;

  return (
    <>
      <div
        className={`app-shell theme-${resolvedTheme}${
          printPages ? " has-active-print-root" : ""
        }`}
        data-testid="app-shell"
        data-print-annotations={printIncludeAnnotations ? "true" : "false"}
      >
        <ReaderToolbar
          fileName={session?.descriptor.file_name ?? null}
          fileSizeBytes={session?.descriptor.file_size_bytes ?? null}
          viewState={session?.view_state ?? null}
          displayZoom={effectiveZoom}
          activeSidebar={activeSidebar}
          isSearchOpen={isSearchOpen}
          hasOpenModal={hasOpenModal}
          showRightPanel={showBookmarksPanel}
          onToggleSidebar={handleToggleSidebar}
          onToggleSearch={handleToggleSearch}
          onOpenSearch={handleOpenSearch}
          onToggleRightPanel={handleToggleNotesPanel}
          onCloseDocument={() => void handleCloseDocument()}
          onShowLibraryRecents={handleShowLibrary}
          onPrevPage={() => void dispatchNavigation({ kind: "previous_page" })}
          onNextPage={() => void dispatchNavigation({ kind: "next_page" })}
          onGoToPage={(p) =>
            void dispatchNavigation({ kind: "go_to_page", value: p })
          }
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onSetZoom={(z) =>
            void dispatchNavigation({ kind: "set_zoom", value: z })
          }
          onSetFitMode={(m) =>
            void dispatchNavigation({ kind: "set_fit_mode", value: m })
          }
          onRotateCw={() =>
            void dispatchNavigation({ kind: "rotate_clockwise" })
          }
          onRotateCcw={() =>
            void dispatchNavigation({ kind: "rotate_counter_clockwise" })
          }
          onSetLayoutMode={(m) =>
            void dispatchNavigation({ kind: "set_layout_mode", value: m })
          }
          onSetRenderMode={(m) =>
            void dispatchNavigation({ kind: "set_render_mode", value: m })
          }
          onOpenPreferences={() => openPreferencesModal("appearance")}
          onOpenShortcuts={() => openPreferencesModal("shortcuts")}
          onOpenAbout={() => openPreferencesModal("about")}
          onOpenImportDialog={openImportModal}
          onOpenShare={session ? openShareModal : undefined}
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
              ? () =>
                  void handleSetDocumentArchived(session.descriptor.id, true)
              : undefined
          }
          onOpenPrint={session ? openPrintModal : undefined}
          onOpenDocumentDetails={
            session ? handleOpenDocumentDetails : undefined
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
          <AppNavigationRail
            hasOpenSession={Boolean(session)}
            showBookmarksPanel={showBookmarksPanel}
            libraryCollection={libraryCollection}
            recentDocs={recentDocs}
            onOpenRecentPath={(path) => void handleOpenPath(path)}
            onOpenImportDialog={openImportModal}
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
                {isSearchOpen && (
                  <SearchPanel
                    hits={searchHits}
                    activeHitIndex={activeSearchHitIndex}
                    onActiveHitChange={(idx) => setActiveSearchHitIndex(idx)}
                    onSearch={(q, cs) => void handleSearch(q, cs)}
                    onSelectHit={(p) =>
                      void dispatchNavigation({ kind: "go_to_page", value: p })
                    }
                    onClose={handleCloseSearch}
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
                  onEffectiveZoomChange={handleEffectiveZoomChange}
                  onCopyText={() => void handleCopyText()}
                  onVisiblePageChange={handleVisiblePageChange}
                  onNextPage={() =>
                    void dispatchNavigation({ kind: "next_page" })
                  }
                  onPrevPage={() =>
                    void dispatchNavigation({ kind: "previous_page" })
                  }
                  onZoomIn={handleZoomIn}
                  onZoomOut={handleZoomOut}
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
              onOpenImportDialog={openImportModal}
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
            onExecutePrint={handleExecutePrint}
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
            onConfirmInstall={(version) => handleInstallUpdate(version)}
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

      {printPages && session && (
        <div
          ref={printRootRef}
          className="print-document-root"
          data-testid="print-document-root"
          data-print-annotations={printIncludeAnnotations ? "true" : "false"}
          aria-label="Printable Document Pages"
        >
          {printPages.map((sheet) => {
            const sheetAnnotations = printIncludeAnnotations
              ? annotations.filter((ann) => ann.page_index === sheet.pageIndex)
              : [];
            return (
              <section
                key={`print-page-${sheet.pageIndex}`}
                className="print-page-sheet"
                data-page-index={sheet.pageIndex}
              >
                <img
                  src={sheet.dataUrl}
                  alt={`Print page ${sheet.pageIndex + 1}`}
                  className="print-page-img"
                />
                {sheetAnnotations.length > 0 && (
                  <div className="print-page-annotations">
                    {sheetAnnotations.map((ann) => (
                      <div key={ann.id} className="print-annotation-note">
                        <strong>{ann.kind.toUpperCase()}:</strong>{" "}
                        {ann.note_text || ann.quote_text}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
};
