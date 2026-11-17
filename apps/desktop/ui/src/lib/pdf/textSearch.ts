import { type RenderMode, type SearchBoundingBoxDto } from "../../types/ipc";

export const ZOOM_PRESETS: readonly number[] = [
  0.25, 0.5, 0.75, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0, 4.0, 5.0,
];

export const SAMPLE_PAGES: readonly string[] = [
  "Page 1: Welcome to Readora — Local-first Rust + Tauri 2 PDF Reader.",
  "Page 2: Hexagonal Architecture — Domain, Application, and Replaceable Ports.",
  "Page 3: Memory-Bounded LRU Render Cache and Stale Request Cancellation.",
  "Page 4: SQLite Persistence for Recent Documents, Bookmarks, and Preferences.",
  "Page 5: Security and Privacy Baseline — Every PDF Treated as Untrusted Input.",
];

export interface PageTextSpan {
  text: string;
  startOffset: number;
  endOffset: number;
  x_ratio: number;
  y_ratio: number;
  width_ratio: number;
  height_ratio: number;
  lineIndex?: number;
}

export interface PageTextLayout {
  fullText: string;
  spans: PageTextSpan[];
}

export interface PageMatchRange {
  origStart: number;
  origEnd: number;
}

export function normalizePdfGlyphText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u00A0/g, " ");
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

  // 1. Whitespace-normalized haystack (collapsing whitespace & hyphenated line wraps) with offset map
  const normChars: string[] = [];
  const normToOrig: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < fullText.length; i += 1) {
    const ch = fullText[i] ?? "";
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

  // 2. Fallback compact stream for words split by wide kerning/tracking in PDF fonts
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

export function buildSyntheticPageLayout(pageText: string): PageTextLayout {
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
    const width_ratio = Math.min(
      0.84,
      Math.max(0.04, (line.length * 7.05) / 612),
    );
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

export function buildSvgPageDataUrl(
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
      ? "#262823"
      : renderMode === "grayscale"
        ? "#f4f4f0"
        : "#fcfbf6";
  const fg =
    renderMode === "dark_inversion"
      ? "#e6e8e1"
      : renderMode === "grayscale"
        ? "#262724"
        : "#23251f";
  const muted =
    renderMode === "dark_inversion"
      ? "#9aa389"
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
