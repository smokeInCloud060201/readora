# Feature Modules and Product Scope

## Product principles

1. Fast first page: render only what the user can see.
2. Local-first: documents remain on the user's machine.
3. Predictable: preserve reading position and preferences.
4. Safe: PDFs are untrusted input.
5. Accessible: keyboard-first workflows and screen-reader labels.
6. Commercial-ready: signed installers, upgrade path, diagnostics, and supportable releases.

## Module map

| Module | MVP | Later / Pro |
|---|---|---|
| App shell | Window, menus, lifecycle, themes | Multi-window, tray, deep links |
| Document access | Open, drag/drop, recent files, close | File associations, session restore |
| Reader viewport | Single/continuous page, scroll, zoom, fit width/page | Spread view, presentation mode |
| Navigation | Page number, previous/next, thumbnails | Custom page labels, history |
| Document structure | Metadata, outline/bookmarks | Attachment browser |
| Find | Current-document text search, next/previous hit | Multi-document search, indexing |
| Reading tools | Rotate, selection, copy text | Reflow, read aloud |
| User organization | App bookmarks, last position | Tags, collections |
| Annotations | Highlight, underline, free text, ink | Shapes, stamps, measurement |
| Forms | Read-only form display | Fill, reset, export form data |
| Security | Password prompt, encrypted-file handling | Certificate/signature validation |
| Export/print | Print through OS, export selected pages | Merge, split, compress, convert |
| Preferences | Theme, zoom behavior, cache limit | Profiles, shortcuts customization |
| Reliability | Crash-safe state, logs without content | Diagnostics bundle, crash reporting opt-in |
| Updates | Manual download/update channel | In-app signed updates |
| Licensing | Third-party notices | Commercial license/entitlement if monetized |

## MVP release gate

The first public beta should include:
- Open PDFs by picker, drag/drop, and command-line/file association where supported.
- Password-protected document prompt.
- Fast single-page and continuous scrolling.
- Zoom, fit width, fit page, rotate.
- Page navigation and thumbnail sidebar.
- Text selection and find-in-document.
- Recent documents and restore last reading position.
- Light/dark/system theme.
- Print and copy selected text.
- Graceful handling of malformed, huge, and unsupported PDFs.
- Installers for all target OSes with version metadata and uninstall support.

## Suggested navigation / UI modules

```text
ApplicationShell
├── MainMenu
├── Workspace
│   ├── DocumentTabs
│   ├── ReaderToolbar
│   ├── PageViewport
│   │   ├── PageCanvas
│   │   └── SelectionOverlay
│   └── StatusBar
├── LeftSidebar
│   ├── ThumbnailsPanel
│   ├── OutlinePanel
│   ├── BookmarksPanel
│   └── SearchResultsPanel
├── RightSidebar
│   ├── PropertiesPanel
│   └── AnnotationToolsPanel
├── Dialogs
│   ├── OpenPasswordDialog
│   ├── PreferencesDialog
│   └── AboutDialog
└── Notifications
```

## Non-functional requirements to baseline

Set measurable targets after profiling representative PDFs. Suggested initial targets:
- App cold start: under 2 seconds on a defined reference machine (excluding first-run OS checks).
- First visible page: under 500 ms for a representative 10 MB PDF on reference hardware.
- Page navigation: no UI freeze; visible page request should be prioritized.
- Memory: bounded render cache with configurable cap; no unbounded page bitmap retention.
- Reliability: no crash on malformed corpus; fuzz the parsing boundary.
- Accessibility: all core actions reachable by keyboard and controls have accessible names.

Treat these as targets to validate, not guarantees.
