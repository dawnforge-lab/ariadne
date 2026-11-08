# Phase 26c gate: multi-source hreflang and sitemap limits

Date: 2026-11-08. Spec: `docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md`
(the 26c section and "Gate 26c"), with the items Phase 26b parked for 26c
(`docs/gates/phase-26b.md` §8). Plan: `docs/superpowers/plans/2026-11-07-phase-26c-hreflang-sitemaps.md`.
Branch `worktree-phase-26c`, built on `e972234` (PR #23 merge). Every figure below was
measured on the final code, **`b5284c8`**, after the final whole-branch review and its fix wave
(ruling R15: review before the gate, so the gate measures the final code once). Raw outputs
are in the git-ignored SDD workspace (`gate26c/`, `baseline-50k/`).

**Verdict: all five clauses pass.** Ruleset 0.22.0 with **187 rules** (72 page / 101 query / 14
metric; 33 critical / 66 warning / 88 info; 15 markers), `EXTRACTION_VERSION` 3, migrations 0029
(schema) and 0030 (share-image backfill). The 50k gate peaks at **293.7 MB** (baseline 297.2 /
297.3 MB), and at **283.0 MB** with 600,080 sitemap hreflang alternates staged and derived. A 49 MB
sitemap streams in **+39.0 MB** of RSS. The stored pre-26c lavishalice crawl gets "not measured"
from every new check and is otherwise judged as before. Hurtigruten's sitemaps give 61,304
alternates and 100% hreflang coverage on the 599 crawled pages, with **no false positive**.

The PR #24 review added one marker after the gate (188 rules, 16 markers): see §8. It moves
none of the gate's measurements.

## Gate clauses

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite green, 0 skipped; `tsc` clean | **pass**: 120 files / 3,458 tests, 0 failed, 0 skipped; `tsc` clean | §1 |
| 2 | a pre-26c crawl gets "not measured" from every 26c check, never a pass; older judgements unchanged | **pass**: marker `{pagesNotRecorded: 602, requiredVersion: 3, sitemapFactsRecorded: false}`; 0 findings from the 5 new rules; 44 of 47 firing rules identical in findings and evidence, the 3 differences exactly the ruled ones | §2 |
| 3 | 50k memory gate ≤ 512 MB, no increase attributable to sitemap parsing | **pass**: 293.7 MB (baselines 297.3 / 297.2); with 600,080 sitemap alternates 283.0 MB; crawl-phase peak not in discovery | §3 |
| 4 | a 10–50 MB sitemap is read whole and streamed (Review Focus 1) | **pass**: 49 MB, 50,000 URLs and 500,000 alternates stored, RSS +39.0 MB plain / +35.4 MB gzip (limit 64 MB) | §4 |
| 5 | a multilingual site that uses sitemap hreflang (Hurtigruten): crawled politely, new rules reviewed for false positives | **pass**: 11 sitemaps, 5,460 URLs, 61,304 alternates, 6,704 sitemap hreflang rows on all 599 pages, 0 false positives (6 live requests of the 40 allowed). The first crawl met a cold CDN (§5.1) | §5 |

## 1. Clause 1: suite and types

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **120 files / 3,458 tests, 0 failed, 0 skipped** on `b5284c8` (`gate26c/fullsuite.log`) |
| `npx tsc --noEmit` | clean (`gate26c/tsc.log`) |
| baseline at the branch point (`e972234`) | 115 files / 3,238 tests |
| phase delta | +5 files, +220 tests |
| ruleset | **0.22.0** (one bump; the version note in `src/rules/registry/registry.ts` carries items T1–T12 and the final review) |
| registry | 187 rules: 72 page / 101 query / 14 metric; 33 critical / 66 warning / 88 info; 15 markers |
| `rules_catalog` | 191,912 bytes (183,585 at the 26b merge; the measuring script reproduced that figure to the byte) |

## 2. Clause 2: a pre-26c crawl, re-judged

The stored lavishalice crawl `crawl_4dd32709-56c9-4a62-9af4-7a843f76ff6c` (602 pages, all at
extraction version 2, no `sitemapFacts`) was snapshotted, re-judged by `runRulesForCrawl` on
`b5284c8`, and snapshotted again (`gate26c/rejudge.sh`, `compare.py`, `compare.txt`). Findings are
compared by (rule, page, dedupe key) and their evidence separately (ruling R12).

- 3,401 findings before, 3,202 after. **44 of the 47 rules with findings are identical in both
  findings and evidence.**
- `extraction.not-recorded` fires once: `{pagesNotRecorded: 602, pagesRecorded: 0,
  requiredVersion: 3, sitemapFactsRecorded: false}`.
- `links.aria-label-only`: 200 listed → 0. It now reads version-3 link facts (Task 5) and refuses
  a v2 crawl; the marker speaks for it.
- `hreflang.non-indexable-target`: the same 4 findings on the same pages; their evidence gains
  `sources: ["html"]` (R12).
- `url.reference-too-long`, `social.image-insecure`, `sitemap.oversized`, `sitemap.url-in-multiple`,
  `hreflang.source-conflict` and `links.no-anchor-text`: 0 before and after.
- Metrics: 92 rows before and after; one changed. The `sitemap.structure` site row keeps
  `totalUrls: 444` and gains the new fields as `null` (not measured) with `docCountsExact: false`
  (ruling R11, Deviation 7).

## 3. Clause 3: the 50k memory gate

`scripts/gate-rules.ts` (crawl → render → rules over the 50,000-page fixture, one process,
`--max-old-space-size=512`), in a dedicated database `ariadne_gate26c` (ruling R4). The baselines
ran on `e972234` (run 1 on the worktree before Task 1 changed anything, run 2 on an export of
that tree), the after-runs on `b5284c8`.

| run | code | sitemap hreflang | crawl | render | rules | **peak** | `time -v` max RSS | wall |
|---|---|---|---|---|---|---:|---:|---:|
| baseline 1 | e972234 | off | 276.3 MB (+2 s) | 275.9 | 297.3 | **297.3 MB** | 307,564 kB | 26:01 |
| baseline 2 | e972234 | off | 275.9 MB (+993 s) | 279.6 | 297.2 | **297.2 MB** | 307,312 kB | 22:56 |
| after | b5284c8 | off | 278.5 MB (+998 s) | 280.2 | 293.7 | **293.7 MB** | 303,408 kB | 23:15 |
| after, hreflang | b5284c8 | on (600,080 alternates) | 260.8 MB (+1,074 s) | 263.7 | 283.0 | **283.0 MB** | 291,032 kB | 40:23 |

- **The peak fell** from 297.2–297.3 MB to 293.7 MB, against a 512 MB contract.
- **No increase is attributable to sitemap parsing.** There is no discovery-stage probe (ruling
  R19: no production hook); the crawl phase's peak and its timestamp stand in. Baseline 1's crawl
  peak fell at +2 s, which is discovery (the old parser buffered each document). In every 26c run
  the crawl peak falls late in the crawl (+998 s, +1,074 s), not in discovery. The +2.6 MB of
  crawl-phase peak against baseline 2 lands there too. Clause 4 measures parse memory directly.
- **The hreflang run exercises 26c at scale.** `GATE_SITEMAP_HREFLANG=1` (`test/gate/site-server.ts`,
  off by default so the comparison above is like for like) gives every `<url>` 11–21 locales plus
  `x-default`. 50,000 memberships and 600,080 alternates were staged, then derived into `hreflang`
  with `source='sitemap'`. The peak stays at 283.0 MB. Wall time grows to 40 minutes: the
  hreflang rules now judge 600,000 more declarations (`missing-return-link` 83.7 s,
  `non-indexable-target` 82.6 s, `inconsistent-return-code` 39.2 s, `invalid-code` 27.0 s in
  keyset batches, `source-conflict` 16.3 s).
- Run-to-run noise between the two baselines: 0.1 MB at the peak, 0.4 MB in the crawl phase.

## 4. Clause 4: the 50 MB probe

`scripts/probe-sitemap-50mb.ts` serves a lazily generated urlset from 127.0.0.1 (51,350,153 bytes
= 48.97 MB uncompressed: 50,000 URLs, 10 alternates each) and runs `discover` with the real
`SitemapRowSink` against Postgres (`gate26c/probe-*.log`).

| | bytes on the wire | URLs read | stored | RSS delta (limit 64 MB) | wall |
|---|---:|---:|---|---:|---:|
| plain | 48.97 MB | 50,000 / 50,000 | 50,000 memberships, 500,000 alternates | **+39.0 MB** | 35.4 s |
| gzip | 1.60 MB | 50,000 / 50,000 | 50,000 memberships, 500,000 alternates | **+35.4 MB** | 39.5 s |

Before 26c this document was dropped whole as "oversized" (10 MB cap) and its URLs left every
sitemap rule. No cap was hit, and there were no failures or malformed entries.

## 5. Clause 5: Hurtigruten (owner OK 2026-11-08)

`gate26c/crawl-hurtigruten.mts`: `siteUrl https://www.hurtigruten.com/en/`, `sitemapUrls
[…/en/sitemaps/en/sitemap.xml]`, 600 pages, `fetchResources: false`, robots, crawl-delay and the
per-host governor (1 s spacing; no 429s in either run).

### 5.1 First crawl: a cold CDN, and a finding

The first crawl (`crawl_5e7f2241-…`) finished 600 pages, but **every one of the 20 locale sitemap
requests failed "timed out"**. Only one document, ja-jp with one URL, answered in time, so
`sitemap_hreflang` held 11 rows and `sitemap.invalid` fired. Systematic debugging, using 4 live
requests:

- The live en sitemap is 910,194 bytes, with 568 `<loc>` and 6,339 alternates. Cloudflare served
  it in 0.11 s over HTTP/2 and 0.09 s over HTTP/1.1 (chunked).
- Discovery run locally on the saved file, with the crawl's own options: 1.1 s, 566 entries,
  6,339 alternates, no failure. The parser, the stream and the deadline are not at fault.
- **Root cause: the site builds each locale sitemap on demand, in about 33 s on a cold cache.**
  The CDN copies' `Last-Modified` stamps fall at our request cadence: en 08:20:15 (our request
  about 08:19:42), en-us 08:20:37, de-de 08:23:23. The discovery deadline is 20 s per document,
  unchanged since before 26c (`DEFAULT_TIMEOUT_MS` in `e972234` is also 20 s).
- So `sitemap.invalid` was true: on a cold cache this site's sitemaps time out for a crawler.

The owner chose to re-crawl while the CDN copies were warm. The deadline itself is parked for a
later phase (§7).

### 5.2 Second crawl: the evidence

`crawl_e1d89a36-4325-462c-af32-d944f7d413fe`: 600 pages (599 at 200, one 308), 14:04 wall, peak
RSS 244 MB (`gate26c/hurtigruten-*`).

| fact | value |
|---|---|
| sitemaps read / failed | 11 / 0 (10 locales + ja-jp) |
| `sitemap_urls` / memberships (stored) | 5,460 / 5,460; 5,481 offered (21 repeats inside one document stored once) |
| staged `sitemap_hreflang` | 61,304 rows, 5,460 URLs, 13 codes (11 locales + en-ca/en-my + `x-default`) |
| `hreflang` rows by source | sitemap 6,704 on all 599 crawled pages; html 15 (`/en` only); header 0 |
| `hreflang.coverage` | **100%** (599 of 599 indexable; the cold first crawl: 0.6%) |
| `sitemap.structure` site row | `totalUrls 5,460`, `totalMemberships 5,460`, `docCountsExact true`, every cap and limit false/0 |

**New and changed rules.**

| rule | findings | verdict |
|---|---:|---|
| `hreflang.source-conflict` | 0 | true negative. Only `/en` has HTML hreflang; its HTML and sitemap sets agree on every shared code, and HTML adds `en` and `de-at` (`onlyIn`, not a conflict, Deviation 4) |
| `sitemap.url-in-multiple` | 0 | true: each locale sitemap lists its own URLs (memberships = distinct URLs) |
| `sitemap.oversized` | 0 | true: the largest document is 0.9 MB |
| `url.reference-too-long` | 0 | true: no page has an over-long reference |
| `social.image-insecure` | 0 | true: no `http:` og:image |
| `hreflang.self-only` | 3 | **true**: the sitemap gives `/en/deals/black-friday`, `/en/deals/save` and `/en/explore-norway` a single `x-default` pointing at itself (owner call 26a: self x-default is flagged) |
| `hreflang.unlinked-target` | 12 | true per the rule: en-us targets named only by their `/en` page |
| `hreflang.alternates-not-crawled` | 1 (4,638 alternates) | true: the 600-page cap; the locale pages are not crawled |
| `links.aria-label-only` | 200 listed | **true**: cruise cards are empty `<a aria-label="Best of Norway" href="/en/cruises/best-of-norway"></a>` |
| `links.no-anchor-text` | 0 | true: every empty link carries an `aria-label` |

**Hand-check.** 6 live requests in all (the cap is 40), including the 4 used for §5.1:
- the home page has 15 `<link rel=alternate hreflang>` tags, which matches the 15 stored;
- `/en/about-us` has none, which matches the 0 stored;
- the card anchor above is quoted from the live HTML.

**False positives: none.**

## 6. Rulings made during the build (owner to see)

The full list, with what each costs if wrong, is in the PR description. The ones that shape what
this gate measured:

- R1/R2: the marker's sitemap condition and the checklist lines landed with the tasks that made
  them true.
- R3: `social.image-broken` keeps 26b's v2 reading.
- R6: migration 0030 backfills `share_image` from 26b's own definition.
- R10: membership key pairs and staging byte budgets.
- R11: `totalUrls` keeps its meaning.
- R12: clause 2 compares findings, not evidence bytes.
- R13: sitemap hreflang joins `pages.url`.
- R14: a page that serves no content declares nothing; one defect fires one rule.
- R15: review before the gate.
- R16: a PDF's header hreflang counts as a return link but is not judged as a declaration.
- R18: an over-long index child stays a named `sitemap.invalid` failure.
- R19: no discovery-stage RSS hook.

## 7. Follow-ups for the owner

- **Sitemap deadline (owner, 2026-11-08: park for a later phase).** Discovery gives each sitemap
  20 s for connect, headers and body together. Hurtigruten generates a cold sitemap in about
  33 s, so a first crawl loses all of its sitemap URLs and hreflang, and `sitemap.invalid` says
  so. Decide a value (for example 60 s) and whether it is idle or total.
- **Header hreflang on non-HTML pages (R16).** A PDF's `Link` header alternates are stored and
  count as return links, but its own declaration set is not judged. The declaring cohort is
  `FETCHED_OK`.
- **`social.image-insecure` has no end-to-end fixture.** The fixture server is plain HTTP, and an
  https fixture needs a certificate seam that costs more than it proves; unit and DB tests prove
  the rule.
- **Deferred minors** from the task reviews and the final review are triaged in the SDD ledger.
  Each is "can wait"; none blocks merge.

## 8. Post-gate change (PR #24 review)

**The finding.** Truncated hreflang input was read as "no declaration". When the sitemap walk
stops early (the staging caps on sitemap alternates, the entry, document or depth caps, or a
document over 50 MB), the `<loc>`s read before the cut are crawled, but their alternates, or
those of later documents, are never read. A page can also lose pairs past 200 per source in its
HTML, its `Link` header or one sitemap `<url>`. `hreflang.missing-return-link` (critical) then
reported every crawled target whose declarations had been dropped. A sitemap-only site with 45k
URLs in 25 locales could get a critical finding for every staged page against every such target.
`hreflang.missing-self-reference`, `hreflang.missing-x-default` and `hreflang.self-only` had the
same exposure.

**The fix (rulings R20 and R21).**
- When the sitemap walk was cut short, the four rules refuse (one shared condition,
  `sitemapHreflangCutShort` in `src/rules/query/hreflang-completeness.ts`).
- A sitemap document that **failed** does not silence them. `sitemap.invalid` already reports it,
  and a stale sitemap that 404s is common enough that refusing would hide far more than it
  protects.
- On any crawl, a declaration set with 200 or more rows from one source is never judged as a
  declarer for the self-reference, x-default and self-only rules, and is never a target that
  "does not return the link".
- The new marker `hreflang.declarations-incomplete` (info, CHECK-24) fires once per crawl when the
  walk was cut short, when a sitemap document failed, when a sitemap `<url>` lost alternates past
  the per-URL cap (`alternatesCapped`, ruling R22: like a failed document, marker only), or when a
  judged page reached the pair cap. Its evidence is `{hreflangLimited, entryLimited, docLimited,
  depthLimited, sitemapDocsFailed, sitemapDocsOversized, alternatesCapped, possiblyCappedPages}`.
  On a crawl from before 26c, the seven sitemap keys are `null` and only the pair cap is judged.
- Ruling R23: "possibly capped" now counts the pair slots taken, not only the rows stored (HTML
  and header rows plus the page's over-long hreflang targets; staged sitemap alternates before
  the derivation's DISTINCT), the marker counts every skipped page whatever its status, and its
  new `reason` evidence names only the triggers that fired. `rules_catalog` is 194,186 bytes.
- Ruling R22 also moved the 45 MB RSS-growth test of the sitemap stream into a file of its own
  (`test/crawl/sitemap-stream-memory.test.ts`), so its RSS delta is measured in a fresh worker. It
  had once read 85 MB in a full run, from garbage left by the earlier tests in its file.

**Counts.** 188 rules: 72 page / 102 query / 14 metric; 33 critical / 66 warning / 89 info; 16
markers. `rules_catalog` is 194,112 bytes after R22, up from 191,912, and 194,186 after R23. No
migration and no version bump.

**Why the gate stands.** Every figure in §1–§5 was measured on `b5284c8`, before this change.
None of the gate crawls truncated hreflang:
- The Hurtigruten re-crawl read 11 sitemaps with 0 failures, `hreflangLimited` false and no page
  near 200 pairs, so the marker would be silent and the four rules judge it as before.
- The 50k runs, the hreflang run's 600,080 alternates included, stayed under every cap.
- The change adds one aggregate query (the marker) and a batch-scoped sub-select to two existing batch
  queries, so it adds nothing to the memory contract.

The Hurtigruten **first** crawl (§5.1, 20 locale sitemaps timed out) is exactly the failed-document
case. Judged now, it would carry the marker with `sitemapDocsFailed: 20` beside `sitemap.invalid`,
and the four rules would still run on it.

Clause 1 was re-run after the change, twice: **122 files / 3,481 tests, 0 failed, 0 skipped**
both times; `tsc` clean (+2 files, +23 tests over `b5284c8`; one of the files is the RSS test
moved out by R22).
