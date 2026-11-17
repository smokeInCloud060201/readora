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
