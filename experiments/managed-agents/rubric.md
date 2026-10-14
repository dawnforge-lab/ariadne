# Ariadne audit rubric (starter: tune after the first runs)

The grader scores each criterion independently. `{site}`, `{host}` and
`{action_plan}` are filled in per run by `src/run.ts`.

## The crawl
1. A crawl of {site} finished, and `crawl_status` reports it judged: `rulesRunAt` is set. The findings file names that crawl's `crawlId`.
2. The crawl's final status, page counts and any blocked pages (`blockedPages`, `hostSpacingMs`) are recorded in the findings file as the engine reported them. A crawl that ended `failed` or `cancelled` is reported as such, not audited as if complete.

## ariadne-findings.json
3. `/mnt/session/outputs/ariadne-findings.json` exists and is valid JSON in the shape the ariadne-audit skill specifies.
4. Every check id in `skills/ariadne-audit/checklist.md` appears exactly once with a status. None is missing and none is invented.
5. Every check the checklist's **Engine** line assigns to a rule or metric is answered by quoting that rule's or metric's output (rule ids, counts and URLs as returned), not by an estimate or by inspecting pages.
6. Every SKIP names what was unavailable. The analytics checks are SKIP because no GSC, GA4 or Ahrefs connector was attached in this run, and the browser checks are SKIP because no browser was available.
7. An empty engine answer is never reported as a clean result unless `crawl_status` shows the crawl was judged (the skill's empty-is-not-clean rule).

## The report
8. A markdown report for {host} exists in `/mnt/session/outputs/`, built from the findings file. Every number it quotes matches the engine's output in the findings file.
9. The report prioritises the findings, giving each a severity argued from this site's context, and names every check that was not audited and why.

## The action plan
10. Excel action plan: {action_plan}. When required, `{host}-action-plan.xlsx` (or the client-named equivalent the skill specifies) exists beside the findings file, with one tab per issue worth fixing and full URL lists from `issue_urls`.
