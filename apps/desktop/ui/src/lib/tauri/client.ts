/**
 * Single typed Tauri IPC client module.
 *
 * All UI components and hooks must route backend calls through this client
 * rather than calling Tauri `invoke()` directly. When running in a standalone
 * browser or Vitest environment without the native Tauri bridge, this module
 * falls back to an in-memory simulation that exercises the exact same typed contract.
 */

import {
  type AnnotationDto,
  type AppSettingsDto,
  type BookmarkDto,
  type CommandErrorDto,
  type DocumentSessionDto,
  type ExportAnnotationsBundleDto,
  type FitMode,
  type NavigationActionDto,
  type OpenDocumentRequestDto,
  type RecentDocumentDto,
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

type TauriInvokeFn = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface WindowWithTauri {
  __TAURI_INTERNALS__?: {
    invoke?: TauriInvokeFn;
  };
}

function getNativeTauriInvoke(): TauriInvokeFn | null {
  if (typeof window === "undefined") {
    return null;
  }
  const win = window as unknown as WindowWithTauri;
  return win.__TAURI_INTERNALS__?.invoke ?? null;
}

const ZOOM_PRESETS: readonly number[] = [
  0.25, 0.5, 0.75, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0, 4.0,
];

const SAMPLE_PAGES: readonly string[] = [
  "Page 1: Welcome to Readora — Local-first Rust + Tauri 2 PDF Reader.",
  "Page 2: Hexagonal Architecture — Domain, Application, and Replaceable Ports.",
  "Page 3: Memory-Bounded LRU Render Cache and Stale Request Cancellation.",
  "Page 4: SQLite Persistence for Recent Documents, Bookmarks, and Preferences.",
  "Page 5: Security and Privacy Baseline — Every PDF Treated as Untrusted Input.",
];

// 1x1 transparent PNG data URL for lightweight browser/Vitest fallback rendering.
const FALLBACK_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class BrowserFallbackBridge {
  private sessions = new Map<string, DocumentSessionDto>();
  private recents: RecentDocumentDto[] = [];
  private annotations = new Map<string, AnnotationDto[]>();
  private settings: AppSettingsDto = {
    theme: "system",
    default_layout: "single_page",
    default_fit_mode: "fit_width",
    default_zoom: 1.0,
    render_cache_budget_bytes: 64 * 1024 * 1024,
    prefetch_window: 1,
  };
  private generation = 1;

  openDocument(request: OpenDocumentRequestDto): DocumentSessionDto {
    const cleanPath = request.path.trim();
    if (!cleanPath) {
      throw this.makeError("platform_error", "File path must not be empty");
    }
    const isEncrypted = cleanPath.toLowerCase().includes("encrypted");
    if (isEncrypted && !request.password) {
      throw this.makeError("password_required", "Document is password-protected");
    }
    if (isEncrypted && request.password !== "topsecret") {
      throw this.makeError("incorrect_password", "Incorrect document password");
    }

    const parts = cleanPath.split(/[/\\]/);
    const fileName = parts[parts.length - 1] || "Document.pdf";
    const docId = `doc-${fileName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const existingRecent = this.recents.find((r) => r.document_id === docId);

    const viewState: ViewStateDto = {
      document_id: docId,
      current_page: existingRecent ? existingRecent.last_page : 0,
      page_count: SAMPLE_PAGES.length,
      zoom: existingRecent ? existingRecent.last_zoom : this.settings.default_zoom,
      fit_mode: this.settings.default_fit_mode,
      rotation: existingRecent ? existingRecent.last_rotation : "deg0",
      layout_mode: this.settings.default_layout,
      render_mode: "standard",
    };

    const existingSession = this.sessions.get(docId);
    const session: DocumentSessionDto = {
      descriptor: {
        id: docId,
        file_name: fileName,
        file_size_bytes: 28_672,
        page_count: SAMPLE_PAGES.length,
        metadata: {
          title: fileName.replace(/\.pdf$/i, ""),
          author: "Readora Architecture",
          subject: "Local-First Desktop PDF Reader",
          creator: "Readora",
          pdf_version: "1.7",
          is_encrypted: isEncrypted,
        },
      },
      view_state: viewState,
      outline: SAMPLE_PAGES.map((text, idx) => ({
        title: text.split("—")[0]?.trim() ?? `Section ${idx + 1}`,
        page_index: idx,
        children: [],
      })),
      bookmarks: existingSession ? existingSession.bookmarks : [],
    };

    this.sessions.set(docId, session);
    this.upsertRecent(cleanPath, session);
    return structuredClone(session);
  }

  navigate(documentId: string, action: NavigationActionDto): ViewStateDto {
    const session = this.sessions.get(documentId);
    if (!session) {
      throw this.makeError("document_not_open", `Document '${documentId}' is not open`);
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
      recent.last_page = vs.current_page;
      recent.last_zoom = vs.zoom;
      recent.last_rotation = vs.rotation;
      recent.last_opened_unix_ms = Date.now();
    }
    return structuredClone(vs);
  }

  renderPage(command: RenderPageCommandDto): RenderedPageResultDto {
    const isRotatedSideways =
      command.rotation_degrees === 90 || command.rotation_degrees === 270;
    const baseW = isRotatedSideways ? 792 : 612;
    const baseH = isRotatedSideways ? 612 : 792;
    return {
      document_id: command.document_id,
      page_index: command.page_index,
      width_px: Math.round(baseW * command.scale),
      height_px: Math.round(baseH * command.scale),
      data_url: FALLBACK_PNG_DATA_URL,
      cache_hit: false,
      generation: command.generation ?? this.generation,
    };
  }

  extractPageText(pageIndex: number): string {
    return SAMPLE_PAGES[pageIndex] ?? `Page ${pageIndex + 1}`;
  }

  searchDocument(request: SearchRequestDto): SearchHitDto[] {
    const q = request.query.trim();
    if (!q) {
      return [];
    }
    const needle = request.case_sensitive ? q : q.toLowerCase();
    const hits: SearchHitDto[] = [];
    SAMPLE_PAGES.forEach((text, idx) => {
      const hay = request.case_sensitive ? text : text.toLowerCase();
      if (hay.includes(needle)) {
        hits.push({
          page_index: idx,
          match_index: 0,
          snippet: text,
        });
      }
    });
    return hits.slice(0, request.max_hits || 100);
  }

  upsertBookmark(command: UpsertBookmarkCommandDto): BookmarkDto {
    const session = this.sessions.get(command.document_id);
    if (!session) {
      throw this.makeError("document_not_open", "Document is not open");
    }
    const trimmed = command.label.trim();
    if (!trimmed) {
      throw this.makeError("validation_error", "Bookmark label must not be empty");
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
    return structuredClone(bm);
  }

  deleteBookmark(bookmarkId: string): boolean {
    for (const session of this.sessions.values()) {
      const idx = session.bookmarks.findIndex((b) => b.id === bookmarkId);
      if (idx >= 0) {
        session.bookmarks.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  listAnnotations(documentId: string): AnnotationDto[] {
    return structuredClone(this.annotations.get(documentId) ?? []);
  }

  upsertAnnotation(command: UpsertAnnotationCommandDto): AnnotationDto {
    const list = this.annotations.get(command.document_id) ?? [];
    const created: AnnotationDto = {
      id: `ann-${command.document_id}-${command.page_index}-${Date.now()}`,
      document_id: command.document_id,
      page_index: command.page_index,
      kind: command.kind,
      color_hex: command.color_hex,
      quote_text: command.quote_text.trim(),
      note_text: command.note_text.trim(),
      created_at_unix_ms: Date.now(),
    };
    const next = [...list, created].sort((a, b) => a.page_index - b.page_index);
    this.annotations.set(command.document_id, next);
    return structuredClone(created);
  }

  deleteAnnotation(annotationId: string): boolean {
    for (const [docId, list] of this.annotations.entries()) {
      const idx = list.findIndex((a) => a.id === annotationId);
      if (idx >= 0) {
        list.splice(idx, 1);
        this.annotations.set(docId, list);
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
    return structuredClone(rec);
  }

  setDocumentArchived(
    documentId: string,
    isArchived: boolean,
  ): RecentDocumentDto | null {
    const rec = this.recents.find((r) => r.document_id === documentId);
    if (!rec) return null;
    rec.is_archived = isArchived;
    return structuredClone(rec);
  }

  deleteRecentDocument(documentId: string): void {
    this.recents = this.recents.filter((r) => r.document_id !== documentId);
  }

  closeDocument(documentId: string): void {
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
    const bookmarks = session?.bookmarks ?? [];
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
      share_uri: `readora://document/${documentId}`,
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
      app_version: "0.1.0",
      target_os: "macos",
      target_arch: "aarch64",
      pdf_engine_kind: "pure_rust_fallback",
      sqlite_schema_version: 3,
      redacted_data_dir: "~/Library/Application Support/com.readora.desktop",
      render_cache_usage_bytes: 0,
      third_party_notices: [
        {
          name: "PDFium",
          version: "chromium/6723",
          license: "BSD-3-Clause AND Apache-2.0",
          role: "Dynamic native PDF rendering engine",
        },
        {
          name: "rusqlite + SQLite",
          version: "0.32",
          license: "MIT AND Blessing",
          role: "Local WAL persistence for recents, bookmarks, annotations, and settings",
        },
        {
          name: "Tauri",
          version: "2.x",
          license: "MIT OR Apache-2.0",
          role: "Cross-platform desktop application shell and IPC",
        },
        {
          name: "React + TypeScript",
          version: "19.x / 5.7",
          license: "MIT AND Apache-2.0",
          role: "Presentation UI layer",
        },
      ],
    };
  }
}

const fallbackBridge = new BrowserFallbackBridge();

export const readoraApi = {
  async openDocument(
    request: OpenDocumentRequestDto,
  ): Promise<DocumentSessionDto> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<DocumentSessionDto>("document_open", { request });
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
      return invoke<string>("page_extract_text", { documentId, pageIndex });
    }
    return fallbackBridge.extractPageText(pageIndex);
  },

  async searchDocument(request: SearchRequestDto): Promise<SearchHitDto[]> {
    const invoke = getNativeTauriInvoke();
    if (invoke) {
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
};
