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
  type UpsertAnnotationCommandDto,
  type UpsertBookmarkCommandDto,
  type ViewStateDto,
} from "../../types/ipc";
import { hasUsableCanvas2D, readFileToUint8Array } from "../pdf/indexedDbStore";
import {
  extractPdfJsPageLayout,
  parsePdfWithPdfJs,
  renderPdfJsPageToDataUrl,
  searchPdfJsDocument,
  type ParsedPdfJsDocument,
} from "../pdf/pdfCanvasRenderer";
import { parseGithubReleasePayload } from "../pdf/releaseParser";
import {
  buildSyntheticPageLayout,
  computeMatchBoundingBoxes,
  findMatchesInPageText,
  normalizePdfGlyphText,
} from "../pdf/textSearch";
import { BrowserFallbackBridge } from "./fallbackBridge";

export {
  computeMatchBoundingBoxes,
  findMatchesInPageText,
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
let cachedNativeEngineKind: string | null = null;
let nativeSearchGeneration = 1;

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
  if (!hasUsableCanvas2D()) {
    return null;
  }
  const existing = nativeCanvasDocs.get(documentId);
  if (existing) {
    return existing;
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
  nativeCanvasDocs.set(documentId, parsed);
  return parsed;
}

async function enrichRawSearchHits(
  documentId: string,
  request: SearchRequestDto,
  rawHits: SearchHitDto[],
  extractTextFn: (docId: string, pageIdx: number) => Promise<string>,
): Promise<SearchHitDto[]> {
  const q = request.query.trim();
  if (!q || rawHits.length === 0) {
    return rawHits;
  }
  const needle = request.case_sensitive ? q : q.toLowerCase();
  const enriched: SearchHitDto[] = [];
  for (const hit of rawHits) {
    if (hit.bounding_box) {
      enriched.push(hit);
      continue;
    }
    const text = await extractTextFn(documentId, hit.page_index);
    const layout = buildSyntheticPageLayout(text);
    const hay = request.case_sensitive ? text : text.toLowerCase();
    let searchFrom = 0;
    let currentIdx = 0;
    let foundPos = 0;
    while (searchFrom < hay.length) {
      const pos = hay.indexOf(needle, searchFrom);
      if (pos === -1) break;
      foundPos = pos;
      if (currentIdx === hit.match_index) {
        break;
      }
      currentIdx += 1;
      searchFrom = pos + Math.max(1, needle.length);
    }
    const boxes = computeMatchBoundingBoxes(layout, foundPos, needle.length);
    enriched.push({
      ...hit,
      match_text: hit.match_text ?? q,
      bounding_box: boxes[0],
      bounding_boxes: boxes,
    });
  }
  return enriched;
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
        nativeCanvasDocs.set(session.descriptor.id, parsedCanvasDoc);
        return {
          ...session,
          descriptor: {
            ...session.descriptor,
            page_count: parsedCanvasDoc.pageCount,
            metadata: parsedCanvasDoc.metadata,
          },
          view_state: {
            ...session.view_state,
            page_count: parsedCanvasDoc.pageCount,
          },
          outline:
            parsedCanvasDoc.outline.length > 0
              ? parsedCanvasDoc.outline
              : session.outline,
        };
      }
      return session;
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
      if (parsedCanvasDoc) {
        return {
          ...session,
          descriptor: {
            ...session.descriptor,
            page_count: parsedCanvasDoc.pageCount,
            metadata: parsedCanvasDoc.metadata,
          },
          view_state: {
            ...session.view_state,
            page_count: parsedCanvasDoc.pageCount,
          },
          outline:
            parsedCanvasDoc.outline.length > 0
              ? parsedCanvasDoc.outline
              : session.outline,
        };
      }
      return session;
    }
    return fallbackBridge.openDocument(request);
  },

  async openSampleDocument(): Promise<DocumentSessionDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<DocumentSessionDto>("document_open_sample");
    }
    return fallbackBridge.openDocument({
      path: "/samples/Readora-Welcome-Guide.pdf",
      password: null,
    });
  },

  async closeDocument(documentId: string): Promise<void> {
    nativeCanvasDocs.delete(documentId);
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
      return invoke<ViewStateDto>("document_navigate", { documentId, action });
    }
    return fallbackBridge.navigate(documentId, action);
  },

  async renderPage(
    command: RenderPageCommandDto,
  ): Promise<RenderedPageResultDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const canvasDoc = await ensureNativeCanvasDoc(invoke, command.document_id);
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
      return invoke<RenderedPageResultDto>("page_render", { command });
    }
    return fallbackBridge.renderPage(command);
  },

  async extractPageText(
    documentId: string,
    pageIndex: number,
  ): Promise<string> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const canvasDoc = await ensureNativeCanvasDoc(invoke, documentId);
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
      const canvasDoc = await ensureNativeCanvasDoc(invoke, request.document_id);
      if (canvasDoc) {
        const gen = ++nativeSearchGeneration;
        return searchPdfJsDocument(
          canvasDoc,
          request,
          () => gen !== nativeSearchGeneration,
        );
      }
      const rawHits = await invoke<SearchHitDto[]>("document_search", {
        request,
      });
      return enrichRawSearchHits(
        request.document_id,
        request,
        rawHits,
        (docId, idx) => this.extractPageText(docId, idx),
      );
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
    nativeCanvasDocs.delete(documentId);
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
  ): Promise<ExportAnnotationsBundleDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<ExportAnnotationsBundleDto>("annotation_export", {
        documentId,
        includeAnnotations,
        destinationPath,
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
              await invoke<AppUpdateStatusDto>("app_stage_github_release", {
                rawJson,
              });
            } else {
              fallbackBridge.stageGithubReleaseJson(rawJson);
            }
          }
        }
      } catch {
        // Offline or network unreachable — fall back to locally staged release manifest
      }
    }

    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_check_for_updates", {
        includeDismissed,
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
      await bridge.triggerSelfUpdate(version);
      return invoke<AppUpdateStatusDto>("app_check_for_updates", {
        includeDismissed: true,
      });
    }
    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_install_update", { version });
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
    nativeCanvasDocs.clear();
    nativeCanvasRenderCache.clear();
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppCleanupReportDto>("app_cleanup_data");
    }
    return fallbackBridge.cleanupApplicationData();
  },
};
