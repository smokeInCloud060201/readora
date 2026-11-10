# Architecture Decision Records

## ADR-001: Tauri 2 + Rust core

**Status:** Proposed

**Decision:** Use Tauri 2 as desktop shell, Rust for application logic, React + TypeScript for UI.

**Reasoning:** Cross-platform desktop packaging, native OS integration, Rust backend, and a frontend technology with a mature component ecosystem. The UI communicates through a narrow typed IPC boundary.

**Consequences:** Must manage Tauri capabilities carefully and test the system webview differences across OSes. Keep UI-independent logic in Rust crates.

## ADR-002: Modular monolith

**Status:** Proposed

**Decision:** Start with a modular monolith using ports/adapters, not microservices.

**Reasoning:** Local desktop workloads do not justify distributed deployment. Internal module boundaries still permit engine and storage replacement.

**Consequences:** Enforce crate dependency direction and avoid a large all-purpose application crate.

## ADR-003: PDFium adapter

**Status:** Candidate; not approved for production until validated

**Decision:** Prototype PDFium behind an engine-neutral `pdf-engine` interface.

**Reasoning:** PDFium is widely used and supports high-quality rendering and a broad set of PDF operations.

**Consequences:** Must verify binding coverage, license compatibility, platform binaries, security update cadence, and required advanced features. The adapter must remain replaceable.
