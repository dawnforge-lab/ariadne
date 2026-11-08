-- Phase 27a: 0031 added crawls.rules_judged_with_jsonb, which runRules writes
-- beside rules_run_at. A crawl judged before it existed was judged with no
-- overrides and no threshold changes, under the cap its config carried (an
-- absent key is the engine default), so stamp exactly that. Unjudged crawls
-- stay null, in lockstep with rules_run_at.
UPDATE crawls
SET rules_judged_with_jsonb =
  jsonb_build_object('disabledRules', '[]'::jsonb, 'thresholds', '{}'::jsonb)
  || CASE WHEN config_jsonb ? 'findingCap'
          THEN jsonb_build_object('findingCap', config_jsonb->'findingCap')
          ELSE '{}'::jsonb END
WHERE rules_run_at IS NOT NULL AND rules_judged_with_jsonb IS NULL;
