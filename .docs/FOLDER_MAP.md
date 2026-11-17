# Folder Map

- `.docs/`: architecture, security, build/release, testing, coding conventions, and ADR documentation.
- `.github/workflows/`: multi-OS CI (`ci.yml`) and release installer packaging + SLSA provenance (`release.yml`).
- `crates/app-domain`: pure business entities, value objects, SemVer comparison, and invariants (zero OS/IO dependencies).
- `crates/pdf-engine`: engine-neutral `PdfEngine` and `PdfDocument` traits, geometry types, and zeroizing password options.
- `crates/app-application`: use cases, DTOs, structured `ApplicationError` mapping, and port traits.
- `crates/pdfium-adapter`: dynamic `pdfium-render` (`chromium/8165`) implementation plus deterministic pure-Rust fallback engine.
- `crates/storage`: `rusqlite` (`WAL` mode) repositories and append-only SQL migrations (`0001`–`0004`).
- `crates/platform`: canonical path validation, SHA-256 verification, atomic file writes, GitHub Release JSON parsing, and scoped cleanup.
- `crates/app-infrastructure`: byte-bounded LRU rendered-page cache and per-document generation cancellation registry.
- `crates/app-core`: hexagonal composition wiring and session-managing `AppCore` facade.
- `apps/desktop/src-tauri`: native `tao` + `wry` desktop shell (`readora-desktop`), hardened loopback HTTP/RPC server (`server.rs`), typed command dispatcher (`commands/mod.rs`), macOS `Entitlements.plist`, and OS uninstall scripts (`installer/`).
- `apps/desktop/ui`: React 19 + TypeScript strict frontend workspace (`readora-ui`).
- `assets/icons`: vector and raster application icons used across UI and OS bundles.
- `sbom.cdx.json` & `THIRD_PARTY_NOTICES.md`: CycloneDX 1.5 SBOM and open-source attributions bundled with releases.
