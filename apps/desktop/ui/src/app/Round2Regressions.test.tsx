import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { ThumbnailsPanel } from "../features/navigation/ThumbnailsPanel";
import {
  getWindowSelectedText,
  sliceByUnicodeCodePoints,
} from "../features/reader/FloatingAnnotationTools";
import { ImportPdfDialog } from "../features/reader/ImportPdfDialog";
import { OpenPasswordDialog } from "../features/reader/OpenPasswordDialog";
import { resolvePrintPageIndices } from "../features/reader/PrintDialog";
import { UpdateDialog } from "../features/reader/UpdateDialog";
import { SearchPanel } from "../features/search/SearchPanel";
import { PreferencesDialog } from "../features/settings/PreferencesDialog";
import * as pdfCanvasRenderer from "../lib/pdf/pdfCanvasRenderer";
import * as indexedDbStore from "../lib/pdf/indexedDbStore";
import { buildPdfJsDocumentInitParams } from "../lib/pdf/pdfCanvasRenderer";
import {
  parseGithubReleasePayload,
  readoraApi,
} from "../lib/tauri/client";
import type {
  AppUpdateStatusDto,
  DocumentSessionDto,
  RenderedPageResultDto,
  SearchHitDto,
} from "../types/ipc";
import { App } from "./App";

interface MockWindowBridges {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __READORA_NATIVE__?: {
    importPdfBytes: (
      fileName: string,
      bytes: Uint8Array,
      password: string | null,
    ) => Promise<DocumentSessionDto>;
    readPdfBytes: (documentId: string) => Promise<Uint8Array | null>;
    triggerSelfUpdate: (version: string) => Promise<{ status?: string }>;
  };
}

function createTestPdfFile(fileName: string): File {
  return new File(["%PDF-1.7 test document bytes\n%%EOF"], fileName, {
    type: "application/pdf",
  });
}

function makeSession(
  overrides: Partial<{
    id: string;
    fileName: string;
    pageCount: number;
    currentPage: number;
    zoom: number;
    fitMode: "manual" | "fit_width" | "fit_page";
    layoutMode: "single_page" | "continuous";
  }> = {},
): DocumentSessionDto {
  const id = overrides.id ?? "doc-r2-test";
  const fileName = overrides.fileName ?? "R2-Test.pdf";
  const pageCount = overrides.pageCount ?? 10;
  const currentPage = overrides.currentPage ?? 0;
  const zoom = overrides.zoom ?? 1.0;
  const fitMode = overrides.fitMode ?? "fit_width";
  const layoutMode = overrides.layoutMode ?? "continuous";
  return {
    descriptor: {
      id,
      file_name: fileName,
      file_size_bytes: 65_536,
      page_count: pageCount,
      metadata: {
        title: fileName.replace(/\.pdf$/i, ""),
        author: null,
        subject: null,
        creator: null,
        pdf_version: "1.7",
        is_encrypted: false,
      },
    },
    view_state: {
      document_id: id,
      current_page: currentPage,
      page_count: pageCount,
      zoom,
      fit_mode: fitMode,
      rotation: "deg0",
      layout_mode: layoutMode,
      render_mode: "standard",
    },
    outline: [
      { title: "Chapter 1", page_index: 0, children: [] },
      { title: "Chapter 2", page_index: 1, children: [] },
    ],
    bookmarks: [],
  };
}

describe("Round-2 Frontend UX, Virtualization, RPC, HiDPI, Print, & Security Regressions", () => {
  const originalFetch = globalThis.fetch;
  const originalDevicePixelRatio = window.devicePixelRatio;

  beforeEach(async () => {
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    await readoraApi.cleanupApplicationData();
  });

  afterEach(async () => {
    const win = window as unknown as MockWindowBridges;
    delete win.__TAURI_INTERNALS__;
    delete win.__READORA_NATIVE__;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      writable: true,
      value: originalDevicePixelRatio,
    });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await readoraApi.cleanupApplicationData();
  });

  it("[R2-CRIT-03] rejects self-update verification failure statuses, maps install_outcome banners, and never freezes UpdateDialog on rejection", async () => {
    const win = window as unknown as MockWindowBridges;
    let triggerStatus = "checksum_verification_failed";
    let checkUpdatesCalls = 0;

    win.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === "app_check_for_updates") {
          checkUpdatesCalls += 1;
          return {
            current_version: "1.0.6",
            update_available: false,
            latest_version: "2.0.0",
            release_title: "2.0.0",
            release_notes: "Notes",
            package_size_bytes: 1024,
            sha256_checksum:
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            download_url:
              "https://github.com/smokeInCloud060201/readora/releases/download/v2.0.0/Readora.dmg",
            github_repo: "smokeInCloud060201/readora",
            verified: true,
            staged_for_restart: false,
            checked_at_unix_ms: Date.now(),
          } satisfies AppUpdateStatusDto;
        }
        return null;
      },
    };
    win.__READORA_NATIVE__ = {
      importPdfBytes: async () => makeSession(),
      readPdfBytes: async () => null,
      triggerSelfUpdate: async () => ({ status: triggerStatus }),
    };

    for (const failureStatus of [
      "checksum_verification_failed",
      "signature_verification_failed",
      "invalid_download_url",
      "missing_download_url",
    ]) {
      triggerStatus = failureStatus;
      await expect(readoraApi.installUpdate("2.0.0")).rejects.toEqual({
        code: failureStatus,
        message: `Update verification failed (${failureStatus.replace(/_/g, " ")}). Installation was aborted for your safety.`,
      });
    }
    expect(checkUpdatesCalls).toBe(0);

    triggerStatus = "restarting";
    const restartingRes = await readoraApi.installUpdate("2.0.0");
    expect(restartingRes.install_outcome).toBe("restarting");

    triggerStatus = "downloaded_installer";
    const installerRes = await readoraApi.installUpdate("2.0.0");
    expect(installerRes.install_outcome).toBe("downloaded_installer");

    triggerStatus = "opened_release";
    const openedRes = await readoraApi.installUpdate("2.0.0");
    expect(openedRes.install_outcome).toBe("opened_release");

    delete win.__TAURI_INTERNALS__;
    delete win.__READORA_NATIVE__;

    // Verify UpdateDialog resets isInstalling in finally when onConfirmInstall rejects
    const rejectingInstall = vi
      .fn<(version: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network aborted"));
    const onDismiss = vi.fn();
    const { unmount } = render(
      <UpdateDialog
        updateStatus={{
          current_version: "1.0.6",
          update_available: true,
          latest_version: "2.1.0",
          release_title: "Focus Reader 2.1.0",
          release_notes: "Security fixes",
          package_size_bytes: 12 * 1024 * 1024,
          sha256_checksum:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          download_url:
            "https://github.com/smokeInCloud060201/readora/releases/download/v2.1.0/Readora.dmg",
          github_repo: "smokeInCloud060201/readora",
          verified: true,
          staged_for_restart: false,
          checked_at_unix_ms: Date.now(),
        }}
        onConfirmInstall={rejectingInstall}
        onDismiss={onDismiss}
        onCheckAgain={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Restart and install" }),
    );
    await waitFor(() => {
      expect(rejectingInstall).toHaveBeenCalledWith("2.1.0");
      expect(
        screen.getByRole("button", { name: "Restart and install" }),
      ).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Later" })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onDismiss).toHaveBeenCalledWith("2.1.0");
    unmount();
  });

  it("[R2-CRIT-04] & [R2-LOW-05] virtualizes ThumbnailsPanel strictly around scrollCenterPage (<=46 cards), scrolls to jumped pages, and bounds concurrency <= 2", async () => {
    let inFlightCount = 0;
    let peakInFlightCount = 0;
    const pendingResolvers: Array<() => void> = [];

    vi.spyOn(readoraApi, "renderPage").mockImplementation(
      (cmd) =>
        new Promise<RenderedPageResultDto>((resolve) => {
          inFlightCount += 1;
          peakInFlightCount = Math.max(peakInFlightCount, inFlightCount);
          pendingResolvers.push(() => {
            inFlightCount -= 1;
            resolve({
              document_id: cmd.document_id,
              page_index: cmd.page_index,
              width_px: 200,
              height_px: 260,
              data_url: `data:image/png;base64,thumb-${cmd.page_index}`,
              cache_hit: false,
              generation: 1,
            });
          });
        }),
    );

    const { rerender, container } = render(
      <ThumbnailsPanel
        documentId="doc-120"
        documentTitle="Big Book"
        pageCount={120}
        currentPage={0}
        onSelectPage={vi.fn()}
      />,
    );

    // Concurrency strictly bounded to at most 2 in-flight renderPage calls
    await waitFor(() => {
      expect(peakInFlightCount).toBe(2);
    });
    expect(inFlightCount).toBeLessThanOrEqual(2);

    // Drain a few queued renders and verify peak never exceeds 2
    while (pendingResolvers.length > 0) {
      const next = pendingResolvers.shift();
      await act(async () => {
        next?.();
      });
      expect(inFlightCount).toBeLessThanOrEqual(2);
    }
    expect(peakInFlightCount).toBeLessThanOrEqual(2);

    const panel = screen.getByLabelText("Page Thumbnails");
    expect(container.querySelectorAll(".focus-thumbnail-card").length).toBeLessThanOrEqual(
      46,
    );

    // User scrolls thumbnail rail independently to ~page 91 while currentPage remains 0
    Object.defineProperty(panel, "clientHeight", {
      configurable: true,
      value: 500,
    });
    panel.scrollTop = 90 * 136;
    fireEvent.scroll(panel);

    await waitFor(() => {
      const cards = container.querySelectorAll(".focus-thumbnail-card");
      // Strictly <= 46 mounted cards around scrollCenterPage (never spanning 0..115!)
      expect(cards.length).toBeLessThanOrEqual(46);
      expect(
        screen.getByText("91", { selector: ".focus-thumbnail-number" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("1", { selector: ".focus-thumbnail-number" }),
    ).not.toBeInTheDocument();

    // Jumping currentPage from 0 -> 79 (Page 80) updates panel.scrollTop so Page 80 card is visible
    panel.scrollTop = 0;
    rerender(
      <ThumbnailsPanel
        documentId="doc-120"
        documentTitle="Big Book"
        pageCount={120}
        currentPage={79}
        onSelectPage={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(panel.scrollTop).toBeGreaterThan(8000);
      expect(
        screen.getByText("80", { selector: ".focus-thumbnail-number" }),
      ).toBeInTheDocument();
    });
  });

  it("[R2-CRIT-05], [R2-HIGH-12], [R2-MED-01], & [R2-LOW-04] handles native search directly, HiDPI dpr scaling, saveToDownloads export, canvasDoc fallback navigation, and isEvalSupported: false", async () => {
    // 1. Verify pdfjsLib.getDocument init parameters explicitly disable eval (isEvalSupported: false)
    const initParams = buildPdfJsDocumentInitParams(
      new Uint8Array([37, 80, 68, 70]),
      "secret",
    );
    expect(initParams.isEvalSupported).toBe(false);
    expect(initParams.password).toBe("secret");

    // 2. Native pdfium_dynamic mode: searchDocument returns document_search directly (0 page_extract_text RPCs),
    //    renderPage multiplies scale by clamped dpr, and exportAnnotations forwards saveToDownloads
    const win = window as unknown as MockWindowBridges;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      writable: true,
      value: 2,
    });

    const invoked: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const nativeHits: SearchHitDto[] = [
      {
        page_index: 3,
        match_index: 0,
        snippet: "Native PDFium search snippet",
        match_text: "PDFium",
        bounding_box: {
          x_ratio: 0.22,
          y_ratio: 0.44,
          width_ratio: 0.14,
          height_ratio: 0.02,
        },
        bounding_boxes: [
          {
            x_ratio: 0.22,
            y_ratio: 0.44,
            width_ratio: 0.14,
            height_ratio: 0.02,
          },
        ],
      },
    ];

    win.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        invoked.push({ cmd, args });
        if (cmd === "system_diagnostics") {
          return {
            app_version: "1.0.6",
            target_os: "macos",
            target_arch: "aarch64",
            pdf_engine_kind: "pdfium_dynamic",
            sqlite_schema_version: 4,
            redacted_data_dir: "~/Library/Application Support/com.readora.desktop",
            render_cache_usage_bytes: 0,
            third_party_notices: [],
          };
        }
        if (cmd === "document_search") {
          return nativeHits;
        }
        if (cmd === "page_render") {
          const command = args?.command as {
            document_id: string;
            page_index: number;
            scale: number;
          };
          return {
            document_id: command.document_id,
            page_index: command.page_index,
            width_px: Math.round(612 * command.scale),
            height_px: Math.round(792 * command.scale),
            data_url: "data:image/png;base64,native",
            cache_hit: false,
            generation: 1,
          } satisfies RenderedPageResultDto;
        }
        if (cmd === "annotation_export") {
          return {
            file_name: "Native-annotations.md",
            share_uri: "Native.pdf (Document ID: doc-native)",
            annotation_count: 2,
            bookmark_count: 1,
            markdown_content: "# Notes",
            saved_path: "/Users/example/Downloads/Native-annotations.md",
          };
        }
        return null;
      },
    };

    const hits = await readoraApi.searchDocument({
      document_id: "doc-native",
      query: "PDFium",
      case_sensitive: false,
      max_hits: 50,
    });
    expect(hits).toEqual(nativeHits);
    expect(invoked.filter((c) => c.cmd === "page_extract_text")).toHaveLength(0);

    await readoraApi.renderPage({
      document_id: "doc-native",
      page_index: 0,
      scale: 1.5,
      rotation_degrees: 0,
      render_mode: "standard",
      generation: null,
    });
    const renderCall = invoked.find((c) => c.cmd === "page_render");
    expect(
      (renderCall?.args?.command as { scale: number } | undefined)?.scale,
    ).toBe(3);

    const exported = await readoraApi.exportAnnotations(
      "doc-native",
      true,
      null,
      true,
    );
    expect(exported.saved_path).toBe(
      "/Users/example/Downloads/Native-annotations.md",
    );
    expect(invoked.find((c) => c.cmd === "annotation_export")?.args).toEqual({
      documentId: "doc-native",
      includeAnnotations: true,
      destinationPath: null,
      saveToDownloads: true,
    });

    // Verify App.tsx skips Blob download when saved_path is returned by native backend
    delete win.__TAURI_INTERNALS__;
    const origCreateObjectURL = URL.createObjectURL;
    const createUrlMock = vi.fn(() => "blob:should-not-run");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createUrlMock,
    });
    const exportSpy = vi
      .spyOn(readoraApi, "exportAnnotations")
      .mockResolvedValue({
        file_name: "SavedNative-annotations.md",
        share_uri: "SavedNative.pdf",
        annotation_count: 1,
        bookmark_count: 0,
        markdown_content: "# Markdown",
        saved_path: "/Users/example/Downloads/SavedNative-annotations.md",
      });

    try {
      render(<App />);
      fireEvent.click(screen.getByText("Import your first PDF"));
      fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
        target: { files: [createTestPdfFile("SavedNative.pdf")] },
      });
      await waitFor(() => {
        expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText("Share Document"));
      fireEvent.click(screen.getByText("Export notes (.md)"));
      await waitFor(() => {
        expect(exportSpy).toHaveBeenCalledWith(
          "doc-savednative-pdf",
          true,
          null,
          true,
        );
        expect(
          screen.getByText(/Exported SavedNative-annotations\.md/i),
        ).toBeInTheDocument();
      });
      expect(createUrlMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: origCreateObjectURL,
      });
    }
  });

  it("[R2-HIGH-07] renders Single-Page Fit Width at crisp effectiveZoom, displays effectiveZoom% in toolbar, and steps zoom relative to effectiveZoom", async () => {
    const origResizeObserver = globalThis.ResizeObserver;
    const resizeCallbacks: Array<() => void> = [];
    class MockResizeObserver {
      private cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe(el: Element) {
        Object.defineProperty(el, "clientWidth", {
          configurable: true,
          value: 1280,
        });
        Object.defineProperty(el, "clientHeight", {
          configurable: true,
          value: 900,
        });
        resizeCallbacks.push(this.cb);
        this.cb();
      }
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver;

    try {
      await readoraApi.updateSettings({
        default_layout: "single_page",
        default_fit_mode: "fit_width",
      });

      const renderScales: number[] = [];
      const origRender = readoraApi.renderPage.bind(readoraApi);
      vi.spyOn(readoraApi, "renderPage").mockImplementation(async (cmd) => {
        if (cmd.scale !== 0.35) {
          renderScales.push(cmd.scale);
        }
        return origRender(cmd);
      });
      const origNavigate = readoraApi.navigate.bind(readoraApi);
      const navActions: unknown[] = [];
      vi.spyOn(readoraApi, "navigate").mockImplementation(
        async (docId, action) => {
          navActions.push(action);
          return origNavigate(docId, action);
        },
      );

      render(<App />);
      fireEvent.click(screen.getByText("Import your first PDF"));
      fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
        target: { files: [createTestPdfFile("Crisp-FitWidth.pdf")] },
      });

      // (1280 - 156) / 608 = 1124 / 608 = 1.8486 -> 1.85 (185%)
      await waitFor(() => {
        expect(screen.getByTestId("zoom-indicator")).toHaveTextContent("185%");
        expect(renderScales).toContain(1.85);
      });

      // Clicking Zoom In (+) at 185% in Fit Width zooms UP to 200% (2.0), never shrinking to 125%!
      fireEvent.click(screen.getByLabelText("Zoom In"));
      await waitFor(() => {
        expect(navActions).toContainEqual({ kind: "set_zoom", value: 2.0 });
        expect(screen.getByTestId("zoom-indicator")).toHaveTextContent("200%");
      });
    } finally {
      globalThis.ResizeObserver = origResizeObserver;
    }
  });

  it("[R2-HIGH-08] & [R2-HIGH-09] uses exact displayHeightPx + 144 spacer height, scrolls to restored page on open, and coalesces rapid continuous scroll navigation", async () => {
    const navigateSpy = vi
      .spyOn(readoraApi, "navigate")
      .mockImplementation(async (docId, action) => ({
        document_id: docId,
        current_page: action.kind === "go_to_page" ? action.value : 0,
        page_count: 60,
        zoom: 1.0,
        fit_mode: "fit_width",
        rotation: "deg0",
        layout_mode: "continuous",
        render_mode: "standard",
      }));

    vi.spyOn(readoraApi, "openDocumentFile").mockResolvedValue(
      makeSession({
        id: "doc-restored-50",
        fileName: "Restored-Book.pdf",
        pageCount: 60,
        currentPage: 49,
        layoutMode: "continuous",
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByText("Import your first PDF"));
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Restored-Book.pdf")] },
    });

    await waitFor(() => {
      expect(screen.getByText("Page 50 of 60")).toBeInTheDocument();
    });

    const viewport = screen.getByLabelText("Document Page Viewport");
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 800,
    });

    // Exact spacer height: at 100% zoom, displayWidthPx=608, displayHeightPx=Math.round(608 * 792/612)=787 -> 787 + 144 = 931px
    const spacer1 = screen.getByTestId("pdf-page-spacer-1");
    expect(spacer1).toHaveStyle({ height: "931px" });

    // Initial requestAnimationFrame restored scrollTop to Page 50 instead of staying at 0
    await waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(40_000);
    });
    expect(screen.getByText("Page 50 of 60")).toBeInTheDocument();

    // Simulate rapid trackpad scrolling across 10 pages -> coalesced into a single navigate RPC
    navigateSpy.mockClear();
    for (let idx = 0; idx < 60; idx += 1) {
      const sheet =
        document.querySelector<HTMLElement>(`[data-page-index="${idx}"]`);
      if (sheet) {
        Object.defineProperty(sheet, "offsetTop", {
          configurable: true,
          value: idx * 959,
        });
        Object.defineProperty(sheet, "offsetHeight", {
          configurable: true,
          value: 931,
        });
      }
    }

    for (let targetIdx = 48; targetIdx >= 38; targetIdx -= 1) {
      viewport.scrollTop = targetIdx * 959;
      fireEvent.scroll(viewport);
    }

    // Immediately after rapid burst (< 100ms), 0 racing navigate RPCs have been sent
    expect(navigateSpy).not.toHaveBeenCalled();

    // Once 100ms debounce settles, exactly 1 coalesced navigate RPC fires for the final page (38)
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenCalledWith("doc-restored-50", {
        kind: "go_to_page",
        value: 38,
      });
    });
  });

  it("[R2-HIGH-10] & [R2-HIGH-11] guards StrictMode bootstrap once, silences startup reopen missing/password errors, and keeps left sidebar mounted when toggling SearchPanel", async () => {
    await readoraApi.updateSettings({
      auto_check_updates: true,
      reopen_last_document: true,
    });

    const checkUpdatesSpy = vi.spyOn(readoraApi, "checkForUpdates");
    vi.spyOn(readoraApi, "listRecentDocuments").mockResolvedValue([
      {
        document_id: "doc-missing",
        file_path: "/missing/Encrypted-Or-Gone.pdf",
        display_name: "Encrypted-Or-Gone.pdf",
        last_page: 0,
        page_count: 5,
        last_zoom: 1.0,
        last_rotation: "deg0",
        last_opened_unix_ms: Date.now(),
      },
    ]);
    const openDocSpy = vi
      .spyOn(readoraApi, "openDocument")
      .mockRejectedValue({
        code: "password_required",
        message: "Document is password-protected",
      });

    render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );

    await waitFor(() => {
      expect(openDocSpy).toHaveBeenCalledTimes(1);
    });

    // StrictMode only ran checkForUpdates ONCE, and silent startup password_required did NOT flash dialog or error alert
    expect(checkUpdatesSpy).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", { name: "Password Required" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Changing prefetch_window in Preferences does NOT re-trigger startup reopen
    fireEvent.click(screen.getByLabelText("Preferences"));
    const prefetchInput = screen.getByLabelText(/Prefetch Window/i);
    fireEvent.change(prefetchInput, { target: { value: "3" } });
    fireEvent.blur(prefetchInput);
    fireEvent.click(screen.getByText("Save Preferences"));
    await waitFor(() => {
      expect(screen.getByText("Preferences saved")).toBeInTheDocument();
    });
    expect(openDocSpy).toHaveBeenCalledTimes(1);

    // Import a document and verify Cmd+F toggles SearchPanel WITHOUT unmounting ThumbnailsPanel
    fireEvent.click(screen.getByRole("button", { name: /Import PDF/i }));
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Sidebar-Preserved.pdf")] },
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Page Thumbnails")).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByLabelText("Find in Document", { selector: "aside" })).toBeInTheDocument();
    // Left 190px ThumbnailsPanel remains mounted!
    expect(screen.getByLabelText("Page Thumbnails")).toBeInTheDocument();

    // Escape inside SearchPanel stops propagation and closes only SearchPanel while keeping ThumbnailsPanel
    const searchInput = screen.getByLabelText("Search query");
    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(
      screen.queryByLabelText("Find in Document", { selector: "aside" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Page Thumbnails")).toBeInTheDocument();
  });

  it("[R2-HIGH-12] prepares multi-page .print-document-root with disabled 'Preparing pages...' state before invoking window.print() and cleans up afterwards", async () => {
    expect(resolvePrintPageIndices("range", 0, 10, "1-3, 5")).toEqual([
      0, 1, 2, 4,
    ]);

    render(<App />);
    fireEvent.click(screen.getByText("Import your first PDF"));
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Printable-Report.pdf")] },
    });
    await waitFor(() => {
      expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    });

    let releasePrintRenders: (() => void) | null = null;
    const gatePromise = new Promise<void>((resolve) => {
      releasePrintRenders = resolve;
    });
    const origRender = readoraApi.renderPage.bind(readoraApi);
    vi.spyOn(readoraApi, "renderPage").mockImplementation(async (cmd) => {
      if (cmd.scale === 1.5) {
        await gatePromise;
      }
      return origRender(cmd);
    });

    let printedSheetCount = 0;
    const origPrint = window.print;
    window.print = vi.fn(() => {
      printedSheetCount = document.querySelectorAll(
        ".print-document-root .print-page-img",
      ).length;
    });

    try {
      fireEvent.click(screen.getByLabelText("Print Document"));
      fireEvent.click(screen.getByRole("radio", { name: /Range/i }));
      fireEvent.change(screen.getByLabelText("Custom page range"), {
        target: { value: "1-3" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Print" }));

      // Button immediately transitions to disabled "Preparing pages..."
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: "Preparing pages..." });
        expect(btn).toBeDisabled();
      });

      releasePrintRenders!();

      await waitFor(() => {
        expect(window.print).toHaveBeenCalledTimes(1);
      });
      expect(printedSheetCount).toBe(3);

      // Cleaned up afterwards
      await waitFor(() => {
        expect(
          document.querySelector(".print-document-root"),
        ).not.toBeInTheDocument();
      });
    } finally {
      window.print = origPrint;
    }
  });

  it("[R2-MED-07..12] & [R2-LOW-06] enforces release security, Continuous ArrowDown guard, .reader-stage selection scope, 4000 code-point notes, CJK 1-char search, custom default_zoom, and dialog UX", async () => {
    // 1. Release parser rejects draft, prerelease, insecure http:// URLs, and cross-OS SHA-256 fallback
    expect(() =>
      parseGithubReleasePayload(
        JSON.stringify({ tag_name: "v3.0.0", draft: true }),
      ),
    ).toThrow(/Draft and prerelease/i);
    expect(() =>
      parseGithubReleasePayload(
        JSON.stringify({ tag_name: "v3.0.0", prerelease: true }),
      ),
    ).toThrow(/Draft and prerelease/i);
    expect(() =>
      parseGithubReleasePayload(
        JSON.stringify({
          tag_name: "v3.0.0",
          assets: [
            {
              name: "Readora.dmg",
              browser_download_url: "http://github.com/org/repo/Readora.dmg",
            },
          ],
        }),
      ),
    ).toThrow(/https:\/\//i);

    const crossOsManifest = parseGithubReleasePayload(
      JSON.stringify({
        tag_name: "v3.0.0",
        html_url: "https://github.com/smokeInCloud060201/readora/releases/tag/v3.0.0",
        assets: [
          {
            name: "Readora_3.0.0_windows-x64.exe",
            size: 30_000_000,
            browser_download_url:
              "https://github.com/smokeInCloud060201/readora/releases/download/v3.0.0/Readora.exe",
            digest:
              "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        ],
      }),
      "macos",
    );
    expect(crossOsManifest.sha256).toBe("");
    await readoraApi.stageUpdateManifest(crossOsManifest);
    await expect(readoraApi.installUpdate("3.0.0")).rejects.toMatchObject({
      code: "checksum_verification_failed",
    });

    // 2. fallbackBridge.upsertAnnotation validates hex color & text bounds, and sliceByUnicodeCodePoints preserves astral emoji
    const session = await readoraApi.openDocument({
      path: "/docs/Validation.pdf",
      password: null,
    });
    await expect(
      readoraApi.upsertAnnotation({
        document_id: session.descriptor.id,
        page_index: 0,
        kind: "highlight",
        color_hex: "not-a-hex",
        quote_text: "Valid quote",
        note_text: "",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    const emojiText = "😀".repeat(4005);
    const slicedEmoji = sliceByUnicodeCodePoints(emojiText, 4000);
    expect(Array.from(slicedEmoji)).toHaveLength(4000);
    expect(slicedEmoji.endsWith("😀")).toBe(true);

    // 3. getWindowSelectedText scopes strictly to .reader-stage
    const outsideDiv = document.createElement("div");
    outsideDiv.textContent = "Toolbar text";
    const insideStage = document.createElement("div");
    insideStage.className = "reader-stage";
    const stageText = document.createTextNode("Stage PDF text");
    insideStage.appendChild(stageText);
    document.body.append(outsideDiv, insideStage);

    const selSpy = vi.spyOn(window, "getSelection");
    selSpy.mockReturnValue({
      isCollapsed: false,
      anchorNode: outsideDiv.firstChild,
      focusNode: outsideDiv.firstChild,
      toString: () => "Toolbar text",
    } as unknown as Selection);
    expect(getWindowSelectedText()).toBe("");

    selSpy.mockReturnValue({
      isCollapsed: false,
      anchorNode: stageText,
      focusNode: stageText,
      toString: () => "Stage PDF text",
    } as unknown as Selection);
    expect(getWindowSelectedText()).toBe("Stage PDF text");
    selSpy.mockRestore();
    outsideDiv.remove();
    insideStage.remove();

    // 4. SearchPanel allows 1-char CJK query and clears stale hits when reduced to 1-char ASCII
    vi.useFakeTimers();
    try {
      const searchCalls: string[] = [];
      const { unmount: unmountSearch } = render(
        <SearchPanel
          hits={[
            { page_index: 0, match_index: 0, snippet: "Stale match" },
          ]}
          onSearch={(q) => searchCalls.push(q)}
          onSelectHit={vi.fn()}
        />,
      );
      const qInput = screen.getByLabelText("Search query");
      fireEvent.change(qInput, { target: { value: "中" } });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(searchCalls).toContain("中");

      // Backspacing to 1-char ASCII immediately clears stale searchHits via onSearch("", ...)
      fireEvent.change(qInput, { target: { value: "S" } });
      expect(searchCalls[searchCalls.length - 1]).toBe("");
      unmountSearch();
    } finally {
      vi.useRealTimers();
    }

    // 5. PreferencesDialog preserves custom default_zoom (1.35), clamps cache on blur, and has updated diagnostic constants
    const diag = await readoraApi.getSystemDiagnostics();
    expect(diag.sqlite_schema_version).toBe(4);
    expect(
      diag.third_party_notices.some(
        (n) => n.name === "React + TypeScript" && n.version.includes("5.9"),
      ),
    ).toBe(true);

    const savedPatches: unknown[] = [];
    const { unmount: unmountPrefs } = render(
      <PreferencesDialog
        settings={{
          theme: "light",
          default_layout: "continuous",
          default_fit_mode: "manual",
          default_zoom: 1.35,
          render_cache_budget_bytes: 64 * 1024 * 1024,
          prefetch_window: 1,
        }}
        initialSection="appearance"
        onSave={(patch) => savedPatches.push(patch)}
        onClose={vi.fn()}
      />,
    );
    const cacheInput = screen.getByLabelText(/Render Cache Budget/i) as HTMLInputElement;
    // Typing "2" does NOT clamp immediately to "8" on keystroke
    fireEvent.change(cacheInput, { target: { value: "2" } });
    expect(cacheInput.value).toBe("2");
    // Blurring clamps "2" -> "8"
    fireEvent.blur(cacheInput);
    expect(cacheInput.value).toBe("8");

    fireEvent.click(screen.getByText("Save Preferences"));
    expect(savedPatches[0]).toMatchObject({
      default_fit_mode: "manual",
      default_zoom_factor: 1.35,
      render_cache_budget_bytes: 8 * 1024 * 1024,
    });
    unmountPrefs();

    // 6. ImportPdfDialog child dragLeave guard & OpenPasswordDialog errorMessage select()
    const { unmount: unmountImport } = render(
      <ImportPdfDialog onImportFile={vi.fn()} onClose={vi.fn()} />,
    );
    const dropShell = document.querySelector(".import-pdf-dialog-shell")!;
    const childBadge = document.querySelector(".import-pdf-badge-box")!;
    fireEvent.dragOver(dropShell);
    expect(dropShell).toHaveClass("dragging");
    const childLeaveEvent = new Event("dragleave", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(childLeaveEvent, "relatedTarget", {
      value: childBadge,
    });
    fireEvent(dropShell, childLeaveEvent);
    expect(dropShell).toHaveClass("dragging");
    const outsideLeaveEvent = new Event("dragleave", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(outsideLeaveEvent, "relatedTarget", {
      value: document.body,
    });
    fireEvent(dropShell, outsideLeaveEvent);
    expect(dropShell).not.toHaveClass("dragging");
    unmountImport();

    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");
    const { rerender: rerenderPw, unmount: unmountPw } = render(
      <OpenPasswordDialog
        pendingPath="/docs/Secret.pdf"
        errorMessage={null}
        onSubmitPassword={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    selectSpy.mockClear();
    rerenderPw(
      <OpenPasswordDialog
        pendingPath="/docs/Secret.pdf"
        errorMessage="Incorrect password"
        onSubmitPassword={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Document password")).toHaveFocus();
    expect(selectSpy).toHaveBeenCalled();
    unmountPw();

    // 7. Continuous ArrowDown does NOT jump discrete pages; Go-to-Page Escape resets & blurs; note textarea has maxLength=4000
    await readoraApi.cleanupApplicationData();
    render(<App />);
    fireEvent.click(screen.getByText("Import your first PDF"));
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Arrow-And-Toolbar.pdf")] },
    });
    await waitFor(() => {
      expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    });

    // Continuous layout: ArrowDown lets browser scroll natively without discrete page jump
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();

    // Go-to-Page input Escape resets and blurs without navigating
    fireEvent.click(screen.getByTitle("Click to jump to a page"));
    const jumpInput = screen.getByLabelText(
      "Jump to page number",
    ) as HTMLInputElement;
    fireEvent.change(jumpInput, { target: { value: "4" } });
    fireEvent.keyDown(jumpInput, { key: "Escape" });
    expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Jump to page number"),
    ).not.toBeInTheDocument();

    // Note textarea has maxLength={4000}
    fireEvent.click(screen.getByLabelText("Toggle Notes and Details Panel"));
    const noteTextarea = screen.getByLabelText("New comment");
    expect(noteTextarea.tagName).toBe("TEXTAREA");
    expect(noteTextarea).toHaveAttribute("maxLength", "4000");

    // Shortcuts skipped inside [role="menu"] / [role="menuitem"], and opening a modal closes open dropdown menus
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    const fileMenu = screen.getByRole("menu", { name: "File Menu" });
    fireEvent.keyDown(fileMenu, { key: "ArrowRight" });
    expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();

    // Opening Preferences closes any open toolbar dropdown so menus/modals never co-mount awkwardly
    fireEvent.click(screen.getByLabelText("Preferences"));
    expect(
      screen.getByRole("dialog", { name: "Reader Preferences" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menu", { name: "File Menu" }),
    ).not.toBeInTheDocument();
  });

  it("[R2-CRIT-05] preserves canvasDoc.pageCount in pure_rust_fallback getDocumentSession & navigate and handles page_out_of_bounds locally", async () => {
    const win = window as unknown as MockWindowBridges;
    vi.spyOn(indexedDbStore, "hasUsableCanvas2D").mockReturnValue(true);
    vi.spyOn(pdfCanvasRenderer, "parsePdfWithPdfJs").mockResolvedValue({
      pdfDoc: {
        numPages: 12,
        cleanup: async () => {},
      } as unknown as pdfjsLib.PDFDocumentProxy,
      pageCount: 12,
      metadata: {
        title: "Fallback 12-Page Doc",
        author: "Author",
        subject: null,
        creator: null,
        pdf_version: "1.7",
        is_encrypted: false,
      },
      outline: [],
      pageTexts: new Map(),
      pageLayouts: new Map(),
    });

    win.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === "system_diagnostics") {
          return {
            app_version: "1.0.6",
            target_os: "macos",
            target_arch: "aarch64",
            pdf_engine_kind: "pure_rust_fallback",
            sqlite_schema_version: 4,
            redacted_data_dir: "~/Library/Application Support/com.readora.desktop",
            render_cache_usage_bytes: 0,
            third_party_notices: [],
          };
        }
        if (cmd === "document_get_info") {
          return makeSession({
            id: "doc-fallback-12",
            fileName: "Fallback12.pdf",
            pageCount: 1,
            currentPage: 0,
          });
        }
        if (cmd === "document_navigate") {
          const action = args?.action as { kind: string; value?: number };
          if (action.kind === "go_to_page" && (action.value ?? 0) >= 1) {
            throw { code: "page_out_of_bounds", message: "Out of bounds" };
          }
          return makeSession({
            id: "doc-fallback-12",
            fileName: "Fallback12.pdf",
            pageCount: 1,
            currentPage: 0,
          }).view_state;
        }
        return null;
      },
    };
    win.__READORA_NATIVE__ = {
      importPdfBytes: async (fileName) =>
        makeSession({
          id: "doc-fallback-12",
          fileName,
          pageCount: 1,
          currentPage: 0,
        }),
      readPdfBytes: async () => new Uint8Array([37, 80, 68, 70]),
      triggerSelfUpdate: async () => ({ status: "staged" }),
    };

    const opened = await readoraApi.openDocumentFile(
      createTestPdfFile("Fallback12.pdf"),
    );
    expect(opened.descriptor.page_count).toBe(12);
    expect(opened.view_state.page_count).toBe(12);

    const sessionInfo = await readoraApi.getDocumentSession("doc-fallback-12");
    expect(sessionInfo.descriptor.page_count).toBe(12);
    expect(sessionInfo.view_state.page_count).toBe(12);

    const navigated = await readoraApi.navigate("doc-fallback-12", {
      kind: "go_to_page",
      value: 7,
    });
    expect(navigated.current_page).toBe(7);
    expect(navigated.page_count).toBe(12);

    // Out of bounds >= canvasDoc.pageCount still rejects
    await expect(
      readoraApi.navigate("doc-fallback-12", {
        kind: "go_to_page",
        value: 20,
      }),
    ).rejects.toMatchObject({ code: "page_out_of_bounds" });
  });

  it("harmonizes PDF page paper and ink colors seamlessly with light (#fcfbf6) and dark (#262823) app themes", async () => {
    const lightPixels = new Uint8ClampedArray([
      255, 255, 255, 255, // pure white PDF background
      0, 0, 0, 255, // pure black PDF ink
    ]);
    pdfCanvasRenderer.harmonizePixelBufferWithTheme(lightPixels, "standard");
    expect(Array.from(lightPixels.slice(0, 4))).toEqual([252, 251, 246, 255]);
    expect(Array.from(lightPixels.slice(4, 8))).toEqual([35, 37, 31, 255]);

    const darkPixels = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 255,
    ]);
    pdfCanvasRenderer.harmonizePixelBufferWithTheme(
      darkPixels,
      "dark_inversion",
    );
    expect(Array.from(darkPixels.slice(0, 4))).toEqual([38, 40, 35, 255]);
    expect(Array.from(darkPixels.slice(4, 8))).toEqual([230, 232, 225, 255]);

    // Switching app theme to dark automatically renders standard PDFs in dark_inversion mode
    await readoraApi.updateSettings({ theme: "dark" });
    vi.spyOn(readoraApi, "openDocumentFile").mockResolvedValue(
      makeSession({
        id: "doc-dark-paper",
        fileName: "Dark-Paper.pdf",
        pageCount: 2,
        currentPage: 0,
      }),
    );
    const renderSpy = vi.spyOn(readoraApi, "renderPage");

    render(<App />);
    fireEvent.click(screen.getByText("Import your first PDF"));
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Dark-Paper.pdf")] },
    });

    await waitFor(() => {
      expect(
        renderSpy.mock.calls.some(
          ([cmd]) => cmd.render_mode === "dark_inversion",
        ),
      ).toBe(true);
    });
  });
});
