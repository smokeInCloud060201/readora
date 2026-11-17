<div align="center">
  <img src="assets/icons/icon-1024.svg" alt="Readora logo" width="88" height="88" />

  # Readora

  **A calm, private place to read your PDFs.**

  Readora is a free, open-source desktop PDF reader for macOS, Windows, and Linux. Your documents and reading notes stay on your computer.

  [Download Readora](https://github.com/smokeInCloud060201/readora/releases) · [Report a problem](https://github.com/smokeInCloud060201/readora/issues) · [Developer guide](DEVELOPMENT.md)

  [![CI](https://github.com/smokeInCloud060201/readora/actions/workflows/ci.yml/badge.svg)](https://github.com/smokeInCloud060201/readora/actions/workflows/ci.yml)
  [![Latest release](https://img.shields.io/github/v/release/smokeInCloud060201/readora)](https://github.com/smokeInCloud060201/readora/releases/latest)
  [![Rust 2024](https://img.shields.io/badge/Rust-Edition%202024-191715?logo=rust)](Cargo.toml)
  [![Native Shell: tao + wry](https://img.shields.io/badge/Shell-tao%200.31%20%2B%20wry%200.48-2a6650)](apps/desktop/src-tauri/Cargo.toml)
  [![React 19 + TypeScript 5](https://img.shields.io/badge/UI-React%2019%20%C2%B7%20TS%205.9-3d6f5c?logo=react)](apps/desktop/ui/package.json)
  [![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-8a8278)](LICENSE-MIT)
  [![Privacy: 100% Local-First](https://img.shields.io/badge/Privacy-Zero%20Telemetry%20%C2%B7%20Local--First-2a6650)](.docs/SECURITY.md)
</div>

---

## A more focused way to read

Whether you are reading a book, studying course material, or reviewing a report, Readora helps you keep your place and focus on the page. It is designed to feel at home on your desktop and to keep your document library under your control.

### Made for everyday reading

- **Read at your pace.** Scroll continuously or move through a document one page at a time. Zoom in, rotate pages, or fit a page to your screen.
- **Make reading easier on your eyes.** Choose a light, dark, or system appearance, and adjust how PDF pages are displayed.
- **Find what you need.** Search document text and move through the document’s contents when an outline is available.
- **Keep your place.** Readora remembers your recent documents and reading position. Bookmark pages, highlight or underline passages, and add notes.
- **Keep things organized.** Mark documents as favorites or archive them, then filter and sort your library.
- **Take your notes with you.** Export bookmarks, highlights, and notes as a Markdown file.

## Your files stay yours

Readora is built to work on your computer, without an account or cloud library. Your PDFs are not uploaded to Readora. Reading progress, preferences, bookmarks, and annotations are stored locally. Readora does not modify your original PDF files.

Readora can check GitHub for updates automatically; you can manage update checks in the app’s preferences. Readora does not run JavaScript embedded in PDFs or automatically open PDF attachments.

## Download and install

Visit [Readora Releases](https://github.com/smokeInCloud060201/readora/releases) and choose the latest download for your computer. The release page and its notes identify the available files and installation details.

Current release packages are provided for **Apple silicon Macs**, **64-bit Windows**, and **64-bit Linux**. Linux packages require WebKitGTK 4.1 and GTK 3 runtime libraries. If your operating system or processor is not listed, check the release notes before installing.

After installation, open Readora and choose a PDF from your computer. Your document stays at its original location.

## An open-source project

Readora is developed in the open and licensed under your choice of the MIT License or Apache License 2.0. It is an independent project, not affiliated with other PDF or browser projects.

Open-source reading tools such as [Okular](https://okular.kde.org/) and [Firefox](https://www.mozilla.org/firefox/) are part of a long-standing ecosystem of community-built software. Readora shares that open-source spirit while focusing on a quiet, local-first desktop reading experience; it does not claim feature parity with those larger projects.

Found a problem or have an idea? [Open an issue](https://github.com/smokeInCloud060201/readora/issues). Please avoid attaching private documents or sharing passwords in reports.

## For developers

Want to build Readora from source, run it locally, or contribute code? Start with the separate [Development Guide](DEVELOPMENT.md). It covers setup, build and test commands, and links to the architecture and security documentation.

## License

Readora is available under either the [MIT License](LICENSE-MIT) or the [Apache License, Version 2.0](LICENSE-APACHE), at your option. Third-party components are acknowledged in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
