# Agent Operating Rules

These rules apply to coding agents and human contributors.

## 1. Mission and boundaries

- Treat this as a local-first desktop product for macOS, Windows, and Linux.
- Rust owns domain rules, file operations, PDF-engine access, persistence, and expensive work.
- The UI is a presentation layer. It must not reimplement document rules or access arbitrary filesystem paths directly.
- Keep the PDF engine behind `pdf-engine` traits. UI and application services must not depend on PDFium types.
- Do not introduce network services, telemetry, account systems, cloud sync, or AI features unless explicitly requested.

## 2. Before changing code

1. Read the relevant architecture and module documents.
2. Inspect the existing implementation and tests; do not assume the scaffold describes completed code.
3. State the intended change, affected modules, risks, and test plan in the PR/task summary.
4. Prefer the smallest coherent change. Do not perform unrelated refactors.

## 3. Architecture rules

- Enforce dependency direction: `domain` ← `application` ← `infrastructure` / `platform` / Tauri composition root.
- Domain must not depend on Tauri, React, SQLite, PDFium, OS APIs, or network clients.
- Application services depend on domain types and ports (traits), never concrete infrastructure.
- Adapters implement ports. Wire implementations at the composition root.
- No direct PDFium calls outside `pdfium-adapter`.
- No direct SQL outside `storage`.
- No `std::fs` / OS file-dialog access from domain or UI. Route file operations through application ports.
- Avoid circular crate dependencies and “god” modules.

## 4. Rust quality rules

- Use stable Rust, edition 2024 unless the project pins a different edition for compatibility.
- Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`, and relevant tests.
- Prefer explicit error enums with `thiserror`; add context at application boundaries.
- Do not use `.unwrap()` / `.expect()` in production paths. Tests may use them when failure is intentional and clear.
- Avoid `unsafe`. If unavoidable, isolate it, document the safety invariant, and add focused tests.
- Avoid `panic!`, `todo!`, and `unimplemented!` in shipped paths.
- Do not silently discard errors (`let _ = ...`) unless the loss is deliberate and documented.
- Use `Result` for recoverable failures; reserve panics for violated programmer invariants.
- Use `Arc` for shared immutable state; use locks only around short critical sections.
- Do not hold a mutex/RwLock across `.await`, PDF rendering, disk I/O, or callbacks.
- Do not create unbounded task queues or unbounded caches.
- Avoid cloning large PDF buffers. Prefer owned handles, `Bytes`, slices, and bounded channels where appropriate.
- Document public APIs and non-obvious invariants.

## 5. Performance rules

- Measure before optimizing. Add benchmarks for rendering, page navigation, search, and large-document workloads.
- Never render every page eagerly. Render visible pages plus a small configurable prefetch window.
- Cache rendered pages by document identity + page index + scale/rotation/color mode; use an LRU/byte budget.
- Cancel obsolete render jobs when the user changes page, zoom, or closes a document.
- Move CPU-heavy PDF work off the UI thread. Bound concurrency and avoid oversubscribing cores.
- Decode/render at target device scale; avoid repeatedly converting large bitmaps.
- Instrument latency and memory in debug/benchmark builds without collecting document contents.

## 6. Security and privacy

- Treat every PDF as untrusted input.
- Validate paths and file sizes; handle malformed, encrypted, and oversized documents safely.
- Do not execute PDF JavaScript, launch embedded files, or auto-open attachments.
- Never log document text, passwords, full paths, or file contents.
- Passwords must not be persisted in plaintext or emitted in events/logs.
- Keep Tauri capabilities allowlisted and minimal. Do not expose unrestricted shell, filesystem, or HTTP access.
- Sanitize filenames used for exports. Use atomic writes for save/export operations.
- Add dependency and license review before adding crates or native binaries.

## 7. Frontend rules

- TypeScript strict mode. No `any` unless justified with a narrow boundary and comment.
- UI calls typed Tauri commands through one API client module; do not scatter `invoke()` calls across components.
- Keep view state separate from durable settings and document metadata.
- Use stable IDs, accessible controls, keyboard navigation, and clear loading/error/empty states.
- Do not put PDF rendering or large binary payloads in React state. Prefer asset/protocol URLs or bounded transfer mechanisms.
- Avoid giant components. Separate toolbar, page viewport, thumbnail rail, outline, search, and properties panels.

### Product UI design source

- The approved UI design source is the [Readora Figma file](https://www.figma.com/design/kwbNKB62nq2S9uMZlPBCIE/readora?node-id=0-1&p=f&m=dev). The user has enabled Dev Mode.
- Before implementing or materially changing a screen, use the connected Figma integration to inspect the relevant page, frame, components, variables, and assets. Follow the actual frames and design system rather than inventing a new visual direction.
- If Figma is not connected or a referenced frame cannot be read, state that limitation and ask for the integration or frame access needed; do not claim to have inspected the design.
- Treat Figma as the visual and interaction reference. Keep document rules and state transitions in Rust/application services, and implement the presentation in React/TypeScript within the frontend rules above.
- When the design and product/security requirements conflict, preserve the architecture and security requirements and call out the specific conflict in the implementation summary.

## 8. Change hygiene

- Add or update unit tests for domain/application behavior.
- Add adapter contract tests for storage and PDF-engine behavior.
- Add integration tests for user-visible workflows where practical.
- Update docs when module boundaries, commands, persistence schema, packaging, or security posture changes.
- Database migrations are append-only; never edit a migration already shipped.
- Do not commit generated binaries, signing keys, certificates, secrets, local PDFs, or user data.
- Keep commits focused and use conventional commit messages.

## 9. Definition of done

A change is done only when:
- Acceptance criteria are met.
- Formatting, linting, and relevant tests pass.
- Error and cancellation paths are handled.
- Cross-platform assumptions are reviewed.
- Security/privacy implications are considered.
- Docs and release notes are updated when needed.
