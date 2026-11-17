/**
 * Single typed desktop IPC client module (`AGENTS.md` §7).
 *
 * All UI components and hooks route backend calls through `readoraApi`.
 * When running inside the native Readora desktop shell, commands execute directly
 * against Rust `DesktopCommandHandler` (`AppCore` + `SqliteStorage` WAL + `MemoryRenderCache`
 * + `PdfiumEngineAdapter`). When `libpdfium` is absent (`pure_rust_fallback`), `pdfjs-dist`
 * provides vector/font canvas rendering while Rust owns all state, files, and SQLite persistence.
 * When running in standalone browser dev / Vitest (`!getNativeTauriInvoke()`), calls fall back
 * to `BrowserFallbackBridge`.
 */

import {
  type AnnotationDto,
  type AppCleanupReportDto,
  type AppSettingsDto,
  type AppUpdateStatusDto,
  type BookmarkDto,
  type CommandErrorDto,
  type DocumentSessionDto,
  type ExportAnnotationsBundleDto,
  type NavigationActionDto,
  type OpenDocumentRequestDto,
  type RecentDocumentDto,
  type ReleaseManifestDto,
  type RenderedPageResultDto,
  type RenderPageCommandDto,
  type SearchHitDto,
  type SearchRequestDto,
  type SettingsPatchDto,
  type SystemDiagnosticsDto,
  type UpdateInstallOutcome,
  type UpsertAnnotationCommandDto,
  type UpsertBookmarkCommandDto,
  type ViewStateDto,
} from "../../types/ipc";
import { hasUsableCanvas2D, readFileToUint8Array } from "../pdf/indexedDbStore";
import {
  destroyParsedPdf,
  extractPdfJsPageLayout,
  parsePdfWithPdfJs,
  purgeDocumentRenderCache,
  renderPdfJsPageToDataUrl,
  searchPdfJsDocument,
  type ParsedPdfJsDocument,
} from "../pdf/pdfCanvasRenderer";
import {
  isAllowedGithubHttpsUrl,
  parseGithubReleasePayload,
} from "../pdf/releaseParser";
import {
  computeMatchBoundingBoxes,
  findMatchesInPageText,
  normalizePdfGlyphText,
  ZOOM_PRESETS,
} from "../pdf/textSearch";
import { BrowserFallbackBridge } from "./fallbackBridge";

export {
  computeMatchBoundingBoxes,
  findMatchesInPageText,
  isAllowedGithubHttpsUrl,
  normalizePdfGlyphText,
  parseGithubReleasePayload,
};

type TauriInvokeFn = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface NativeDesktopBridge {
  importPdfBytes: (
    fileName: string,
    bytes: Uint8Array,
    password: string | null,
  ) => Promise<DocumentSessionDto>;
  readPdfBytes: (documentId: string) => Promise<Uint8Array | null>;
  triggerSelfUpdate: (version: string) => Promise<{ status?: string }>;
}

interface WindowWithDesktopBridges {
  __TAURI_INTERNALS__?: {
    invoke?: TauriInvokeFn;
  };
  __READORA_NATIVE__?: NativeDesktopBridge;
}

function getNativeTauriInvoke(): TauriInvokeFn | null {
  if (typeof window === "undefined") {
    return null;
  }
  const win = window as unknown as WindowWithDesktopBridges;
  return win.__TAURI_INTERNALS__?.invoke ?? null;
}

function getNativeDesktopBridge(): NativeDesktopBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const win = window as unknown as WindowWithDesktopBridges;
  return win.__READORA_NATIVE__ ?? null;
}

const fallbackBridge = new BrowserFallbackBridge();
const nativeCanvasDocs = new Map<string, ParsedPdfJsDocument>();
const nativeCanvasRenderCache = new Map<string, string>();
const nativeViewStates = new Map<string, ViewStateDto>();
let cachedNativeEngineKind: string | null = null;
let nativeSearchGeneration = 1;

const UPDATE_FAILURE_STATUSES = new Set([
  "checksum_verification_failed",
  "signature_verification_failed",
  "invalid_download_url",
  "missing_download_url",
  "invalid_parameters",
  "failed",
]);

function mapUpdateStatusToOutcome(status: string): UpdateInstallOutcome {
  if (status === "restarting") {
    return "restarting";
  }
  if (status === "downloaded_installer") {
    return "downloaded_installer";
  }
  if (status === "opened_release" || status === "opened_release_page") {
    return "opened_release";
  }
  return "staged";
}

function mergeSessionWithCanvasDoc(
  session: DocumentSessionDto,
  canvasDoc: ParsedPdfJsDocument | null,
): DocumentSessionDto {
  if (!canvasDoc) {
    nativeViewStates.set(session.descriptor.id, { ...session.view_state });
    return session;
  }
  const mergedPageCount = Math.max(
    session.descriptor.page_count,
    session.view_state.page_count,
    canvasDoc.pageCount,
  );
  const mergedViewState: ViewStateDto = {
    ...session.view_state,
    page_count: mergedPageCount,
  };
  nativeViewStates.set(session.descriptor.id, { ...mergedViewState });
  return {
    ...session,
    descriptor: {
      ...session.descriptor,
      page_count: mergedPageCount,
      metadata: canvasDoc.metadata,
    },
    view_state: mergedViewState,
    outline:
      canvasDoc.outline.length > 0 ? canvasDoc.outline : session.outline,
  };
}

function applyLocalFallbackNavigation(
  documentId: string,
  prev: ViewStateDto | undefined,
  action: NavigationActionDto,
  pageCount: number,
): ViewStateDto | null {
  const base: ViewStateDto = prev
    ? { ...prev, page_count: Math.max(prev.page_count, pageCount) }
    : {
        document_id: documentId,
        current_page: 0,
        page_count: pageCount,
        zoom: 1.0,
        fit_mode: "fit_width",
        rotation: "deg0",
        layout_mode: "continuous",
        render_mode: "standard",
      };

  switch (action.kind) {
    case "go_to_page":
      if (action.value < 0 || action.value >= base.page_count) {
        return null;
      }
      base.current_page = action.value;
      return base;
    case "next_page":
      if (base.current_page + 1 < base.page_count) {
        base.current_page += 1;
      }
      return base;
    case "previous_page":
      if (base.current_page > 0) {
        base.current_page -= 1;
      }
      return base;
    case "set_zoom":
      base.zoom = Math.min(5.0, Math.max(0.25, action.value));
      base.fit_mode = "manual";
      return base;
    case "step_zoom_in":
      base.zoom = ZOOM_PRESETS.find((p) => p > base.zoom + 0.01) ?? 5.0;
      base.fit_mode = "manual";
      return base;
    case "step_zoom_out":
      base.zoom =
        [...ZOOM_PRESETS].reverse().find((p) => p < base.zoom - 0.01) ?? 0.25;
      base.fit_mode = "manual";
      return base;
    case "set_fit_mode":
      base.fit_mode = action.value;
      if (action.value === "fit_page") {
        base.zoom = 0.9;
      } else if (action.value === "fit_width") {
        base.zoom = 1.0;
      }
      return base;
    default:
      return null;
  }
}

async function resolveNativeEngineKind(
  invoke: TauriInvokeFn,
): Promise<string> {
  if (cachedNativeEngineKind) {
    return cachedNativeEngineKind;
  }
  try {
    const diag = await invoke<SystemDiagnosticsDto>("system_diagnostics");
    cachedNativeEngineKind = diag.pdf_engine_kind;
    return diag.pdf_engine_kind;
  } catch {
    return "pure_rust_fallback";
  }
}

async function ensureNativeCanvasDoc(
  invoke: TauriInvokeFn,
  documentId: string,
  fileNameHint = "Document.pdf",
  password: string | null = null,
): Promise<ParsedPdfJsDocument | null> {
  const existing = nativeCanvasDocs.get(documentId);
  if (existing) {
    return existing;
  }
  if (!hasUsableCanvas2D()) {
    return null;
  }
  const engineKind = await resolveNativeEngineKind(invoke);
  if (engineKind === "pdfium_dynamic") {
    return null;
  }
  const bridge = getNativeDesktopBridge();
  if (!bridge) {
    return null;
  }
  const bytes = await bridge.readPdfBytes(documentId);
  if (!bytes || bytes.byteLength === 0) {
    return null;
  }
  const parsed = await parsePdfWithPdfJs(fileNameHint, bytes, password);
  const previous = nativeCanvasDocs.get(documentId);
  if (previous && previous !== parsed) {
    destroyParsedPdf(previous);
  }
  nativeCanvasDocs.set(documentId, parsed);
  return parsed;
}

export const readoraApi = {
  async openDocumentFile(
    file: File,
    password: string | null = null,
  ): Promise<DocumentSessionDto> {
    const invoke = getNativeTauriInvoke();
    const bridge = getNativeDesktopBridge();
    if (invoke && bridge) {
      const bytes = await readFileToUint8Array(file);
      const engineKind = await resolveNativeEngineKind(invoke);
      let parsedCanvasDoc: ParsedPdfJsDocument | null = null;
      if (engineKind !== "pdfium_dynamic" && hasUsableCanvas2D()) {
        parsedCanvasDoc = await parsePdfWithPdfJs(
          file.name || "Document.pdf",
          bytes,
          password,
        );
      }
      const session = await bridge.importPdfBytes(
        file.name || "Document.pdf",
        bytes,
        password,
      );
      if (parsedCanvasDoc) {
        const previous = nativeCanvasDocs.get(session.descriptor.id);
        if (previous && previous !== parsedCanvasDoc) {
          destroyParsedPdf(previous);
        }
        nativeCanvasDocs.set(session.descriptor.id, parsedCanvasDoc);
      }
      return mergeSessionWithCanvasDoc(session, parsedCanvasDoc);
    }
    return fallbackBridge.openDocumentFile(file, password);
  },

  async openDocument(
    request: OpenDocumentRequestDto,
  ): Promise<DocumentSessionDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const session = await invoke<DocumentSessionDto>("document_open", {
        request,
      });
      const parsedCanvasDoc = await ensureNativeCanvasDoc(
        invoke,
        session.descriptor.id,
        session.descriptor.file_name,
        request.password,
      );
      return mergeSessionWithCanvasDoc(session, parsedCanvasDoc);
    }
    return fallbackBridge.openDocument(request);
  },

  async openSampleDocument(): Promise<DocumentSessionDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const session = await invoke<DocumentSessionDto>("document_open_sample");
      const parsedCanvasDoc = await ensureNativeCanvasDoc(
        invoke,
        session.descriptor.id,
        session.descriptor.file_name,
        null,
      );
      return mergeSessionWithCanvasDoc(session, parsedCanvasDoc);
    }
    return fallbackBridge.openDocument({
      path: "/samples/Readora-Welcome-Guide.pdf",
      password: null,
    });
  },

  async getDocumentSession(documentId: string): Promise<DocumentSessionDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const session = await invoke<DocumentSessionDto>("document_get_info", {
        documentId,
      });
      const canvasDoc =
        nativeCanvasDocs.get(documentId) ??
        (await ensureNativeCanvasDoc(
          invoke,
          documentId,
          session.descriptor.file_name,
          null,
        ));
      return mergeSessionWithCanvasDoc(session, canvasDoc);
    }
    return fallbackBridge.getDocumentSession(documentId);
  },

  async closeDocument(documentId: string): Promise<void> {
    destroyParsedPdf(nativeCanvasDocs.get(documentId));
    nativeCanvasDocs.delete(documentId);
    nativeViewStates.delete(documentId);
    purgeDocumentRenderCache(nativeCanvasRenderCache, documentId);
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      await invoke<void>("document_close", { documentId });
      return;
    }
    fallbackBridge.closeDocument(documentId);
  },

  async navigate(
    documentId: string,
    action: NavigationActionDto,
  ): Promise<ViewStateDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const canvasDoc =
        nativeCanvasDocs.get(documentId) ??
        (await ensureNativeCanvasDoc(invoke, documentId));
      const prevView = nativeViewStates.get(documentId);

      try {
        const res = await invoke<ViewStateDto>("document_navigate", {
          documentId,
          action,
        });
        if (!canvasDoc) {
          nativeViewStates.set(documentId, { ...res });
          return res;
        }
        const mergedPageCount = Math.max(res.page_count, canvasDoc.pageCount);
        let mergedCurrentPage = res.current_page;
        if (res.page_count < mergedPageCount && prevView) {
          if (
            action.kind === "next_page" &&
            res.current_page === prevView.current_page &&
            prevView.current_page + 1 < mergedPageCount
          ) {
            mergedCurrentPage = prevView.current_page + 1;
          } else if (
            action.kind === "previous_page" &&
            prevView.current_page >= res.page_count
          ) {
            mergedCurrentPage = Math.max(0, prevView.current_page - 1);
          } else if (
            action.kind !== "go_to_page" &&
            action.kind !== "next_page" &&
            action.kind !== "previous_page" &&
            prevView.current_page >= res.page_count &&
            prevView.current_page < mergedPageCount
          ) {
            mergedCurrentPage = prevView.current_page;
          }
        }
        const merged: ViewStateDto = {
          ...res,
          current_page: mergedCurrentPage,
          page_count: mergedPageCount,
        };
        nativeViewStates.set(documentId, { ...merged });
        return merged;
      } catch (err) {
        const maybeCode = (err as Partial<CommandErrorDto> | null)?.code ?? "";
        if (
          canvasDoc &&
          (maybeCode === "page_out_of_bounds" ||
            maybeCode === "validation_error")
        ) {
          const fallbackUpdated = applyLocalFallbackNavigation(
            documentId,
            prevView,
            action,
            canvasDoc.pageCount,
          );
          if (fallbackUpdated) {
            nativeViewStates.set(documentId, { ...fallbackUpdated });
            return fallbackUpdated;
          }
        }
        throw err;
      }
    }
    return fallbackBridge.navigate(documentId, action);
  },

  async renderPage(
    command: RenderPageCommandDto,
  ): Promise<RenderedPageResultDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const canvasDoc =
        nativeCanvasDocs.get(command.document_id) ??
        (await ensureNativeCanvasDoc(invoke, command.document_id));
      if (canvasDoc) {
        const rendered = await renderPdfJsPageToDataUrl(
          canvasDoc,
          command,
          nativeCanvasRenderCache,
          command.generation ?? 1,
        );
        if (rendered) {
          return rendered;
        }
      }
      const dpr =
        typeof window !== "undefined"
          ? Math.min(2, Math.max(1, window.devicePixelRatio || 1))
          : 1;
      const hiDpiCommand: RenderPageCommandDto = {
        ...command,
        scale: Number(
          Math.min(10, Math.max(0.25, command.scale * dpr)).toFixed(2),
        ),
      };
      return invoke<RenderedPageResultDto>("page_render", {
        command: hiDpiCommand,
      });
    }
    return fallbackBridge.renderPage(command);
  },

  async extractPageText(
    documentId: string,
    pageIndex: number,
  ): Promise<string> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const canvasDoc =
        nativeCanvasDocs.get(documentId) ??
        (await ensureNativeCanvasDoc(invoke, documentId));
      if (canvasDoc) {
        await extractPdfJsPageLayout(canvasDoc, pageIndex);
        return canvasDoc.pageTexts.get(pageIndex) ?? "";
      }
      return invoke<string>("page_extract_text", { documentId, pageIndex });
    }
    return fallbackBridge.extractPageText(documentId, pageIndex);
  },

  async searchDocument(request: SearchRequestDto): Promise<SearchHitDto[]> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const canvasDoc =
        nativeCanvasDocs.get(request.document_id) ??
        (await ensureNativeCanvasDoc(invoke, request.document_id));
      if (canvasDoc) {
        const gen = ++nativeSearchGeneration;
        return searchPdfJsDocument(
          canvasDoc,
          request,
          () => gen !== nativeSearchGeneration,
        );
      }
      return invoke<SearchHitDto[]>("document_search", { request });
    }
    return fallbackBridge.searchDocument(request);
  },

  async listRecentDocuments(limit = 20): Promise<RecentDocumentDto[]> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<RecentDocumentDto[]>("recent_documents_list", { limit });
    }
    return fallbackBridge.listRecents();
  },

  async setFavoriteDocument(
    documentId: string,
    isFavorite: boolean,
  ): Promise<RecentDocumentDto | null> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<RecentDocumentDto | null>("recent_document_set_favorite", {
        documentId,
        isFavorite,
      });
    }
    return fallbackBridge.setFavoriteDocument(documentId, isFavorite);
  },

  async setDocumentArchived(
    documentId: string,
    isArchived: boolean,
  ): Promise<RecentDocumentDto | null> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<RecentDocumentDto | null>("recent_document_set_archived", {
        documentId,
        isArchived,
      });
    }
    return fallbackBridge.setDocumentArchived(documentId, isArchived);
  },

  async deleteRecentDocument(documentId: string): Promise<void> {
    destroyParsedPdf(nativeCanvasDocs.get(documentId));
    nativeCanvasDocs.delete(documentId);
    nativeViewStates.delete(documentId);
    purgeDocumentRenderCache(nativeCanvasRenderCache, documentId);
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      await invoke<void>("recent_document_delete", { documentId });
      return;
    }
    fallbackBridge.deleteRecentDocument(documentId);
  },

  async upsertBookmark(
    command: UpsertBookmarkCommandDto,
  ): Promise<BookmarkDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<BookmarkDto>("bookmark_upsert", { command });
    }
    return fallbackBridge.upsertBookmark(command);
  },

  async deleteBookmark(bookmarkId: string): Promise<boolean> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<boolean>("bookmark_delete", { bookmarkId });
    }
    return fallbackBridge.deleteBookmark(bookmarkId);
  },

  async listAnnotations(documentId: string): Promise<AnnotationDto[]> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AnnotationDto[]>("annotation_list", { documentId });
    }
    return fallbackBridge.listAnnotations(documentId);
  },

  async upsertAnnotation(
    command: UpsertAnnotationCommandDto,
  ): Promise<AnnotationDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AnnotationDto>("annotation_upsert", { command });
    }
    return fallbackBridge.upsertAnnotation(command);
  },

  async deleteAnnotation(annotationId: string): Promise<boolean> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<boolean>("annotation_delete", { annotationId });
    }
    return fallbackBridge.deleteAnnotation(annotationId);
  },

  async exportAnnotations(
    documentId: string,
    includeAnnotations: boolean,
    destinationPath: string | null = null,
    saveToDownloads = false,
  ): Promise<ExportAnnotationsBundleDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<ExportAnnotationsBundleDto>("annotation_export", {
        documentId,
        includeAnnotations,
        destinationPath,
        saveToDownloads,
      });
    }
    return fallbackBridge.exportAnnotations(
      documentId,
      includeAnnotations,
      destinationPath,
    );
  },

  async getSettings(): Promise<AppSettingsDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppSettingsDto>("settings_get");
    }
    return fallbackBridge.getSettings();
  },

  async updateSettings(patch: SettingsPatchDto): Promise<AppSettingsDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppSettingsDto>("settings_update", { patch });
    }
    return fallbackBridge.updateSettings(patch);
  },

  async getSystemDiagnostics(): Promise<SystemDiagnosticsDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<SystemDiagnosticsDto>("system_diagnostics");
    }
    return fallbackBridge.getSystemDiagnostics();
  },

  async checkForUpdates(includeDismissed = false): Promise<AppUpdateStatusDto> {
    const invoke = getNativeTauriInvoke();
    const settings = await this.getSettings();
    const repo = (
      settings.github_release_repo || "smokeInCloud060201/readora"
    ).trim();

    let stagedVerifiedViaWebview = false;
    if (typeof fetch === "function" && repo.includes("/")) {
      try {
        const response = await fetch(
          `https://api.github.com/repos/${repo}/releases/latest`,
          {
            method: "GET",
            headers: { Accept: "application/vnd.github+json" },
          },
        );
        if (response.ok) {
          const rawJson = await response.text();
          if (rawJson.trim().startsWith("{")) {
            if (invoke) {
              const staged = await invoke<AppUpdateStatusDto>(
                "app_stage_github_release",
                {
                  rawJson,
                },
              );
              stagedVerifiedViaWebview = Boolean(staged?.verified);
            } else {
              const staged = fallbackBridge.stageGithubReleaseJson(rawJson);
              stagedVerifiedViaWebview = Boolean(staged?.verified);
            }
          }
        }
      } catch {
        // Offline or network unreachable — fall back to native remote manifest or cached state
      }
    }

    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_check_for_updates", {
        includeDismissed,
        fetchRemote: !stagedVerifiedViaWebview,
      });
    }
    return fallbackBridge.checkForUpdates(includeDismissed);
  },

  async stageUpdateManifest(
    manifest: ReleaseManifestDto,
  ): Promise<AppUpdateStatusDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_stage_update_manifest", {
        manifest,
      });
    }
    return fallbackBridge.stageUpdateManifest(manifest);
  },

  async installUpdate(version: string): Promise<AppUpdateStatusDto> {
    const invoke = getNativeTauriInvoke();
    const bridge = getNativeDesktopBridge();
    if (invoke && bridge) {
      const res = await bridge.triggerSelfUpdate(version);
      const status = res?.status ?? "";
      if (
        UPDATE_FAILURE_STATUSES.has(status) ||
        status.endsWith("_failed") ||
        status === "error"
      ) {
        const code = status || "update_failed";
        const err: CommandErrorDto = {
          code,
          message:
            "Update verification failed (" +
            code.replace(/_/g, " ") +
            "). Installation was aborted for your safety.",
        };
        throw err;
      }
      const checked = await invoke<AppUpdateStatusDto>("app_check_for_updates", {
        includeDismissed: true,
      });
      return {
        ...checked,
        install_outcome: mapUpdateStatusToOutcome(status),
      };
    }
    if (invoke) {
      const installed = await invoke<AppUpdateStatusDto>("app_install_update", {
        version,
      });
      return {
        ...installed,
        install_outcome: installed.install_outcome ?? "staged",
      };
    }
    return fallbackBridge.installUpdate(version);
  },

  async dismissUpdate(version: string): Promise<AppUpdateStatusDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_dismiss_update", { version });
    }
    return fallbackBridge.dismissUpdate(version);
  },

  async cleanupApplicationData(): Promise<AppCleanupReportDto> {
    for (const parsed of nativeCanvasDocs.values()) {
      destroyParsedPdf(parsed);
    }
    nativeCanvasDocs.clear();
    nativeViewStates.clear();
    nativeCanvasRenderCache.clear();
    cachedNativeEngineKind = null;
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppCleanupReportDto>("app_cleanup_data");
    }
    return fallbackBridge.cleanupApplicationData();
  },
};
