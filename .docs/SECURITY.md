# Security and Privacy Baseline

## Threat model

Assume PDFs may be malformed, malicious, encrypted, very large, or crafted to exploit native parsing code. The renderer and all file metadata are untrusted.

## Required controls

- Keep the PDF engine isolated behind a narrow adapter.
- Keep native dependencies patched; track PDFium upstream releases and advisories.
- Fuzz document open, page parsing, text extraction, and annotation boundaries with a safe corpus.
- Apply resource limits: maximum render dimensions, bounded worker count, bounded cache, cancellation, and sensible file-size warnings.
- Avoid writing temporary files unless required; use private app cache directories and clean them up.
- Never auto-run JavaScript/actions, embedded files, launch links, or external protocols from a PDF.
- Confirm before exporting over an existing file.
- Treat document metadata and filenames as untrusted display text.
- Do not include document contents, passwords, or full local paths in telemetry or logs.
- Keep Tauri permissions/capabilities minimal and per-window.
- Validate all IPC input and reject unknown enum values / invalid page indexes.
- Use OS credential storage if a future feature must retain secrets; do not store passwords in SQLite.
- Provide a privacy notice and opt-in diagnostics before any telemetry is introduced.

## Security review gates

Before beta:
- PDF engine and binding license review.
- Native library provenance, checksums, and vulnerability update process.
- Tauri capability audit.
- Fuzzing and malformed-file regression corpus.
- Export path traversal and overwrite tests.
- Dependency audit and SBOM.
