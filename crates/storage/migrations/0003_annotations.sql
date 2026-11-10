-- Readora append-only migration 0003: persistent Phase 4 annotations (Highlight, Underline, Comment)
CREATE TABLE IF NOT EXISTS annotations (
    id                 TEXT PRIMARY KEY,
    document_id        TEXT NOT NULL,
    page_index         INTEGER NOT NULL CHECK (page_index >= 0),
    kind               TEXT NOT NULL CHECK (kind IN ('highlight', 'underline', 'comment')),
    color_hex          TEXT NOT NULL,
    quote_text         TEXT NOT NULL,
    note_text          TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_document
    ON annotations (document_id, page_index ASC, created_at_unix_ms ASC);
