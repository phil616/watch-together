-- Runtime migrations are embedded from internal/database/migrations. This
-- mirrored copy is kept for operators who inspect or apply SQL manually.
UPDATE rooms
SET status = 'HOST_DISCONNECTED',
    closed_at_ms = NULL,
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE status = 'CLOSED';
