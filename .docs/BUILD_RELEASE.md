# Build, Installers, Signing, and Release

## Release principle

Build native artifacts on native operating-system runners (`.github/workflows/release.yml`). Readora packages a native `tao` + `wry` Rust binary (`readora-desktop`), compiled Vite UI assets (`apps/desktop/ui/dist`), and a pinned `chromium/8165` PDFium shared library on each target OS.

## Official CI artifact matrix

| Platform | Runner | Target label | Primary artifact | Additional artifact |
|---|---|---|---|---|
| macOS | `macos-latest` | `macos-aarch64` | `Readora_<ver>_macos-aarch64.dmg` | `Readora_<ver>_macos-aarch64.app.tar.gz` |
| Windows | `windows-latest` | `windows-x86_64` | `Readora_<ver>_windows-x86_64-setup.zip` (complete bundle: `Readora.exe`, `ui/`, `pdfium/pdfium.dll`, licenses, SBOM) | — |
| Linux | `ubuntu-latest` | `linux-x86_64` | `Readora_<ver>_linux-x86_64.deb` (`Depends: libwebkit2gtk-4.1-0, libgtk-3-0`, `Recommends: curl, xdg-utils`) | `Readora_<ver>_linux-x86_64.tar.gz` |

> Note: Source builds also compile on `macos-x86_64`. On Intel Macs, the self-updater strictly requests `macos-x86_64` assets and never falls back to `macos-aarch64` binaries.

## Build prerequisites

- **All platforms**: Pinned stable Rust toolchain (`1.85+`, Edition `2024` via [`rust-toolchain.toml`](../rust-toolchain.toml)), Node.js `22+`, `pnpm` (`12.5.1`), committed `Cargo.lock` and workspace [`pnpm-lock.yaml`](../pnpm-lock.yaml).
- **macOS**: Xcode Command Line Tools (`sips`, `iconutil`, `hdiutil`, `codesign`, `notarytool`).
- **Windows**: MSVC Build Tools, Edge WebView2 runtime (preinstalled on Windows 10/11), Authenticode `signtool.exe` when signing secrets are configured.
- **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `rpm`, `dpkg-dev`.

## Local development

```bash
# Install frontend workspace dependencies from repository root (configured via pnpm-workspace.yaml)
pnpm install --frozen-lockfile

# Rust formatting, strict Clippy lints, and workspace tests (9 crates)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked

# Frontend lint, strict TypeScript check, Vitest suite, and production bundle
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# Launch the native desktop shell against apps/desktop/ui/dist
cargo run -p readora-desktop
```

Do not commit machine-specific build outputs, local PDFs, or signing secrets.

## CI & release pipeline (`.github/workflows/`)

1. **`.github/workflows/ci.yml`**: Runs `cargo fmt`, `cargo clippy --locked -- -D warnings`, `cargo test --workspace --locked`, and `pnpm lint` / `typecheck` / `test` / `build` across `ubuntu-latest`, `macos-latest`, and `windows-latest`.
2. **`.github/workflows/release.yml`**:
   - Triggered on `v*.*.*` tags or manual `workflow_dispatch` (defaulting `VITE_APP_VERSION` and `CLEAN_VERSION` to `1.1.2`).
   - Fetches PDFium pinned deterministically to `PDFIUM_TAG="chromium%2F8165"` from `bblanchon/pdfium-binaries`, verifies pinned archive SHA-256 checksums, and fails closed if `curl`, checksum, `tar`, or library/`LICENSE` extraction fails.
   - Places macOS `libpdfium.dylib` inside `Contents/Frameworks/libpdfium.dylib`, signs it **first without entitlements**, then signs `Readora.app` with `--options runtime --entitlements apps/desktop/src-tauri/Entitlements.plist` **without `--deep`**, followed by `codesign --verify --deep --strict`, notarizes and staples `Readora.app` **before** archiving `Readora_<ver>_macos-aarch64.app.tar.gz` and building/notarizing/stapling the `.dmg`.
   - Generates `release-manifest-<label>.json` (recording exact `"asset"` and `"sha256"`), `.sha256` checksum lists, and GitHub Sigstore SLSA build provenance attestations.

## PDFium binary packaging rules

- **Never** download mutable `releases/latest` PDFium archives in CI. Always pin an explicit `chromium/<build>` tag (currently `chromium/8165`) matching [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and [`sbom.cdx.json`](../sbom.cdx.json).
- Fail closed if archive checksum or expected shared library/`LICENSE` verification fails.
- Bundle [`LICENSE-MIT`](../LICENSE-MIT), [`LICENSE-APACHE`](../LICENSE-APACHE), `LICENSE-PDFIUM`, [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), and [`sbom.cdx.json`](../sbom.cdx.json) inside every OS distribution.

## Application Data Locations, Upgrades & Clean Uninstall

| OS | Data Directory | Cache Directory | Uninstall Cleanup |
|---|---|---|---|
| macOS | `~/Library/Application Support/com.readora.desktop` | `~/Library/Caches/com.readora.desktop` | `readora-desktop --uninstall-cleanup` or [`uninstall-cleanup.sh`](../apps/desktop/src-tauri/installer/macos/uninstall-cleanup.sh) |
| Windows | `%APPDATA%\Readora` | `%LOCALAPPDATA%\Readora\Cache` | Portable `.zip` builds use in-app **Clean up app data** or `.\Readora.exe --uninstall-cleanup` (NSIS [`nsis-hooks.nsh`](../apps/desktop/src-tauri/installer/windows/nsis-hooks.nsh) retained for NSIS packaging) |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/readora` | `${XDG_CACHE_HOME:-~/.cache}/readora` | Debian [`postrm`](../apps/desktop/src-tauri/installer/linux/postrm) **only on `purge`** (never `remove`/`upgrade`), enforcing fail-closed privilege drop via `runuser`/`su` (never `uid 0`), bounded file-extension deletion (never `rm -rf`), and refusing symlinked path segments |

- **Database upgrades**: `SqliteStorage::open` applies append-only schema migrations (`0001` → `0002` → `0003` → `0004` → `0005`) transactionally.
- **Self-update safety**: Downloads stage inside a mode-`0700` CSPRNG directory under `<data_dir>/updates/.stage-*`, verify 64-hex SHA-256 digests fail-closed against the staged manifest, verify macOS `codesign --verify --deep --strict`, and atomically back up & roll back `Readora.app` on move failure.

## Release checklist

- [x] Workspace version (`1.1.2`), [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), and [`sbom.cdx.json`](../sbom.cdx.json) synced with `Cargo.lock` and `pnpm-lock.yaml`.
- [x] Unit, adapter-contract, and integration tests pass on macOS, Linux, and Windows (`.github/workflows/ci.yml`).
- [x] PDFium pinned to `chromium/8165` with pinned archive SHA-256 and `LICENSE-PDFIUM` verification.
- [x] macOS dylib signed separately without entitlements before signing `Readora.app`.
- [x] Debian package declares `Depends: libwebkit2gtk-4.1-0, libgtk-3-0`, `Recommends: curl, xdg-utils`, and `postrm` purges data strictly on `purge` without following symlinks.
- [x] Logs and `SystemDiagnosticsDto` redact user home paths and never emit document text or passwords.
