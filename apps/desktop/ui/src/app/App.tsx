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
const MAX_PRINT_CACHE_ENTRIES = 64;

function toCachedPrintUrl(dataUrl: string): string {
  if (
    dataUrl.startsWith("data:image/") &&
    dataUrl.length > 256 &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof URL.revokeObjectURL === "function" &&
    typeof Blob === "function" &&
    typeof atob === "function"
  ) {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx > 0) {
      const meta = dataUrl.slice(5, commaIdx);
      const payload = dataUrl.slice(commaIdx + 1);
      if (meta.endsWith(";base64")) {
        try {
          const mime = meta.slice(0, -7) || "image/png";
          const binary = atob(payload);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          return URL.createObjectURL(new Blob([bytes], { type: mime }));
        } catch {
          return dataUrl;
        }
      }
    }
  }
  return dataUrl;
}

function revokeObjectUrlIfBlob(url: string | undefined): void {
  if (
    url &&
    url.startsWith("blob:") &&
    typeof URL !== "undefined" &&
    typeof URL.revokeObjectURL === "function"
  ) {
    URL.revokeObjectURL(url);
  }
}

function isCommandError(err: unknown): err is CommandErrorDto {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const candidate = err as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
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
    auto_check_updates: true,
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
  const openRequestSeqRef = useRef<number>(0);
  const renderSeqRef = useRef<number>(0);
  const navSeqRef = useRef<number>(0);
  const scrollNavTimerRef = useRef<number | null>(null);
  const scrollNavSeqRef = useRef<number>(0);
  const effectiveZoomRef = useRef<number>(1.0);
  const sessionRef = useRef<DocumentSessionDto | null>(null);
  const settingsRef = useRef<AppSettingsDto>(settings);
  const bootstrappedRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const printRootRef = useRef<HTMLDivElement | null>(null);
  const printCacheRef = useRef<Map<string, string>>(new Map());
  const printJobSeqRef = useRef<number>(0);
  const printCleanupTimerRef = useRef<number | null>(null);
  const printAfterHandlerRef = useRef<(() => void) | null>(null);

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

  const resolvedTheme: "light" | "dark" =
    settings.theme === "system"
      ? osPrefersDark
        ? "dark"
        : "light"
      : settings.theme;
  const resolvedThemeRef = useRef<"light" | "dark">(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;

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

  const clearPendingPrintCleanup = useCallback(() => {
    if (printCleanupTimerRef.current !== null) {
      window.clearTimeout(printCleanupTimerRef.current);
      printCleanupTimerRef.current = null;
    }
    if (
      typeof window !== "undefined" &&
      printAfterHandlerRef.current !== null
    ) {
      window.removeEventListener("afterprint", printAfterHandlerRef.current);
      printAfterHandlerRef.current = null;
    }
  }, []);

  const clearPrintCache = useCallback(() => {
    for (const url of printCacheRef.current.values()) {
      revokeObjectUrlIfBlob(url);
    }
    printCacheRef.current.clear();
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearPendingPrintCleanup();
      clearPrintCache();
      if (scrollNavTimerRef.current !== null) {
        window.clearTimeout(scrollNavTimerRef.current);
        scrollNavTimerRef.current = null;
      }
    };
  }, [clearPendingPrintCleanup, clearPrintCache]);

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
      const effectiveMode: RenderMode =
        viewState.render_mode === "grayscale"
          ? "grayscale"
          : viewState.render_mode === "dark_inversion" ||
              resolvedThemeRef.current === "dark"
            ? "dark_inversion"
            : "standard";
      const seq = ++renderSeqRef.current;
      if (!quietBackground) {
        setIsRendering(true);
      }
      try {
        const rotationDegrees = rotationToDegrees(viewState.rotation);
        const renderGeneration = viewState.generation ?? null;
        const [renderResult, extractedText] = await Promise.all([
          readoraApi.renderPage({
            document_id: docId,
            page_index: viewState.current_page,
            scale: renderScale,
            rotation_degrees: rotationDegrees,
            render_mode: effectiveMode,
            generation: renderGeneration,
          }),
          readoraApi.extractPageText(docId, viewState.current_page),
        ]);
        if (
          seq !== renderSeqRef.current ||
          !isMountedRef.current ||
          sessionRef.current?.descriptor.id !== docId
        ) {
          return;
        }
        setRenderedState({
          result: renderResult,
          zoom: renderScale,
          rotation: viewState.rotation,
          renderMode: effectiveMode,
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
                  render_mode: effectiveMode,
                  generation: renderGeneration,
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
                  render_mode: effectiveMode,
                  generation: renderGeneration,
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
      const openSeq = ++openRequestSeqRef.current;
      navSeqRef.current += 1;
      searchRequestGenRef.current += 1;
      printJobSeqRef.current += 1;
      clearPendingPrintCleanup();
      if (!silentStartup) {
        setErrorBanner(null);
      }
      try {
        const opened = await readoraApi.openDocument({ path, password });
        if (!isMountedRef.current || openSeq !== openRequestSeqRef.current) {
          void readoraApi.closeDocument(opened.descriptor.id).catch(() => {});
          return;
        }
        if (silentStartup && sessionRef.current !== null) {
          void readoraApi.closeDocument(opened.descriptor.id).catch(() => {});
          return;
        }
        const prevDocId = sessionRef.current?.descriptor.id;
        if (prevDocId && prevDocId !== opened.descriptor.id) {
          void readoraApi.closeDocument(prevDocId).catch(() => {});
        }
        renderSeqRef.current += 1;
        sessionRef.current = opened;
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
        setPrintPages(null);
        clearPrintCache();
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
        if (!isMountedRef.current || openSeq !== openRequestSeqRef.current) {
          return;
        }
        setRecentDocs(recents);
        setAnnotations(loadedAnnotations);
      } catch (err) {
        if (!isMountedRef.current || openSeq !== openRequestSeqRef.current) {
          return;
        }
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
    [
      cancelPendingScrollNav,
      clearPendingPrintCleanup,
      clearPrintCache,
      closeAllModals,
      loadVisiblePageAndPrefetch,
    ],
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

        if (loadedSettings.auto_check_updates !== false) {
          void readoraApi
            .checkForUpdates(false)
            .then((status) => {
              if (isMountedRef.current) {
                setUpdateStatus(status);
              }
            })
            .catch(() => {});
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
      const openSeq = ++openRequestSeqRef.current;
      navSeqRef.current += 1;
      searchRequestGenRef.current += 1;
      printJobSeqRef.current += 1;
      clearPendingPrintCleanup();
      setErrorBanner(null);
      try {
        const opened = await readoraApi.openDocumentFile(file, password);
        if (!isMountedRef.current || openSeq !== openRequestSeqRef.current) {
          void readoraApi.closeDocument(opened.descriptor.id).catch(() => {});
          return;
        }
        const prevDocId = sessionRef.current?.descriptor.id;
        if (prevDocId && prevDocId !== opened.descriptor.id) {
          void readoraApi.closeDocument(prevDocId).catch(() => {});
        }
        renderSeqRef.current += 1;
        sessionRef.current = opened;
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
        setPrintPages(null);
        clearPrintCache();
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
        if (!isMountedRef.current || openSeq !== openRequestSeqRef.current) {
          return;
        }
        setRecentDocs(recents);
        setAnnotations(loadedAnnotations);
      } catch (err) {
        if (!isMountedRef.current || openSeq !== openRequestSeqRef.current) {
          return;
        }
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
    [
      cancelPendingScrollNav,
      clearPendingPrintCleanup,
      clearPrintCache,
      closeAllModals,
      loadVisiblePageAndPrefetch,
    ],
  );

  const handleCloseDocument = useCallback(async () => {
    const activeDocId = sessionRef.current?.descriptor.id;
    if (!activeDocId) return;
    cancelPendingScrollNav();
    openRequestSeqRef.current += 1;
    navSeqRef.current += 1;
    searchRequestGenRef.current += 1;
    printJobSeqRef.current += 1;
    clearPendingPrintCleanup();
    renderSeqRef.current += 1;
    setIsRendering(false);
    try {
      await readoraApi.closeDocument(activeDocId);
      if (!isMountedRef.current) return;
      sessionRef.current = null;
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
      clearPrintCache();
      const recents = await readoraApi.listRecentDocuments(20);
      if (isMountedRef.current) {
        setRecentDocs(recents);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setErrorBanner(
          isCommandError(err) ? err.message : "Failed to close document",
        );
      }
    }
  }, [cancelPendingScrollNav, clearPendingPrintCleanup, clearPrintCache]);

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
      const targetDocId = session.descriptor.id;
      const prevZoom = session.view_state.zoom;
      const navSeq = ++navSeqRef.current;
      cancelPendingScrollNav();
      if (
        action.kind === "set_zoom" ||
        action.kind === "step_zoom_in" ||
        action.kind === "step_zoom_out" ||
        action.kind === "set_fit_mode" ||
        action.kind === "rotate_clockwise" ||
        action.kind === "rotate_counter_clockwise" ||
        action.kind === "set_render_mode"
      ) {
        void readoraApi.cancelRenders(targetDocId);
      }
      try {
        const updatedView = await readoraApi.navigate(targetDocId, action);
        if (
          !isMountedRef.current ||
          navSeq !== navSeqRef.current ||
          sessionRef.current?.descriptor.id !== targetDocId
        ) {
          return;
        }
        let targetScale = effectiveZoomRef.current;
        if (updatedView.fit_mode === "manual") {
          targetScale = updatedView.zoom;
          effectiveZoomRef.current = updatedView.zoom;
          setEffectiveZoom(updatedView.zoom);
        } else if (action.kind === "set_fit_mode") {
          const containerWidth =
            document.querySelector<HTMLElement>(".document-canvas-viewport")
              ?.clientWidth ?? 0;
          if (
            containerWidth === 0 ||
            Math.abs(effectiveZoomRef.current - prevZoom) < 0.005
          ) {
            targetScale = updatedView.zoom;
            effectiveZoomRef.current = updatedView.zoom;
            setEffectiveZoom(updatedView.zoom);
          }
        }
        setSession((prev) =>
          prev && prev.descriptor.id === targetDocId
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
          targetDocId,
          updatedView,
          settings.prefetch_window,
          targetScale,
        );
      } catch (err) {
        if (
          !isMountedRef.current ||
          navSeq !== navSeqRef.current ||
          sessionRef.current?.descriptor.id !== targetDocId
        ) {
          return;
        }
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
    const targetDocId = session.descriptor.id;
    try {
      const created = await readoraApi.upsertBookmark({
        document_id: targetDocId,
        page_index: session.view_state.current_page,
        label,
      });
      if (!isMountedRef.current) return;
      setSession((prev) => {
        if (!prev || prev.descriptor.id !== targetDocId) return prev;
        const filtered = prev.bookmarks.filter(
          (b) => b.page_index !== created.page_index,
        );
        const nextBookmarks = [...filtered, created].sort(
          (a, b) => a.page_index - b.page_index,
        );
        return { ...prev, bookmarks: nextBookmarks };
      });
      if (sessionRef.current?.descriptor.id === targetDocId) {
        setStatusMessage(`Saved bookmark "${created.label}"`);
      }
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to save bookmark",
      );
    }
  };

  const handleDeleteBookmark = async (bookmarkId: string) => {
    if (!session) return;
    const targetDocId = session.descriptor.id;
    try {
      await readoraApi.deleteBookmark(bookmarkId);
      if (!isMountedRef.current) return;
      setSession((prev) =>
        prev && prev.descriptor.id === targetDocId
          ? {
              ...prev,
              bookmarks: prev.bookmarks.filter((b) => b.id !== bookmarkId),
            }
          : prev,
      );
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to delete bookmark",
      );
    }
  };

  const handleCreateAnnotation = async (
    kind: AnnotationKind,
    colorHex: string,
    quoteText: string,
    noteText: string,
  ): Promise<boolean> => {
    if (!session) return false;
    const targetDocId = session.descriptor.id;
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
        document_id: targetDocId,
        page_index: session.view_state.current_page,
        kind,
        color_hex: colorHex,
        quote_text: safeQuote,
        note_text: safeNote,
      });
      if (!isMountedRef.current || sessionRef.current?.descriptor.id !== targetDocId) {
        return false;
      }
      setAnnotations((prev) =>
        [...prev, created].sort((a, b) => a.page_index - b.page_index),
      );
      setStatusMessage(
        kind === "comment" ? "Saved comment" : "Saved page highlight",
      );
      return true;
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to save annotation",
      );
      return false;
    }
  };

  const handleAddComment = (noteText: string): Promise<boolean> => {
    if (!session) return Promise.resolve(false);
    const excerpt = buildSafeQuoteExcerpt(
      pageText,
      session.view_state.current_page,
    );
    return handleCreateAnnotation("comment", "#9bc8e0", excerpt, noteText);
  };

  const handleDeleteAnnotation = async (annotationId: string) => {
    if (!session) return;
    const targetDocId = session.descriptor.id;
    try {
      await readoraApi.deleteAnnotation(annotationId);
      if (
        !isMountedRef.current ||
        sessionRef.current?.descriptor.id !== targetDocId
      ) {
        return;
      }
      setAnnotations((prev) => prev.filter((a) => a.id !== annotationId));
    } catch (err) {
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to delete annotation",
      );
    }
  };

  const handleSearch = async (query: string, caseSensitive: boolean) => {
    if (!session) return;
    const targetDocId = session.descriptor.id;
    const requestGen = ++searchRequestGenRef.current;
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchHits([]);
      setActiveSearchHitIndex(0);
      return;
    }
    try {
      const hits = await readoraApi.searchDocument({
        document_id: targetDocId,
        query,
        case_sensitive: caseSensitive,
        max_hits: 100,
      });
      if (
        !isMountedRef.current ||
        requestGen !== searchRequestGenRef.current ||
        sessionRef.current?.descriptor.id !== targetDocId
      ) {
        return;
      }
      setSearchHits(hits);
      setActiveSearchHitIndex(0);
      setStatusMessage(`Found ${hits.length} match(es)`);
    } catch (err) {
      if (
        !isMountedRef.current ||
        requestGen !== searchRequestGenRef.current ||
        sessionRef.current?.descriptor.id !== targetDocId
      ) {
        return;
      }
      setErrorBanner(
        isCommandError(err) ? err.message : "Failed to search document",
      );
    }
  };

  const handleSavePreferences = async (patch: SettingsPatchDto) => {
    try {
      const updated = await readoraApi.updateSettings(patch);
      if (!isMountedRef.current) return;
      setSettings(updated);
      if (patch.auto_check_updates === false) {
        setUpdateStatus((prev) =>
          prev ? { ...prev, update_available: false } : null,
        );
      } else if (patch.auto_check_updates === true) {
        const status = await readoraApi.checkForUpdates(false);
        if (isMountedRef.current) {
          setUpdateStatus(status);
        }
      }
      setShowPreferences(false);
      setStatusMessage("Preferences saved");
    } catch (err) {
      if (isMountedRef.current) {
        setErrorBanner(
          isCommandError(err) ? err.message : "Failed to save preferences",
        );
      }
    }
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
    openRequestSeqRef.current += 1;
    navSeqRef.current += 1;
    searchRequestGenRef.current += 1;
    printJobSeqRef.current += 1;
    clearPendingPrintCleanup();
    renderSeqRef.current += 1;
    setIsRendering(false);
    try {
      const report = await readoraApi.cleanupApplicationData();
      const freshSettings = await readoraApi.getSettings();
      const freshUpdateStatus =
        freshSettings.auto_check_updates !== false
          ? await readoraApi.checkForUpdates(false)
          : null;
      if (!isMountedRef.current) return;
      sessionRef.current = null;
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
      clearPrintCache();
      setSettings(freshSettings);
      setUpdateStatus(freshUpdateStatus);
      setShowPreferences(false);
      setStatusMessage(
        `Cleaned up Readora database (${report.removed_database_files} files) and cache (${report.removed_cache_entries} entries) — PDF files on disk untouched`,
      );
    } catch (err) {
      if (isMountedRef.current) {
        setErrorBanner(
          isCommandError(err)
            ? err.message
            : "Failed to clean up application data",
        );
      }
    }
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
      const printGen = session.view_state.generation ?? null;
      const jobSeq = ++printJobSeqRef.current;
      clearPendingPrintCleanup();
      setErrorBanner(null);

      try {
        const prepared: PreparedPrintPage[] = [];
        for (const pageIndex of pageIndices) {
          if (
            !isMountedRef.current ||
            jobSeq !== printJobSeqRef.current ||
            sessionRef.current?.descriptor.id !== docId
          ) {
            return;
          }
          const cacheKey = `${docId}:${pageIndex}:${rotationDegrees}:1.50:standard`;
          const cachedUrl = printCacheRef.current.get(cacheKey);
          if (cachedUrl) {
            printCacheRef.current.delete(cacheKey);
            printCacheRef.current.set(cacheKey, cachedUrl);
            prepared.push({ pageIndex, dataUrl: cachedUrl });
            continue;
          }
          const rendered = await readoraApi.renderPage({
            document_id: docId,
            page_index: pageIndex,
            scale: 1.5,
            rotation_degrees: rotationDegrees,
            render_mode: "standard",
            generation: printGen,
          });
          if (
            !isMountedRef.current ||
            jobSeq !== printJobSeqRef.current ||
            sessionRef.current?.descriptor.id !== docId
          ) {
            return;
          }
          if (printCacheRef.current.size >= MAX_PRINT_CACHE_ENTRIES) {
            const oldestKey = printCacheRef.current.keys().next().value;
            if (oldestKey) {
              revokeObjectUrlIfBlob(printCacheRef.current.get(oldestKey));
              printCacheRef.current.delete(oldestKey);
            }
          }
          const cachedPrintUrl = toCachedPrintUrl(rendered.data_url);
          printCacheRef.current.set(cacheKey, cachedPrintUrl);
          prepared.push({ pageIndex, dataUrl: cachedPrintUrl });
        }

        if (
          !isMountedRef.current ||
          jobSeq !== printJobSeqRef.current ||
          sessionRef.current?.descriptor.id !== docId
        ) {
          return;
        }
        setPrintIncludeAnnotations(includeAnn);
        setPrintPages(prepared);

        // Wait one animation frame for React DOM commit and image decode
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        if (!isMountedRef.current || jobSeq !== printJobSeqRef.current) {
          return;
        }

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

        if (!isMountedRef.current || jobSeq !== printJobSeqRef.current) {
          return;
        }
        setShowPrintDialog(false);
        setStatusMessage(summary);

        const finishPrintCleanup = () => {
          clearPendingPrintCleanup();
          if (isMountedRef.current) {
            setPrintPages(null);
          }
        };

        const isMockedPrint =
          typeof window !== "undefined" &&
          typeof window.print === "function" &&
          "mock" in (window.print as unknown as Record<string, unknown>);
        if (
          typeof window !== "undefined" &&
          typeof window.print === "function" &&
          (!isJsdomEnvironment() || isMockedPrint)
        ) {
          const handleAfterPrint = () => {
            finishPrintCleanup();
          };
          printAfterHandlerRef.current = handleAfterPrint;
          window.addEventListener("afterprint", handleAfterPrint, {
            once: true,
          });
          printCleanupTimerRef.current = window.setTimeout(
            finishPrintCleanup,
            isJsdomEnvironment() ? 120 : 2500,
          );
          window.print();
        } else {
          finishPrintCleanup();
        }
      } catch (err) {
        clearPendingPrintCleanup();
        if (isMountedRef.current) {
          setPrintPages(null);
          setErrorBanner(
            isCommandError(err) ? err.message : "Failed to prepare pages for printing",
          );
        }
      }
    },
    [clearPendingPrintCleanup, session],
  );

  const prevThemeForRenderRef = useRef<"light" | "dark">(resolvedTheme);
  useEffect(() => {
    if (prevThemeForRenderRef.current === resolvedTheme) {
      return;
    }
    prevThemeForRenderRef.current = resolvedTheme;
    const active = sessionRef.current;
    if (active && active.view_state.render_mode === "standard") {
      void loadVisiblePageAndPrefetch(
        active.descriptor.id,
        active.view_state,
        settingsRef.current.prefetch_window,
        effectiveZoomRef.current,
        true,
      );
    }
  }, [loadVisiblePageAndPrefetch, resolvedTheme]);

  const handleToggleTheme = async () => {
    const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
    try {
      const updated = await readoraApi.updateSettings({ theme: nextTheme });
      if (isMountedRef.current) {
        setSettings(updated);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setErrorBanner(
          isCommandError(err) ? err.message : "Failed to switch theme",
        );
      }
    }
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
    try {
      await readoraApi.setFavoriteDocument(documentId, isFavorite);
      const recents = await readoraApi.listRecentDocuments(20);
      if (!isMountedRef.current) return;
      setRecentDocs(recents);
      setStatusMessage(
        isFavorite ? "Added document to favorites" : "Removed from favorites",
      );
    } catch (err) {
      if (isMountedRef.current) {
        setErrorBanner(
          isCommandError(err)
            ? err.message
            : "Failed to update favorite status",
        );
      }
    }
  };

  const handleSetDocumentArchived = async (
    documentId: string,
    isArchived: boolean,
  ) => {
    try {
      await readoraApi.setDocumentArchived(documentId, isArchived);
      if (isArchived && sessionRef.current?.descriptor.id === documentId) {
        cancelPendingScrollNav();
        openRequestSeqRef.current += 1;
        navSeqRef.current += 1;
        searchRequestGenRef.current += 1;
        printJobSeqRef.current += 1;
        clearPendingPrintCleanup();
        renderSeqRef.current += 1;
        setIsRendering(false);
        await readoraApi.closeDocument(documentId);
        if (!isMountedRef.current) return;
        sessionRef.current = null;
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
        clearPrintCache();
      }
      const recents = await readoraApi.listRecentDocuments(20);
      if (!isMountedRef.current) return;
      setRecentDocs(recents);
      setStatusMessage(
        isArchived ? "Moved document to archive" : "Restored document to library",
      );
    } catch (err) {
      if (isMountedRef.current) {
        setErrorBanner(
          isCommandError(err) ? err.message : "Failed to update archive state",
        );
      }
    }
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
    try {
      if (sessionRef.current?.descriptor.id === documentId) {
        cancelPendingScrollNav();
        openRequestSeqRef.current += 1;
        navSeqRef.current += 1;
        searchRequestGenRef.current += 1;
        printJobSeqRef.current += 1;
        clearPendingPrintCleanup();
        renderSeqRef.current += 1;
        setIsRendering(false);
        sessionRef.current = null;
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
        clearPrintCache();
      }
      await readoraApi.deleteRecentDocument(documentId);
      const recents = await readoraApi.listRecentDocuments(20);
      if (!isMountedRef.current) return;
      setRecentDocs(recents);
      setStatusMessage("Removed document from library");
    } catch (err) {
      if (isMountedRef.current) {
        setErrorBanner(
          isCommandError(err)
            ? err.message
            : "Failed to remove document from library",
        );
      }
    }
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

  const effectiveRenderMode: RenderMode =
    session?.view_state.render_mode === "grayscale"
      ? "grayscale"
      : session?.view_state.render_mode === "dark_inversion" ||
          resolvedTheme === "dark"
        ? "dark_inversion"
        : "standard";

  const activeRenderedPage: RenderedPageResultDto | null =
    session &&
    renderedState &&
    renderedState.result.document_id === session.descriptor.id &&
    renderedState.result.page_index === session.view_state.current_page &&
    Math.abs(renderedState.zoom - effectiveZoom) < 0.02 &&
    renderedState.rotation === session.view_state.rotation &&
    renderedState.renderMode === effectiveRenderMode
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
                  rotation={session.view_state.rotation}
                  renderMode={effectiveRenderMode}
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
                  effectiveRenderMode={effectiveRenderMode}
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
            onCancelPrepare={() => {
              printJobSeqRef.current += 1;
              clearPendingPrintCleanup();
              setPrintPages(null);
            }}
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
                return handleOpenFile(pendingPasswordFile, pw);
              }
              return handleOpenPath(pendingPasswordPath, pw);
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
            updateStatus={updateStatus}
            onCheckForUpdates={() => void handleCheckForUpdates()}
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
