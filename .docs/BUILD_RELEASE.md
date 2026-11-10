# Build, Installers, Signing, and Release

## Release principle

Build native artifacts on native operating-system runners. Tauri supports platform-specific bundles, but signing and some packaging tools are OS-specific. Do not promise a single cross-compiled job will produce every production installer.

## Artifact matrix

| Platform | Architectures | Primary artifact | Additional |
|---|---|---|---|
| macOS | arm64 + x86_64 (separate or universal after validation) | `.dmg` containing signed `.app` | `.app` |
| Windows | x86_64 initially; arm64 later if validated | NSIS setup `.exe` | `.msi` |
| Linux | x86_64 initially; arm64 later if validated | `.AppImage` | `.deb`, `.rpm` |

Linux distribution needs a documented minimum glibc baseline and supported desktop/runtime expectations. Test on clean machines/VMs, not only the build image.

## Build prerequisites

- All platforms: pinned Rust toolchain, Node LTS, package manager lockfile, Tauri CLI, reproducible build scripts.
- macOS: Xcode Command Line Tools, Apple Developer ID certificate for outside-App-Store distribution, notarization credentials.
- Windows: Microsoft C++ Build Tools, WebView2 runtime strategy, Windows code-signing certificate; WiX tooling for MSI as applicable.
- Linux: Tauri/WebKitGTK build dependencies, packaging dependencies, clean target distro images.

Use the official Tauri prerequisites for the exact dependency list for the pinned Tauri version.

## Local development

Typical commands (adapt to the package scripts and generated Tauri project):

```bash
# Rust checks
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace

# Frontend
cd apps/desktop/ui
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test

# Desktop development/build
cd ..
pnpm tauri dev
pnpm tauri build
```

Do not commit machine-specific build outputs or vendor secrets.

## CI pipeline

Recommended GitHub Actions (or equivalent) matrix:
1. Pull request: fmt, clippy, unit tests, frontend lint/typecheck/tests, dependency audit, license report.
2. Main branch: build unsigned artifacts on native runners for smoke testing.
3. Release tag: build release artifacts, sign, notarize where required, generate checksums/SBOM, publish draft release.
4. Human release approval: verify artifacts, install/upgrade/uninstall tests, then publish.

Suggested runner matrix:
- `macos-latest`: macOS arm64 build; use an Intel runner if shipping x86_64 separately.
- `windows-latest`: Windows x64 installer.
- `ubuntu-latest`: Linux packages; test AppImage/DEB/RPM on clean supported distributions.

Runner labels and available CPU architectures change; verify the actual runner architecture in CI.

## Signing and trust

- macOS direct distribution: Developer ID signing, hardened runtime/entitlements as required, notarize, staple ticket, verify Gatekeeper behavior.
- Windows: Authenticode-sign installer and executable; timestamp signatures.
- Linux: sign repository metadata/packages where applicable; publish SHA-256 checksums and provenance.
- Never store certificates or passwords in repository. Use CI secret store and least-privilege credentials.
- Test upgrades over the previous production version and clean uninstall behavior.

## PDFium binary packaging

- Bundle the matching PDFium shared library for each OS/architecture if required by the chosen Rust binding.
- Verify dynamic library lookup paths and required runtime dependencies on clean machines.
- Include all required third-party notices and licenses.
- Scan native binaries and define an update process for security fixes.
- Do not download arbitrary “latest” binaries at build time. Pin a known version and checksum.

## Application Data Locations, Backup & Uninstall

| OS | Data Directory | Files Stored | Uninstall Cleanup |
|---|---|---|---|
| macOS | `~/Library/Application Support/com.readora.desktop` | `readora.sqlite`, `-wal`, `-shm` | Remove app bundle + delete `com.readora.desktop` folder (`NativePlatformAdapter::cleanup_app_data_dir`) |
| Windows | `%APPDATA%\Readora` | `readora.sqlite`, `-wal`, `-shm` | Run NSIS uninstaller + delete `%APPDATA%\Readora` if resetting user data |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/readora` | `readora.sqlite`, `-wal`, `-shm` | Remove package (`apt`/`rpm`/AppImage) + delete `~/.local/share/readora` |

- **Upgrades**: `SqliteStorage::open` applies append-only schema migrations (`0001` → `0002` → `0003`) inside a transaction without modifying existing preferences, bookmarks, or annotations.
- **SBOM & License Notices**: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and [`sbom.cdx.json`](../sbom.cdx.json) are bundled with release artifacts and surfaced in-app via `Preferences -> About & Licenses`.

## Release checklist

- [x] Version, changelog, and release notes updated.
- [x] Cargo and frontend (`pnpm-lock.yaml`) lockfiles committed.
- [x] Dependency, license, and native-binary inventory reviewed (`THIRD_PARTY_NOTICES.md`).
- [x] Unit/integration/smoke tests pass on supported OSes (`.github/workflows/ci.yml`).
- [x] Install, launch, open PDF, print, upgrade, and uninstall tested.
- [x] Signatures and macOS notarization entitlements configured (`apps/desktop/src-tauri/Entitlements.plist`).
- [x] Checksums and CycloneDX SBOM generated (`sbom.cdx.json` + `.github/workflows/release.yml`).
- [x] Crash logs and `SystemDiagnosticsDto` do not contain document content, passwords, or unredacted user home paths.
- [x] Rollback/update-channel plan ready.
