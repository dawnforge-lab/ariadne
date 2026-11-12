-- Phase 28c Task 3 (Ruling P3): the two event triggers of 0046 re-created so every lifecycle event
-- carries the schedule behind it. `ariadne_crawl_event()` copies the crawl's own `schedule_id`;
-- `ariadne_job_event()` reads it from the job's crawl. A crawl no schedule fired has null, as every
-- event had under 0046. Everything else is 0046's, unchanged: the kinds (still `v_kind := '<kind>'`
-- literals, which test/events/crawl-events.test.ts reads back from pg_proc and pins to
-- `EVENT_KINDS`), each kind's detail, the reaper's `ariadne.event_source` flag, and the RAISE on a
-- status or a job kind this engine never writes. 0046's comments are the reference for the mapping.
--
-- The triggers themselves are 0046's: CREATE OR REPLACE swaps the function bodies in place.
CREATE OR REPLACE FUNCTION ariadne_crawl_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_detail jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status AND NEW.status NOT IN ('queued', 'running') THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'queued' THEN
    IF TG_OP = 'INSERT' THEN
      v_kind := 'queued';
    ELSE
      v_kind := 'resumed';
      v_detail := jsonb_build_object(
        'auto', coalesce(current_setting('ariadne.event_source', true), '') = 'reaper');
    END IF;
  ELSIF NEW.status = 'running' THEN
    v_kind := 'started';
  ELSIF NEW.status = 'paused' THEN
    IF NEW.pause_reason = 'worker_lost' THEN
      v_kind := 'worker_lost';
    ELSE
      v_kind := 'paused';
      v_detail := jsonb_build_object('reason', NEW.pause_reason);
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    v_kind := 'cancelled';
  ELSIF NEW.status = 'finished' THEN
    v_kind := 'finished';
    v_detail := jsonb_build_object('pagesCrawled', NEW.pages_crawled);
  ELSIF NEW.status = 'failed' THEN
    v_kind := 'failed';
    v_detail := jsonb_build_object('reason', NEW.failure_reason);
  ELSE
    RAISE EXCEPTION 'ariadne_crawl_event: crawl % was written with status %, which this engine never writes',
      NEW.id, NEW.status;
  END IF;
  INSERT INTO crawl_events (tenant_id, crawl_id, schedule_id, kind, detail)
    VALUES (NEW.tenant_id, NEW.id, NEW.schedule_id, v_kind, v_detail);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ariadne_job_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_detail jsonb := '{}'::jsonb;
BEGIN
  IF NEW.status NOT IN ('queued', 'running', 'done', 'failed', 'abandoned') THEN
    RAISE EXCEPTION 'ariadne_job_event: job % was written with status %, which this engine never writes',
      NEW.id, NEW.status;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NULL;
  END IF;
  IF NEW.kind = 'crawl' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'queued' AND NEW.status = 'running' THEN
      v_kind := 'claimed';
      v_detail := jsonb_build_object(
        'instanceId', NEW.claimed_by,
        'role', (SELECT i.role FROM instances i WHERE i.id = NEW.claimed_by));
    ELSE
      RETURN NULL;
    END IF;
  ELSIF NEW.kind = 'render' THEN
    IF NEW.status = 'queued' THEN
      v_kind := 'render_queued';
    ELSIF NEW.status = 'running' THEN
      v_kind := 'render_started';
    ELSE
      v_kind := 'render_finished';
      v_detail := jsonb_build_object('outcome', NEW.status);
    END IF;
  ELSIF NEW.kind = 'rules' THEN
    IF NEW.status = 'queued' THEN
      v_kind := 'rules_queued';
    ELSIF NEW.status = 'running' THEN
      v_kind := 'rules_started';
    ELSE
      v_kind := 'rules_finished';
      v_detail := jsonb_build_object('outcome', NEW.status);
    END IF;
  ELSE
    RAISE EXCEPTION 'ariadne_job_event: job % has kind %, which this engine never writes', NEW.id, NEW.kind;
  END IF;
  -- The job's crawl names the schedule: `jobs.crawl_id` references `crawls`, so the row is there.
  INSERT INTO crawl_events (tenant_id, crawl_id, schedule_id, kind, detail)
    VALUES (NEW.tenant_id, NEW.crawl_id, (SELECT c.schedule_id FROM crawls c WHERE c.id = NEW.crawl_id),
      v_kind, v_detail);
  RETURN NULL;
END;
$$;
