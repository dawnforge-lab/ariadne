-- Phase 28c Task 3, fix round 1: `ariadne_job_event()` reads its crawl's schedule under a lock.
--
-- 0048 read `crawls.schedule_id` with a plain subquery. A job written while `deleteSchedule`
-- (src/schedule/store.ts) held the schedule's row deleted but uncommitted read the OLD id — the
-- crawl lock that delete takes does not stop a job write, whose foreign key to `crawls` is only a
-- key-share — then its event insert waited on the schedule row's key-share for its own foreign
-- key, and when the delete committed the check failed: `crawl_events_schedule_id_schedules_id_fk`,
-- the job write rolled back, the job left `running` (Review Focus 4).
--
-- Now the schedule row is read `FOR KEY SHARE`, the lock the event's foreign key takes anyway.
-- Under READ COMMITTED a delete in flight makes the read wait, and once it commits the row is gone
-- and the read answers no row: the event is written with `schedule_id` null, exactly what the
-- delete's ON DELETE SET NULL would have made of it. A schedule that stays is locked here as the
-- foreign key would lock it.
--
-- The crawl trigger, `ariadne_crawl_event()`, is unchanged: it writes `NEW.schedule_id`, and a
-- crawl's status write holds the crawl row, which `deleteSchedule` locks before the schedule, so
-- the two are serialised — the write either commits first (its event then has the id, nulled by
-- the delete's SET NULL) or runs after, on the row the delete left with `schedule_id` null.
--
-- Everything else is 0046's and 0048's, unchanged: the kind literals (pinned by
-- test/events/crawl-events.test.ts), the details, and the RAISEs.
CREATE OR REPLACE FUNCTION ariadne_job_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_detail jsonb := '{}'::jsonb;
  v_schedule_id text;
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
  -- The job's crawl names the schedule; the schedule row is locked as the event's foreign key would
  -- lock it, so a delete in flight is waited for and then reads as no schedule.
  SELECT s.id INTO v_schedule_id
    FROM crawls c JOIN schedules s ON s.id = c.schedule_id
   WHERE c.id = NEW.crawl_id
     FOR KEY SHARE OF s;
  INSERT INTO crawl_events (tenant_id, crawl_id, schedule_id, kind, detail)
    VALUES (NEW.tenant_id, NEW.crawl_id, v_schedule_id, v_kind, v_detail);
  RETURN NULL;
END;
$$;
