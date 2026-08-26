# Phase 2 gate — the fixture site, judged end to end, with CI enforcing it

**Date:** 2026-08-26
**Code:** branch `worktree-phase-2-page-rules` at `0561701` (the last rule and
fixture commit), plus the commit that adds this file, the coverage pin and the
CI workflow. Everything below was measured on exactly that tree — the added
files are a test, a workflow and this page, so they change no behaviour the
figures describe.
**Verdict:** PASSED. The 53-page fixture site is crawled by the real crawler and
judged by the real rule runner in one pass; **every one of the 28 registered
rules fires on at least one fixture**, every authored fixture fires exactly the
rules it declares and nothing else, and the control page fires nothing at all.
The full suite is **437 tests across 28 files, green**, with `tsc --noEmit`
clean, and `.github/workflows/ci.yml` now runs that suite against a real
Postgres 16 on every push to `main` and every pull request.

**What this gate is not:** it is not full checklist coverage. 15 of the 47
crawl-derived checks are claimed by a rule today; 29 are not. **Closing that
gap is the PHASE 3 gate.** Phase 2's gate is the fixture harness green and CI
enforcing it — evidence that the rules that exist are real end to end, not a
claim about how many exist.

## How to reproduce

```bash
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm run db:migrate
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm test
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npx tsc --noEmit
```

The gate lives in `test/fixtures/harness.test.ts`. It starts the fixture site
(`test/fixtures/app.ts`) on loopback, runs `runCrawl` against it once, runs
`runRules` once, and asserts from the `issues` table it wrote. Nothing in it
stubs a fetch, hand-builds a `pages` row, or calls a rule directly — which is
what makes it the only test that fails when the analyzer stops extracting a
signal, or the writer stops persisting it, or a rule stops reading it.
`allowPrivate: true` is the sanctioned use of that flag: the site is 127.0.0.1.

## The ruleset — 28 rules

| kind | count | rules |
|---|---|---|
| `page` | 26 | `title.{missing,too-short,too-long}`, `meta-description.{missing,too-short,too-long}`, `headings.{h1-missing,h1-multiple,level-skip}`, `content.{thin,placeholder}`, `http.server-error`, `crawl.blocked`, `canonical.{missing,points-elsewhere,multiple,html-header-conflict,cross-domain}`, `directive.canonical-noindex-conflict`, `indexability.{noindex,meta-header-conflict}`, `mobile.viewport-missing`, `images.{missing-dimensions,missing-alt}`, `performance.slow-response`, `structure.deep-page` |
| `query` | 2 | `hreflang.invalid-code`, `hreflang.missing-x-default` |
| `metric` | 0 | — (Phase 3) |

Every rule carries `checkIds`, client-facing copy and a severity;
`defineRule` rejects a rule missing any of them at `buildRegistry()` time,
before a crawl.

## The fixture site — 53 pages

| source | count | what they are |
|---|---|---|
| absorbed | 42 | pages absorbed from the badseo corpus (`test/fixtures/pages/absorbed.ts`). `expectedIssues` is a **floor**: upstream built each to demonstrate one issue, not to be silent about the other twenty-seven. |
| authored | 10 | written here for the rules absorb left unclaimed (`test/fixtures/pages/authored.ts`). Each is the control recipe with exactly one signal broken, so `exact: true` — the declared set is the COMPLETE set, and a rule that grew too eager fails. |
| control | 1 | `/control` — a clean page that must fire nothing. |

By category: head-tags 10, content 9, structure 9, indexability 5, redirect 5,
canonical 4, status 4, hreflang 2, images 1, mobile 1, performance 1,
kitchen-sink 1, control 1.

## The harness assertions

The plan asked for three; the harness carries five, the two extra added by the
Task 4 and Task 5 reviews to close attribution holes. All five pass
(`test/fixtures/harness.test.ts`, 5 tests, 4.34s including the crawl).

| # | Assertion | Result |
|---|---|---|
| 1 | The crawl finishes with 0 pending and 0 failed, and **every fixture path has a `pages` row** — asserted from the rows, not from the findings, so a fixture the hub forgot to link reads as unreachable rather than as a broken rule. | PASS |
| 2 | **Every fixture's expected issues fire on its path** — exact-set equality for the 10 authored fixtures, containment for the 42 absorbed ones. | PASS |
| 3 | **No rule fires on the control page** — and the control is first proved auditable (`fetch_class = ok`, status 200, non-null `word_count`), because "fired nothing" on a page that was never analyzed proves the opposite of what it claims. | PASS |
| 4 | **The site-scoped finding belongs to the crawl and to no fixture path** — `hreflang.missing-x-default` is written once with a null page id; the hreflang declarations that provoked it are pinned per path (`/authored/hreflang-bad-code` → `english-uk`; `/authored/hreflang-no-xdefault` → `de`, `en`; 3 declarations total), and no fixture path — `/control` above all — is blamed for it. | PASS |
| 5 | **Every registered rule fires on at least one fixture.** Fixture paths only: the hub is crawled and judged like any other page, but a rule "covered" only by the hub is a rule no fixture was ever written for. Unfired list is empty. | PASS |

## Coverage — the pin, not a promise

`test/rules/coverage.test.ts` asserts the exact set of crawl-derived checks no
rule claims. Equality, not a ceiling, so it fails in both directions: a check
quietly dropped by a rule appears as an addition, and a newly claimed check must
be deleted from the literal in the same commit as the rule claiming it.

| | count | ids |
|---|---|---|
| Crawl-derived universe (`CRAWL_CHECK_IDS`) | 47 | checklist Pre-Crawl + sections 1–11 |
| **Claimed by a Phase 2 rule** | **15** | 04, 05, 12, 13, 16, 17, 18, 20, 21, 25, 31, 35, 36, 37, 40 |
| `AGENT_CHECKS` — judgement, never a rule | 3 | 38, 41, 42 |
| **Unclaimed — the Phase 3 gate** | **29** | 01, 02, 03, 06–11, 14, 15, 19, 22, 23, 24, 26–30, 32, 33, 33b, 34, 39, 43–46 |

`15 + 3 + 29 = 47`, asserted as arithmetic in the same test so that a drift in
the universe itself fails rather than silently changing what "unclaimed" means.
No rule claims an AGENT check — a rule behind one would be a rule that always
passes (build plan §6).

**Three claims sit outside the 47 by design:** `mobile.viewport-missing`
(CHECK-52), `images.{missing-dimensions,missing-alt}` (CHECK-49) and
`performance.slow-response` (CHECK-50) trace to checklist **section 12
(Performance & CWV)**, not to the crawl-derived set. They satisfy hard rule 10
— each has a real checklist id — but `unclaimedChecks` only ever *subtracts*
from `CRAWL_CHECK_IDS`, so they neither appear in the pin nor shrink it. They
are bonus coverage, and the 15/47 figure above is deliberately not inflated by
them.

## CI

`.github/workflows/ci.yml`, on push to `main` and on every pull request:
`ubuntu-latest`, a health-checked `postgres:16` service (`pg_isready -U
ariadne`, 5s interval, 10 retries) so `db:migrate` cannot race the container's
first boot, Node 22 with npm cache, then `npm ci` → `npx tsc --noEmit` →
`npm run db:migrate` → `npm test`.

The whole suite — the fixture harness and the coverage pin included — runs
against a real Postgres. There is no in-memory stand-in and no skip-if-no-DB
branch: a missing `DATABASE_URL` throws (`test/fixtures/harness.test.ts`), per
hard rule 7.

**First CI run: pending first push.** The branch has not been pushed, so this
workflow has never executed on GitHub; it was validated structurally here (YAML
parses; job, service, env and step shape as above). Its first execution — and
the run link that belongs in this row — happens on the first push.

## Machine

| | |
|---|---|
| Node | v22.23.2 |
| Postgres | 16, Docker container `ariadne-pg` on port 5440 |
| Suite | 437 tests, 28 files, 10.3s wall |

## What Phase 3 inherits

1. **The 29 unclaimed checks** — the coverage literal is the work list, and
   emptying it is the Phase 3 gate. Most of what remains is `query`-kind
   (sitemaps, redirect chains, broken links, pagination, parameters, internal
   linking, structured data) rather than `page`-kind: they are questions about
   the `links`, `sitemap_urls` and `structured_data` tables, answered in SQL.
2. **No `metric` rules exist yet.** The kind is defined and validated; nothing
   registers one.
3. **A hard kill still loses buffered rows** (carried from the Phase 1 gate's
   findings, unchanged here).
