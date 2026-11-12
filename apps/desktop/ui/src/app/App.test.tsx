import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeMatchBoundingBoxes,
  findMatchesInPageText,
  normalizePdfGlyphText,
  readoraApi,
} from "../lib/tauri/client";
import { App } from "./App";

function createTestPdfFile(fileName: string): File {
  return new File(["%PDF-1.7 test document bytes"], fileName, {
    type: "application/pdf",
  });
}

describe("Readora Desktop Reader UI Vertical Slice", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    // Isolate all tests from live GitHub API network calls so publishing new tags never races or breaks CI
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    await readoraApi.cleanupApplicationData();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("imports a PDF via Figma Import PDF Dialog file picker without manual path input, renders page 1, navigates pages, zooms, searches, bookmarks, and reopens recent", async () => {
    render(<App />);

    // 1. Verify Figma Empty Library state (Frame 22) and open Import PDF Dialog (Frame 07)
    expect(screen.getByText("Your library")).toBeInTheDocument();
    expect(screen.getByText("Start your reading library")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Import your first PDF"));

    expect(
      screen.getByRole("dialog", { name: "Import PDF Dialog" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("PDF file path to import"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose PDF file" }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Field-Notes-On-Focus.pdf")] },
    });

    await waitFor(() => {
      expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    });

    // 2. Verify Smooth Continuous Scroll mode is active by default and scrolling advances to page 2
    expect(
      screen.queryByLabelText("Selectable Page Text"),
    ).not.toBeInTheDocument();
    const viewport = screen.getByLabelText("Document Page Viewport");
    expect(viewport).toHaveClass("continuous-scroll-mode");
    expect(screen.getByTestId("pdf-page-sheet-2")).toBeInTheDocument();

    fireEvent.wheel(viewport, { deltaY: 120 });
    await waitFor(() => {
      expect(screen.getByText("Page 2 of 5")).toBeInTheDocument();
      expect(screen.getByTestId("pdf-page-sheet")).toHaveClass(
        "active-page-sheet",
      );
    });
    expect(screen.getByText(/Hexagonal Architecture/i)).toBeInTheDocument();

    // 3. Step zoom in and zoom out and verify both zoom indicator and page sheet width scale
    expect(screen.getByTestId("pdf-page-sheet")).toHaveStyle({
      width: "680px",
    });
    fireEvent.click(screen.getByLabelText("Zoom In"));
    await waitFor(() => {
      expect(screen.getByTestId("zoom-indicator")).toHaveTextContent("125%");
      expect(screen.getByTestId("pdf-page-sheet")).toHaveStyle({
        width: "832px",
      });
    });

    fireEvent.click(screen.getByLabelText("Zoom Out"));
    await waitFor(() => {
      expect(screen.getByTestId("zoom-indicator")).toHaveTextContent("100%");
      expect(screen.getByTestId("pdf-page-sheet")).toHaveStyle({
        width: "680px",
      });
    });

    // 4. Open Notes & Details panel (Figma Frame 01/09) and add a bookmark on page 2
    fireEvent.click(screen.getByLabelText("Toggle Notes and Details Panel"));
    const bmInput = screen.getByLabelText("New bookmark label");
    fireEvent.change(bmInput, { target: { value: "Architecture Ports" } });
    fireEvent.click(screen.getByText("Save Bookmark on Page 2"));

    await waitFor(() => {
      expect(screen.getByText("Architecture Ports")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByLabelText("Document Details")).toBeInTheDocument();

    // 5. Search in document for "SQLite" via keyboard shortcut (Cmd/Win/Super+F) and jump to matching page 4
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const searchInput = screen.getByLabelText("Search query");
    expect(searchInput).toHaveFocus();
    fireEvent.change(searchInput, { target: { value: "SQLite" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => {
      expect(screen.getByText(/SQLite Persistence/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/SQLite Persistence/i));

    await waitFor(() => {
      expect(screen.getByText("Page 4 of 5")).toBeInTheDocument();
      expect(
        screen.getByTestId("search-highlights-page-4"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("active-search-highlight")).toBeInTheDocument();
    });

    // 6. Close document, verify Continue Reading banner and Recent Documents card at page 4, and reopen it
    fireEvent.click(screen.getByLabelText("Close document"));
    await waitFor(() => {
      expect(screen.getByText("CONTINUE READING")).toBeInTheDocument();
      expect(screen.getByText("5 pages · Page 4")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("5 pages · Page 4"));
    await waitFor(() => {
      expect(screen.getByText("Page 4 of 5")).toBeInTheDocument();
    });
  });

  it("prompts for password when opening an encrypted PDF file and supports preferences theme toggle", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Import PDF/i }));
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("encrypted-contract.pdf")] },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Password Required" }),
      ).toBeInTheDocument();
    });

    const pwInput = screen.getByLabelText("Document password");
    fireEvent.change(pwInput, { target: { value: "topsecret" } });
    fireEvent.click(screen.getByText("Unlock PDF"));

    await waitFor(() => {
      expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    });

    // Open Preferences Dialog, switch to Dark theme, and enable extracted text layer below page
    fireEvent.click(screen.getByLabelText("Preferences"));
    expect(
      screen.getByRole("dialog", { name: "Reader Preferences" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preference Theme"), {
      target: { value: "dark" },
    });
    fireEvent.click(
      screen.getByLabelText("Show extracted text below page"),
    );
    fireEvent.click(screen.getByText("Save Preferences"));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toHaveClass("theme-dark");
      expect(
        screen.getByLabelText("Selectable Page Text"),
      ).toBeInTheDocument();
    });
  });

  it("supports Highlight Options popover, Print Dialog, More Actions menu, Favorites, and Archive restore", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Import PDF/i }));
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Field-Notes-On-Focus.pdf")] },
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Toggle Notes and Details Panel"),
      ).toBeInTheDocument();
      expect(screen.getByText(/Page \d+ of 5/)).toBeInTheDocument();
    });

    // 1. Open Highlight Options popover (Figma Frame 24) and save a persistent highlight
    fireEvent.click(screen.getByRole("button", { name: "Highlight Options" }));
    expect(
      screen.getByRole("dialog", { name: "Highlight Options" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Highlight color Sage"));
    fireEvent.click(screen.getByLabelText("Underline instead"));
    fireEvent.click(screen.getByLabelText("Save page highlight"));

    await waitFor(() => {
      expect(screen.getByText("Saved page highlight")).toBeInTheDocument();
    });

    // Verify saved annotation appears in Bookmarks / Notes panel
    fireEvent.click(screen.getByLabelText("Toggle Notes and Details Panel"));
    expect(screen.getByText(/underline · Page \d+/i)).toBeInTheDocument();

    // 2. Open Print Dialog (Figma Frame 21) and submit print job
    fireEvent.click(screen.getByLabelText("Print Document"));
    expect(
      screen.getByRole("dialog", { name: "Print Document Dialog" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Increase copies"));
    expect(screen.getByTestId("print-copies-value")).toHaveTextContent("2");
    fireEvent.click(screen.getByText("Print"));

    await waitFor(() => {
      expect(screen.getByText(/Sent .*2 copies/i)).toBeInTheDocument();
    });

    // 3. Use More Document Actions menu (Figma Frame 16) to favorite & archive the document
    fireEvent.click(screen.getByLabelText("More Document Actions"));
    expect(
      screen.getByRole("menu", { name: "Document Actions Menu" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Add to favorites"));

    await waitFor(() => {
      expect(
        screen.getByText("Added document to favorites"),
      ).toBeInTheDocument();
    });

    // Close document and verify Favorites collection (Figma Frame 05)
    fireEvent.click(screen.getByLabelText("Close document"));
    await waitFor(() => {
      expect(screen.getByText("Your library")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Favorites/i }));
    expect(screen.getByText("Starred documents")).toBeInTheDocument();
    expect(
      screen.getByText("Documents you want to keep close."),
    ).toBeInTheDocument();

    // Switch back to Library, archive a document, and restore it from Archive (Figma Frame 06)
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.click(
      screen.getByLabelText("Archive Field-Notes-On-Focus.pdf"),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Moved document to archive"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Archive/i }));
    expect(screen.getByText("Archive")).toBeInTheDocument();
    fireEvent.click(
      screen.getByLabelText("Restore Field-Notes-On-Focus.pdf"),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Restored document to library"),
      ).toBeInTheDocument();
    });
  });

  it("supports Application Menu Bar (11-15), Import PDF Dialog (07), Share/Export Dialog (20), Preferences General/Shortcuts (18-19), and Form/Signature inspection", async () => {
    render(<App />);

    // 1. Open File menu (Figma Frame 11), verify outside-click dismissal, then launch Import PDF Dialog (Figma Frame 07)
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menu", { name: "File Menu" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(
      screen.queryByRole("menu", { name: "File Menu" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menu", { name: "File Menu" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open PDF…"));

    expect(
      screen.getByRole("dialog", { name: "Import PDF Dialog" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Choose local PDF file"), {
      target: { files: [createTestPdfFile("Field-Notes-On-Focus.pdf")] },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Toggle Notes and Details Panel"),
      ).toBeInTheDocument();
      expect(screen.getByText(/Page \d+ of 5/)).toBeInTheDocument();
    });

    // 2. Inspect Form & Signature status in Document Details (Phase 5 non-misleading language)
    fireEvent.click(screen.getByLabelText("Toggle Notes and Details Panel"));
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("Signatures")).toBeInTheDocument();
    expect(screen.getByText("No digital signature fields")).toBeInTheDocument();
    expect(screen.getByText("Forms")).toBeInTheDocument();

    // 3. Open Share Dialog (Figma Frame 20) and export annotations bundle
    expect(
      screen.queryByLabelText("Export Annotations"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Share Document"));
    expect(
      screen.getByRole("dialog", { name: "Share Document Dialog" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Export annotated PDF"));

    await waitFor(() => {
      expect(
        screen.getByText(/Exported Field-Notes-On-Focus-annotations\.md/i),
      ).toBeInTheDocument();
    });

    // 4. Open Preferences General & Shortcuts tabs (Figma Frames 18 & 19)
    fireEvent.click(screen.getByLabelText("Preferences"));
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByText("Reopen documents on launch")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    const shortcutSearch = screen.getByLabelText("Search shortcuts");
    fireEvent.change(shortcutSearch, { target: { value: "comment" } });
    expect(screen.getByText("Add comment")).toBeInTheDocument();

    // 5. Inspect About & Licenses tab (Phase 6 SBOM & system diagnostics)
    fireEvent.click(screen.getByRole("button", { name: "About & Licenses" }));
    expect(
      screen.getByLabelText("System Diagnostics and Licenses"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("THIRD-PARTY OPEN-SOURCE NOTICES (SBOM)"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("PDFium")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Close preferences"));

    // 6. Verify no hardcoded update badge on launch, then simulate a newer GitHub Release dynamically relative to installed_version (Figma Frames 27 & 28)
    expect(
      screen.queryByRole("button", { name: "Update available" }),
    ).not.toBeInTheDocument();

    const activeSettings = await readoraApi.getSettings();
    const currentMajor =
      Number.parseInt(
        (activeSettings.installed_version || "1.0.0")
          .replace(/^v/i, "")
          .split(".")[0] || "1",
        10,
      ) || 1;
    const nextVersion = `${currentMajor + 1}.0.0`;
    const nextTag = `v${nextVersion}`;
    const nextTitle = `Focus Reader ${nextVersion} is ready`;

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tag_name: nextTag,
          name: nextTitle,
          body: "### Highlights\n- **Seamless Software Updates**: A faster reader and improved annotations are ready to install.",
          published_at: "2026-11-10T00:00:00Z",
          html_url: `https://github.com/smokeInCloud060201/readora/releases/tag/${nextTag}`,
          assets: [
            {
              name: `Readora_${nextVersion}_macos-aarch64.dmg`,
              size: 42 * 1024 * 1024,
              browser_download_url: `https://github.com/smokeInCloud060201/readora/releases/download/${nextTag}/Readora_${nextVersion}_macos-aarch64.dmg`,
              digest:
                "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    // Trigger Help -> Check for Updates… which queries GitHub Releases
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    fireEvent.click(screen.getByText("Check for Updates…"));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Update Available Dialog" }),
      ).toBeInTheDocument();
      expect(screen.getByText(nextTitle)).toBeInTheDocument();
    });
    expect(
      screen.getByText("42 MB · Downloaded and verified"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update available" }),
    ).toBeInTheDocument();

    // Defer with "Later" -> notification pill hides
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Update available" }),
      ).not.toBeInTheDocument();
    });

    // Manually check via Help -> Check for Updates…
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    fireEvent.click(screen.getByText("Check for Updates…"));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Update Available Dialog" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Restart and install" }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`Focus Reader ${nextVersion.replace(/\./g, "\\.")} staged`, "i")),
      ).toBeInTheDocument();
    });

    // Verify Help -> Check for Updates… now shows up-to-date status for nextVersion even when GitHub latest is nextTag
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    fireEvent.click(screen.getByText("Check for Updates…"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: `Focus Reader ${nextVersion} is up to date`,
        }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // 7. Test Clean up application data & cache in Preferences -> General
    fireEvent.click(screen.getByLabelText("Preferences"));
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.click(
      screen.getByLabelText("Clean up application data and cache"),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Cleaned up Readora database/i),
      ).toBeInTheDocument();
      expect(screen.getByText("Your library")).toBeInTheDocument();
    });
  });

  it("matches PDF words split by kerning, Unicode ligatures, soft hyphens, and line wraps", () => {
    const rawPdfStream = normalizePdfGlyphText(
      "Ef\uFB01cient con\uFB02ow architec\u00ADture with De vel op ment and perfor-\nmance metrics.",
    );
    expect(rawPdfStream).toContain("Efficient");
    expect(rawPdfStream).toContain("conflow");
    expect(rawPdfStream).toContain("architecture");

    // 1. Ligature & soft-hyphen normalized matches
    expect(findMatchesInPageText(rawPdfStream, "efficient", false)).toHaveLength(1);
    expect(findMatchesInPageText(rawPdfStream, "architecture", false)).toHaveLength(1);

    // 2. Kerning-split word ("De vel op ment" matched when searching "Development")
    const kerningMatches = findMatchesInPageText(
      rawPdfStream,
      "Development",
      false,
    );
    expect(kerningMatches).toHaveLength(1);
    expect(
      rawPdfStream.slice(
        kerningMatches[0]!.origStart,
        kerningMatches[0]!.origEnd,
      ),
    ).toBe("De vel op ment");

    // 3. Hyphenated line-wrap ("perfor-\nmance" matched when searching "performance")
    const wrappedMatches = findMatchesInPageText(
      rawPdfStream,
      "performance",
      false,
    );
    expect(wrappedMatches).toHaveLength(1);
    expect(
      rawPdfStream.slice(
        wrappedMatches[0]!.origStart,
        wrappedMatches[0]!.origEnd,
      ),
    ).toBe("perfor-\nmance");

    // 4. Multi-word phrase wrapping across 2 lines with realistic 12pt PDF line spacing (delta y_ratio = 0.015) emits 2 highlight boxes
    const twoLineText = " End of first line memory\nbounded cache on second line";
    const multiLineLayout = {
      fullText: twoLineText,
      spans: [
        {
          text: "End of first line memory",
          startOffset: 1,
          endOffset: 25,
          x_ratio: 0.08,
          y_ratio: 0.2,
          width_ratio: 0.72,
          height_ratio: 0.016,
          lineIndex: 0,
        },
        {
          text: "bounded cache on second line",
          startOffset: 26,
          endOffset: 54,
          x_ratio: 0.08,
          y_ratio: 0.215,
          width_ratio: 0.78,
          height_ratio: 0.016,
          lineIndex: 1,
        },
      ],
    };
    const phraseMatch = findMatchesInPageText(
      twoLineText,
      "memory bounded cache",
      false,
    )[0]!;
    const boxes = computeMatchBoundingBoxes(
      multiLineLayout,
      phraseMatch.origStart,
      phraseMatch.origEnd - phraseMatch.origStart,
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.y_ratio).toBeCloseTo(0.2, 3);
    expect(boxes[0]!.x_ratio).toBeGreaterThan(0.5);
    expect(boxes[1]!.y_ratio).toBeCloseTo(0.215, 3);
    expect(boxes[1]!.x_ratio).toBeCloseTo(0.08, 3);
    expect(boxes[1]!.width_ratio).toBeGreaterThan(0.3);
  });

  it("persists imported PDFs, reading progress, bookmarks, and annotations in localStorage", async () => {
    const session = await readoraApi.openDocument({
      path: "/docs/Persisted-Research-Paper.pdf",
      password: null,
    });
    await readoraApi.navigate(session.descriptor.id, {
      kind: "go_to_page",
      value: 2,
    });
    await readoraApi.upsertBookmark({
      document_id: session.descriptor.id,
      page_index: 2,
      label: "Methodology Bookmark",
    });
    await readoraApi.upsertAnnotation({
      document_id: session.descriptor.id,
      page_index: 2,
      kind: "highlight",
      color_hex: "#fef08a",
      quote_text: "Deterministic rendering pipeline",
      note_text: "Key invariant",
    });

    const rawState = window.localStorage.getItem("readora.library.state.v1");
    expect(rawState).toBeTruthy();
    const parsed = JSON.parse(rawState!) as {
      recents: Array<{
        document_id: string;
        display_name: string;
        last_page: number;
      }>;
      bookmarks: Record<string, Array<{ label: string; page_index: number }>>;
      annotations: Record<string, Array<{ note_text: string }>>;
    };
    expect(
      parsed.recents.some(
        (r) =>
          r.document_id === session.descriptor.id &&
          r.display_name === "Persisted-Research-Paper.pdf" &&
          r.last_page === 2,
      ),
    ).toBe(true);
    expect(parsed.bookmarks[session.descriptor.id]?.[0]?.label).toBe(
      "Methodology Bookmark",
    );
    expect(parsed.annotations[session.descriptor.id]?.[0]?.note_text).toBe(
      "Key invariant",
    );

    await readoraApi.cleanupApplicationData();
    expect(window.localStorage.getItem("readora.library.state.v1")).toBeNull();
  });
});
