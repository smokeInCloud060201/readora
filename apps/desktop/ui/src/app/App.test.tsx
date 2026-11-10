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
});
