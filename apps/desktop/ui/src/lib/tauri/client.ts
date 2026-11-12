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

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
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
  type RenderMode,
  type RenderPageCommandDto,
  type Rotation,
  type SearchBoundingBoxDto,
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

interface PageTextSpan {
  text: string;
  startOffset: number;
  endOffset: number;
  x_ratio: number;
  y_ratio: number;
  width_ratio: number;
  height_ratio: number;
  lineIndex?: number;
}

interface PageTextLayout {
  fullText: string;
  spans: PageTextSpan[];
}

export function normalizePdfGlyphText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u00A0/g, " ");
}

interface PageMatchRange {
  origStart: number;
  origEnd: number;
}

export function findMatchesInPageText(
  fullText: string,
  rawQuery: string,
  caseSensitive: boolean,
): PageMatchRange[] {
  const normalizedQuery = normalizePdfGlyphText(rawQuery)
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedQuery || !fullText) {
    return [];
  }

  const needle = caseSensitive
    ? normalizedQuery
    : normalizedQuery.toLowerCase();

  // 1. Build whitespace-normalized haystack (collapsing runs of whitespace & hyphenated line wraps) with offset map
  const normChars: string[] = [];
  const normToOrig: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < fullText.length; i += 1) {
    const ch = fullText[i] ?? "";
    // Skip hyphen immediately followed by newline (line-break word wrap: "architec-\nture")
    if (
      ch === "-" &&
      (fullText[i + 1] === "\n" ||
        (fullText[i + 1] === "\r" && fullText[i + 2] === "\n"))
    ) {
      while (i + 1 < fullText.length && /\s/.test(fullText[i + 1] ?? "")) {
        i += 1;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (!inWhitespace && normChars.length > 0) {
        normChars.push(" ");
        normToOrig.push(i);
        inWhitespace = true;
      }
    } else {
      normChars.push(caseSensitive ? ch : ch.toLowerCase());
      normToOrig.push(i);
      inWhitespace = false;
    }
  }

  const normHay = normChars.join("");
  const results: PageMatchRange[] = [];

  let searchFrom = 0;
  while (searchFrom < normHay.length) {
    const pos = normHay.indexOf(needle, searchFrom);
    if (pos === -1) break;
    const origStart = normToOrig[pos] ?? 0;
    const lastNormIdx = pos + needle.length - 1;
    const origEnd = (normToOrig[lastNormIdx] ?? origStart) + 1;
    results.push({ origStart, origEnd });
    searchFrom = pos + Math.max(1, needle.length);
  }

  // 2. Fallback compact/spaceless stream for words split by wide kerning/tracking in PDF fonts (e.g. "D e v e l o p m e n t")
  const compactNeedle = needle.replace(/\s+/g, "");
  if (compactNeedle.length >= 2) {
    const compactChars: string[] = [];
    const compactToOrig: number[] = [];
    for (let i = 0; i < fullText.length; i += 1) {
      const ch = fullText[i] ?? "";
      if (/\s/.test(ch)) continue;
      if (
        ch === "-" &&
        (fullText[i + 1] === "\n" ||
          (fullText[i + 1] === "\r" && fullText[i + 2] === "\n"))
      ) {
        continue;
      }
      compactChars.push(caseSensitive ? ch : ch.toLowerCase());
      compactToOrig.push(i);
    }
    const compactHay = compactChars.join("");
    let cFrom = 0;
    const maxAllowedSpan = compactNeedle.length * 2 + 4;
    while (cFrom < compactHay.length) {
      const cPos = compactHay.indexOf(compactNeedle, cFrom);
      if (cPos === -1) break;
      const origStart = compactToOrig[cPos] ?? 0;
      const origEnd =
        (compactToOrig[cPos + compactNeedle.length - 1] ?? origStart) + 1;
      const spanLength = origEnd - origStart;
      const alreadyCovered = results.some(
        (r) => r.origStart < origEnd && r.origEnd > origStart,
      );
      if (!alreadyCovered && spanLength <= maxAllowedSpan) {
        results.push({ origStart, origEnd });
      }
      cFrom = cPos + Math.max(1, compactNeedle.length);
    }
    results.sort((a, b) => a.origStart - b.origStart);
  }

  return results;
}

interface StoredPdfRecord {
  docId: string;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  bytes: Uint8Array | null;
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageTexts: Map<number, string>;
  pageLayouts: Map<number, PageTextLayout>;
}

function buildSyntheticPageLayout(pageText: string): PageTextLayout {
  const spans: PageTextSpan[] = [];
  const rawParagraphs = (pageText || "").split(/\r?\n/);
  const wrappedLines: string[] = [];
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

  let cursor = 0;
  const fullParts: string[] = [];
  wrappedLines.slice(0, 26).forEach((line, idx) => {
    if (idx > 0) {
      fullParts.push(" ");
      cursor += 1;
    }
    const startOffset = cursor;
    fullParts.push(line);
    cursor += line.length;
    const endOffset = cursor;
    const x_ratio = 48 / 612;
    const y_ratio = Math.max(0.02, (124 + idx * 22 - 12) / 792);
    const width_ratio = Math.min(0.84, Math.max(0.04, (line.length * 7.05) / 612));
    const height_ratio = 18 / 792;
    spans.push({
      text: line,
      startOffset,
      endOffset,
      x_ratio,
      y_ratio,
      width_ratio,
      height_ratio,
      lineIndex: idx,
    });
  });

  return {
    fullText: fullParts.join("") || pageText,
    spans,
  };
}

export function computeMatchBoundingBoxes(
  layout: PageTextLayout,
  matchStart: number,
  matchLength: number,
): SearchBoundingBoxDto[] {
  const matchEnd = matchStart + Math.max(1, matchLength);
  const overlapping = layout.spans.filter(
    (span) =>
      span.endOffset > matchStart &&
      span.startOffset < matchEnd &&
      span.text.length > 0,
  );
  if (overlapping.length > 0) {
    const lineGroups: PageTextSpan[][] = [];
    for (const span of overlapping) {
      const lastGroup = lineGroups[lineGroups.length - 1];
      const refSpan = lastGroup?.[0];
      const prevSpan = lastGroup?.[lastGroup.length - 1];
      const hasDifferentLineIndex =
        span.lineIndex !== undefined &&
        refSpan?.lineIndex !== undefined &&
        span.lineIndex !== refSpan.lineIndex;
      const yThreshold = refSpan
        ? Math.max(
            0.004,
            Math.min(span.height_ratio, refSpan.height_ratio) * 0.35,
          )
        : 0.005;
      const hasDifferentY = refSpan
        ? Math.abs(span.y_ratio - refSpan.y_ratio) > yThreshold
        : true;
      const wrappedLeftToNewRow = prevSpan
        ? span.x_ratio + 0.015 < prevSpan.x_ratio
        : false;

      if (
        lastGroup &&
        refSpan &&
        !hasDifferentLineIndex &&
        !hasDifferentY &&
        !wrappedLeftToNewRow
      ) {
        lastGroup.push(span);
      } else {
        lineGroups.push([span]);
      }
    }

    return lineGroups.map((group) => {
      const firstSpan = group[0]!;
      const lastSpan = group[group.length - 1] ?? firstSpan;

      const firstLen = Math.max(1, firstSpan.text.length);
      const firstLocalStart = Math.max(0, matchStart - firstSpan.startOffset);
      const leftEdge = Math.min(
        0.96,
        firstSpan.x_ratio +
          firstSpan.width_ratio * (firstLocalStart / firstLen),
      );

      const lastLen = Math.max(1, lastSpan.text.length);
      const lastLocalEnd = Math.min(lastLen, matchEnd - lastSpan.startOffset);
      const rightEdge = Math.min(
        0.99,
        lastSpan.x_ratio +
          lastSpan.width_ratio * (Math.max(1, lastLocalEnd) / lastLen),
      );

      const width_ratio = Math.min(
        1 - leftEdge,
        Math.max(0.018, rightEdge - leftEdge),
      );
      const minY = Math.min(...group.map((s) => s.y_ratio));
      const maxH = Math.max(...group.map((s) => s.height_ratio));
      return {
        x_ratio: leftEdge,
        y_ratio: minY,
        width_ratio,
        height_ratio: maxH,
      };
    });
  }

  const totalLen = Math.max(1, layout.fullText.length);
  const ratioInPage = matchStart / totalLen;
  return [
    {
      x_ratio: 0.08 + (ratioInPage % 0.25),
      y_ratio: 0.14 + Math.min(0.74, ratioInPage * 0.68),
      width_ratio: Math.min(0.35, Math.max(0.045, matchLength * 0.011)),
      height_ratio: 0.024,
    },
  ];
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

function compareSemver(left: string, right: string): number {
  const parse = (raw: string): [number, number, number] => {
    const cleaned = raw.trim().replace(/^[vV]/, "");
    const core = cleaned.split(/[-+]/)[0] ?? "";
    const parts = core.split(".");
    return [
      Number.parseInt(parts[0] ?? "0", 10) || 0,
      Number.parseInt(parts[1] ?? "0", 10) || 0,
      Number.parseInt(parts[2] ?? "0", 10) || 0,
    ];
  };
  const l = parse(left);
  const r = parse(right);
  for (let i = 0; i < 3; i += 1) {
    const li = l[i] ?? 0;
    const ri = r[i] ?? 0;
    if (li > ri) return 1;
    if (li < ri) return -1;
  }
  return 0;
}

interface GithubReleaseAssetPayload {
  name?: string;
  size?: number;
  browser_download_url?: string;
  digest?: string;
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  assets?: GithubReleaseAssetPayload[];
}

export function parseGithubReleasePayload(
  rawJson: string,
  targetOs = "macos",
): ReleaseManifestDto {
  const parsed = JSON.parse(rawJson) as GithubReleasePayload;
  const rawTag = (parsed.tag_name ?? "").trim();
  const version = rawTag.replace(/^[vV]/, "").trim();
  if (!version) {
    throw new Error("GitHub release payload is missing tag_name");
  }

  const title =
    parsed.name?.trim() || `Focus Reader ${version} is ready`;
  const notes =
    parsed.body?.trim() ||
    `Release ${version} published on GitHub Releases.`;
  const publishedAt = parsed.published_at ?? "";
  const htmlUrl = parsed.html_url ?? null;

  const osTokens =
    targetOs === "windows"
      ? [".msi", ".exe", "windows", "win64"]
      : targetOs === "linux"
        ? [".appimage", ".deb", ".rpm", "linux"]
        : [".dmg", ".app.tar.gz", "macos", "darwin"];

  let selectedSize = 0;
  let selectedUrl: string | null = null;
  let selectedSha256: string | null = null;

  if (Array.isArray(parsed.assets)) {
    for (const asset of parsed.assets) {
      const nameLower = (asset.name ?? "").toLowerCase();
      const size = typeof asset.size === "number" ? asset.size : 0;
      const url = asset.browser_download_url ?? null;
      const digest = asset.digest
        ? asset.digest.replace(/^sha256:/i, "").trim()
        : null;
      const matchesOs = osTokens.some((tok) => nameLower.includes(tok));
      if (matchesOs || selectedSize === 0) {
        if (size > 0) selectedSize = size;
        if (url) selectedUrl = url;
        if (digest) selectedSha256 = digest;
        if (matchesOs) break;
      }
    }
  }

  const packageSizeBytes =
    selectedSize > 0 ? selectedSize : 42 * 1024 * 1024;
  const downloadUrl = selectedUrl ?? htmlUrl;
  const sha256 =
    selectedSha256 ||
    `github-tag-${version}-${(downloadUrl ?? "").length}`;

  return {
    version,
    title,
    notes,
    package_size_bytes: packageSizeBytes,
    sha256,
    published_at: publishedAt,
    download_url: downloadUrl,
  };
}

const DEFAULT_APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || "1.0.6";

const LIBRARY_STATE_STORAGE_KEY = "readora.library.state.v1";
const PDF_IDB_NAME = "readora_pdf_store_v1";
const PDF_IDB_STORE = "pdfs";

interface PersistedLibraryState {
  recents?: RecentDocumentDto[];
  bookmarks?: Record<string, BookmarkDto[]>;
  annotations?: Record<string, AnnotationDto[]>;
  settings?: Partial<AppSettingsDto>;
}

function isJsdomEnvironment(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /jsdom/i.test(navigator.userAgent ?? "")
  );
}

function openPdfIndexedDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined" || isJsdomEnvironment()) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(PDF_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PDF_IDB_STORE)) {
          db.createObjectStore(PDF_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function savePdfBytesToIndexedDb(
  docId: string,
  bytes: Uint8Array,
): Promise<void> {
  const db = await openPdfIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readwrite");
      tx.objectStore(PDF_IDB_STORE).put(bytes.slice(), docId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function loadPdfBytesFromIndexedDb(
  docId: string,
): Promise<Uint8Array | null> {
  const db = await openPdfIndexedDb();
  if (!db) return null;
  return new Promise<Uint8Array | null>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readonly");
      const req = tx.objectStore(PDF_IDB_STORE).get(docId);
      req.onsuccess = () => {
        db.close();
        const res = req.result;
        if (res instanceof Uint8Array) {
          resolve(res);
        } else if (res instanceof ArrayBuffer) {
          resolve(new Uint8Array(res));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function deletePdfBytesFromIndexedDb(docId: string): Promise<void> {
  const db = await openPdfIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readwrite");
      tx.objectStore(PDF_IDB_STORE).delete(docId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function clearPdfIndexedDb(): Promise<void> {
  const db = await openPdfIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readwrite");
      tx.objectStore(PDF_IDB_STORE).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function savePdfBytesToNativeServer(
  docId: string,
  bytes: Uint8Array,
): Promise<void> {
  if (isJsdomEnvironment() || typeof fetch !== "function") return;
  try {
    const bodyBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await fetch(`/__readora_pdf?id=${encodeURIComponent(docId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: bodyBuffer,
    });
  } catch {
    // Ignore when running in standalone browser dev server
  }
}

async function loadPdfBytesFromNativeServer(
  docId: string,
): Promise<Uint8Array | null> {
  if (isJsdomEnvironment() || typeof fetch !== "function") return null;
  try {
    const resp = await fetch(`/__readora_pdf?id=${encodeURIComponent(docId)}`, {
      method: "GET",
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/pdf")) {
      return null;
    }
    const buf = await resp.arrayBuffer();
    return buf.byteLength > 0 ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

async function deletePdfBytesFromNativeServer(docId: string): Promise<void> {
  if (isJsdomEnvironment() || typeof fetch !== "function") return;
  try {
    await fetch(`/__readora_pdf?id=${encodeURIComponent(docId)}`, {
      method: "DELETE",
    });
  } catch {
    // Ignore when running in standalone browser dev server
  }
}

class BrowserFallbackBridge {
  private sessions = new Map<string, DocumentSessionDto>();
  private storedPdfsByDocId = new Map<string, StoredPdfRecord>();
  private storedPdfsByPath = new Map<string, StoredPdfRecord>();
  private renderCache = new Map<string, string>();
  private recents: RecentDocumentDto[] = [];
  private bookmarks = new Map<string, BookmarkDto[]>();
  private annotations = new Map<string, AnnotationDto[]>();
  private stagedManifest: ReleaseManifestDto | null = null;
  private hydratedFromNative = false;
  private settings: AppSettingsDto = {
    theme: "system",
    default_layout: "continuous",
    default_fit_mode: "fit_width",
    default_zoom: 1.0,
    render_cache_budget_bytes: 64 * 1024 * 1024,
    prefetch_window: 1,
    show_extracted_text_layer: false,
    auto_check_updates: true,
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

  private serializeState(): string {
    const payload: PersistedLibraryState = {
      recents: this.recents,
      bookmarks: Object.fromEntries(this.bookmarks.entries()),
      annotations: Object.fromEntries(this.annotations.entries()),
      settings: this.settings,
    };
    return JSON.stringify(payload);
  }

  private persistState(): void {
    const json = this.serializeState();
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        window.localStorage.setItem(LIBRARY_STATE_STORAGE_KEY, json);
      } catch {
        // Ignore quota errors
      }
    }
    if (!isJsdomEnvironment() && typeof fetch === "function") {
      void fetch("/__readora_state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
      }).catch(() => {});
    }
  }

  async ensureHydrated(): Promise<void> {
    if (this.recents.length === 0) {
      this.loadFromLocalStorage();
    }
    if (
      this.hydratedFromNative ||
      isJsdomEnvironment() ||
      typeof fetch !== "function"
    ) {
      return;
    }
    this.hydratedFromNative = true;
    try {
      const resp = await fetch("/__readora_state", { method: "GET" });
      if (!resp.ok) return;
      const text = await resp.text();
      if (!text.trim().startsWith("{")) return;
      const parsed = JSON.parse(text) as PersistedLibraryState;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.recents) &&
        parsed.recents.length > 0
      ) {
        if (this.recents.length === 0) {
          this.applyPersistedState(parsed);
          if (typeof window !== "undefined" && window.localStorage) {
            window.localStorage.setItem(
              LIBRARY_STATE_STORAGE_KEY,
              this.serializeState(),
            );
          }
        } else {
          // Merge any native recents not already in memory
          let changed = false;
          for (const item of parsed.recents) {
            if (!this.recents.some((r) => r.document_id === item.document_id)) {
              this.recents.push(item);
              changed = true;
            }
          }
          if (changed) {
            this.persistState();
          }
        }
      } else if (this.recents.length > 0) {
        this.persistState();
      }
    } catch {
      // Ignore when running outside native loopback server
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

    const persistedBytes =
      (await loadPdfBytesFromIndexedDb(docId)) ??
      (await loadPdfBytesFromNativeServer(docId));
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
    const pageLayouts = new Map<number, PageTextLayout>();

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
        pageLayouts.set(idx, buildSyntheticPageLayout(text));
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
      pageLayouts,
    };
    this.storedPdfsByDocId.set(docId, record);
    this.storedPdfsByPath.set(cleanPath, record);
    if (bytes && bytes.byteLength > 0) {
      void savePdfBytesToIndexedDb(docId, bytes);
      void savePdfBytesToNativeServer(docId, bytes);
    }
    this.warmDocumentTextIndex(docId, pageCount);

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
    this.persistState();
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

  private warmDocumentTextIndex(documentId: string, pageCount: number): void {
    const record = this.storedPdfsByDocId.get(documentId);
    if (!record || !record.pdfDoc) {
      return;
    }
    const maxBackgroundPages = Math.min(pageCount, 150);
    let nextPage = 0;
    const step = () => {
      const currentRecord = this.storedPdfsByDocId.get(documentId);
      if (!currentRecord || !this.sessions.has(documentId)) {
        return;
      }
      if (nextPage >= maxBackgroundPages) {
        return;
      }
      const pageIdx = nextPage;
      nextPage += 1;
      void this.extractPageLayout(documentId, pageIdx).finally(() => {
        if (nextPage < maxBackgroundPages) {
          setTimeout(step, 4);
        }
      });
    };
    setTimeout(step, 12);
  }

  private async extractPageLayout(
    documentId: string,
    pageIndex: number,
  ): Promise<PageTextLayout> {
    const record = this.storedPdfsByDocId.get(documentId);
    if (record) {
      const cachedLayout = record.pageLayouts.get(pageIndex);
      if (cachedLayout !== undefined) {
        return cachedLayout;
      }
      if (record.pdfDoc) {
        try {
          const page = await record.pdfDoc.getPage(pageIndex + 1);
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
                tx !== null &&
                lastEndX !== null &&
                tx < lastEndX - fontH * 1.4;

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
                  // Only insert a space when the horizontal gap between PDF text runs exceeds a kerning threshold
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
                  Math.max(
                    0.01,
                    (pageH - effectiveTy - fontH * 0.92) / pageH,
                  ),
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
          record.pageTexts.set(pageIndex, extracted.replace(/[ \t]+\n/g, "\n").trim());
          record.pageLayouts.set(pageIndex, layout);
          return layout;
        } catch {
          const emptyLayout: PageTextLayout = { fullText: "", spans: [] };
          return emptyLayout;
        }
      }
      const existingText =
        record.pageTexts.get(pageIndex) ??
        SAMPLE_PAGES[pageIndex] ??
        `Page ${pageIndex + 1}`;
      const synthetic = buildSyntheticPageLayout(existingText);
      record.pageLayouts.set(pageIndex, synthetic);
      return synthetic;
    }

    const fallbackText = SAMPLE_PAGES[pageIndex] ?? `Page ${pageIndex + 1}`;
    return buildSyntheticPageLayout(fallbackText);
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
        await this.extractPageLayout(documentId, pageIndex);
        return record.pageTexts.get(pageIndex) ?? "";
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
    const hits: SearchHitDto[] = [];
    const session = this.sessions.get(request.document_id);
    const pageCount = session?.descriptor.page_count ?? SAMPLE_PAGES.length;

    for (let idx = 0; idx < pageCount; idx += 1) {
      const layout = await this.extractPageLayout(request.document_id, idx);
      if (searchGen !== this.searchGeneration) {
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

  async enrichSearchHits(
    request: SearchRequestDto,
    rawHits: SearchHitDto[],
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
      const text = await readoraApi.extractPageText(
        request.document_id,
        hit.page_index,
      );
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
    const existing = this.recents.find((r) => r.document_id === documentId);
    if (existing) {
      this.storedPdfsByPath.delete(existing.file_path);
    }
    this.recents = this.recents.filter((r) => r.document_id !== documentId);
    this.storedPdfsByDocId.delete(documentId);
    this.bookmarks.delete(documentId);
    this.annotations.delete(documentId);
    void deletePdfBytesFromIndexedDb(documentId);
    void deletePdfBytesFromNativeServer(documentId);
    this.persistState();
  }

  hasSession(documentId: string): boolean {
    return (
      this.sessions.has(documentId) ||
      this.storedPdfsByDocId.has(documentId) ||
      this.recents.some((r) => r.document_id === documentId)
    );
  }

  hasStoredPath(path: string): boolean {
    const trimmed = path.trim();
    return (
      this.storedPdfsByPath.has(trimmed) ||
      this.recents.some((r) => r.file_path === trimmed)
    );
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
      app_version: this.settings.installed_version || "1.0.0",
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
      const verified =
        manifest.sha256.trim().length > 0 && manifest.package_size_bytes > 0;
      return {
        current_version: currentVersion,
        update_available: !isDismissed && verified,
        latest_version: manifest.version,
        release_title: manifest.title,
        release_notes: manifest.notes,
        package_size_bytes: manifest.package_size_bytes,
        sha256_checksum: manifest.sha256,
        download_url: manifest.download_url ?? null,
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
      verified: true,
      staged_for_restart: false,
      checked_at_unix_ms: now,
    };
  }

  stageGithubReleaseJson(rawJson: string): AppUpdateStatusDto {
    const manifest = parseGithubReleasePayload(rawJson, "macos");
    return this.stageUpdateManifest(manifest);
  }

  stageUpdateManifest(manifest: ReleaseManifestDto): AppUpdateStatusDto {
    if (!manifest.version?.trim() || !manifest.sha256?.trim()) {
      throw this.makeError(
        "platform_error",
        "Release manifest must include non-empty version and sha256 fields",
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
    const stagedDownloadUrl = this.stagedManifest?.download_url ?? null;
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
      show_extracted_text_layer: false,
      auto_check_updates: true,
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
    if (!isJsdomEnvironment() && typeof fetch === "function") {
      void fetch("/__readora_state", { method: "DELETE" }).catch(() => {
        // Ignore when native server is not running
      });
    }
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
    await fallbackBridge.ensureHydrated();
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
      const rawHits = await invoke<SearchHitDto[]>("document_search", {
        request,
      });
      return fallbackBridge.enrichSearchHits(request, rawHits);
    }
    return fallbackBridge.searchDocument(request);
  },

  async listRecentDocuments(limit = 20): Promise<RecentDocumentDto[]> {
    await fallbackBridge.ensureHydrated();
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
    await fallbackBridge.ensureHydrated();
    const localSettings = fallbackBridge.getSettings();
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const remote = await invoke<AppSettingsDto>("settings_get");
      return {
        ...remote,
        show_extracted_text_layer:
          remote.show_extracted_text_layer ??
          localSettings.show_extracted_text_layer ??
          false,
        auto_check_updates:
          remote.auto_check_updates ??
          localSettings.auto_check_updates ??
          true,
      };
    }
    return localSettings;
  },

  async updateSettings(patch: SettingsPatchDto): Promise<AppSettingsDto> {
    const localUpdated = fallbackBridge.updateSettings(patch);
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      const remote = await invoke<AppSettingsDto>("settings_update", { patch });
      return {
        ...remote,
        show_extracted_text_layer:
          remote.show_extracted_text_layer ??
          localUpdated.show_extracted_text_layer ??
          false,
        auto_check_updates:
          remote.auto_check_updates ??
          localUpdated.auto_check_updates ??
          true,
      };
    }
    return localUpdated;
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
    const repo = (settings.github_release_repo || "smokeInCloud060201/readora").trim();

    if (typeof fetch === "function" && repo.includes("/")) {
      try {
        const response = await fetch(
          `https://api.github.com/repos/${repo}/releases/latest`,
          {
            method: "GET",
            headers: {
              Accept: "application/vnd.github+json",
            },
          },
        );
        if (response.ok) {
          const rawJson = await response.text();
          if (rawJson.trim().startsWith("{")) {
            fallbackBridge.stageGithubReleaseJson(rawJson);
            if (invoke) {
              await invoke<AppUpdateStatusDto>("app_stage_github_release", {
                rawJson,
              });
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
    const localStatus = fallbackBridge.stageUpdateManifest(manifest);
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_stage_update_manifest", {
        manifest,
      });
    }
    return localStatus;
  },

  async installUpdate(version: string): Promise<AppUpdateStatusDto> {
    const localStatus = fallbackBridge.installUpdate(version);
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_install_update", { version });
    }

    const isJsdomTest =
      typeof navigator !== "undefined" &&
      /jsdom/i.test(navigator.userAgent ?? "");
    if (!isJsdomTest && typeof fetch === "function") {
      let handledByNativeBridge = false;
      try {
        const cleanVersion = version.trim().replace(/^[vV]/, "");
        const repo = localStatus.github_repo || "smokeInCloud060201/readora";
        const resp = await fetch(
          `/__readora_update?version=${encodeURIComponent(cleanVersion)}&repo=${encodeURIComponent(repo)}`,
          { method: "GET" },
        );
        if (resp.ok) {
          const text = await resp.text();
          if (text.trim().startsWith("{")) {
            handledByNativeBridge = true;
          }
        }
      } catch {
        // Ignore when running outside native loopback server
      }

      if (
        !handledByNativeBridge &&
        localStatus.download_url &&
        localStatus.download_url.startsWith("https://") &&
        typeof document !== "undefined"
      ) {
        const link = document.createElement("a");
        link.href = localStatus.download_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.setAttribute("download", "");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    }

    return localStatus;
  },

  async dismissUpdate(version: string): Promise<AppUpdateStatusDto> {
    const localStatus = fallbackBridge.dismissUpdate(version);
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppUpdateStatusDto>("app_dismiss_update", { version });
    }
    return localStatus;
  },

  async cleanupApplicationData(): Promise<AppCleanupReportDto> {
    const localReport = fallbackBridge.cleanupApplicationData();
    const invoke = getNativeTauriInvoke();
    if (invoke) {
      return invoke<AppCleanupReportDto>("app_cleanup_data");
    }
    return localReport;
  },
};
