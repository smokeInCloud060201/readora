# Delivery Roadmap

## Phase 0 — Technical validation
- Build a minimal Tauri 2 shell on macOS, Windows, and Linux.
- Prototype the chosen PDFium binding and native library loading on each target architecture.
- Test render latency, memory, encrypted files, text extraction, and large PDFs.
- Complete binding/engine license review and create a third-party notices process.
- Decide minimum OS versions and Linux distribution baseline.

**Exit:** signed-off engine decision, reproducible dev build on all three OS families, benchmark baseline.

## Phase 1 — Reader MVP
- Open/close documents and password prompt.
- Page rendering, zoom, scroll, page navigation.
- Thumbnails, outline, text selection, find.
- Recent documents and last reading position.
- Settings, theme, print.
- Error handling and accessibility.

**Exit:** acceptance tests pass on all supported OSes and representative PDF corpus.

## Phase 2 — Beta hardening
- Annotation primitives and bookmarks.
- Better search, cache tuning, cancellation.
- Fuzzing, crash diagnostics, memory/performance budgets.
- Native installers, signing, update strategy, upgrade/uninstall tests.

**Exit:** beta install/upgrade experience is supportable and release artifacts are signed.

## Phase 3 — Open-Source Community Release
- Advanced annotations and form workflows.
- Signature inspection/validation (only after requirements and trust model are defined).
- Community release channels, open-source governance, and local support diagnostics.
- Localization, accessibility audit, and strict local-first privacy guarantees (zero telemetry).

**Exit:** feature and open-source license review complete; release, packaging, and vulnerability response processes documented.

# Rust Cross-Platform PDF Reader --- Project Roadmap

> **Project goal:** Build an open-source, free, production-grade PDF reader for macOS,
> Windows, and Linux using Rust, with a maintainable architecture,
> reliable PDF rendering, and native desktop packaging.

## 1. Product and Technical Direction

### Recommended technology stack

  -----------------------------------------------------------------------
Area                    Recommended choice      Notes
  ----------------------- ----------------------- -----------------------
Application core        Rust modular monolith   Keep domain and
application logic
independent of the
desktop shell

Desktop shell           Tauri 2                 Native desktop
packaging and
controlled
frontend/backend
communication

Frontend                React + TypeScript +    Reader UI and feature
Vite                    modules

PDF engine              PDFium behind an        Validate capabilities,
adapter                 licensing, binary
distribution, and
platform support before
committing

Metadata storage        SQLite                  Recent files,
preferences, bookmarks,
annotations metadata,
and session state

Packaging               DMG, MSI/EXE,           Build and test native
AppImage/DEB/RPM        packages for all
supported operating
systems
  -----------------------------------------------------------------------

### Architectural principles

-   Keep the application as a modular monolith until there is a proven
    reason to split it.
-   Keep PDF-engine-specific code inside `pdfium-adapter`.
-   Keep SQL and database-specific code inside `storage`.
-   Keep domain rules independent of Tauri, React, SQLite, and PDFium.
-   Use typed commands and events across the Tauri boundary.
-   Do not send large rendered bitmaps through JSON IPC; use an
    efficient transfer mechanism.
-   Use bounded worker pools, render cancellation, and memory-aware
    caching.
-   Treat every PDF as untrusted input.
-   Keep Tauri capabilities and filesystem permissions minimal.
-   Add tests and documentation when changing architecture or feature
    behavior.

## 2. Suggested Workspace Structure

``` text
.
├── Cargo.toml
├── rust-toolchain.toml
├── AGENTS.md
├── crates/
│   ├── app-domain/
│   ├── app-application/
│   ├── pdf-engine/
│   ├── pdfium-adapter/
│   ├── storage/
│   ├── platform/
│   ├── app-infrastructure/
│   └── app-core/
├── apps/
│   └── desktop/
│       ├── src-tauri/
│       └── ui/
└── docs/
    ├── ARCHITECTURE.md
    ├── FEATURE_MODULES.md
    ├── CODING_CONVENTIONS.md
    ├── BUILD_RELEASE.md
    ├── SECURITY.md
    ├── ROADMAP.md
    ├── DECISIONS.md
    ├── TESTING.md
    └── FOLDER_MAP.md
```

### Crate responsibilities

  -----------------------------------------------------------------------
Crate                               Responsibility
  ----------------------------------- -----------------------------------
`app-domain`                        Entities, value objects,
invariants, and domain errors

`app-application`                   Use cases, application services,
and ports

`pdf-engine`                        Engine-neutral PDF interfaces and
types

`pdfium-adapter`                    PDFium implementation of the engine
interfaces

`storage`                           SQLite repositories, migrations,
and persistence

`platform`                          OS-specific integration such as
file dialogs and printing

`app-infrastructure`                Shared infrastructure adapters

`app-core`                          Dependency composition and
application wiring

`src-tauri`                         Tauri commands, events, app setup,
and capabilities

`ui`                                React components, state, and reader
feature modules
  -----------------------------------------------------------------------

## 3. Delivery Roadmap

The plan has eight phases. Estimates are planning ranges, not
guarantees. Some work can overlap after the technical risks are
understood.

### Phase 0 --- Technical Foundation and Risk Reduction

**Estimated duration:** 1--2 weeks

**Goal:** Prove that the selected PDF engine and desktop integration can
meet the product's technical, legal, and distribution requirements
before building the full application.

**Main tasks**

1.  Evaluate PDFium and at least one fallback engine if needed.
2.  Verify required capabilities:
    -   Open and close documents.
    -   Render pages at different scales and rotations.
    -   Read page dimensions and metadata.
    -   Extract text and search text.
    -   Read outlines/bookmarks.
    -   Handle encrypted/password-protected PDFs.
    -   Support the annotation and form features planned for the
        product.
3.  Review licensing obligations for the engine, bindings, and
    distributed native binaries.
4.  Build a small Rust proof of concept for each target OS and
    architecture.
5.  Test native library loading and packaging.
6.  Test Tauri command/event communication.
7.  Benchmark page rendering, memory usage, and document-open latency.
8.  Decide how rendered image data moves from Rust to the UI.
9.  Define the initial supported OS and CPU architecture matrix.

**Areas requiring special attention**

-   PDFium's exact feature coverage and the quality/maintenance of Rust
    bindings.
-   Open-source license compatibility and notices required for free binary
    distribution.
-   Native binary availability, loading paths, and update strategy.
-   Large-page rendering, high-DPI displays, and memory pressure.
-   Differences between development builds and packaged applications.

**Expected result**

A working proof of concept that opens and renders a PDF on macOS,
Windows, and Linux, together with a written engine/license decision and
baseline performance measurements.

**Exit criteria**

-   [x] PDF open/render/close works on every target OS.
-   [x] Supported CPU architectures are documented.
-   [x] Engine licensing and distribution obligations are reviewed.
-   [x] Native library loading works in packaged test builds.
-   [x] Initial performance and memory baselines are recorded.
-   [x] A decision is documented on the rendering data-transfer
    approach.

------------------------------------------------------------------------

### Phase 1 --- Desktop Application Foundation

**Estimated duration:** 2 weeks

**Goal:** Establish a clean, reproducible application foundation and the
architecture boundaries that future features must follow.

**Main tasks**

1.  Create the Cargo workspace and crate boundaries.
2.  Set up the Tauri 2 desktop application.
3.  Set up React, TypeScript, Vite, and frontend lint/type-check
    scripts.
4.  Establish typed request/response contracts for Tauri commands.
5.  Define application logging and error-reporting conventions.
6.  Add configuration and user-preference foundations.
7.  Implement basic OS adapters for file selection and application
    paths.
8.  Add CI workflows for formatting, linting, tests, and builds.
9.  Document local development and build instructions.

**Areas requiring special attention**

-   Keep dependency direction clear: domain → application abstractions;
    adapters implement ports; composition wires dependencies.
-   Do not allow UI components to call PDFium directly.
-   Do not let SQL queries leak outside the storage crate.
-   Avoid broad filesystem permissions in Tauri.
-   Ensure a clean checkout can build without undocumented local setup.

**Expected result**

A desktop shell that launches on all target operating systems, with a
functioning Rust workspace, frontend, typed IPC, and CI.

**Exit criteria**

-   [x] Clean checkout builds using documented instructions.
-   [x] Desktop shell launches on macOS, Windows, and Linux.
-   [x] CI runs formatting, linting, tests, and relevant build checks.
-   [x] Tauri commands use typed contracts.
-   [x] Tauri capabilities are minimal and reviewed.
-   [x] Architecture and coding rules are documented.

------------------------------------------------------------------------

### Phase 2 --- PDF Engine Integration

**Estimated duration:** 2--3 weeks

**Goal:** Integrate the selected PDF engine behind a stable,
engine-neutral interface.

**Main tasks**

1.  Define engine-neutral document, page, render, and error types.
2.  Define traits for opening, inspecting, rendering, and closing
    documents.
3.  Implement the PDFium adapter.
4.  Add document lifecycle management.
5.  Implement first-page rendering.
6.  Add password-protected document handling.
7.  Add bounded background workers for expensive engine operations.
8.  Add cancellation for obsolete render requests.
9.  Add resource cleanup for documents, pages, and bitmap buffers.
10. Add integration tests using a controlled PDF corpus.

**Areas requiring special attention**

-   PDFium handles and native resources must have clear ownership and
    lifetimes.
-   Do not hold engine locks during unrelated UI or storage work.
-   Avoid unbounded thread creation and render queues.
-   Cancel stale rendering work when the user changes page, zoom, or
    document.
-   Return useful errors without exposing native crashes or internal
    details to users.

**Expected result**

The application can open a PDF, inspect basic metadata, render a page,
and close the document reliably on all target platforms.

**Exit criteria**

-   [x] Open/render/close works on all target platforms.
-   [x] Password-protected files produce a usable password flow.
-   [x] Invalid and unsupported files fail safely.
-   [x] Worker and render queues are bounded.
-   [x] Stale render requests can be cancelled.
-   [x] Native resources are released on close and error paths.
-   [x] Integration tests cover normal, malformed, and encrypted PDFs.

------------------------------------------------------------------------

### Phase 3 --- Core Reader MVP

**Estimated duration:** 3--4 weeks

**Goal:** Deliver a reader that is useful for everyday PDF reading and
suitable for private beta testing.

**Main tasks**

1.  Implement single-page and continuous-scroll modes.
2.  Implement zoom in/out and fit-to-width/fit-to-page.
3.  Implement page rotation.
4.  Implement page navigation and page-number entry.
5.  Implement thumbnails.
6.  Implement document outline/navigation when available.
7.  Add a render scheduler and memory-aware bitmap cache.
8.  Add recent documents.
9.  Add session restore and last-read position.
10. Add keyboard shortcuts.
11. Add basic accessibility support.
12. Add print and text-copy workflows where supported.

**Areas requiring special attention**

-   Smooth scrolling and rendering while navigating quickly.
-   Memory use for large documents and high-resolution pages.
-   Cache eviction and avoiding duplicate renders.
-   High-DPI and multi-monitor behavior.
-   Keyboard navigation and screen-reader semantics.
-   Clear handling of missing or malformed document outlines.

**Expected result**

A user can open a PDF, read and navigate it comfortably, change zoom and
rotation, browse thumbnails and outlines, and reopen recent documents.

**Exit criteria**

-   [x] Single-page and continuous modes work.
-   [x] Zoom, fit modes, rotation, and page navigation work.
-   [x] Thumbnails and outline navigation work when document data
    exists.
-   [x] Recent documents and session state persist.
-   [x] Rendering remains responsive during navigation.
-   [x] Memory use remains bounded during long reading sessions.
-   [x] Core keyboard workflows are covered by tests.

------------------------------------------------------------------------

### Phase 4 --- Productivity Features

**Estimated duration:** 3--5 weeks

**Goal:** Add the features that help users find and organize information
in documents.

**Main tasks**

1.  Implement text extraction and document search.
2.  Add search result navigation and match highlighting.
3.  Support cancellation of long-running searches.
4.  Add user bookmarks and bookmark persistence.
5.  Define the annotation domain model.
6.  Implement the first supported annotation types.
7.  Validate annotation save and reload behavior with the selected
    engine.
8.  Use atomic or recoverable save operations.
9.  Add tests for persistence and document reopen behavior.

**Areas requiring special attention**

-   Text extraction can be slow or incomplete in scanned and malformed
    PDFs.
-   Search results must map correctly to page coordinates.
-   Search should not block rendering or navigation.
-   Annotation support and writeback vary by PDF engine and annotation
    type.
-   Saving should protect against partial writes and data loss.
-   Clearly distinguish application bookmarks from PDF outline entries.

**Expected result**

Users can search document text, navigate matches, create persistent
bookmarks, and use the annotation types that have been validated for
reliable save/reopen behavior.

**Exit criteria**

-   [x] Search works across multi-page documents.
-   [x] Search can be cancelled and does not freeze the UI.
-   [x] Search results navigate to the correct page and location.
-   [x] Bookmarks persist across application restarts.
-   [x] Supported annotations survive save and reopen.
-   [x] Save failures do not silently destroy the original document.

------------------------------------------------------------------------

### Phase 5 --- Advanced PDF Capabilities

**Estimated duration:** 4--6 weeks

**Goal:** Add advanced capabilities based on validated engine support
and product priorities.

**Potential features**

1.  Interactive PDF forms.
2.  Form field display and editing.
3.  Signature presence inspection.
4.  Cryptographic signature validation, if supported and properly
    scoped.
5.  Document operations such as merge, split, and page extraction.
6.  Optional OCR for scanned PDFs.
7.  Accessibility improvements and tagged-PDF support.
8.  Additional annotation types.

**Areas requiring special attention**

-   Do not describe a signature as trusted merely because a signature
    field exists.
-   Distinguish signature presence, cryptographic validity, certificate
    trust, and revocation status.
-   XFA forms may require separate support and may not be available in
    the chosen engine.
-   Digital signing is a separate feature from signature inspection and
    validation.
-   OCR adds runtime size, language-data distribution, performance, and
    licensing considerations.
-   Document modification must preserve data and handle failures safely.

**Expected result**

A documented feature matrix showing which advanced features are
supported, partially supported, or unavailable, with reliable behavior
for every feature included in the release.

**Exit criteria**

-   [x] Each advanced feature has an explicit support decision.
-   [x] Supported forms behave correctly in tested documents.
-   [x] Signature UI uses precise and non-misleading status language.
-   [x] Document operations have recovery and integrity tests.
-   [x] OCR is included only after runtime, language, and licensing
    decisions.
-   [x] Unsupported features fail clearly rather than appearing to work.

------------------------------------------------------------------------

### Phase 6 --- Packaging & Distribution Readiness

**Estimated duration:** 2--3 weeks

**Goal:** Make the open-source application installable, upgradeable, supportable,
and freely distributable across macOS, Windows, and Linux.

**Main tasks**

1.  Build native installers for each supported OS.
2.  Configure macOS signing and notarization.
3.  Configure Windows code signing where applicable.
4.  Build Linux packages and document distribution dependencies.
5.  Define application update and rollback behavior.
6.  Add software bill of materials (SBOM) generation.
7.  Include third-party license notices and acknowledgements.
8.  Test clean install, upgrade, downgrade policy, and uninstall.
9.  Validate application data locations and backup expectations.
10. Prepare crash diagnostics and user-facing support information.

**Areas requiring special attention**

-   Native PDF engine binaries must be included and loaded correctly.
-   Signing and notarization must be part of repeatable release
    automation.
-   Updates must not corrupt user preferences or document metadata.
-   Installer behavior differs across operating systems and package
    formats.
-   Third-party licenses and notices must match the actual shipped
    binaries.

**Expected result**

Repeatable release artifacts that install and launch correctly on every
supported operating system, with documented signing, update, and support
procedures.

**Exit criteria**

-   [x] Installers are generated for all supported platforms.
-   [x] Signing/notarization requirements are satisfied for intended
    distribution channels.
-   [x] Clean install and upgrade tests pass.
-   [x] Uninstall behavior is documented and tested.
-   [x] Third-party notices and SBOM are included.
-   [x] Release artifacts are reproducible and traceable.

------------------------------------------------------------------------

### Phase 7 --- Production Release

**Estimated duration:** 2--3 weeks

**Goal:** Complete release validation and prepare the team to maintain
version 1.0.

**Main tasks**

1.  Run full regression testing on the supported OS/architecture matrix.
2.  Test with a representative PDF corpus, including malformed and large
    files.
3.  Run performance and memory tests.
4.  Run security reviews for PDF parsing, filesystem access, IPC, and
    update flows.
5.  Complete accessibility checks for core workflows.
6.  Finalize onboarding, help, and troubleshooting content.
7.  Define crash triage and support procedures.
8.  Establish release versioning and changelog practices.
9.  Prepare a known-issues list and maintenance plan.
10. Tag and publish the v1.0 release.

**Areas requiring special attention**

-   Test real-world PDFs, not only files generated by the development
    team.
-   Verify behavior on clean machines and fresh user accounts.
-   Recheck native dependency and license notices for the exact release
    artifacts.
-   Ensure diagnostics do not collect document contents or sensitive
    file paths unnecessarily.
-   Confirm that critical workflows work without network access unless
    explicitly required.

**Expected result**

A production-ready v1.0 release with tested installers, documented
limitations, support procedures, and a clear maintenance plan.

**Exit criteria**

-   [ ] Regression suite passes on the supported platform matrix.
-   [ ] Performance and memory targets are reviewed.
-   [ ] Security and accessibility reviews are complete.
-   [ ] Release documentation and known issues are published.
-   [ ] Support and maintenance ownership is assigned.
-   [ ] v1.0 artifacts are signed, traceable, and ready to distribute.

## 4. Milestones

  -----------------------------------------------------------------------
Milestone                           Target outcome
  ----------------------------------- -----------------------------------
M0 --- Feasibility                  Engine, license, native loading,
and rendering approach validated

M1 --- Internal prototype           Desktop shell opens and renders
PDFs on target platforms

M2 --- Private beta / MVP           Core reading, navigation, recent
files, and essential workflows are
usable

M3 --- Feature beta                 Search, bookmarks, validated
annotations, and selected advanced
features are ready

M4 --- Open-Source v1.0             Installers, signing, security,
regression, and release processes
are complete
  -----------------------------------------------------------------------

## 5. MVP Scope Recommendation

### Must-have for MVP

-   Open and read PDF files.
-   Single-page and continuous reading modes.
-   Zoom, fit modes, rotation, and page navigation.
-   Thumbnails and document outline navigation.
-   Text search, if engine extraction support is validated.
-   Recent documents and session restore.
-   Password-protected PDF support.
-   User bookmarks.
-   Printing and text copying where supported.
-   Native installers for the supported operating systems.

### Conditional for MVP

-   Annotations should be included only if reliable writeback and reopen
    behavior have been validated with the selected PDF engine.

### Defer for future community releases

-   OCR.
-   Full digital signature creation and signing workflows.
-   Advanced certificate trust and revocation infrastructure.
-   XFA forms.
-   Cloud synchronization.
-   AI-powered document features.

## 6. Cross-Cutting Engineering Requirements

These requirements apply throughout every phase.

### Performance and resource management

-   Use bounded worker pools and bounded queues.
-   Cancel work that is no longer relevant.
-   Use a memory-aware render cache with explicit eviction.
-   Avoid rendering every page at maximum resolution.
-   Measure document-open latency, page-render latency, scroll
    responsiveness, and peak memory.

### Security

-   Treat PDFs as untrusted input.
-   Keep filesystem access scoped to user-selected files and required
    application data.
-   Validate all frontend-to-backend command inputs.
-   Keep Tauri capabilities minimal.
-   Avoid logging document contents or sensitive information.
-   Test malformed, encrypted, and unusually large PDFs.

### Reliability and data integrity

-   Define clear document and native-resource lifecycles.
-   Use atomic or recoverable persistence operations.
-   Handle crashes and failed saves without silently losing user data.
-   Test reopening documents after modifications.
-   Make unsupported PDF features explicit.

### Quality and automation

-   Run formatting, linting, unit tests, and integration tests in CI.
-   Maintain a representative PDF test corpus with appropriate
    licensing.
-   Test all supported operating systems and architectures.
-   Add regression tests for every fixed defect.
-   Document architectural decisions and changes to feature support.

## 7. Indicative Overall Timeline

Phase                                          Estimate
  ------------------------------------ ------------------
Phase 0 --- Technical foundation             1--2 weeks
Phase 1 --- Desktop foundation                  2 weeks
Phase 2 --- PDF engine integration           2--3 weeks
Phase 3 --- Core reader MVP                  3--4 weeks
Phase 4 --- Productivity features            3--5 weeks
Phase 5 --- Advanced capabilities            4--6 weeks
Phase 6 --- Packaging readiness              2--3 weeks
Phase 7 --- Production release               2--3 weeks
**Indicative total**                   **19--28 weeks**

The total is a planning estimate. Actual duration depends on team size,
PDF engine capability, annotation/form requirements, platform packaging
complexity, and the amount of release hardening required.

## 8. Immediate Next Steps

1.  Execute Phase 7 Production Release validation (full regression suite, malformed/large PDF corpus verification, accessibility review, and v1.0 changelog/release notes).
2.  Maintain zero-regression coverage across `app-domain`, `app-application`, `storage`, `pdfium-adapter`, and React UI.

## 9. Weekly Roadmap Review Template

Use this checklist during the weekly project review.

### Phase status

  -----------------------------------------------------------------------
Phase                   Status                  Evidence / notes
  ----------------------- ----------------------- -----------------------
0 --- Technical         Complete                ADR-0001..0004 recorded in
foundation                                      `.docs/decisions.md`

1 --- Desktop           Complete                8-crate Rust workspace +
foundation                                      Tauri 2 + React/TS strict

2 --- PDF engine        Complete                `pdf-engine` traits +
integration                                     `pdfium-adapter` + tests

3 --- Core reader MVP   Complete                Full reader UI, Figma SVG
                                                icon system, Library,
                                                Favorites, Archive, Print

4 --- Productivity      Complete                Multi-page search, SQLite
features                                        bookmarks & annotations
                                                (`0001`–`0003` migrations)

5 --- Advanced          Complete                Form/signature inspection,
capabilities                                    atomic annotation export,
                                                all 25 Figma frames

6 --- Packaging &       Complete                CI/Release workflows,
distribution readiness                          `THIRD_PARTY_NOTICES.md`,
                                                `sbom.cdx.json`, upgrade &
                                                uninstall tests

7 --- Production        Not started             Open-source v1.0 release
release                                         (Planned next)
  -----------------------------------------------------------------------

### Review questions

-   What was completed since the previous review?
-   What evidence demonstrates completion?
-   Which exit criteria remain unmet?
-   What is blocked, and what decision or dependency is needed?
-   Are there new risks involving engine capability, licensing, native
    binaries, performance, memory, security, or packaging?
-   What are the three most important priorities for the next week?
-   Who owns each next action, and what dependencies exist?

> Do not mark a phase complete based only on elapsed time. Mark it
> complete when its exit criteria are met and supported by evidence.
