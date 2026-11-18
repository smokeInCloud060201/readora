# Architecture Decision Records

## ADR-001: Native `tao` + `wry` Desktop Shell + Hexagonal Rust Core

**Status:** Accepted

**Decision:** Use `tao` + `wry` directly for cross-platform native desktop windowing and OS WebViews, Rust (`crates/*`) for domain rules, SQLite persistence, PDF engine orchestration, and caching, and React + TypeScript for presentation UI communicating over an authenticated typed IPC/RPC boundary (`DesktopCommandHandler`).

**Reasoning:** Provides a lightweight, zero-bloat cross-platform desktop binary while enforcing a strict Content-Security-Policy, navigation allowlist, ephemeral loopback binding (`127.0.0.1:0`), `Host` anti-rebinding checks, and per-launch 256-bit CSPRNG token authentication.

**Consequences:** Keep all business logic, file operations, SQLite persistence, and self-update verification inside Rust crates (`app-domain`, `app-application`, `storage`, `platform`, `app-core`).

## ADR-002: Modular Monolith (Ports & Adapters)

**Status:** Accepted

**Decision:** Structure the backend as a modular monolith using hexagonal ports and adapters (`app-domain` ← `app-application` ← adapters ← `app-core` ← `readora-desktop`).

**Reasoning:** Local desktop workloads benefit from in-process low latency while strict crate boundaries keep the PDF engine and SQLite storage replaceable and unit-testable in isolation.

**Consequences:** Enforce inward crate dependency direction and avoid circular dependencies or "god" modules.

## ADR-003: PDFium Dynamic Adapter with Bundled Library Discovery & Pure-Rust Fallback

**Status:** Accepted

**Decision:** Implement `PdfiumEngineAdapter` behind `pdf-engine` (`PdfEngine` / `PdfDocument`) using dynamic native binding (`pdfium-render` `thread_safe` + `pdfium_latest`) probing `READORA_PDFIUM_PATH` (debug/test builds) and verified non-symlink, non-world-writable OS bundle directories (`Contents/MacOS` / `Contents/Frameworks` on macOS, executable directory / `/usr/lib/readora` on Linux, `<exe>/pdfium` on Windows), plus `assets/pdfium/` and system paths in debug/test builds, paired with a built-in pure-Rust fallback engine (`FallbackPdfDocument` with bounded Flate stream inspection) when `libpdfium` is absent.

**Reasoning:** Release installers provision native `libpdfium` for full fidelity while clean developer checkouts and CI runners execute deterministic unit, contract, and vertical-slice tests without committing native binaries to Git.

**Consequences:** Zeroize document passwords on drop, avoid cloning large PDF buffers (`bytes::Bytes`), and inspect capabilities without full-buffer UTF-8 allocations.

## ADR-004: Rendered Page Transfer and Byte-Bounded LRU Cache

**Status:** Accepted

**Decision:** Encode rendered page bitmaps to PNG and transfer them across the IPC boundary as compact `data:image/png;base64,...` URLs cached inside a byte-bounded `MemoryRenderCache` keyed by `(DocumentId, PageIndex, ScaleBucket, Rotation, RenderMode)`, paired with a per-document `GenerationCancellationRegistry`.

**Reasoning:** Guarantees bounded memory consumption (default 64 MiB, configurable 8–512 MiB) and cancels obsolete page render jobs when scrolling, zooming, rotating, or closing a document.
