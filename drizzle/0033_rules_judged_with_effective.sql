-- Phase 27a (final review, Ruling 15): a rules run's stamp holds the EFFECTIVE
-- thresholds it used, all 20, not only the overrides. A stamp written before
-- this (by runRules, or backfilled by 0032) holds the overrides alone, so its
-- effective values are the defaults in force when it was written overlaid with
-- those overrides. Those defaults are 0.22.0's and 0.23.0's (identical), and
-- are written out here as the historical fact they are, not read from code a
-- later ruleset may change. Idempotent: a stamp that already holds all 20 is
-- overlaid onto the defaults and comes back unchanged. A null stamp stays null;
-- a stamp with no thresholds object is malformed and is left as it is, for
-- readStamp to refuse loudly (hard rule 7).
UPDATE crawls
SET rules_judged_with_jsonb = jsonb_set(
  rules_judged_with_jsonb,
  '{thresholds}',
  '{"TITLE_MIN": 30, "TITLE_MAX": 60, "META_MIN": 70, "META_MAX": 155,
    "H1_MAX": 70, "H2_MAX": 70, "URL_MAX": 115, "SLOW_MS": 1500,
    "TITLE_PX_MIN": 200, "TITLE_PX_MAX": 561, "META_PX_MIN": 400, "META_PX_MAX": 985,
    "DEEP_DEPTH": 5, "THIN_WORDS": 150, "SOFT_404_WORDS": 300,
    "IMAGE_WEIGHT_WARN": 100000, "CHAIN_HOPS": 2,
    "HIGH_INTERNAL_OUTLINKS": 1000, "HIGH_EXTERNAL_OUTLINKS": 10,
    "UNAVAILABLE_AFTER_WARN_DAYS": 30}'::jsonb
    || (rules_judged_with_jsonb -> 'thresholds')
)
WHERE rules_judged_with_jsonb IS NOT NULL
  AND jsonb_typeof(rules_judged_with_jsonb -> 'thresholds') = 'object';
