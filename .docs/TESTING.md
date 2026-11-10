# Testing Strategy

## Test pyramid

- Domain unit tests: invariants, IDs, page ranges, bookmark rules, settings validation.
- Application tests: use cases with fake ports; verify orchestration, cancellation, and error mapping.
- Adapter contract tests: same behavioral suite for PDF engine and storage implementations.
- Integration tests: open/render/search/close workflows against a curated PDF fixture corpus.
- UI tests: keyboard flows, dialogs, loading/error states, viewport controls.
- Platform smoke tests: install, launch, open file via picker/drop, print, upgrade, uninstall.

## PDF fixture corpus

Maintain licensed fixtures for:
- small text-only document
- image-heavy/scanned document
- mixed vector/raster document
- large page count
- unusual page sizes and rotations
- encrypted/password-protected
- malformed/truncated
- forms, annotations, outlines, embedded attachments
- Unicode filenames and metadata

Do not commit confidential or user-provided documents. Record fixture provenance and license.

## Performance benchmarks

Measure:
- cold start and first page
- page render at common zoom levels
- scroll throughput / dropped frames
- text search latency
- memory after navigating a large document
- cache hit rate and eviction behavior
- cancellation latency after rapid zoom/page changes

Record machine specs, OS version, engine version, and fixture hash with benchmark results.
