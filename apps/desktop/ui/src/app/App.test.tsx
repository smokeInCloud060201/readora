import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("Readora Desktop Reader UI Vertical Slice", () => {
  it("opens sample PDF, renders page 1, navigates pages, zooms, searches, bookmarks, and reopens recent", async () => {
    render(<App />);

    // 1. Verify empty welcome state and open the sample PDF guide
    expect(screen.getByText("Readora PDF Reader")).toBeInTheDocument();
    expect(screen.getByText("Your library")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open Built-in Sample Guide"));

    await waitFor(() => {
      expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    });

    // 2. Navigate to page 2 and verify selectable text updates
    fireEvent.click(screen.getByLabelText("Next Page"));
    await waitFor(() => {
      expect(screen.getByText("Page 2 of 5")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Hexagonal Architecture/i),
    ).toBeInTheDocument();

    // 3. Step zoom in and verify zoom indicator updates to 125%
    fireEvent.click(screen.getByLabelText("Zoom In"));
    await waitFor(() => {
      expect(screen.getByTestId("zoom-indicator")).toHaveTextContent("125%");
    });

    // 4. Add a bookmark on page 2 and inspect Document Details tab
    fireEvent.click(screen.getByText("Bookmarks"));
    const bmInput = screen.getByLabelText("New bookmark label");
    fireEvent.change(bmInput, { target: { value: "Architecture Ports" } });
    fireEvent.click(screen.getByText("Save Bookmark on Page 2"));

    await waitFor(() => {
      expect(screen.getByText("Architecture Ports")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByLabelText("Document Details")).toBeInTheDocument();

    // 5. Search in document for "SQLite" and jump to matching page 4
    fireEvent.click(screen.getByText("Find"));
    const searchInput = screen.getByLabelText("Search query");
    fireEvent.change(searchInput, { target: { value: "SQLite" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => {
      expect(screen.getByText(/SQLite Persistence/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/SQLite Persistence/i));

    await waitFor(() => {
      expect(screen.getByText("Page 4 of 5")).toBeInTheDocument();
    });

    // 6. Close document, verify Continue Reading banner and Recent Documents card at page 4, and reopen it
    fireEvent.click(screen.getByLabelText("Close document"));
    await waitFor(() => {
      expect(screen.getByText("CONTINUE READING")).toBeInTheDocument();
      expect(
        screen.getByText(/Resume at page 4 of 5/i),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Resume at page 4 of 5/i));
    await waitFor(() => {
      expect(screen.getByText("Page 4 of 5")).toBeInTheDocument();
    });
  });

  it("prompts for password when opening an encrypted PDF path and supports preferences theme toggle", async () => {
    render(<App />);

    const pathInput = screen.getByLabelText("Local PDF file path");
    fireEvent.change(pathInput, {
      target: { value: "/vault/encrypted-contract.pdf" },
    });
    fireEvent.click(screen.getByText("Open Path"));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Password Required" })).toBeInTheDocument();
    });

    const pwInput = screen.getByLabelText("Document password");
    fireEvent.change(pwInput, { target: { value: "topsecret" } });
    fireEvent.click(screen.getByText("Unlock PDF"));

    await waitFor(() => {
      expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    });

    // Open Preferences Dialog and switch to Dark theme
    fireEvent.click(screen.getByLabelText("Preferences"));
    expect(
      screen.getByRole("dialog", { name: "Reader Preferences" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preference Theme"), {
      target: { value: "dark" },
    });
    fireEvent.click(screen.getByText("Save Preferences"));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toHaveClass("theme-dark");
    });
  });

  it("supports Highlight Options popover, Print Dialog, More Actions menu, Favorites, and Archive restore", async () => {
    render(<App />);

    fireEvent.click(screen.getByText("Open Built-in Sample Guide"));
    await waitFor(() => {
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
    fireEvent.click(screen.getByText("Bookmarks"));
    expect(
      screen.getByText(/underline · Page \d+/i),
    ).toBeInTheDocument();

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
    expect(screen.getByText("Favorite documents")).toBeInTheDocument();
    expect(
      screen.getByText("Documents you want to keep close."),
    ).toBeInTheDocument();

    // Switch back to Library, archive a document, and restore it from Archive (Figma Frame 06)
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.click(
      screen.getByLabelText("Archive Readora-Welcome-Guide.pdf"),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Moved document to archive"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Archive/i }));
    expect(screen.getByText("Archived documents")).toBeInTheDocument();
    fireEvent.click(
      screen.getByLabelText("Restore Readora-Welcome-Guide.pdf"),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Restored document to library"),
      ).toBeInTheDocument();
    });
  });

  it("supports Application Menu Bar (11-15), Import PDF Dialog (07), Share/Export Dialog (20), Preferences General/Shortcuts (18-19), and Form/Signature inspection", async () => {
    render(<App />);

    // 1. Open File menu (Figma Frame 11) and launch Import PDF Dialog (Figma Frame 07)
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menu", { name: "File Menu" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open PDF…"));

    expect(
      screen.getByRole("dialog", { name: "Import PDF Dialog" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Sample Guide" }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Page \d+ of 5/)).toBeInTheDocument();
    });

    // 2. Inspect Form & Signature status in Document Details (Phase 5 non-misleading language)
    fireEvent.click(screen.getByText("Bookmarks"));
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("Signatures")).toBeInTheDocument();
    expect(screen.getByText("No digital signature fields")).toBeInTheDocument();
    expect(screen.getByText("Forms")).toBeInTheDocument();

    // 3. Open Share Dialog (Figma Frame 20) and export annotations bundle
    fireEvent.click(screen.getByLabelText("Share Document"));
    expect(
      screen.getByRole("dialog", { name: "Share Document Dialog" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Export annotated PDF"));

    await waitFor(() => {
      expect(
        screen.getByText(/Exported Readora-Welcome-Guide-annotations\.md/i),
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
  });
});
