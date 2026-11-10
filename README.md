# Rust PDF Reader — Architecture Pack

A commercial-grade, cross-platform desktop PDF reader architecture for macOS, Windows, and Linux.

## Product direction

- **Desktop shell:** Tauri 2
- **Application core:** Rust
- **UI:** React + TypeScript + Vite
- **PDF engine:** PDFium behind a replaceable Rust adapter
- **Persistence:** SQLite for application metadata; original PDFs remain ordinary files
- **Packaging:** native installers per operating system, signed release artifacts, update channel

This is an architecture and repository scaffold, not a finished PDF reader. It intentionally leaves engine binaries, signing identities, secrets, and product-specific branding out of source control.

## Start here

1. Read [`docs/ARCHITECTURE.md`](.docs/ARCHITECTURE.md).
2. Review [`docs/FEATURE_MODULES.md`](.docs/FEATURE_MODULES.md) and agree on MVP scope.
3. Follow [`docs/CODING_CONVENTIONS.md`](.docs/CODING_CONVENTIONS.md).
4. Give agents [`AGENTS.md`](AGENTS.md) before asking them to change code.
5. Use [`docs/BUILD_RELEASE.md`](.docs/BUILD_RELEASE.md) for platform build and installer planning.
6. Resolve the PDF engine licensing and binary-distribution decision before shipping.

## Suggested first milestone

Build a vertical slice: launch app → open a local PDF → render one page → zoom/scroll → navigate pages → reopen recent document. Do not begin with annotation, OCR, cloud sync, or a plugin system.

## Verification & Development Commands

```bash
# Rust formatting, strict Clippy lints, and workspace unit/contract/integration tests
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace

# Frontend (React 19 + TypeScript strict + Vite + Vitest)
cd apps/desktop/ui
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

## Repository layout

```text
.
├── AGENTS.md
├── Cargo.toml
├── rust-toolchain.toml
├── .cargo/config.toml
├── crates/
│   ├── app-core/
│   ├── app-domain/
│   ├── app-application/
│   ├── app-infrastructure/
│   ├── pdf-engine/
│   ├── pdfium-adapter/
│   ├── storage/
│   └── platform/
├── apps/
│   ├── desktop/src-tauri/
│   └── desktop/ui/
├── migrations/
├── assets/
├── packaging/
├── scripts/
├── tests/
└── docs/
```

The Cargo workspace is intentionally a skeleton. Add crates incrementally as boundaries become real; avoid empty abstractions.
