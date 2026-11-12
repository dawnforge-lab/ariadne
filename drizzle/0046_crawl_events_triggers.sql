-- Phase 28c Task 1 (call C1): the lifecycle events of `crawl_events` are written by these two
-- triggers, not by the application. A crawl's status has about ten writers (the loop's claim and
-- closes, crawl_pause / crawl_cancel / crawl_mark_failed / crawl_resume, the reaper's pause and
-- requeue, the runner's pre-start pauses); an event missed at one of them would be invisible, and a
-- trigger misses none. The application writes only the schedule kinds (`recordEvent`,
-- src/events/events.ts).
--
-- THE KIND LIST IS DUPLICATED HERE: every kind these functions write is a `v_kind := '<kind>'`
-- literal, and test/events/crawl-events.test.ts reads the functions' source from pg_proc and pins
-- those literals to `EVENT_KINDS` minus `APP_EVENT_KINDS`. Each kind's detail keys are
-- `EVENT_DETAIL_KEYS[kind]`, built only from the named columns below: never a credential, never a
-- key a client sent.
--
-- `schedule_id` is null here: `schedules` and `crawls.schedule_id` arrive in Task 3, whose
-- migration re-creates both functions to fill it.
--
-- A status or a job kind this engine never writes is RAISED, not skipped: an unrecorded transition
-- is the invisible event this table exists to prevent.
--
-- ON CRAWLS, after an insert or an update of `status`, one event per row written. A write that
-- leaves the status as it was is no event, except `queued` and `running`: `crawl_resume` adopting a
-- queued crawl's orphaned job re-queues it, and a resume re-claiming a `running` row a dead process
-- left starts it again — each a real resume or start.
--  - insert `queued` (crawl_start) -> queued
--  - update to `queued` (crawl_resume, the reaper's requeue) -> resumed {auto}; `auto` is true
--    exactly when the reaper's requeue transaction wrote it: that transaction sets
--    `ariadne.event_source` to 'reaper' (transaction-local) first (src/worker/reaper.ts). A
--    shutdown requeue is auto too, though it does not raise `auto_resume_count` (Ruling R17).
--  - `running` (the loop's claim, or a direct insert) -> started
--  - `paused` with pause_reason `worker_lost` (the reaper) -> worker_lost, and no `paused` beside it;
--    any other pause -> paused {reason: pause_reason}
--  - `cancelled` -> cancelled; `finished` -> finished {pagesCrawled}; `failed` -> failed {reason:
--    failure_reason}
CREATE FUNCTION ariadne_crawl_event() RETURNS trigger LANGUAGE plpgsql AS $$
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
    VALUES (NEW.tenant_id, NEW.id, NULL, v_kind, v_detail);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- ON JOBS, after an insert or an update of `status` that changes it.
--  - a `crawl` job: only its claim (`queued` -> `running`) -> claimed {instanceId: claimed_by, role:
--    the claimer's `instances.role`}. Everything else a crawl job does is already its crawl's own
--    event. `role` is null when `claimed_by` names no `instances` row — an id no process
--    registered, which only the test suite's bare pins are; every runner registers at boot.
--  - a `render` or `rules` job: `queued` -> *_queued; `running` (claimed, or inserted running by a
--    synchronous call) -> *_started; `done | failed | abandoned` -> *_finished {outcome: status}.
CREATE FUNCTION ariadne_job_event() RETURNS trigger LANGUAGE plpgsql AS $$
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
  INSERT INTO crawl_events (tenant_id, crawl_id, schedule_id, kind, detail)
    VALUES (NEW.tenant_id, NEW.crawl_id, NULL, v_kind, v_detail);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER crawls_lifecycle_event AFTER INSERT OR UPDATE OF status ON crawls
  FOR EACH ROW EXECUTE FUNCTION ariadne_crawl_event();
--> statement-breakpoint
CREATE TRIGGER jobs_lifecycle_event AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION ariadne_job_event();
