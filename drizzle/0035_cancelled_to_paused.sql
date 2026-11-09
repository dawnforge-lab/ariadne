-- Phase 27b: `cancelled` now means "stopped on request, final". Before 27b the
-- only path that wrote `cancelled` was a shutdown abort, which is resumable —
-- that is `paused` with reason `shutdown`. Relabel every stored row.
update "crawls" set "status" = 'paused', "pause_reason" = 'shutdown' where "status" = 'cancelled';
