# Third-Party Open-Source Notices and Acknowledgements

Readora is free, open-source software distributed under the **MIT OR Apache-2.0** dual license.
This distribution incorporates or links against the following open-source components:

---

## 1. PDF Engine (`pdfium-adapter`)

### PDFium (Chromium PDF Engine)
- **Upstream**: <https://pdfium.googlesource.com/pdfium/>
- **License**: `BSD-3-Clause AND Apache-2.0`
- **Usage**: Dynamically loaded via `libloading` when present at `READORA_PDFIUM_PATH` or inside the application bundle (`libpdfium.dylib`, `pdfium.dll`, `libpdfium.so`). When absent, Readora uses its built-in deterministic Rust PDF engine.

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
```

---

## 2. Rust Workspace Dependencies (`Cargo.lock`)

| Crate | Version | License | Purpose |
|---|---|---|---|
| `rusqlite` / `libsqlite3-sys` | `0.32.x` | `MIT` (SQLite: `Blessing` / Public Domain) | Local SQLite WAL persistence (`crates/storage`) |
| `serde` / `serde_json` | `1.0.x` | `MIT OR Apache-2.0` | Typed IPC and DTO serialization |
| `thiserror` | `2.0.x` | `MIT OR Apache-2.0` | Explicit domain and application error enums |
| `libloading` | `0.8.x` | `ISC` | Dynamic runtime loading of PDFium shared libraries |
| `sha2` | `0.10.x` | `MIT OR Apache-2.0` | Deterministic SHA-256 document ID derivation |
| `base64` | `0.22.x` | `MIT OR Apache-2.0` | PNG data-URI encoding across IPC |
| `crc32fast` | `1.4.x` | `MIT OR Apache-2.0` | Checksum calculation for PNG chunks |
| `flate2` | `1.0.x` | `MIT OR Apache-2.0` | Deflate compression for rendered page bitmaps |
| `tracing` / `tracing-subscriber` | `0.1.x` / `0.3.x` | `MIT` | Structured, privacy-preserving diagnostic logging |

---

## 3. Desktop Shell & Frontend (`apps/desktop`)

| Package | Version | License | Purpose |
|---|---|---|---|
| `@tauri-apps/cli` / Tauri | `2.x` | `MIT OR Apache-2.0` | Cross-platform desktop application shell and native bundler |
| `react` / `react-dom` | `19.x` | `MIT` | User interface component runtime |
| `pdfjs-dist` | `6.5.x` | `Apache-2.0` | Browser-mode local PDF parsing, text extraction, and HTML canvas rendering |
| `typescript` | `5.7.x` | `Apache-2.0` | Static type checking |
| `vite` | `6.x` | `MIT` | Frontend bundler |
| `vitest` / `@testing-library/react` | `3.x` / `16.x` | `MIT` | Automated UI verification |
