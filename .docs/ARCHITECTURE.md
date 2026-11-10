# System Architecture

## 1. Architectural style

Use a **modular monolith with ports and adapters (hexagonal architecture)**.

Why:
- A desktop PDF reader is primarily a local interactive application; microservices add deployment and IPC complexity without a clear benefit.
- Rust can keep rendering, parsing, search indexing, and storage close to the process for low latency.
- Ports isolate the PDF engine, storage, OS integration, and future alternatives.
- Tauri is the desktop composition root and bridge, not the place for business logic.

## 2. Context and runtime flow

```text
┌────────────────────────────── Desktop process ──────────────────────────────┐
│                                                                             │
│  React + TypeScript UI                                                      │
│  ├─ Reader workspace / tabs / toolbar / panels                             │
│  └─ typed API client                                                       │
│             │ Tauri commands + events                                      │
│             ▼                                                               │
│  Tauri adapter / composition root (apps/desktop/src-tauri)                 │
│             │                                                               │
│             ▼                                                               │
│  Application use cases                                                     │
│  ├─ OpenDocument   ├─ RenderPage   ├─ SearchText                            │
│  ├─ NavigatePage   ├─ UpdateBookmark ├─ SaveAnnotation                      │
│  └─ ExportDocument └─ ReadSettings                                          │
│             │ ports                                                        │
│       ┌─────┴─────────────┐                                                 │
│       ▼                   ▼                                                 │
│  PDF engine port      Storage / platform ports                              │
│       │                   │                                                 │
│  PDFium adapter       SQLite / filesystem / dialogs / OS                    │
│                                                                             │
│  Domain: Document, PageIndex, ViewState, Bookmark, Annotation, SearchHit    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. Crate responsibilities and dependency direction

| Crate | Responsibility | Must not depend on |
|---|---|---|
| `app-domain` | Entities, value objects, invariants, domain errors | Tauri, UI, SQLite, PDFium |
| `app-application` | Use cases, orchestration, ports, DTOs | Concrete adapters |
| `pdf-engine` | Engine-neutral traits/types for open/render/text/search | PDFium implementation |
| `pdfium-adapter` | PDFium bindings, native library loading, engine-specific conversions | UI, Tauri commands |
| `storage` | SQLite repositories, migrations, preferences, recent files | UI, PDFium |
| `platform` | File dialogs, OS paths, open-with, print integration, notifications | Domain internals |
| `app-infrastructure` | Shared adapter implementations and app services | UI |
| `app-core` | Composition/wiring, application state, command-facing facade | Frontend |
| `src-tauri` | Tauri commands, events, capabilities, startup/shutdown | Business rules |
| `ui` | React views, view models, accessibility, styling | Direct native/PDFium access |

Dependency direction:

```text
Tauri composition root ───────► app-core
app-core ─────────────────────► app-application
app-application ──────────────► app-domain + ports
adapters ────────────────────► ports + app-domain
pdfium-adapter ──────────────► pdf-engine
storage ─────────────────────► app-application ports + app-domain
UI ──────────────────────────► typed Tauri API only
```

Keep `app-domain` the innermost crate. If two crates need each other, move the shared contract inward or create a small dedicated contract crate; do not create a cycle.

## 4. Threading and rendering model

- UI thread: input, layout, lightweight view state only.
- Tauri async command layer: validates requests and dispatches use cases.
- PDF worker pool: bounded CPU workers for render, text extraction, and indexing.
- Storage worker: short SQLite transactions; WAL mode can be evaluated for concurrent reads.
- Event channel: progress, page-ready, search-progress, document-closed notifications.

Rendering policy:
1. Open document and read metadata/page count.
2. Compute visible page range from viewport.
3. Request visible pages at target scale and device pixel ratio.
4. Prefetch a small number of adjacent pages.
5. Deduplicate identical in-flight requests.
6. Cancel stale requests after navigation/zoom/close.
7. Cache by `(document_id, page_index, scale_bucket, rotation, render_mode)`.
8. Enforce a byte-based cache budget and evict least-recently-used entries.

Never hold a global lock while calling PDFium or doing disk I/O. Confirm PDFium thread-safety constraints for the selected binding/build and serialize access if required by the engine.

## 5. Tauri IPC contract

Expose coarse, typed commands, not low-level engine calls.

Examples:
- `document_open(path_or_dialog_request) -> DocumentSummary`
- `document_close(document_id) -> ()`
- `document_get_info(document_id) -> DocumentInfo`
- `page_render(document_id, page_index, render_options) -> RenderedPageHandle`
- `document_search(document_id, query, options) -> SearchRequestId`
- `bookmark_upsert(document_id, bookmark) -> Bookmark`
- `settings_get() -> Settings`
- `settings_update(patch) -> Settings`

Use events for long-running work:
- `document-open-progress`
- `page-rendered`
- `search-progress`
- `search-completed`
- `operation-failed`

Do not return multi-megabyte bitmap arrays through ordinary JSON IPC. Use a bounded asset/protocol strategy or a file-backed temporary render cache with opaque handles and strict cleanup. Benchmark IPC transfer options on all three operating systems.

## 6. Persistence

SQLite stores application metadata only:
- recent documents (path, display name, last-opened, last-page)
- bookmarks and user annotations
- reading preferences and application settings
- optional local search index metadata

PDF files remain at user-selected locations. Do not silently copy originals into an application database. Use migrations, transactions, schema versioning, and backup/restore tests. Treat file paths as platform-specific opaque values; do not assume UTF-8 paths on every platform.

## 7. PDF engine strategy

Define `PdfEngine` and `PdfDocument` traits in `pdf-engine`; put all PDFium-specific types in `pdfium-adapter`.

PDFium is a reasonable initial candidate for rendering and broad PDF support. Validate:
- exact crate version and license of the Rust binding
- PDFium upstream license and third-party notices
- availability of signed/reproducible binaries for each target/architecture
- security update cadence and vulnerability response
- text extraction, forms, annotations, signatures, encryption, and accessibility needs
- binary size, startup time, memory, and rendering performance

Do not assume one Rust wrapper implements every PDF feature. Build a capability matrix and prototype the required operations. Keep the adapter replaceable if licensing or feature gaps require another engine.

## 8. Cross-platform abstractions

Keep OS-specific code behind `platform`:
- native open/save dialogs
- path resolution and app data/cache directories
- file associations and drag/drop
- printing
- menu, tray, deep links, and notifications
- startup/update integration

Use `cfg(target_os = "...")` only inside platform adapters or narrow build configuration. Test behavior on real OS runners, not only cross-compilation.
