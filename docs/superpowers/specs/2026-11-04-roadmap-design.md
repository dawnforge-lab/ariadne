# Roadmap: audit parity and the cloud product

Date: 2026-11-04. Status: owner-agreed order (2026-11-04). Supersedes the "After 24a"
outline in `docs/superpowers/plans/2026-10-23-phase-24a-throttling-platforms.md`
(Phase 24b and the old Phase 25); their items are placed below.

Each phase below gets its own design, plan and gate, in the usual way. This document
fixes the order, the scope boundary and the decisions already made; it does not design
any phase.

## Intent

Ariadne is operated by agents: an agent configures the crawl, monitors it and writes
the report. A crawl-setup UI exists too, but it is secondary and lives in Talos. In
production every call reaches Ariadne through Talos.

The largest product gap is **check coverage**. The target is rough parity with
Screaming Frog on the checks that matter for a website audit, not on SF's whole filter
taxonomy. The engine itself (frontier, memory contract, politeness, URL policy, typed
rules) is already ahead and is not being reworked.

## Scope boundary

| In | Later, slimmed | Out |
|---|---|---|
| Security headers + mixed content | Accessibility: a chosen subset of axe rules, not all ~100 | AMP |
| Social cards (OG / X) | | Spelling and grammar |
| Hreflang, pagination, directives, canonical depth | | |
| H2, links/anchors, images, URL hygiene | | |
| Structured-data validation | | |
| JS errors from the render pass | | |
| Google Search Console (performance + URL Inspection) | | |
| GA4 (sessions per URL) | | |
| Bing Webmaster Tools | | |
| PageSpeed Insights, sampled per template | | |

Parity is measured against `skills/ariadne-audit/checklist.md`: a new check family
starts by adding checklist ids, then rules claim them (hard rule 10). CI coverage then
reports progress without extra tooling.

## Decisions

1. **Auth lives in Talos.** Talos owns users, tenants, the "connect Google / connect
   Bing" consent flow, encrypted refresh tokens and revocation. It already runs Google
   OAuth sign-in. Ariadne has no user accounts and never stores a refresh token.
2. **Ariadne owns the data pull and the join.** It obtains a short-lived access token
   through a credential-provider interface: the Talos token endpoint in production, an
   environment token in development and tests. Integration data lands in tables keyed
   by crawl and normalised URL; rules join it in SQL (hard rule 2 holds).
3. **A missing or expired connection is a classified state**, surfaced to the agent at
   crawl-config time with a Talos login link, and recorded on the crawl if it breaks
   mid-run. Never an empty integration section (hard rule 7).
4. **Tenancy is a key, not an identity system.** Talos passes the tenant; Ariadne
   scopes every row and every listing by it.
5. **Deployment mirrors Talos's topology:** separate API and worker containers over
   Postgres, workers claiming crawls with `FOR UPDATE SKIP LOCKED`, blob storage
   S3-compatible in production and a local directory in development.

## Order

### Housekeeping (no phase; done in the commit that added this roadmap)

- `README.md` status line ("implementation not started") and document index.
- `src/crawl/politeness.ts:120`: the comment that SF has no adaptive back-off is out of
  date; SF 25 has auto-throttle and `Retry-After` handling.

### Phase 25 — Evidence layer

- Response headers and the request headers actually sent, per page (auth redacted).
- Raw HTML in a content-addressed blob store with a retention policy and a hash-only
  mode for very large crawls.
- Engine and parser version stamps on the crawl, so rules can gate on extraction age.
- Render evidence: console errors, page errors and failed requests, capped per page.
- Carried debt: after a render launch failure, rows stay `render_pending` and
  `render.coverage` reads "ran" with no evidence (Phase 24a gate, T4).

### Phase 26 — Checks wave 1 (parser + SQL)

Absorbs the old Phase 24b.

- Security headers and mixed content (needs Phase 25's headers).
- Social cards: full OG / X extraction, completeness, duplicates, outside head, image
  URL checks.
- Hreflang depth, including the HTTP `Link` header and sitemap `xhtml:link` sources,
  `<html lang>` capture and the return-link variants.
- Pagination integrity, directives depth, canonical hygiene.
- H2, link graph quality (empty href, anchors, nofollow, localhost, high outlink
  counts, uncrawlable links), image depth, URL hygiene, sitemap protocol limits.
- Title and description pixel widths; black-box calibration of thresholds.

### Phase 27 — Agent control plane

Absorbs the old Phase 25's priority axis.

- Issue type (issue / warning / opportunity) × priority (high / medium / low) beside
  severity, and per-crawl overrides (disable, retype, reprioritise, thresholds) applied
  at read time.
- Config as a JSON Schema with get / set / validate tools for the agent; the schema is
  the allowlist.
- Pause, cancel, delete, list-mode crawls; URL and link-path excludes; custom headers,
  HTTP auth, cookies; configurable limits (redirects, depth, per-subdomain, URL length).
- Issues Overview and Crawl Overview reports (JSON + CSV).

### Phase 28 — Cloud foundations

- Tenant key on every row; every listing scoped (closes `talos-surface.md` §9.3).
- API and worker images; multiple workers claiming crawls.
- Health and Prometheus metrics; the 50k memory gate as a scheduled CI job.
- Scheduler (schedules table, advisory-lock leader, the existing queue) and crawl
  history events.

### Phase 29 — Integrations

Needs Phase 28's tenancy.

- Credential provider (Talos endpoint / environment token).
- GSC performance and URL Inspection, GA4, Bing Webmaster, PSI sampled per template.
- Rules that join integration data to crawled URLs (e.g. orphan pages with traffic,
  indexable pages not indexed, user canonical not selected).

### Phase 30 — Checks wave 2

- Structured-data validation, JS errors and blocked resources, images larger than
  displayed, mobile render, the chosen accessibility subset.
- Field-level crawl diff, external link checking (budgeted, off by default), link score
  and anchor aggregation.

## Not on this roadmap

Dashboards, visual graphs and export filename patterns (UI concerns for Talos); XLSX
until a client needs it; localisation of rule copy until a market needs it.
