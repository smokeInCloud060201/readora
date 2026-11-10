# Folder Map

- `crates/app-domain`: pure business entities and invariants.
- `crates/app-application`: use cases and ports.
- `crates/pdf-engine`: engine-neutral PDF contracts.
- `crates/pdfium-adapter`: PDFium implementation only.
- `crates/storage`: SQLite repositories and migrations.
- `crates/platform`: native OS integration adapters.
- `crates/app-infrastructure`: shared infrastructure adapters.
- `crates/app-core`: dependency wiring and application facade.
- `apps/desktop/src-tauri`: Tauri commands, events, permissions, lifecycle.
- `apps/desktop/ui`: React feature modules and shared UI.
- `assets/pdfium`: pinned, reviewed PDFium runtime binaries (do not commit until license/provenance review).
- `packaging`: OS-specific configuration and installer resources.
- `scripts`: repeatable development, CI, packaging, and verification scripts.
- `tests`: fixtures and cross-module integration tests.
