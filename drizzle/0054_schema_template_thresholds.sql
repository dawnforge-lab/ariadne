-- Phase 29a (T8): two thresholds became overridable, SCHEMA_TEMPLATE_SHARE and
-- SCHEMA_TEMPLATE_MIN_PAGES. A rules run's stamp must name every threshold
-- (Phase 27a Ruling 15; `readStamp` refuses a stamp missing one), so every
-- stamp written before this holds 20 and is rewritten to hold 22. The two
-- values are the defaults those runs would have used had the thresholds
-- existed, written out here as the historical fact they are, not read from code
-- a later ruleset may change. Idempotent: the stored thresholds are overlaid
-- onto the two defaults, so a stamp that already holds them comes back
-- unchanged. A null stamp stays null; a stamp with no thresholds object is
-- malformed and is left as it is, for readStamp to refuse loudly (hard rule 7).
UPDATE crawls SET rules_judged_with_jsonb = jsonb_set(rules_judged_with_jsonb, '{thresholds}',
  '{"SCHEMA_TEMPLATE_SHARE": 70, "SCHEMA_TEMPLATE_MIN_PAGES": 10}'::jsonb
  || (rules_judged_with_jsonb -> 'thresholds'))
WHERE rules_judged_with_jsonb IS NOT NULL
  AND jsonb_typeof(rules_judged_with_jsonb -> 'thresholds') = 'object';
