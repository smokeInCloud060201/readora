# Third-Party Open-Source Notices and Acknowledgements

Readora (`1.1.3`) is free, open-source software distributed under the **MIT OR Apache-2.0** dual license ([`LICENSE-MIT`](LICENSE-MIT) / [`LICENSE-APACHE`](LICENSE-APACHE)).
This distribution incorporates or links against the following open-source components (synced with [`sbom.cdx.json`](sbom.cdx.json), [`Cargo.lock`](Cargo.lock), and [`pnpm-lock.yaml`](pnpm-lock.yaml)):

---

## 1. PDF Engine (`pdfium-adapter`)

### PDFium (Chromium PDF Engine — `chromium/8165`)
- **Upstream**: <https://pdfium.googlesource.com/pdfium/> (prebuilt distribution: `bblanchon/pdfium-binaries` tag `chromium/8165`)
- **Version**: `chromium-8165`
- **License**: `BSD-3-Clause AND Apache-2.0` (full upstream license bundled as [`LICENSE-PDFIUM`](LICENSE-PDFIUM) in every release archive)
- **Usage**: Dynamically loaded via `pdfium-render` (`0.8.37`) and `libloading` (`0.9.0`) from trusted application bundle paths (or `READORA_PDFIUM_PATH` in development/test builds). When absent, Readora uses its built-in deterministic pure-Rust PDF engine.

```text
Copyright 2014 The PDFium Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 2. Rust Workspace Production Dependencies (`Cargo.lock`)

| Crate | Version | License | Purpose |
|---|---|---|---|
| `tao` | `0.31.1` | `Apache-2.0` | Cross-platform native desktop window creation and event loop |
| `wry` | `0.48.1` | `Apache-2.0 OR MIT` | Cross-platform native OS WebView rendering (`WKWebView`, `WebView2`, `WebKitGTK`) |
| `rusqlite` | `0.32.1` | `MIT` | Local SQLite WAL persistence (`crates/storage`) |
| `libsqlite3-sys` | `0.30.1` | `MIT` (SQLite: `Blessing` / Public Domain) | Bundled SQLite C engine bindings |
| `pdfium-render` | `0.8.37` | `MIT OR Apache-2.0` | High-level thread-safe dynamic bindings to PDFium (`crates/pdfium-adapter`) |
| `libloading` | `0.9.0` | `ISC` | Dynamic runtime loading of PDFium shared libraries |
| `serde` | `1.0.229` | `MIT OR Apache-2.0` | Typed IPC and DTO serialization |
| `serde_json` | `1.0.154` | `MIT OR Apache-2.0` | JSON RPC envelope and release manifest parsing |
| `thiserror` | `2.0.21` | `MIT OR Apache-2.0` | Explicit domain, storage, PDF engine, and application error enums |
| `sha2` | `0.10.9` | `MIT OR Apache-2.0` | Deterministic SHA-256 document ID derivation and update checksum verification |
| `base64` | `0.22.1` | `MIT OR Apache-2.0` | PNG data-URI encoding across IPC |
| `crc32fast` | `1.5.4` | `MIT OR Apache-2.0` | Checksum calculation for PNG chunks |
| `flate2` | `1.1.11` | `MIT OR Apache-2.0` | Deflate compression/decompression for fallback PDF streams and PNG bitmaps |
| `bytes` | `1.12.1` | `MIT` | Zero-copy reference-counted PDF byte buffers |
| `uuid` | `1.29.2` | `Apache-2.0 OR MIT` | Bookmark/annotation identifiers and 256-bit CSPRNG loopback session tokens |
| `tempfile` | `3.27.0` | `MIT OR Apache-2.0` | Mode-`0700` CSPRNG temporary staging directories for self-updates |
| `tracing` | `0.1.44` | `MIT` | Structured, privacy-preserving diagnostic instrumentation |
| `tracing-subscriber` | `0.3.23` | `MIT` | Environment-filtered structured log formatting |

---

## 3. Frontend Production & Build Dependencies (`pnpm-lock.yaml`)

| Package | Version | License | Purpose |
|---|---|---|---|
| `react` | `19.3.1` | `MIT` | User interface component runtime |
| `react-dom` | `19.3.1` | `MIT` | DOM renderer for the desktop UI |
| `pdfjs-dist` | `6.5.438` | `Apache-2.0` | WebView canvas PDF rendering and text-layer geometry |
| `typescript` | `5.9.3` | `Apache-2.0` | Strict static type checking (build-time devDependency) |
| `vite` | `6.4.6` | `MIT` | Frontend production asset bundler (build-time devDependency) |
| `vitest` / `@testing-library/react` | `4.1.12` / `16.3.3` | `MIT` | Automated UI verification suite (build-time devDependency) |
