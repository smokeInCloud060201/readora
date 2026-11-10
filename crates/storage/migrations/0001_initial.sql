-- 0001_initial.sql
-- Append-only initial schema for Readora metadata storage.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at_unix_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_documents (
    document_id TEXT PRIMARY KEY NOT NULL,
    file_path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    last_page INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 1,
    zoom_pct INTEGER NOT NULL DEFAULT 100,
    rotation_deg INTEGER NOT NULL DEFAULT 0,
    last_opened_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_documents_last_opened
    ON recent_documents (last_opened_unix_ms DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    label TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    UNIQUE(document_id, page_index)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_document_page
    ON bookmarks (document_id, page_index ASC);

CREATE TABLE IF NOT EXISTS app_settings (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    settings_json TEXT NOT NULL
);
