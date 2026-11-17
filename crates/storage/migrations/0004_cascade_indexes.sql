-- Readora append-only migration 0004: cascade cleanup triggers and document lookup indexes
CREATE INDEX IF NOT EXISTS idx_annotations_doc
    ON annotations (document_id);

CREATE INDEX IF NOT EXISTS idx_bookmarks_doc
    ON bookmarks (document_id);

CREATE TRIGGER IF NOT EXISTS trg_recent_documents_cascade_delete
AFTER DELETE ON recent_documents
BEGIN
    DELETE FROM bookmarks WHERE document_id = OLD.document_id;
    DELETE FROM annotations WHERE document_id = OLD.document_id;
END;
