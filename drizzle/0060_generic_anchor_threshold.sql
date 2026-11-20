-- Phase 29c (T4): one threshold became overridable, GENERIC_ANCHOR_MIN_INLINKS. A
-- rules run's stamp must name every threshold (Phase 27a Ruling 15; `readStamp`
-- refuses a stamp missing one), so every stamp written before this holds 23 and
-- is rewritten to hold 24. The value is the default those runs would have used
-- had the threshold existed, written out here as the historical fact it is, not
-- read from code a later ruleset may change. Idempotent: the stored thresholds
-- are overlaid onto the default, so a stamp that already holds it comes back
-- unchanged. A null stamp stays null; a stamp with no thresholds object is
-- malformed and is left as it is, for readStamp to refuse loudly (hard rule 7).
UPDATE crawls SET rules_judged_with_jsonb = jsonb_set(rules_judged_with_jsonb, '{thresholds}',
  '{"GENERIC_ANCHOR_MIN_INLINKS": 3}'::jsonb
  || (rules_judged_with_jsonb -> 'thresholds'))
WHERE rules_judged_with_jsonb IS NOT NULL
  AND jsonb_typeof(rules_judged_with_jsonb -> 'thresholds') = 'object';
