# System Architecture

## 1. Architectural style

Readora uses a **modular monolith with ports and adapters (hexagonal architecture)** paired with a lightweight **`tao` + `wry` native desktop shell** and an **authenticated loopback HTTP/RPC transport**.

Why:
- A desktop PDF reader is a local interactive application; microservices add deployment and IPC complexity without benefit.
- Rust keeps rendering, parsing, search indexing, SQLite persistence, and caching inside one process for low latency.
- Ports isolate the PDF engine, SQLite storage, and OS platform integration behind explicit traits.
- `apps/desktop/src-tauri` (`readora-desktop`) is strictly the composition root, native window/WebView host, and authenticated RPC boundary—never the home for domain rules.

## 2. Context and runtime flow

```text
┌────────────────────────────── Desktop process ──────────────────────────────┐
│                                                                             │
│  React 19 + TypeScript UI (apps/desktop/ui)                                 │
│  ├─ Reader workspace / library / toolbar / inspector panels                 │
│  └─ Typed RPC client (src/lib/tauri/client.ts)                              │
│             │ Authenticated loopback POST (127.0.0.1:<ephemeral>)           │
│             │ + Host / Origin / Sec-Fetch-Site / X-Readora-Token            │
│             ▼                                                               │
│  Native desktop shell & composition root (apps/desktop/src-tauri)           │
│  ├─ tao Window + wry OS WebView (strict navigation & CSP enforcement)       │
│  ├─ Hardened loopback HTTP/RPC server (server.rs, bounded worker pool)      │
│  └─ DesktopCommandHandler (commands/mod.rs)                                 │
│             │                                                               │
│             ▼                                                               │
│  AppCore facade (crates/app-core)                                           │
│             │                                                               │
│             ▼                                                               │
│  Application use cases (crates/app-application)                             │
│  ├─ OpenDocument   ├─ RenderPage       ├─ SearchDocument                    │
│  ├─ NavigatePage   ├─ UpsertBookmark   ├─ UpsertAnnotation / Export         │
│  └─ Settings       └─ Check/Stage/InstallUpdates & Cleanup                  │
│             │ ports (traits)                                                │
│       ┌─────┴──────────────────────┐                                        │
│       ▼                            ▼                                        │
│  PdfEngine / PdfDocument      Storage / Platform / RenderCache ports        │
│       │                            │                                        │
│  pdfium-adapter               storage (rusqlite WAL) / platform / infra     │
│  (PDFium chromium/6723 +                                                    │
│   pure-Rust fallback)                                                       │
│                                                                             │
│  Domain (crates/app-domain): DocumentDescriptor, PageIndex, ViewState,      │
│  ZoomLevel, Rotation, Bookmark, Annotation, AppSettings, SemVer             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. Workspace crates (9 Cargo members) and dependency direction

The Cargo workspace in [`Cargo.toml`](../Cargo.toml) contains **9 Rust members** plus the React frontend workspace package in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml):

| Crate / Package | Responsibility | Must not depend on |
|---|---|---|
| `crates/app-domain` | Entities, value objects, invariants, SemVer comparison, domain errors | `tao`, `wry`, UI, SQLite, PDFium, OS I/O |
| `crates/pdf-engine` | Engine-neutral `PdfEngine` / `PdfDocument` traits, geometry, zeroizing password options | PDFium implementation, SQLite, UI |
| `crates/app-application` | Use cases, orchestration, port traits, boundary DTOs | Concrete adapters (`rusqlite`, `pdfium-render`, `wry`) |
| `crates/pdfium-adapter` | Dynamic `pdfium-render` bindings (`chromium/6723`) + pure-Rust fallback engine & PNG encoder | UI, desktop shell |
| `crates/storage` | `rusqlite` (`WAL` mode) repositories and append-only migrations (`0001`–`0004`) | UI, PDFium |
| `crates/platform` | Canonical path validation, SHA-256 verification, atomic writes, release JSON parsing, scoped cleanup | Domain internals, UI |
| `crates/app-infrastructure` | Byte-bounded LRU rendered-page cache and generation cancellation registry | UI, SQLite |
| `crates/app-core` | Dependency wiring, session management, and command-facing facade | Frontend, `tao`/`wry` |
| `apps/desktop/src-tauri` (`readora-desktop`) | Native `tao` + `wry` window/WebView shell, authenticated loopback RPC server, self-updater, installer hooks | Domain business rules |
| `apps/desktop/ui` (`readora-ui`) | React 19 + TypeScript strict presentation views, hooks, accessibility, styling | Direct filesystem, SQL, or PDFium access |

Dependency direction:

```text
readora-desktop (apps/desktop/src-tauri) ──► app-core
app-core ──────────────────────────────────► app-application + adapters
app-application ───────────────────────────► app-domain + pdf-engine + ports
adapters ──────────────────────────────────► ports + app-domain
pdfium-adapter ────────────────────────────► pdf-engine
storage ───────────────────────────────────► app-application ports + app-domain
apps/desktop/ui ───────────────────────────► typed client (src/lib/tauri/client.ts) only
```

Keep `app-domain` the innermost crate with zero external infrastructure dependencies.

## 4. Threading, loopback RPC, and rendering model

- **Main OS thread**: `tao` event loop, native window lifecycle, and `wry` OS WebView (`WKWebView` on macOS, `WebView2` on Windows, `WebKitGTK 4.1` on Linux).
- **Loopback HTTP/RPC worker pool**: Ephemeral `127.0.0.1:0` listener with explicit error backoff feeding a bounded `sync_channel(64)` and `8` worker threads (`main.rs` + `server.rs`), enforcing wall-clock request deadlines (`20s`), header/body size caps, anti-rebinding `Host` checks, `Origin` + `Sec-Fetch-Site`, and constant-time 256-bit `X-Readora-Token` authentication.
- **Storage**: Short `rusqlite` transactions in `WAL` mode with `busy_timeout` and `foreign_keys = ON`.
- **Rendering & caching policy**:
  1. Open document and inspect metadata, page count, outlines, forms, and signature fields.
  2. Compute visible page range in the viewport plus configurable prefetch window (`0`–`5` pages).
  3. Quantize zoom scale buckets and cancel stale renders per document via `GenerationCancellationRegistry`.
  4. Cache rendered PNG data URLs in `MemoryRenderCache` keyed by `(DocumentId, PageIndex, ScaleBucket, Rotation, RenderMode)` under a configurable byte budget (`8`–`512 MiB`, default `64 MiB`) with LRU eviction.

Never hold a mutex across PDF rendering or disk I/O.

## 5. Typed RPC contract (`/__readora_rpc`, `/__readora_import`, `/__readora_pdf_read`, `/__readora_update`)

`DesktopCommandHandler::dispatch_rpc` exposes coarse, typed commands:
- `document_open`, `document_open_sample`, `document_close`, `document_get_info`, `document_navigate`
- `page_render`, `page_cancel_renders`, `page_extract_text`, `document_search`
- `recent_documents_list`, `recent_document_set_favorite`, `recent_document_set_archived`, `recent_document_delete`
- `bookmark_upsert`, `bookmark_list`, `bookmark_delete`
- `annotation_upsert`, `annotation_list`, `annotation_delete`, `annotation_export`
- `settings_get`, `settings_update`, `system_diagnostics`, `app_cleanup_data`
- `app_check_for_updates`, `app_stage_update_manifest`, `app_stage_github_release`, `app_install_update`, `app_dismiss_update`

Binary PDF imports (`/__readora_import`, bounded at `512 MiB`) and binary PDF reads (`/__readora_pdf_read`) use dedicated authenticated binary endpoints rather than JSON byte arrays.

## 6. Persistence

SQLite (`readora.sqlite` in OS application data directory) stores application metadata only:
- recent documents, favorite/archive flags, and last reading position/zoom/rotation
- bookmarks and user annotations (highlights, underlines, comments)
- reading preferences and application settings (including opt-in `auto_check_updates` default `false`)
- append-only schema migrations (`0001` → `0002` → `0003` → `0004`)

External user PDF files remain untouched at their original paths; browser/drag-and-drop imports are staged inside `<app_data_dir>/library/pdfs/` and cleaned up cleanly on `--uninstall-cleanup` or package purge.

## 7. PDF engine strategy

`PdfEngine` and `PdfDocument` live in `crates/pdf-engine`; all `pdfium-render` bindings live exclusively in `crates/pdfium-adapter`.
- Release installers bundle prebuilt PDFium pinned to **`chromium/6723`** (`bblanchon/pdfium-binaries` tag `chromium%2F6723`), matching [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and [`sbom.cdx.json`](../sbom.cdx.json).
- When no dynamic PDFium binary is present (e.g., clean developer checkouts and CI unit tests), `PdfiumEngineAdapter` transparently falls back to its built-in deterministic pure-Rust PDF parser/renderer.
