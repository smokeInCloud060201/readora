# Architecture Decision Records

## ADR-001: Tauri 2 + Rust core

**Status:** Proposed

**Decision:** Use Tauri 2 as desktop shell, Rust for application logic, React + TypeScript for UI.

**Reasoning:** Cross-platform desktop packaging, native OS integration, Rust backend, and a frontend technology with a mature component ecosystem. The UI communicates through a narrow typed IPC boundary.

**Consequences:** Must manage Tauri capabilities carefully and test the system webview differences across OSes. Keep UI-independent logic in Rust crates.

## ADR-002: Modular monolith

**Status:** Proposed

**Decision:** Start with a modular monolith using ports/adapters, not microservices.

**Reasoning:** Local desktop workloads do not justify distributed deployment. Internal module boundaries still permit engine and storage replacement.

**Consequences:** Enforce crate dependency direction and avoid a large all-purpose application crate.

## ADR-003: PDFium adapter

**Status:** Implemented with pure-Rust fallback

**Decision:** Implement `PdfiumEngineAdapter` behind the engine-neutral `pdf-engine` (`PdfEngine` / `PdfDocument`) interface using dynamic native binding (`pdfium-render` `thread_safe` + `pdfium_latest`) from `READORA_PDFIUM_PATH`, `assets/pdfium/`, or system library paths, paired with a built-in pure-Rust PDF parser/renderer fallback (`FallbackPdfDocument`) when `libpdfium` is not installed on the machine.

**Reasoning:** Allows clean checkouts, CI runners, and developer environments to run full unit, contract, and vertical-slice integration tests without committing native PDFium binaries to source control, while supporting native PDFium rendering wherever `libpdfium` is provisioned.

**Consequences:** Must verify binding coverage, license compatibility, platform binaries, security update cadence, and required advanced features before shipping release installers.

## ADR-004: Rendered page IPC transfer and byte-bounded LRU cache

**Status:** Accepted

**Decision:** Encode rendered page bitmaps to PNG and transfer them across the Tauri IPC boundary as compact `data:image/png;base64,...` URLs cached inside a byte-bounded `MemoryRenderCache` keyed by `(DocumentId, PageIndex, ScaleBucket, Rotation, RenderMode)`, paired with a per-document `GenerationCancellationRegistry`.

**Reasoning:** Prevents multi-megabyte raw JSON byte arrays across IPC, guarantees bounded memory consumption (default 64 MiB, configurable 8–512 MiB), and cancels obsolete page render requests when the user navigates, zooms, rotates, or closes a document.
