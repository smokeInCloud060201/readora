ALTER TABLE recent_documents ADD COLUMN fit_mode TEXT;
ALTER TABLE recent_documents ADD COLUMN layout_mode TEXT;

CREATE INDEX IF NOT EXISTS idx_recent_documents_favorite
    ON recent_documents(is_favorite, last_opened_unix_ms DESC)
    WHERE is_favorite = 1;

CREATE INDEX IF NOT EXISTS idx_recent_documents_archived
    ON recent_documents(is_archived, last_opened_unix_ms DESC)
    WHERE is_archived = 1;
