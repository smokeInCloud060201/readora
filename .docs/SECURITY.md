# Security and Privacy Baseline

## Threat model

Assume every PDF may be malformed, malicious, encrypted, deeply nested, decompression-bombed, or crafted to exploit native parsing or WebView rendering code. Assume other unprivileged local processes or browser tabs may attempt cross-origin, DNS-rebinding, Slowloris, or symlink attacks against local ports and filesystem paths.

## Enforced controls

### 1. PDF & untrusted input isolation
- Isolate PDF parsing/rendering behind `crates/pdf-engine` traits (`crates/pdfium-adapter` only).
- Pin prebuilt PDFium binaries to a reviewed tag (`chromium/8165` in `.github/workflows/release.yml`, `sbom.cdx.json`, and `THIRD_PARTY_NOTICES.md`) and verify pinned SHA-256 archive digests before extraction.
- Enforce strict resource bounds: `512 MiB` maximum PDF size, `4096 px` maximum render dimension, bounded Flate decompression caps in the pure-Rust fallback parser, bounded HTTP worker pool (`8` threads, queue `64`), and byte-bounded LRU render cache.
- Never execute PDF JavaScript, launch embedded files, or auto-open external protocols.
- Zeroize PDF passwords in memory on drop, redact them in `Debug` impls, and never persist or log them.

### 2. Native WebView & loopback RPC hardening (`apps/desktop/src-tauri`)
- Bind loopback HTTP/RPC strictly to `127.0.0.1:0` (OS-assigned ephemeral port).
- Enforce `Host: 127.0.0.1:<port>`, `POST`, `Origin: http://127.0.0.1:<port>`, `Sec-Fetch-Site: same-origin`, and constant-time 256-bit CSPRNG `X-Readora-Token` checks before reading API request bodies.
- Reject duplicate security headers (`Host`, `Origin`, `Sec-Fetch-Site`, `X-Readora-Token`, `X-Readora-Filename`, `X-Readora-Password`, `Content-Length`), reject `Transfer-Encoding`, reject incomplete headers or truncated bodies, and enforce `3s` header-read and `20s` total request deadlines (`MAX_HEADER_DURATION` / `MAX_REQUEST_DURATION`).
- Resolve bundled UI assets strictly from trusted `current_exe()` / FHS `/usr/lib/readora/ui` paths in release builds (`#[cfg(not(debug_assertions))]`), blocking CWD UI hijacking.
- Serve HTML, `.js`, `.mjs` (Web Worker), and `.svg` assets with `Content-Security-Policy` excluding `script-src 'unsafe-inline'` (`script-src 'self' blob:`), `X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff`.
- Lock WebView navigation via `is_allowed_navigation_url` to exact `http://127.0.0.1:<port>` authorities (blocking `about:blank`, `javascript:`, `@` userinfo bypasses, and port-prefix collisions), block new windows (`with_new_window_req_handler(|_| false)`), inject the RPC bridge at document creation with subframe/origin guards and captured `window.fetch`, and sanitize all hyperlinks rendered in the UI.

### 3. Self-updater, installer & privacy controls
- Query only the configured GitHub Releases endpoint (`/repos/{owner}/{repo}/releases/latest` over HTTPS with strict `is_valid_github_repo_slug` validation) on launch when `auto_check_updates = true` (user-configurable in `Preferences → General`, with zero telemetry or document metadata sent).
- Stage downloaded updates inside a mode-`0700` CSPRNG temporary directory under `<app_data_dir>/updates`, pin executable self-updates to the official release repository in release builds, verify 64-hex SHA-256 checksums **fail-closed** against the staged release manifest, verify macOS `codesign --verify --deep --strict` (with `TeamIdentifier` continuity when signed) **before** clearing quarantine, pass bundle paths as positional `$1` arguments (never shell interpolation), and back up/restore `Readora.app` on move failure.
- On Linux, `DEBIAN/postrm` cleans user artifacts **only on `purge`** (never `remove`/`upgrade`), enforces fail-closed non-root privilege drop via `runuser` or `su` (never executing cleanup inside user home directories as `uid 0` and never invoking recursive `rm -rf`), and refuses symlinked path segments (`find -P`).
- Never log document text, passwords, or unredacted user home paths.
