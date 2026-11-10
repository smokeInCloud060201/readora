# Coding Conventions

## Rust

### Naming
- `snake_case` for modules, functions, variables, and files.
- `UpperCamelCase` for types and traits.
- `SCREAMING_SNAKE_CASE` for constants and statics.
- Use domain language: `DocumentId`, `PageIndex`, `RenderRequest`, not generic `Data` or `Manager`.

### Module layout
Prefer small modules grouped by capability:

```text
src/
├── lib.rs
├── error.rs
├── model/
│   ├── mod.rs
│   ├── document.rs
│   └── bookmark.rs
├── ports/
│   ├── mod.rs
│   └── pdf_engine.rs
└── use_cases/
    ├── mod.rs
    └── open_document.rs
```

- Keep `lib.rs` as a curated public API; avoid wildcard re-exports.
- Keep files focused. Split a module when it has multiple reasons to change.
- Prefer private-by-default visibility; use `pub(crate)` before `pub` when possible.

### Types and errors
- Newtypes for IDs, page indexes, and validated values.
- `thiserror` for library/domain errors.
- Add context at boundaries; preserve source errors.
- Avoid stringly typed status values and error codes.
- Avoid `anyhow` in domain/public library APIs; it is acceptable at executable boundaries.

### Async and concurrency
- Async for I/O and orchestration; CPU-bound rendering belongs on a bounded blocking/worker pool.
- Do not mark a function async if it performs no async work.
- Never block the UI thread.
- Avoid holding locks across `.await`.
- Define cancellation behavior for long-running operations.

### Comments and docs
- Explain why, invariants, safety, and trade-offs; do not narrate obvious code.
- Public items need rustdoc with examples when useful.
- Every `unsafe` block must have a `// SAFETY:` explanation immediately above it.

## TypeScript / React

- Strict TypeScript; use `unknown` at untrusted boundaries and validate it.
- Components use `PascalCase`; hooks use `useX`; functions/variables use `camelCase`.
- Keep Tauri commands in `src/lib/tauri/`; expose typed functions to feature modules.
- Use feature-first folders rather than one global components dump.
- Avoid business logic in components; use hooks/services/view models.
- Keep components small and accessible; semantic HTML and keyboard behavior are mandatory.
- Use a single source of truth for document/session state.

Suggested UI layout:

```text
ui/src/
├── app/
├── features/
│   ├── reader/
│   ├── navigation/
│   ├── search/
│   ├── bookmarks/
│   ├── annotations/
│   └── settings/
├── shared/
│   ├── components/
│   ├── hooks/
│   └── styles/
├── lib/
│   └── tauri/
└── types/
```

## API and serialization

- Use explicit request/response DTOs at the Tauri boundary.
- Keep internal domain types separate from serialized IPC DTOs where their needs differ.
- Version persisted schemas and long-lived event contracts.
- Never serialize engine handles or native pointers.
- Use opaque IDs for open documents and rendered page resources.

## Git and review

Use Conventional Commits:
- `feat(reader): add continuous page mode`
- `fix(render): cancel stale page requests`
- `perf(cache): cap bitmap cache by bytes`
- `refactor(storage): isolate recent-file repository`
- `test(pdf): cover encrypted document open`

PR checklist:
- [ ] Scope is focused and acceptance criteria are clear.
- [ ] Architecture boundaries are preserved.
- [ ] Tests cover success, failure, and cancellation paths.
- [ ] Formatting and lint pass.
- [ ] No secrets, PDFs, generated binaries, or personal data committed.
- [ ] Docs/migrations/release notes updated as applicable.
