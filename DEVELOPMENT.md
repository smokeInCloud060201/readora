# Readora Development Guide

This guide is for contributors and developers who want to build and run Readora from source. For the end-user introduction and downloads, see the [main README](README.md).

## What you will build

Readora is a local-first desktop PDF reader. Its interface is built with React and TypeScript, while Rust handles application rules, PDF-engine access, persistence, and platform operations. The native desktop shell uses `tao` and `wry`.

The repository follows a ports-and-adapters architecture: application services depend on domain types and interfaces, while concrete storage, platform, and PDF-engine implementations are wired at the desktop composition root. Keep PDFium calls inside `crates/pdfium-adapter`, SQL inside `crates/storage`, and filesystem access out of the UI and domain layers.

## Prerequisites

- **Rust:** stable toolchain; the workspace uses Rust 2024 edition (Rust 1.85 or newer). `rustfmt` and `clippy` are included in `rust-toolchain.toml`.
- **Node.js:** 22 or newer.
- **pnpm:** 12.5.1, as specified in the root `package.json`.
- **Linux only:** GTK 3 and WebKitGTK 4.1 development libraries, plus packaging utilities for building Linux packages.

On Ubuntu or Debian, install the documented system dependencies with:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf rpm dpkg-dev
```

On macOS, install the Xcode Command Line Tools. On Windows, use a supported Rust toolchain with the required native build tools. Refer to the official Rust, Node.js, and pnpm installation documentation for platform-specific setup.

## Set up the checkout

From the repository root:

```bash
git clone https://github.com/smokeInCloud060201/readora.git
cd readora
pnpm install --frozen-lockfile
```

The Rust toolchain is selected by `rust-toolchain.toml`. Cargo will fetch the locked Rust dependencies during the first build.

## Build and run the desktop app

Build the frontend bundle, then launch the native shell:

```bash
pnpm build
cargo run -p readora-desktop
```

The native shell loads the built UI from `apps/desktop/ui/dist`. Re-run `pnpm build` after frontend changes before launching the desktop app.

For frontend-only work, start Vite with:

```bash
pnpm dev
```

This opens the UI development server in a browser; it is useful for developing presentation-layer code, but does not launch the native desktop shell.

## Verify changes

Run the checks relevant to your change before submitting it. The complete Rust and frontend verification suite is:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked

pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Project documentation

- [Architecture and layer boundaries](.docs/ARCHITECTURE.md)
- [Feature modules and MVP scope](.docs/FEATURE_MODULES.md)
- [Security and privacy baseline](.docs/SECURITY.md)
- [Build, packaging, and release guide](.docs/BUILD_RELEASE.md)
- [Testing strategy](.docs/TESTING.md)
- [Coding conventions](.docs/CODING_CONVENTIONS.md)
- [Agent operating rules](AGENTS.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Contribution notes

Keep changes focused and preserve the architecture boundaries. Treat PDFs as untrusted input; do not log document contents, passwords, or full user paths. Do not add network, telemetry, account, cloud-sync, or AI features unless they are explicitly requested.

Before contributing, check open [issues](https://github.com/smokeInCloud060201/readora/issues) and follow the repository’s contribution instructions if provided. When reporting bugs, include your operating system and steps to reproduce, but never include private PDF files, passwords, or sensitive document text.
