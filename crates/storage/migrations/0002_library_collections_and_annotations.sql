-- Readora append-only migration 0002: library collections (Favorites & Archive)
ALTER TABLE recent_documents ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recent_documents ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
