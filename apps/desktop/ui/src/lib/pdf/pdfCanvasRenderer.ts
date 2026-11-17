/// <reference types="vite/client" />
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  type CommandErrorDto,
  type DocumentMetadataDto,
  type OutlineNodeDto,
  type RenderedPageResultDto,
  type RenderMode,
  type RenderPageCommandDto,
  type SearchHitDto,
  type SearchRequestDto,
} from "../../types/ipc";
import { hasUsableCanvas2D } from "./indexedDbStore";
import {
  computeMatchBoundingBoxes,
  findMatchesInPageText,
  normalizePdfGlyphText,
  type PageTextLayout,
  type PageTextSpan,
} from "./textSearch";

if (typeof window !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface ParsedPdfJsDocument {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageCount: number;
  metadata: DocumentMetadataDto;
  outline: OutlineNodeDto[];
  pageTexts: Map<number, string>;
  pageLayouts: Map<number, PageTextLayout>;
}

export function destroyParsedPdf(
  parsed: ParsedPdfJsDocument | null | undefined,
): void {
  if (!parsed) {
    return;
  }
  parsed.pageTexts.clear();
  parsed.pageLayouts.clear();
  const maybeDestroyable = parsed.pdfDoc as pdfjsLib.PDFDocumentProxy & {
    destroy?: () => Promise<void>;
  };
  if (typeof maybeDestroyable.destroy === "function") {
    void maybeDestroyable.destroy().catch(() => {});
  } else if (parsed.pdfDoc.loadingTask) {
    void parsed.pdfDoc.loadingTask.destroy().catch(() => {});
  } else {
    void parsed.pdfDoc.cleanup(false).catch(() => {});
  }
}

export function purgeDocumentRenderCache(
  renderCache: Map<string, string>,
  documentId: string,
): void {
  const prefix = `${documentId}:`;
  for (const key of Array.from(renderCache.keys())) {
    if (key.startsWith(prefix)) {
      renderCache.delete(key);
    }
  }
}

function makePdfError(code: string, message: string): CommandErrorDto {
  return { code, message };
}

export function sanitizeMetadataTitle(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const withoutCtrl = Array.from(raw)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  if (!withoutCtrl) {
    return null;
  }

  const stripped = withoutCtrl.replace(/^microsoft word\s*-\s*/i, "").trim();
  if (!stripped) {
    return null;
  }

  const lower = stripped.toLowerCase();
  if (
    lower === "untitled" ||
    lower === "untitled document" ||
    lower === "document"
  ) {
    return null;
  }

  if (
    /^(?:file:|https?:\/\/|ftp:\/\/|about:|data:|blob:|mailto:|javascript:|chrome-extension:\/\/)/i.test(
      stripped,
    )
  ) {
    return null;
  }

  if (/^[a-zA-Z]:[\\/]/.test(stripped) || stripped.startsWith("\\\\")) {
    return null;
  }

  if (
    stripped.startsWith("/") &&
    (stripped.slice(1).includes("/") || /^\/(?:tmp|var|etc)\b/i.test(stripped))
  ) {
    return null;
  }

  if (
    (stripped.includes("/") || stripped.includes("\\")) &&
    /\.(?:htm|html|xhtml|mht|mhtml|doc|docx|tmp)$/i.test(stripped)
  ) {
    return null;
  }

  return stripped;
}

const PAPER_LIGHT_RGB: readonly [number, number, number] = [252, 251, 246]; // #fcfbf6
const INK_LIGHT_RGB: readonly [number, number, number] = [35, 37, 31]; // #23251f
const PAPER_GRAY_RGB: readonly [number, number, number] = [244, 244, 240]; // #f4f4f0
const INK_GRAY_RGB: readonly [number, number, number] = [38, 39, 36]; // #262724
const PAPER_DARK_RGB: readonly [number, number, number] = [38, 40, 35]; // #262823
const INK_DARK_RGB: readonly [number, number, number] = [230, 232, 225]; // #e6e8e1

function lerpChannel(a: number, b: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return Math.min(255, Math.max(0, Math.round(a + (b - a) * clamped)));
}

export function harmonizePixelBufferWithTheme(
  data: Uint8ClampedArray,
  renderMode: RenderMode,
): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    if (renderMode === "standard") {
      const t = Math.pow(Math.min(1, Math.max(0, luma)), 1.12);
      const nr = INK_LIGHT_RGB[0] + (PAPER_LIGHT_RGB[0] - INK_LIGHT_RGB[0]) * t;
      const ng = INK_LIGHT_RGB[1] + (PAPER_LIGHT_RGB[1] - INK_LIGHT_RGB[1]) * t;
      const nb = INK_LIGHT_RGB[2] + (PAPER_LIGHT_RGB[2] - INK_LIGHT_RGB[2]) * t;
      if (chroma <= 12) {
        data[i] = Math.round(nr);
        data[i + 1] = Math.round(ng);
        data[i + 2] = Math.round(nb);
      } else {
        const cr = r * (PAPER_LIGHT_RGB[0] / 255);
        const cg = g * (PAPER_LIGHT_RGB[1] / 255);
        const cb = b * (PAPER_LIGHT_RGB[2] / 255);
        const w = (chroma - 12) / 24;
        data[i] = lerpChannel(nr, cr, w);
        data[i + 1] = lerpChannel(ng, cg, w);
        data[i + 2] = lerpChannel(nb, cb, w);
      }
    } else if (renderMode === "grayscale") {
      const t = Math.pow(Math.min(1, Math.max(0, luma)), 1.12);
      data[i] = lerpChannel(INK_GRAY_RGB[0], PAPER_GRAY_RGB[0], t);
      data[i + 1] = lerpChannel(INK_GRAY_RGB[1], PAPER_GRAY_RGB[1], t);
      data[i + 2] = lerpChannel(INK_GRAY_RGB[2], PAPER_GRAY_RGB[2], t);
    } else if (renderMode === "dark_inversion") {
      const invT = Math.pow(1 - Math.min(1, Math.max(0, luma)), 0.92);
      const nr =
        PAPER_DARK_RGB[0] + (INK_DARK_RGB[0] - PAPER_DARK_RGB[0]) * invT;
      const ng =
        PAPER_DARK_RGB[1] + (INK_DARK_RGB[1] - PAPER_DARK_RGB[1]) * invT;
      const nb =
        PAPER_DARK_RGB[2] + (INK_DARK_RGB[2] - PAPER_DARK_RGB[2]) * invT;
      if (chroma <= 12) {
        data[i] = Math.round(nr);
        data[i + 1] = Math.round(ng);
        data[i + 2] = Math.round(nb);
      } else {
        const srcLuma = Math.max(1, 0.299 * r + 0.587 * g + 0.114 * b);
        const targetLuma = 0.299 * nr + 0.587 * ng + 0.114 * nb;
        const delta = targetLuma - srcLuma;
        const cr = Math.min(
          242,
          Math.max(PAPER_DARK_RGB[0], r * 0.78 + delta + 12),
        );
        const cg = Math.min(
          242,
          Math.max(PAPER_DARK_RGB[1], g * 0.78 + delta + 12),
        );
        const cb = Math.min(
          242,
          Math.max(PAPER_DARK_RGB[2], b * 0.78 + delta + 12),
        );
        const w = (chroma - 12) / 28;
        data[i] = lerpChannel(nr, cr, w);
        data[i + 1] = lerpChannel(ng, cg, w);
        data[i + 2] = lerpChannel(nb, cb, w);
      }
    }
  }
}

function applyRenderModeToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  renderMode: RenderMode,
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  harmonizePixelBufferWithTheme(imageData.data, renderMode);
  ctx.putImageData(imageData, 0, 0);
}

async function resolveOutlineNodes(
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
        ? await resolveOutlineNodes(pdfDoc, item.items)
        : [];
    result.push({
      title: item.title || "Untitled Section",
      page_index: pageIndex,
      children,
    });
  }
  return result;
}

export type HardenedPdfJsInitParams = NonNullable<
  Parameters<typeof pdfjsLib.getDocument>[0]
> & {
  isEvalSupported: false;
};

export function buildPdfJsDocumentInitParams(
  bytes: Uint8Array,
  password: string | null,
): HardenedPdfJsInitParams {
  return {
    data: bytes.slice(),
    password: password ?? undefined,
    isEvalSupported: false,
  };
}

export async function parsePdfWithPdfJs(
  fileName: string,
  bytes: Uint8Array,
  password: string | null,
): Promise<ParsedPdfJsDocument> {
  try {
    const loadingTask = pdfjsLib.getDocument(
      buildPdfJsDocumentInitParams(bytes, password),
    );
    const pdfDoc = await loadingTask.promise;
    const pageCount = Math.max(1, pdfDoc.numPages);

    let metadata: DocumentMetadataDto = {
      title: fileName.replace(/\.pdf$/i, ""),
      author: null,
      subject: null,
      creator: null,
      pdf_version: "1.7",
      is_encrypted: Boolean(password),
      form_support: "none",
      form_field_count: 0,
      signature_status: "no_signatures",
      signature_field_count: 0,
    };

    try {
      const metaResult = await pdfDoc.getMetadata();
      const info = (metaResult?.info ?? {}) as Record<string, unknown>;
      const cleanEmbeddedTitle =
        typeof info.Title === "string"
          ? sanitizeMetadataTitle(info.Title)
          : null;
      metadata = {
        title: cleanEmbeddedTitle ?? fileName.replace(/\.pdf$/i, ""),
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
        is_encrypted: Boolean(password),
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

    let outline: OutlineNodeDto[] = [];
    try {
      const rawOutline = await pdfDoc.getOutline();
      if (Array.isArray(rawOutline) && rawOutline.length > 0) {
        outline = await resolveOutlineNodes(pdfDoc, rawOutline);
      }
    } catch {
      // Keep empty outline if PDF has no bookmarks
    }

    return {
      pdfDoc,
      pageCount,
      metadata,
      outline,
      pageTexts: new Map<number, string>(),
      pageLayouts: new Map<number, PageTextLayout>(),
    };
  } catch (err) {
    const maybePwErr = err as { name?: string; code?: number };
    if (maybePwErr?.name === "PasswordException") {
      if (maybePwErr.code === 2) {
        throw makePdfError("incorrect_password", "Incorrect document password");
      }
      throw makePdfError("password_required", "Document is password-protected");
    }
    throw makePdfError(
      "invalid_pdf",
      "Selected file is not a valid or readable PDF document",
    );
  }
}

export async function extractPdfJsPageLayout(
  parsed: ParsedPdfJsDocument,
  pageIndex: number,
): Promise<PageTextLayout> {
  const cached = parsed.pageLayouts.get(pageIndex);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const page = await parsed.pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageW = Math.max(1, viewport.width || 612);
    const pageH = Math.max(1, viewport.height || 792);
    const textContent = await page.getTextContent();
    const parts: string[] = [];
    const spans: PageTextSpan[] = [];
    let cursor = 0;
    let lastY: number | null = null;
    let lastEndX: number | null = null;
    let lastFontH = 12;
    let currentLineIndex = 0;

    for (const item of textContent.items) {
      if ("str" in item) {
        const rawStr = normalizePdfGlyphText(item.str);
        if (rawStr.length === 0) {
          if (item.hasEOL && parts.length > 0) {
            parts.push("\n");
            cursor += 1;
            lastEndX = null;
            currentLineIndex += 1;
          }
          continue;
        }

        const hasTransform = Array.isArray(item.transform);
        const fontH = hasTransform
          ? Math.max(
              8,
              Math.hypot(
                Number(item.transform[2]) || 0,
                Number(item.transform[3]) || 0,
              ) || Math.abs(Number(item.transform[0]) || 12),
            )
          : lastFontH;
        const itemW = Math.max(
          fontH * 0.35,
          typeof item.width === "number" && item.width > 0
            ? item.width
            : rawStr.length * fontH * 0.52,
        );
        const tx =
          hasTransform && typeof item.transform[4] === "number"
            ? item.transform[4]
            : null;
        const ty =
          hasTransform && typeof item.transform[5] === "number"
            ? Number(item.transform[5])
            : null;

        const lineThreshold = Math.max(
          3,
          Math.min(fontH, lastFontH) * 0.35,
        );
        const isVerticalLineBreak =
          lastY !== null &&
          ty !== null &&
          Math.abs(ty - lastY) > lineThreshold;
        const isCarriageReturnWrap =
          tx !== null && lastEndX !== null && tx < lastEndX - fontH * 1.4;

        if (
          (isVerticalLineBreak || isCarriageReturnWrap) &&
          parts.length > 0
        ) {
          const lastPart = parts[parts.length - 1] ?? "";
          if (!lastPart.endsWith("\n")) {
            parts.push("\n");
            cursor += 1;
          }
          lastEndX = null;
          currentLineIndex += 1;
        } else if (parts.length > 0) {
          const lastPart = parts[parts.length - 1] ?? "";
          const prevEndsWithSpace = /\s$/.test(lastPart);
          const currStartsWithSpace = /^\s/.test(rawStr);
          if (!prevEndsWithSpace && !currStartsWithSpace) {
            const shouldInsertSpace =
              tx !== null && lastEndX !== null
                ? tx - lastEndX > fontH * 0.16
                : false;
            if (shouldInsertSpace) {
              parts.push(" ");
              cursor += 1;
            }
          }
        }

        const startOffset = cursor;
        parts.push(rawStr);
        cursor += rawStr.length;
        const endOffset = cursor;

        if (rawStr.trim().length > 0 && hasTransform) {
          const effectiveTx = tx ?? 48;
          const effectiveTy = ty ?? pageH - 124;
          const x_ratio = Math.min(
            0.98,
            Math.max(0.01, effectiveTx / pageW),
          );
          const y_ratio = Math.min(
            0.98,
            Math.max(0.01, (pageH - effectiveTy - fontH * 0.92) / pageH),
          );
          const width_ratio = Math.min(
            1 - x_ratio,
            Math.max(0.012, itemW / pageW),
          );
          const height_ratio = Math.min(
            1 - y_ratio,
            Math.max(0.016, (fontH * 1.28) / pageH),
          );

          spans.push({
            text: rawStr,
            startOffset,
            endOffset,
            x_ratio,
            y_ratio,
            width_ratio,
            height_ratio,
            lineIndex: currentLineIndex,
          });
        }

        if (tx !== null) {
          lastEndX = tx + itemW;
        }
        if (ty !== null) {
          lastY = ty;
        }
        lastFontH = fontH;

        if (item.hasEOL) {
          parts.push("\n");
          cursor += 1;
          lastEndX = null;
          currentLineIndex += 1;
        }
      }
    }

    const extracted = parts.join("");
    const layout: PageTextLayout = {
      fullText: extracted.trim().length > 0 ? extracted : "",
      spans,
    };
    parsed.pageTexts.set(
      pageIndex,
      extracted.replace(/[ \t]+\n/g, "\n").trim(),
    );
    parsed.pageLayouts.set(pageIndex, layout);
    return layout;
  } catch {
    return { fullText: "", spans: [] };
  }
}

export async function renderPdfJsPageToDataUrl(
  parsed: ParsedPdfJsDocument,
  command: RenderPageCommandDto,
  renderCache: Map<string, string>,
  fallbackGeneration: number,
): Promise<RenderedPageResultDto | null> {
  if (!hasUsableCanvas2D()) {
    return null;
  }

  const cacheKey = `${command.document_id}:${command.page_index}:${command.scale.toFixed(2)}:${command.rotation_degrees}:${command.render_mode}`;
  const cachedUrl = renderCache.get(cacheKey);
  const pageNumber = command.page_index + 1;
  const page = await parsed.pdfDoc.getPage(pageNumber);
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
      generation: command.generation ?? fallbackGeneration,
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
  if (!ctx) {
    return null;
  }

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
  if (renderCache.size >= 48) {
    const oldestKey = renderCache.keys().next().value;
    if (oldestKey) renderCache.delete(oldestKey);
  }
  renderCache.set(cacheKey, dataUrl);

  return {
    document_id: command.document_id,
    page_index: command.page_index,
    width_px: widthPx,
    height_px: heightPx,
    data_url: dataUrl,
    cache_hit: false,
    generation: command.generation ?? fallbackGeneration,
  };
}

export async function searchPdfJsDocument(
  parsed: ParsedPdfJsDocument,
  request: SearchRequestDto,
  isCancelled: () => boolean,
): Promise<SearchHitDto[]> {
  const q = request.query.trim();
  if (!q) {
    return [];
  }
  const hits: SearchHitDto[] = [];
  for (let idx = 0; idx < parsed.pageCount; idx += 1) {
    const layout = await extractPdfJsPageLayout(parsed, idx);
    if (isCancelled()) {
      return [];
    }
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
