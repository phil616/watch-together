-- Older releases permanently closed a room when its host was offline for the
-- reconnect grace period and no member was available for takeover. Because
-- those releases did not record whether CLOSED was automatic or explicit,
-- restore legacy closed rooms once during upgrade. Future explicit closes are
-- unaffected because this migration is only applied once.
UPDATE rooms
SET status = 'HOST_DISCONNECTED',
    closed_at_ms = NULL,
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE status = 'CLOSED';
