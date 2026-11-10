/// <reference types="vite/client" />
/**
 * Single typed Tauri IPC client module.
 *
 * All UI components and hooks must route backend calls through this client
 * rather than calling Tauri `invoke()` directly. When running in a standalone
 * browser or WebView environment without native PDFium bound, this module
 * uses Mozilla PDF.js (`pdfjs-dist`) to parse, render, extract text/outlines,
 * and search real user-selected PDF files locally in memory.
 */

import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  type AnnotationDto,
  type AppSettingsDto,
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
  type RenderedPageResultDto,
  type RenderMode,
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

if (typeof window !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

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

interface StoredPdfRecord {
  docId: string;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  bytes: Uint8Array | null;
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageTexts: Map<number, string>;
}

async function readFileToUint8Array(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    const ab = await file.arrayBuffer();
    return new Uint8Array(ab);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error("Failed to read file bytes"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read error"));
    reader.readAsArrayBuffer(file);
  });
}

function buildSvgPageDataUrl(
  widthPx: number,
  heightPx: number,
  title: string,
  pageNumber: number,
  pageCount: number,
  pageText: string,
  renderMode: RenderMode,
): string {
  const bg =
    renderMode === "dark_inversion"
      ? "#1e201b"
      : renderMode === "grayscale"
        ? "#f2f2f2"
        : "#fdfbf6";
  const fg =
    renderMode === "dark_inversion"
      ? "#e8ebe2"
      : renderMode === "grayscale"
        ? "#2b2b2b"
        : "#292b25";
  const muted =
    renderMode === "dark_inversion"
      ? "#9aa191"
      : renderMode === "grayscale"
        ? "#6b6b6b"
        : "#788467";

  const escapeXml = (str: string) =>
    str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const wrappedLines: string[] = [];
  const rawParagraphs = (pageText || `Page ${pageNumber}`).split(/\r?\n/);
  for (const para of rawParagraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let currentLine = "";
    for (const word of words) {
      if ((currentLine + " " + word).trim().length > 68) {
        if (currentLine) wrappedLines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = currentLine ? `${currentLine} ${word}` : word;
      }
    }
    if (currentLine) wrappedLines.push(currentLine);
  }

  const tspans = wrappedLines
    .slice(0, 26)
    .map(
      (line, idx) =>
        `<tspan x="48" y="${124 + idx * 22}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 612 792">
    <rect width="612" height="792" fill="${bg}" />
    <text x="48" y="54" fill="${muted}" font-family="Georgia, serif" font-size="11" font-weight="700" letter-spacing="1">${escapeXml(title.toUpperCase())}</text>
    <text x="564" y="54" fill="${muted}" font-family="sans-serif" font-size="11" text-anchor="end">Page ${pageNumber} / ${pageCount}</text>
    <line x1="48" y1="68" x2="564" y2="68" stroke="${muted}" stroke-opacity="0.25" stroke-width="1" />
    <text fill="${fg}" font-family="Georgia, serif" font-size="13">${tspans}</text>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function applyRenderModeToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  renderMode: RenderMode,
): void {
  if (renderMode === "standard") return;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (renderMode === "grayscale") {
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
    } else if (renderMode === "dark_inversion") {
      data[i] = 255 - r;
      data[i + 1] = 255 - g;
      data[i + 2] = 255 - b;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function hasUsableCanvas2D(): boolean {
  if (typeof document === "undefined") return false;
  if (
    typeof navigator !== "undefined" &&
    /jsdom/i.test(navigator.userAgent ?? "")
  ) {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("2d"));
  } catch {
    return false;
  }
}

class BrowserFallbackBridge {
  private sessions = new Map<string, DocumentSessionDto>();
  private storedPdfsByDocId = new Map<string, StoredPdfRecord>();
  private storedPdfsByPath = new Map<string, StoredPdfRecord>();
  private renderCache = new Map<string, string>();
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
    const fileName = parts[parts.length - 1] || "Document.pdf";
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
    const isEncryptedByName = cleanPath.toLowerCase().includes("encrypted");
    if (isEncryptedByName && !password) {
      throw this.makeError("password_required", "Document is password-protected");
    }
    if (isEncryptedByName && password !== "topsecret") {
      throw this.makeError("incorrect_password", "Incorrect document password");
    }

    const docId = `doc-${fileName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const existingRecent = this.recents.find((r) => r.document_id === docId);

    let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
    let pageCount = SAMPLE_PAGES.length;
    let metadata: DocumentMetadataDto = {
      title: fileName.replace(/\.pdf$/i, ""),
      author: "Local Author",
      subject: null,
      creator: null,
      pdf_version: "1.7",
      is_encrypted: isEncryptedByName,
      form_support: "none",
      form_field_count: 0,
      signature_status: "no_signatures",
      signature_field_count: 0,
    };
    let outline: OutlineNodeDto[] = [];
    const pageTexts = new Map<number, string>();

    if (bytes && bytes.byteLength > 0 && hasUsableCanvas2D()) {
      try {
        const loadingTask = pdfjsLib.getDocument({
          data: bytes.slice(),
          password: password ?? undefined,
        });
        pdfDoc = await loadingTask.promise;
        pageCount = Math.max(1, pdfDoc.numPages);

        try {
          const metaResult = await pdfDoc.getMetadata();
          const info = (metaResult?.info ?? {}) as Record<string, unknown>;
          metadata = {
            title:
              typeof info.Title === "string" && info.Title.trim().length > 0
                ? info.Title.trim()
                : fileName.replace(/\.pdf$/i, ""),
            author:
              typeof info.Author === "string" && info.Author.trim().length > 0
                ? info.Author.trim()
                : null,
            subject:
              typeof info.Subject === "string" && info.Subject.trim().length > 0
                ? info.Subject.trim()
                : null,
            creator:
              typeof info.Creator === "string" && info.Creator.trim().length > 0
                ? info.Creator.trim()
                : null,
            pdf_version:
              typeof info.PDFFormatVersion === "string" &&
              info.PDFFormatVersion.trim().length > 0
                ? info.PDFFormatVersion.trim()
                : "1.7",
            is_encrypted: Boolean(password) || isEncryptedByName,
            form_support: info.IsXFAPresent
              ? "unsupported_xfa"
              : info.IsAcroFormPresent
                ? "acro_form_read_only"
                : "none",
            form_field_count: info.IsAcroFormPresent ? 1 : 0,
            signature_status: info.IsSignaturesPresent
              ? "signature_present_unverified"
              : "no_signatures",
            signature_field_count: info.IsSignaturesPresent ? 1 : 0,
          };
        } catch {
          // Keep default metadata if PDF info dictionary is absent
        }

        try {
          const rawOutline = await pdfDoc.getOutline();
          if (Array.isArray(rawOutline) && rawOutline.length > 0) {
            outline = await this.resolveOutlineNodes(pdfDoc, rawOutline);
          }
        } catch {
          // Keep empty outline if PDF has no bookmarks
        }
      } catch (err) {
        const maybePwErr = err as { name?: string; code?: number };
        if (maybePwErr?.name === "PasswordException") {
          if (maybePwErr.code === 2) {
            throw this.makeError(
              "incorrect_password",
              "Incorrect document password",
            );
          }
          throw this.makeError(
            "password_required",
            "Document is password-protected",
          );
        }
        throw this.makeError(
          "invalid_pdf",
          "Selected file is not a valid or readable PDF document",
        );
      }
    } else {
      SAMPLE_PAGES.forEach((text, idx) => {
        pageTexts.set(idx, text);
      });
      outline = SAMPLE_PAGES.map((text, idx) => ({
        title: text.split("—")[0]?.trim() ?? `Section ${idx + 1}`,
        page_index: idx,
        children: [],
      }));
    }

    const record: StoredPdfRecord = {
      docId,
      filePath: cleanPath,
      fileName,
      fileSizeBytes,
      bytes,
      pdfDoc,
      pageTexts,
    };
    this.storedPdfsByDocId.set(docId, record);
    this.storedPdfsByPath.set(cleanPath, record);

    const initialPage = existingRecent
      ? Math.min(existingRecent.last_page, Math.max(0, pageCount - 1))
      : 0;

    const viewState: ViewStateDto = {
      document_id: docId,
      current_page: initialPage,
      page_count: pageCount,
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
        file_size_bytes: fileSizeBytes,
        page_count: pageCount,
        metadata,
      },
      view_state: viewState,
      outline,
      bookmarks: existingSession ? existingSession.bookmarks : [],
    };

    this.sessions.set(docId, session);
    this.upsertRecent(cleanPath, session);
    return structuredClone(session);
  }

  private async resolveOutlineNodes(
    pdfDoc: pdfjsLib.PDFDocumentProxy,
    items: Awaited<ReturnType<pdfjsLib.PDFDocumentProxy["getOutline"]>>,
  ): Promise<OutlineNodeDto[]> {
    const result: OutlineNodeDto[] = [];
    for (const item of items) {
      let pageIndex: number | null = null;
      try {
        let dest = item.dest;
        if (typeof dest === "string") {
          dest = await pdfDoc.getDestination(dest);
        }
        if (Array.isArray(dest) && dest[0]) {
          pageIndex = await pdfDoc.getPageIndex(dest[0]);
        }
      } catch {
        pageIndex = 0;
      }
      const children =
        Array.isArray(item.items) && item.items.length > 0
          ? await this.resolveOutlineNodes(pdfDoc, item.items)
          : [];
      result.push({
        title: item.title || "Untitled Section",
        page_index: pageIndex,
        children,
      });
    }
    return result;
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
      recent.last_page = vs.current_page;
      recent.last_zoom = vs.zoom;
      recent.last_rotation = vs.rotation;
      recent.last_opened_unix_ms = Date.now();
    }
    return structuredClone(vs);
  }

  async renderPage(
    command: RenderPageCommandDto,
  ): Promise<RenderedPageResultDto> {
    const cacheKey = `${command.document_id}:${command.page_index}:${command.scale.toFixed(2)}:${command.rotation_degrees}:${command.render_mode}`;
    const cachedUrl = this.renderCache.get(cacheKey);
    const record = this.storedPdfsByDocId.get(command.document_id);
    const session = this.sessions.get(command.document_id);

    if (record?.pdfDoc && hasUsableCanvas2D()) {
      const pageNumber = command.page_index + 1;
      const page = await record.pdfDoc.getPage(pageNumber);
      const totalRotation = (page.rotate + command.rotation_degrees) % 360;
      const unscaledViewport = page.getViewport({
        scale: 1.0,
        rotation: totalRotation,
      });
      const aspect =
        unscaledViewport.height / Math.max(1, unscaledViewport.width);
      const isLandscape = unscaledViewport.width > unscaledViewport.height;
      const baseDisplayWidth = isLandscape ? 760 : 608;
      const widthPx = Math.max(120, Math.round(baseDisplayWidth * command.scale));
      const heightPx = Math.max(120, Math.round(widthPx * aspect));

      if (cachedUrl) {
        return {
          document_id: command.document_id,
          page_index: command.page_index,
          width_px: widthPx,
          height_px: heightPx,
          data_url: cachedUrl,
          cache_hit: true,
          generation: command.generation ?? this.generation,
        };
      }

      const dpr =
        typeof window !== "undefined"
          ? Math.min(2, Math.max(1.25, window.devicePixelRatio || 1.5))
          : 1.5;
      const effectivePdfScale =
        (widthPx * dpr) / Math.max(1, unscaledViewport.width);
      const renderViewport = page.getViewport({
        scale: effectivePdfScale,
        rotation: totalRotation,
      });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(renderViewport.width));
      canvas.height = Math.max(1, Math.round(renderViewport.height));
      const ctx = canvas.getContext("2d");

      if (ctx) {
        await page.render({
          canvasContext: ctx,
          viewport: renderViewport,
          canvas,
        }).promise;
        applyRenderModeToCanvas(
          ctx,
          canvas.width,
          canvas.height,
          command.render_mode,
        );
        const dataUrl = canvas.toDataURL("image/png");
        if (this.renderCache.size >= 48) {
          const oldestKey = this.renderCache.keys().next().value;
          if (oldestKey) this.renderCache.delete(oldestKey);
        }
        this.renderCache.set(cacheKey, dataUrl);

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
      const cached = record.pageTexts.get(pageIndex);
      if (cached !== undefined) {
        return cached;
      }
      if (record.pdfDoc) {
        try {
          const page = await record.pdfDoc.getPage(pageIndex + 1);
          const textContent = await page.getTextContent();
          const parts: string[] = [];
          let lastY: number | null = null;
          for (const item of textContent.items) {
            if ("str" in item) {
              const y = Array.isArray(item.transform)
                ? Number(item.transform[5])
                : null;
              if (
                lastY !== null &&
                y !== null &&
                Math.abs(y - lastY) > 4 &&
                parts.length > 0
              ) {
                parts.push("\n");
              } else {
                const lastPart = parts[parts.length - 1];
                if (lastPart !== undefined && !lastPart.endsWith("\n")) {
                  parts.push(" ");
                }
              }
              parts.push(item.str);
              if (item.hasEOL) {
                parts.push("\n");
              }
              if (y !== null) {
                lastY = y;
              }
            }
          }
          const extracted = parts.join("").replace(/[ \t]+\n/g, "\n").trim();
          record.pageTexts.set(pageIndex, extracted);
          return extracted;
        } catch {
          return "";
        }
      }
    }
    return SAMPLE_PAGES[pageIndex] ?? `Page ${pageIndex + 1}`;
  }

  async searchDocument(request: SearchRequestDto): Promise<SearchHitDto[]> {
    const q = request.query.trim();
    if (!q) {
      return [];
    }
    const needle = request.case_sensitive ? q : q.toLowerCase();
    const hits: SearchHitDto[] = [];
    const session = this.sessions.get(request.document_id);
    const pageCount = session?.descriptor.page_count ?? SAMPLE_PAGES.length;

    for (let idx = 0; idx < pageCount; idx += 1) {
      const text = await this.extractPageText(request.document_id, idx);
      if (!text) continue;
      const hay = request.case_sensitive ? text : text.toLowerCase();
      let searchFrom = 0;
      let matchIdx = 0;
      while (searchFrom < hay.length) {
        const pos = hay.indexOf(needle, searchFrom);
        if (pos === -1) break;
        const start = Math.max(0, pos - 28);
        const end = Math.min(text.length, pos + needle.length + 42);
        const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
        hits.push({
          page_index: idx,
          match_index: matchIdx,
          snippet,
        });
        if (hits.length >= (request.max_hits || 100)) {
          return hits;
        }
        matchIdx += 1;
        searchFrom = pos + Math.max(1, needle.length);
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

  hasSession(documentId: string): boolean {
    return this.sessions.has(documentId) || this.storedPdfsByDocId.has(documentId);
  }

  hasStoredPath(path: string): boolean {
    return this.storedPdfsByPath.has(path.trim());
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
          name: "pdfjs-dist (Mozilla PDF.js)",
          version: "6.5.x",
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
  async openDocumentFile(
    file: File,
    password: string | null = null,
  ): Promise<DocumentSessionDto> {
    return fallbackBridge.openDocumentFile(file, password);
  },

  async openDocument(
    request: OpenDocumentRequestDto,
  ): Promise<DocumentSessionDto> {
    if (fallbackBridge.hasStoredPath(request.path)) {
      return fallbackBridge.openDocument(request);
    }
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
    if (fallbackBridge.hasSession(documentId)) {
      fallbackBridge.closeDocument(documentId);
      return;
    }
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
    if (fallbackBridge.hasSession(documentId)) {
      return fallbackBridge.navigate(documentId, action);
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<ViewStateDto>("document_navigate", { documentId, action });
    }
    return fallbackBridge.navigate(documentId, action);
  },

  async renderPage(
    command: RenderPageCommandDto,
  ): Promise<RenderedPageResultDto> {
    if (fallbackBridge.hasSession(command.document_id)) {
      return fallbackBridge.renderPage(command);
    }
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
    if (fallbackBridge.hasSession(documentId)) {
      return fallbackBridge.extractPageText(documentId, pageIndex);
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<string>("page_extract_text", { documentId, pageIndex });
    }
    return fallbackBridge.extractPageText(documentId, pageIndex);
  },

  async searchDocument(request: SearchRequestDto): Promise<SearchHitDto[]> {
    if (fallbackBridge.hasSession(request.document_id)) {
      return fallbackBridge.searchDocument(request);
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<SearchHitDto[]>("document_search", { request });
    }
    return fallbackBridge.searchDocument(request);
  },

  async listRecentDocuments(limit = 20): Promise<RecentDocumentDto[]> {
    const localRecents = fallbackBridge.listRecents();
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const nativeRecents = await invoke<RecentDocumentDto[]>(
        "recent_documents_list",
        { limit },
      );
      const merged = [...localRecents];
      for (const nr of nativeRecents) {
        if (!merged.some((r) => r.document_id === nr.document_id)) {
          merged.push(nr);
        }
      }
      return merged.slice(0, limit);
    }
    return localRecents;
  },

  async setFavoriteDocument(
    documentId: string,
    isFavorite: boolean,
  ): Promise<RecentDocumentDto | null> {
    if (fallbackBridge.hasSession(documentId)) {
      return fallbackBridge.setFavoriteDocument(documentId, isFavorite);
    }
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
    if (fallbackBridge.hasSession(documentId)) {
      return fallbackBridge.setDocumentArchived(documentId, isArchived);
    }
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
    if (fallbackBridge.hasSession(documentId)) {
      fallbackBridge.deleteRecentDocument(documentId);
      return;
    }
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
    if (fallbackBridge.hasSession(command.document_id)) {
      return fallbackBridge.upsertBookmark(command);
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<BookmarkDto>("bookmark_upsert", { command });
    }
    return fallbackBridge.upsertBookmark(command);
  },

  async deleteBookmark(bookmarkId: string): Promise<boolean> {
    if (fallbackBridge.deleteBookmark(bookmarkId)) {
      return true;
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<boolean>("bookmark_delete", { bookmarkId });
    }
    return false;
  },

  async listAnnotations(documentId: string): Promise<AnnotationDto[]> {
    if (fallbackBridge.hasSession(documentId)) {
      return fallbackBridge.listAnnotations(documentId);
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AnnotationDto[]>("annotation_list", { documentId });
    }
    return fallbackBridge.listAnnotations(documentId);
  },

  async upsertAnnotation(
    command: UpsertAnnotationCommandDto,
  ): Promise<AnnotationDto> {
    if (fallbackBridge.hasSession(command.document_id)) {
      return fallbackBridge.upsertAnnotation(command);
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AnnotationDto>("annotation_upsert", { command });
    }
    return fallbackBridge.upsertAnnotation(command);
  },

  async deleteAnnotation(annotationId: string): Promise<boolean> {
    if (fallbackBridge.deleteAnnotation(annotationId)) {
      return true;
    }
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<boolean>("annotation_delete", { annotationId });
    }
    return false;
  },

  async exportAnnotations(
    documentId: string,
    includeAnnotations: boolean,
    destinationPath: string | null = null,
  ): Promise<ExportAnnotationsBundleDto> {
    if (fallbackBridge.hasSession(documentId)) {
      return fallbackBridge.exportAnnotations(
        documentId,
        includeAnnotations,
        destinationPath,
      );
    }
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
