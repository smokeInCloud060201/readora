import {
  type AnnotationDto,
  type AppCleanupReportDto,
  type AppSettingsDto,
  type AppUpdateStatusDto,
  type BookmarkDto,
  type CommandErrorDto,
  type DocumentMetadataDto,
  type DocumentSessionDto,
  type ExportAnnotationsBundleDto,
  type FitMode,
  type NavigationActionDto,
  type OpenDocumentRequestDto,
  type OutlineNodeDto,
  type RecentDocumentDto,
  type ReleaseManifestDto,
  type RenderedPageResultDto,
  type RenderPageCommandDto,
  type Rotation,
  type SearchHitDto,
  type SearchRequestDto,
  type SettingsPatchDto,
  type SystemDiagnosticsDto,
  type UpsertAnnotationCommandDto,
  type UpsertBookmarkCommandDto,
  type ViewStateDto,
} from "../../types/ipc";
import {
  clearPdfIndexedDb,
  deletePdfBytesFromIndexedDb,
  hasUsableCanvas2D,
  loadPdfBytesFromIndexedDb,
  readFileToUint8Array,
  savePdfBytesToIndexedDb,
} from "../pdf/indexedDbStore";
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
  compareSemver,
  DEFAULT_APP_VERSION,
  isAllowedGithubHttpsUrl,
  isValidSha256Hex,
  parseGithubReleasePayload,
} from "../pdf/releaseParser";
import {
  buildSvgPageDataUrl,
  buildSyntheticPageLayout,
  computeMatchBoundingBoxes,
  findMatchesInPageText,
  SAMPLE_PAGES,
  ZOOM_PRESETS,
  type PageTextLayout,
} from "../pdf/textSearch";

const LIBRARY_STATE_STORAGE_KEY = "readora.library.state.v1";

interface PersistedLibraryState {
  recents?: RecentDocumentDto[];
  bookmarks?: Record<string, BookmarkDto[]>;
  annotations?: Record<string, AnnotationDto[]>;
  settings?: Partial<AppSettingsDto>;
}

interface StoredPdfRecord {
  docId: string;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  bytes: Uint8Array | null;
  parsedPdf: ParsedPdfJsDocument | null;
  pageTexts: Map<number, string>;
  pageLayouts: Map<number, PageTextLayout>;
}

function inspectSyntheticEncryption(bytes: Uint8Array | null): {
  isEncrypted: boolean;
  expectedPassword: string | null;
} {
  if (!bytes || bytes.byteLength === 0) {
    return { isEncrypted: false, expectedPassword: null };
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 8192)),
  );
  if (!text.includes("/Encrypt")) {
    return { isEncrypted: false, expectedPassword: null };
  }
  const match = /\/UserPassword\s*\(([^)]*)\)/.exec(text);
  return {
    isEncrypted: true,
    expectedPassword: match?.[1] ?? null,
  };
}

/**
 * Standalone browser / Vitest fallback bridge used only when no native desktop IPC
 * (`window.__TAURI_INTERNALS__`) is bound.
 */
export class BrowserFallbackBridge {
  private sessions = new Map<string, DocumentSessionDto>();
  private storedPdfsByDocId = new Map<string, StoredPdfRecord>();
  private storedPdfsByPath = new Map<string, StoredPdfRecord>();
  private renderCache = new Map<string, string>();
  private recents: RecentDocumentDto[] = [];
  private bookmarks = new Map<string, BookmarkDto[]>();
  private annotations = new Map<string, AnnotationDto[]>();
  private stagedManifest: ReleaseManifestDto | null = null;
  private settings: AppSettingsDto = {
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
    github_release_repo: "smokeInCloud060201/readora",
    installed_version: DEFAULT_APP_VERSION,
    dismissed_update_version: null,
  };
  private generation = 1;
  private searchGeneration = 1;

  constructor() {
    this.loadFromLocalStorage();
  }

  private applyPersistedState(parsed: PersistedLibraryState): void {
    if (Array.isArray(parsed.recents)) {
      this.recents = parsed.recents;
    }
    if (parsed.bookmarks && typeof parsed.bookmarks === "object") {
      this.bookmarks = new Map(Object.entries(parsed.bookmarks));
    }
    if (parsed.annotations && typeof parsed.annotations === "object") {
      this.annotations = new Map(Object.entries(parsed.annotations));
    }
    if (parsed.settings && typeof parsed.settings === "object") {
      this.settings = {
        ...this.settings,
        ...parsed.settings,
        installed_version: DEFAULT_APP_VERSION,
      };
    }
  }

  private loadFromLocalStorage(): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(LIBRARY_STATE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedLibraryState;
      if (parsed && typeof parsed === "object") {
        this.applyPersistedState(parsed);
      }
    } catch {
      // Ignore malformed localStorage state
    }
  }

  private persistState(): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      const payload: PersistedLibraryState = {
        recents: this.recents,
        bookmarks: Object.fromEntries(this.bookmarks.entries()),
        annotations: Object.fromEntries(this.annotations.entries()),
        settings: this.settings,
      };
      window.localStorage.setItem(
        LIBRARY_STATE_STORAGE_KEY,
        JSON.stringify(payload),
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  async openDocumentFile(
    file: File,
    password: string | null = null,
  ): Promise<DocumentSessionDto> {
    const fileName = file.name || "Document.pdf";
    const maybeFileWithPath = file as File & { path?: string };
    const cleanPath =
      typeof maybeFileWithPath.path === "string" &&
      maybeFileWithPath.path.trim().length > 0
        ? maybeFileWithPath.path.trim()
        : fileName;

    const bytes = await readFileToUint8Array(file);
    return this.openFromBytesOrSynthetic(
      cleanPath,
      fileName,
      file.size || bytes.byteLength,
      bytes,
      password,
    );
  }

  async openDocument(
    request: OpenDocumentRequestDto,
  ): Promise<DocumentSessionDto> {
    const cleanPath = request.path.trim();
    if (!cleanPath) {
      throw this.makeError("platform_error", "File path must not be empty");
    }

    const existingRecord = this.storedPdfsByPath.get(cleanPath);
    if (existingRecord && existingRecord.bytes) {
      return this.openFromBytesOrSynthetic(
        cleanPath,
        existingRecord.fileName,
        existingRecord.fileSizeBytes,
        existingRecord.bytes,
        request.password,
      );
    }

    const parts = cleanPath.split(/[/\\]/);
    const recent = this.recents.find((r) => r.file_path === cleanPath);
    const fileName =
      recent?.display_name || parts[parts.length - 1] || "Document.pdf";
    const docId =
      recent?.document_id ||
      `doc-${fileName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

    const byDocRecord = this.storedPdfsByDocId.get(docId);
    if (byDocRecord && byDocRecord.bytes) {
      return this.openFromBytesOrSynthetic(
        cleanPath,
        byDocRecord.fileName,
        byDocRecord.fileSizeBytes,
        byDocRecord.bytes,
        request.password,
      );
    }

    const persistedBytes = await loadPdfBytesFromIndexedDb(docId);
    if (persistedBytes && persistedBytes.byteLength > 0) {
      return this.openFromBytesOrSynthetic(
        cleanPath,
        fileName,
        persistedBytes.byteLength,
        persistedBytes,
        request.password,
      );
    }

    return this.openFromBytesOrSynthetic(
      cleanPath,
      fileName,
      28_672,
      null,
      request.password,
    );
  }

  private async openFromBytesOrSynthetic(
    cleanPath: string,
    fileName: string,
    fileSizeBytes: number,
    bytes: Uint8Array | null,
    password: string | null,
  ): Promise<DocumentSessionDto> {
    const docId = `doc-${fileName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const existingRecent = this.recents.find((r) => r.document_id === docId);

    let parsedPdf: ParsedPdfJsDocument | null = null;
    let pageCount = SAMPLE_PAGES.length;
    let metadata: DocumentMetadataDto = {
      title: fileName.replace(/\.pdf$/i, ""),
      author: null,
      subject: null,
      creator: null,
      pdf_version: "1.7",
      is_encrypted: false,
      form_support: "none",
      form_field_count: 0,
      signature_status: "no_signatures",
      signature_field_count: 0,
    };
    let outline: OutlineNodeDto[] = [];
    const pageTexts = new Map<number, string>();
    const pageLayouts = new Map<number, PageTextLayout>();

    if (bytes && bytes.byteLength > 0 && hasUsableCanvas2D()) {
      parsedPdf = await parsePdfWithPdfJs(fileName, bytes, password);
      pageCount = parsedPdf.pageCount;
      metadata = parsedPdf.metadata;
      outline = parsedPdf.outline;
    } else {
      // Headless synthetic mode (e.g. Vitest jsdom): inspect PDF /Encrypt dictionary in bytes
      const enc = inspectSyntheticEncryption(bytes);
      if (enc.isEncrypted) {
        if (!password) {
          throw this.makeError(
            "password_required",
            "Document is password-protected",
          );
        }
        const expectedPw = enc.expectedPassword ?? "readora-open";
        if (password !== expectedPw) {
          throw this.makeError(
            "incorrect_password",
            "Incorrect document password",
          );
        }
        metadata.is_encrypted = true;
      }

      SAMPLE_PAGES.forEach((text, idx) => {
        pageTexts.set(idx, text);
        pageLayouts.set(idx, buildSyntheticPageLayout(text));
      });
      outline = SAMPLE_PAGES.map((text, idx) => ({
        title: text.split("—")[0]?.trim() ?? `Section ${idx + 1}`,
        page_index: idx,
        children: [],
      }));
    }

    const prevRecord = this.storedPdfsByDocId.get(docId);
    if (prevRecord?.parsedPdf && prevRecord.parsedPdf !== parsedPdf) {
      destroyParsedPdf(prevRecord.parsedPdf);
    }

    const record: StoredPdfRecord = {
      docId,
      filePath: cleanPath,
      fileName,
      fileSizeBytes,
      bytes,
      parsedPdf,
      pageTexts,
      pageLayouts,
    };
    this.storedPdfsByDocId.set(docId, record);
    this.storedPdfsByPath.set(cleanPath, record);
    if (bytes && bytes.byteLength > 0) {
      void savePdfBytesToIndexedDb(docId, bytes);
    }

    const shouldRememberPosition =
      this.settings.remember_page_position !== false;
    const initialPage =
      existingRecent && shouldRememberPosition
        ? Math.min(existingRecent.last_page, Math.max(0, pageCount - 1))
        : 0;

    const viewState: ViewStateDto = {
      document_id: docId,
      current_page: initialPage,
      page_count: pageCount,
      zoom: existingRecent
        ? existingRecent.last_zoom
        : this.settings.default_zoom,
      fit_mode: this.settings.default_fit_mode,
      rotation: existingRecent ? existingRecent.last_rotation : "deg0",
      layout_mode: this.settings.default_layout,
      render_mode: "standard",
    };

    const existingSession = this.sessions.get(docId);
    const savedBookmarks =
      this.bookmarks.get(docId) ??
      (existingSession ? existingSession.bookmarks : []);
    const session: DocumentSessionDto = {
      descriptor: {
        id: docId,
        file_name: fileName,
        file_size_bytes: fileSizeBytes,
        page_count: pageCount,
        metadata,
      },
      view_state: viewState,
      outline,
      bookmarks: structuredClone(savedBookmarks),
    };

    this.bookmarks.set(docId, structuredClone(session.bookmarks));
    this.sessions.set(docId, session);
    this.upsertRecent(cleanPath, session);
    return structuredClone(session);
  }

  getDocumentSession(documentId: string): DocumentSessionDto {
    const session = this.sessions.get(documentId);
    if (!session) {
      throw this.makeError(
        "document_not_open",
        `Document '${documentId}' is not open`,
      );
    }
    return structuredClone(session);
  }

  navigate(documentId: string, action: NavigationActionDto): ViewStateDto {
    const session = this.sessions.get(documentId);
    if (!session) {
      throw this.makeError(
        "document_not_open",
        `Document '${documentId}' is not open`,
      );
    }
    const vs = session.view_state;
    switch (action.kind) {
      case "go_to_page":
        if (action.value < 0 || action.value >= vs.page_count) {
          throw this.makeError("validation_error", "Page index out of bounds");
        }
        vs.current_page = action.value;
        break;
      case "next_page":
        if (vs.current_page + 1 < vs.page_count) {
          vs.current_page += 1;
        }
        break;
      case "previous_page":
        if (vs.current_page > 0) {
          vs.current_page -= 1;
        }
        break;
      case "set_zoom":
        vs.zoom = Math.min(5.0, Math.max(0.25, action.value));
        vs.fit_mode = "manual";
        break;
      case "step_zoom_in": {
        const next = ZOOM_PRESETS.find((p) => p > vs.zoom + 0.01) ?? 5.0;
        vs.zoom = next;
        vs.fit_mode = "manual";
        break;
      }
      case "step_zoom_out": {
        const prev =
          [...ZOOM_PRESETS].reverse().find((p) => p < vs.zoom - 0.01) ?? 0.25;
        vs.zoom = prev;
        vs.fit_mode = "manual";
        break;
      }
      case "set_fit_mode":
        vs.fit_mode = action.value as FitMode;
        if (action.value === "fit_page") {
          vs.zoom = 0.9;
        } else if (action.value === "fit_width") {
          vs.zoom = 1.0;
        }
        break;
      case "rotate_clockwise":
        vs.rotation = this.rotateCw(vs.rotation);
        break;
      case "rotate_counter_clockwise":
        vs.rotation = this.rotateCcw(vs.rotation);
        break;
      case "set_layout_mode":
        vs.layout_mode = action.value;
        break;
      case "set_render_mode":
        vs.render_mode = action.value;
        break;
    }

    this.generation += 1;
    const recent = this.recents.find((r) => r.document_id === documentId);
    if (recent) {
      recent.last_page =
        this.settings.remember_page_position !== false ? vs.current_page : 0;
      recent.last_zoom = vs.zoom;
      recent.last_rotation = vs.rotation;
      recent.last_opened_unix_ms = Date.now();
    }
    this.persistState();
    return structuredClone(vs);
  }

  async renderPage(
    command: RenderPageCommandDto,
  ): Promise<RenderedPageResultDto> {
    const record = this.storedPdfsByDocId.get(command.document_id);
    const session = this.sessions.get(command.document_id);

    if (record?.parsedPdf) {
      const rendered = await renderPdfJsPageToDataUrl(
        record.parsedPdf,
        command,
        this.renderCache,
        this.generation,
      );
      if (rendered) {
        return rendered;
      }
    }

    const isRotatedSideways =
      command.rotation_degrees === 90 || command.rotation_degrees === 270;
    const baseW = isRotatedSideways ? 792 : 612;
    const baseH = isRotatedSideways ? 612 : 792;
    const widthPx = Math.round(baseW * command.scale);
    const heightPx = Math.round(baseH * command.scale);
    const text = await this.extractPageText(
      command.document_id,
      command.page_index,
    );
    const title =
      session?.descriptor.metadata.title ??
      session?.descriptor.file_name ??
      "PDF Document";
    const pageCount = session?.descriptor.page_count ?? SAMPLE_PAGES.length;
    const dataUrl = buildSvgPageDataUrl(
      widthPx,
      heightPx,
      title,
      command.page_index + 1,
      pageCount,
      text,
      command.render_mode,
    );

    return {
      document_id: command.document_id,
      page_index: command.page_index,
      width_px: widthPx,
      height_px: heightPx,
      data_url: dataUrl,
      cache_hit: false,
      generation: command.generation ?? this.generation,
    };
  }

  async extractPageText(
    documentId: string,
    pageIndex: number,
  ): Promise<string> {
    const record = this.storedPdfsByDocId.get(documentId);
    if (record) {
      if (record.parsedPdf) {
        const cached = record.parsedPdf.pageTexts.get(pageIndex);
        if (cached !== undefined) {
          return cached;
        }
        await extractPdfJsPageLayout(record.parsedPdf, pageIndex);
        return record.parsedPdf.pageTexts.get(pageIndex) ?? "";
      }
      const cached = record.pageTexts.get(pageIndex);
      if (cached !== undefined) {
        return cached;
      }
    }
    return SAMPLE_PAGES[pageIndex] ?? `Page ${pageIndex + 1}`;
  }

  async searchDocument(request: SearchRequestDto): Promise<SearchHitDto[]> {
    const searchGen = ++this.searchGeneration;
    const q = request.query.trim();
    if (!q) {
      return [];
    }
    const record = this.storedPdfsByDocId.get(request.document_id);
    if (record?.parsedPdf) {
      return searchPdfJsDocument(
        record.parsedPdf,
        request,
        () => searchGen !== this.searchGeneration,
      );
    }

    const hits: SearchHitDto[] = [];
    const session = this.sessions.get(request.document_id);
    const pageCount = session?.descriptor.page_count ?? SAMPLE_PAGES.length;

    for (let idx = 0; idx < pageCount; idx += 1) {
      const existingText =
        record?.pageTexts.get(idx) ?? SAMPLE_PAGES[idx] ?? `Page ${idx + 1}`;
      const layout =
        record?.pageLayouts.get(idx) ?? buildSyntheticPageLayout(existingText);
      const text = layout.fullText;
      if (!text) continue;
      const matches = findMatchesInPageText(text, q, request.case_sensitive);
      for (let matchIdx = 0; matchIdx < matches.length; matchIdx += 1) {
        const range = matches[matchIdx];
        if (!range) continue;
        const pos = range.origStart;
        const matchLen = Math.max(1, range.origEnd - range.origStart);
        const start = Math.max(0, pos - 28);
        const end = Math.min(text.length, pos + matchLen + 42);
        const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
        const matchText = text.slice(pos, pos + matchLen);
        const boundingBoxes = computeMatchBoundingBoxes(layout, pos, matchLen);
        hits.push({
          page_index: idx,
          match_index: matchIdx,
          snippet,
          match_text: matchText,
          bounding_box: boundingBoxes[0],
          bounding_boxes: boundingBoxes,
        });
        if (hits.length >= (request.max_hits || 100)) {
          return hits;
        }
      }
    }
    return hits;
  }

  upsertBookmark(command: UpsertBookmarkCommandDto): BookmarkDto {
    const session = this.sessions.get(command.document_id);
    if (!session) {
      throw this.makeError("document_not_open", "Document is not open");
    }
    const trimmed = command.label.trim();
    if (!trimmed) {
      throw this.makeError(
        "validation_error",
        "Bookmark label must not be empty",
      );
    }
    const existingIdx = session.bookmarks.findIndex(
      (b) => b.page_index === command.page_index,
    );
    const bm: BookmarkDto = {
      id: `bm-${command.document_id}-${command.page_index}`,
      document_id: command.document_id,
      page_index: command.page_index,
      label: trimmed,
      created_at_unix_ms: Date.now(),
    };
    if (existingIdx >= 0) {
      session.bookmarks[existingIdx] = bm;
    } else {
      session.bookmarks.push(bm);
      session.bookmarks.sort((a, b) => a.page_index - b.page_index);
    }
    this.bookmarks.set(
      command.document_id,
      structuredClone(session.bookmarks),
    );
    this.persistState();
    return structuredClone(bm);
  }

  deleteBookmark(bookmarkId: string): boolean {
    for (const [docId, session] of this.sessions.entries()) {
      const idx = session.bookmarks.findIndex((b) => b.id === bookmarkId);
      if (idx >= 0) {
        session.bookmarks.splice(idx, 1);
        this.bookmarks.set(docId, structuredClone(session.bookmarks));
        this.persistState();
        return true;
      }
    }
    for (const [docId, list] of this.bookmarks.entries()) {
      const idx = list.findIndex((b) => b.id === bookmarkId);
      if (idx >= 0) {
        list.splice(idx, 1);
        this.bookmarks.set(docId, list);
        this.persistState();
        return true;
      }
    }
    return false;
  }

  listAnnotations(documentId: string): AnnotationDto[] {
    return structuredClone(this.annotations.get(documentId) ?? []);
  }

  upsertAnnotation(command: UpsertAnnotationCommandDto): AnnotationDto {
    if (!Number.isInteger(command.page_index) || command.page_index < 0) {
      throw this.makeError(
        "validation_error",
        "Annotation page_index must be a non-negative integer",
      );
    }
    const colorTrimmed = command.color_hex.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(colorTrimmed)) {
      throw this.makeError(
        "validation_error",
        `color_hex must be a #RRGGBB hex string, got '${colorTrimmed}'`,
      );
    }
    // eslint-disable-next-line no-control-regex
    const controlRe = /[\x00-\x09\x0B-\x1F\x7F]/g;
    const cleanQuote = command.quote_text.replace(controlRe, "").trim();
    const cleanNote = command.note_text.replace(controlRe, "").trim();
    if (!cleanQuote && !cleanNote) {
      throw this.makeError(
        "validation_error",
        "Annotation must contain quote_text or note_text",
      );
    }
    const quoteCodePoints = Array.from(cleanQuote);
    const noteCodePoints = Array.from(cleanNote);
    if (quoteCodePoints.length > 4000 || noteCodePoints.length > 4000) {
      throw this.makeError(
        "validation_error",
        "Annotation text exceeds maximum length of 4000 characters",
      );
    }

    const list = this.annotations.get(command.document_id) ?? [];
    const requestedId = command.id?.trim() || null;
    const existingIdx = requestedId
      ? list.findIndex((item) => item.id === requestedId)
      : -1;
    const existingItem = existingIdx >= 0 ? list[existingIdx] : undefined;
    const created: AnnotationDto = {
      id:
        requestedId ||
        `ann-${command.document_id}-${command.page_index}-${Date.now()}-${list.length}`,
      document_id: command.document_id,
      page_index: command.page_index,
      kind: command.kind,
      color_hex: colorTrimmed,
      quote_text: cleanQuote,
      note_text: cleanNote,
      created_at_unix_ms: existingItem?.created_at_unix_ms ?? Date.now(),
    };
    const updatedList =
      existingIdx >= 0
        ? list.map((item, idx) => (idx === existingIdx ? created : item))
        : [...list, created];
    const next = updatedList.sort((a, b) => a.page_index - b.page_index);
    this.annotations.set(command.document_id, next);
    this.persistState();
    return structuredClone(created);
  }

  deleteAnnotation(annotationId: string): boolean {
    for (const [docId, list] of this.annotations.entries()) {
      const idx = list.findIndex((a) => a.id === annotationId);
      if (idx >= 0) {
        list.splice(idx, 1);
        this.annotations.set(docId, list);
        this.persistState();
        return true;
      }
    }
    return false;
  }

  listRecents(): RecentDocumentDto[] {
    return structuredClone(this.recents);
  }

  setFavoriteDocument(
    documentId: string,
    isFavorite: boolean,
  ): RecentDocumentDto | null {
    const rec = this.recents.find((r) => r.document_id === documentId);
    if (!rec) return null;
    rec.is_favorite = isFavorite;
    this.persistState();
    return structuredClone(rec);
  }

  setDocumentArchived(
    documentId: string,
    isArchived: boolean,
  ): RecentDocumentDto | null {
    const rec = this.recents.find((r) => r.document_id === documentId);
    if (!rec) return null;
    rec.is_archived = isArchived;
    this.persistState();
    return structuredClone(rec);
  }

  deleteRecentDocument(documentId: string): void {
    const record = this.storedPdfsByDocId.get(documentId);
    if (record?.parsedPdf) {
      destroyParsedPdf(record.parsedPdf);
      record.parsedPdf = null;
    }
    purgeDocumentRenderCache(this.renderCache, documentId);
    const existing = this.recents.find((r) => r.document_id === documentId);
    if (existing) {
      this.storedPdfsByPath.delete(existing.file_path);
    }
    this.recents = this.recents.filter((r) => r.document_id !== documentId);
    this.storedPdfsByDocId.delete(documentId);
    this.sessions.delete(documentId);
    this.bookmarks.delete(documentId);
    this.annotations.delete(documentId);
    void deletePdfBytesFromIndexedDb(documentId);
    this.persistState();
  }

  closeDocument(documentId: string): void {
    const record = this.storedPdfsByDocId.get(documentId);
    if (record?.parsedPdf) {
      destroyParsedPdf(record.parsedPdf);
      record.parsedPdf = null;
    }
    purgeDocumentRenderCache(this.renderCache, documentId);
    this.sessions.delete(documentId);
  }

  getSettings(): AppSettingsDto {
    return structuredClone(this.settings);
  }

  updateSettings(patch: SettingsPatchDto): AppSettingsDto {
    if (patch.theme !== undefined) this.settings.theme = patch.theme;
    if (patch.default_layout !== undefined) {
      this.settings.default_layout = patch.default_layout;
    }
    if (patch.default_fit_mode !== undefined) {
      this.settings.default_fit_mode = patch.default_fit_mode;
    }
    if (patch.default_zoom_factor !== undefined) {
      this.settings.default_zoom = patch.default_zoom_factor;
    }
    if (patch.render_cache_budget_bytes !== undefined) {
      this.settings.render_cache_budget_bytes = patch.render_cache_budget_bytes;
    }
    if (patch.prefetch_window !== undefined) {
      this.settings.prefetch_window = patch.prefetch_window;
    }
    if (patch.reopen_last_document !== undefined) {
      this.settings.reopen_last_document = patch.reopen_last_document;
    }
    if (patch.remember_page_position !== undefined) {
      this.settings.remember_page_position = patch.remember_page_position;
    }
    if (patch.confirm_before_delete !== undefined) {
      this.settings.confirm_before_delete = patch.confirm_before_delete;
    }
    if (patch.show_extracted_text_layer !== undefined) {
      this.settings.show_extracted_text_layer = patch.show_extracted_text_layer;
    }
    if (patch.auto_check_updates !== undefined) {
      this.settings.auto_check_updates = patch.auto_check_updates;
    }
    if (
      patch.github_release_repo !== undefined &&
      patch.github_release_repo.trim().includes("/")
    ) {
      this.settings.github_release_repo = patch.github_release_repo.trim();
    }
    this.persistState();
    return structuredClone(this.settings);
  }

  exportAnnotations(
    documentId: string,
    includeAnnotations: boolean,
    destinationPath: string | null = null,
  ): ExportAnnotationsBundleDto {
    const session = this.sessions.get(documentId);
    const recent = this.recents.find((r) => r.document_id === documentId);
    const fileName =
      session?.descriptor.file_name ?? recent?.display_name ?? "Document.pdf";
    const stem = fileName.replace(/\.pdf$/i, "");
    const bookmarks =
      session?.bookmarks ?? this.bookmarks.get(documentId) ?? [];
    const annotations = includeAnnotations
      ? (this.annotations.get(documentId) ?? [])
      : [];

    const lines = [
      `# ${fileName} — Reading Notes & Annotations`,
      "",
      `- **Document ID:** \`${documentId}\``,
      `- **Bookmarks:** ${bookmarks.length}`,
      `- **Annotations:** ${annotations.length}`,
    ];
    for (const bm of bookmarks) {
      lines.push(`\n### Bookmark · Page ${bm.page_index + 1}`);
      lines.push(bm.label);
    }
    for (const ann of annotations) {
      lines.push(
        `\n### Page ${ann.page_index + 1} · ${ann.kind} (${ann.color_hex})`,
      );
      if (ann.quote_text) {
        lines.push(`> “${ann.quote_text}”`);
      }
      if (ann.note_text) {
        lines.push(ann.note_text);
      }
    }

    return {
      file_name: `${stem}-annotations.md`,
      share_uri: `${fileName} (Document ID: ${documentId})`,
      annotation_count: annotations.length,
      bookmark_count: bookmarks.length,
      markdown_content: lines.join("\n"),
      saved_path: destinationPath,
    };
  }

  private upsertRecent(filePath: string, session: DocumentSessionDto): void {
    const prev = this.recents.find(
      (r) => r.document_id === session.descriptor.id,
    );
    const entry: RecentDocumentDto = {
      document_id: session.descriptor.id,
      file_path: filePath,
      display_name: session.descriptor.file_name,
      last_page: session.view_state.current_page,
      page_count: session.descriptor.page_count,
      last_zoom: session.view_state.zoom,
      last_rotation: session.view_state.rotation,
      last_opened_unix_ms: Date.now(),
      is_favorite: prev?.is_favorite ?? false,
      is_archived: prev?.is_archived ?? false,
    };
    this.recents = [
      entry,
      ...this.recents.filter((r) => r.document_id !== entry.document_id),
    ];
    this.persistState();
  }

  private rotateCw(r: Rotation): Rotation {
    switch (r) {
      case "deg0":
        return "deg90";
      case "deg90":
        return "deg180";
      case "deg180":
        return "deg270";
      case "deg270":
        return "deg0";
    }
  }

  private rotateCcw(r: Rotation): Rotation {
    switch (r) {
      case "deg0":
        return "deg270";
      case "deg90":
        return "deg0";
      case "deg180":
        return "deg90";
      case "deg270":
        return "deg180";
    }
  }

  private makeError(code: string, message: string): CommandErrorDto {
    return { code, message };
  }

  getSystemDiagnostics(): SystemDiagnosticsDto {
    return {
      app_version:
        this.settings.installed_version || DEFAULT_APP_VERSION || "1.1.0",
      target_os: "macos",
      target_arch: "aarch64",
      pdf_engine_kind: "pure_rust_fallback",
      sqlite_schema_version: 4,
      redacted_data_dir: "~/Library/Application Support/com.readora.desktop",
      render_cache_usage_bytes: 0,
      third_party_notices: [
        {
          name: "PDFium",
          version: "chromium/8165",
          license: "BSD-3-Clause AND Apache-2.0",
          role: "Dynamic native PDF rendering engine",
        },
        {
          name: "pdfjs-dist (Mozilla PDF.js)",
          version: "6.5",
          license: "Apache-2.0",
          role: "Local WebView/Canvas PDF parsing, rendering, and text extraction",
        },
        {
          name: "rusqlite + SQLite",
          version: "0.32",
          license: "MIT AND Blessing",
          role: "Local WAL persistence for recents, bookmarks, annotations, and settings",
        },
        {
          name: "tao + wry",
          version: "0.31 / 0.48",
          license: "Apache-2.0 OR MIT",
          role: "Cross-platform native desktop windowing and OS WebView shell",
        },
        {
          name: "React + TypeScript",
          version: "19.x / 5.9",
          license: "MIT AND Apache-2.0",
          role: "Presentation UI layer",
        },
      ],
    };
  }

  checkForUpdates(includeDismissed: boolean): AppUpdateStatusDto {
    const currentVersion =
      this.settings.installed_version || DEFAULT_APP_VERSION;
    const githubRepo =
      this.settings.github_release_repo || "smokeInCloud060201/readora";
    const manifest = this.stagedManifest;
    const now = Date.now();

    if (manifest && compareSemver(manifest.version, currentVersion) > 0) {
      const isDismissed =
        !includeDismissed &&
        this.settings.dismissed_update_version === manifest.version.trim();
      const rawUrl = manifest.download_url?.trim() ?? "";
      const hasSafeUrl =
        rawUrl.length === 0 || isAllowedGithubHttpsUrl(rawUrl);
      const verified =
        isValidSha256Hex(manifest.sha256) &&
        manifest.package_size_bytes > 0 &&
        hasSafeUrl;
      return {
        current_version: currentVersion,
        update_available: !isDismissed,
        latest_version: manifest.version,
        release_title: manifest.title,
        release_notes: manifest.notes,
        package_size_bytes: manifest.package_size_bytes,
        sha256_checksum: verified ? manifest.sha256.trim().toLowerCase() : null,
        download_url: rawUrl.length > 0 && hasSafeUrl ? rawUrl : null,
        github_repo: githubRepo,
        verified,
        staged_for_restart: false,
        checked_at_unix_ms: now,
      };
    }

    return {
      current_version: currentVersion,
      update_available: false,
      latest_version: currentVersion,
      release_title: null,
      release_notes: null,
      package_size_bytes: null,
      sha256_checksum: null,
      download_url: null,
      github_repo: githubRepo,
      verified: false,
      staged_for_restart: false,
      checked_at_unix_ms: now,
    };
  }

  stageGithubReleaseJson(rawJson: string): AppUpdateStatusDto {
    const manifest = parseGithubReleasePayload(rawJson, "macos");
    return this.stageUpdateManifest(manifest);
  }

  stageUpdateManifest(manifest: ReleaseManifestDto): AppUpdateStatusDto {
    if (!manifest.version?.trim()) {
      throw this.makeError(
        "platform_error",
        "Release manifest must include a non-empty version field",
      );
    }
    this.stagedManifest = structuredClone(manifest);
    if (this.settings.dismissed_update_version === manifest.version.trim()) {
      this.settings.dismissed_update_version = null;
    }
    return this.checkForUpdates(true);
  }

  installUpdate(targetVersion: string): AppUpdateStatusDto {
    const trimmed = targetVersion.trim();
    const currentVersion =
      this.settings.installed_version || DEFAULT_APP_VERSION;
    const githubRepo =
      this.settings.github_release_repo || "smokeInCloud060201/readora";
    if (!trimmed || compareSemver(trimmed, currentVersion) <= 0) {
      throw this.makeError(
        "platform_error",
        `Target version ${trimmed} is not newer than installed version ${currentVersion}`,
      );
    }
    const status = this.checkForUpdates(true);
    if (
      !this.stagedManifest ||
      this.stagedManifest.version.trim() !== trimmed ||
      !status.verified
    ) {
      throw this.makeError(
        "checksum_verification_failed",
        "Update verification failed (checksum verification failed). Installation was aborted for your safety.",
      );
    }
    const stagedDownloadUrl = status.download_url;
    this.settings.installed_version = trimmed;
    this.settings.dismissed_update_version = null;
    this.stagedManifest = null;
    this.persistState();
    return {
      current_version: trimmed,
      update_available: false,
      latest_version: trimmed,
      release_title: null,
      release_notes: null,
      package_size_bytes: null,
      sha256_checksum: null,
      download_url: stagedDownloadUrl,
      github_repo: githubRepo,
      verified: true,
      staged_for_restart: true,
      checked_at_unix_ms: Date.now(),
      install_outcome: "staged",
    };
  }

  dismissUpdate(version: string): AppUpdateStatusDto {
    const trimmed = version.trim();
    this.settings.dismissed_update_version = trimmed || null;
    this.persistState();
    return this.checkForUpdates(false);
  }

  cleanupApplicationData(): AppCleanupReportDto {
    const removedCacheItems =
      this.renderCache.size +
      this.storedPdfsByDocId.size +
      this.sessions.size;
    for (const record of this.storedPdfsByDocId.values()) {
      destroyParsedPdf(record.parsedPdf);
    }
    this.sessions.clear();
    this.storedPdfsByDocId.clear();
    this.storedPdfsByPath.clear();
    this.recents = [];
    this.bookmarks.clear();
    this.annotations.clear();
    this.renderCache.clear();
    this.stagedManifest = null;
    this.settings = {
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
      github_release_repo: "smokeInCloud060201/readora",
      installed_version: DEFAULT_APP_VERSION,
      dismissed_update_version: null,
    };
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(LIBRARY_STATE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage access errors
    }
    void clearPdfIndexedDb();
    return {
      removed_database_files: 1,
      removed_cache_entries: removedCacheItems,
      removed_temp_entries: 0,
      data_dir_removed: true,
      cache_dir_removed: true,
      redacted_data_dir: "~/Library/Application Support/com.readora.desktop",
      redacted_cache_dir: "~/Library/Caches/com.readora.desktop",
    };
  }
}
