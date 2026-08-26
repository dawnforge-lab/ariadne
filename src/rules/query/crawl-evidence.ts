import { and, eq } from "drizzle-orm";

import type { DiscoveryTruncation } from "../../crawl/discovery.js";
import type { FetchClass } from "../../crawl/fetch-page.js";
import type { HostProbeHop, HostProbeResult, HostProbeVariant } from "../../crawl/host-probe.js";
import type {
  DiscoveryEvidence,
  NotFoundProbeEvidence,
  NotFoundProbeSample,
} from "../../crawl/loop.js";
import type { Db } from "../../db/client.js";
import { crawls, sitemapUrls } from "../../db/schema.js";
import type { Finding } from "../registry/registry.js";

/**
 * What a URL-scoped rule may report before it starts summarising instead.
 *
 * Two hundred findings is already more than any action plan works through in
 * one pass, and the alternative — one row per URL on a sitemap of a hundred
 * thousand — is a findings table that grows with the site rather than with the
 * problem. The cap bounds what is *listed*, and wherever the rule's scan runs
 * to completion anyway the count behind it is exact (`noteTruncation`). Where
 * the scan itself is what the cap has to stop — a quadratic join, an
 * accumulator that grows with the site — the number reported is a lower bound
 * and says so (`noteAtLeastTruncation`). What is never on offer is a listing
 * cut short in silence.
 */
export const URL_FINDING_CAP = 200;

/** The crawl row the robots and sitemap rules read, validated. */
export interface CrawlEvidence {
  siteUrl: string;
  discovery: DiscoveryEvidence;
  /** `config_jsonb` as stored. Read through `userAgentOf`, never directly. */
  config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OUTCOMES = new Set(["read", "absent", "unreachable"]);

/**
 * The stored blob, checked against the shape `runCrawl` writes rather than
 * cast to it.
 *
 * A cast would let a row written by something else — an older schema, a
 * hand-edited jsonb, a future field rename — reach a rule as `undefined`s: a
 * `truncated` that is not a boolean reads as falsy, and the truncation refusal
 * that exists to stop an unsound conclusion silently stops applying. Every
 * field a rule branches on is checked here, and a mismatch names the crawl.
 */
function parseDiscovery(value: unknown, ruleId: string, crawlId: string): DiscoveryEvidence {
  const bad = (why: string): never => {
    throw new Error(`${ruleId}: crawl '${crawlId}' discovery evidence ${why}`);
  };

  if (value === null || value === undefined) {
    // `discovery_jsonb` is written by `runCrawl` before the frontier is seeded
    // and before any branch on its contents, so a null column is not "the
    // crawl chose not to look" — it is a row this engine's crawl loop did not
    // produce. Refusing loudly beats judging a site on evidence that is not
    // there (hard rule 7).
    return bad(
      "is missing: `runCrawl` writes it before the frontier is seeded, so this " +
        "row either predates the discovery evidence or belongs to a crawl that " +
        "failed inside discovery — re-crawl the site to produce a row the " +
        "robots and sitemap rules can read",
    );
  }
  if (!isRecord(value)) return bad("is not an object");

  const robots = value["robots"];
  if (!isRecord(robots)) return bad("has no robots object");
  if (typeof robots["outcome"] !== "string" || !OUTCOMES.has(robots["outcome"])) {
    return bad(`has an unknown robots outcome '${String(robots["outcome"])}'`);
  }
  if (typeof robots["truncated"] !== "boolean") return bad("has a non-boolean robots.truncated");
  const raw = robots["raw"];
  if (raw !== null && typeof raw !== "string") return bad("has a non-string robots.raw");
  const note = robots["note"];
  if (note !== null && typeof note !== "string") return bad("has a non-string robots.note");
  const delay = robots["crawlDelaySec"];
  if (delay !== null && typeof delay !== "number") {
    return bad("has a non-numeric robots.crawlDelaySec");
  }

  const sources = value["sitemapSources"];
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string")) {
    return bad("has no sitemapSources array of strings");
  }

  const truncation = value["truncation"];
  if (!isRecord(truncation)) return bad("has no truncation object");
  const failures = truncation["failures"];
  if (
    !Array.isArray(failures) ||
    failures.some(
      (f) => !isRecord(f) || typeof f["url"] !== "string" || typeof f["reason"] !== "string",
    )
  ) {
    return bad("has no truncation.failures array of {url, reason}");
  }

  if (typeof value["docsFetched"] !== "number") return bad("has a non-numeric docsFetched");

  return {
    robots: {
      outcome: robots["outcome"] as DiscoveryEvidence["robots"]["outcome"],
      crawlDelaySec: delay as number | null,
      note: note as string | null,
      raw: raw as string | null,
      truncated: robots["truncated"],
    },
    sitemapSources: sources as string[],
    // Only `failures` is checked, because only `failures` is read by a rule
    // (`sitemap.invalid`). The counters beside it are carried through as
    // stored: a rule that starts branching on one of them must add its check
    // above rather than trusting this cast.
    truncation: truncation as unknown as DiscoveryTruncation,
    docsFetched: value["docsFetched"],
  };
}

/**
 * The crawl row a rule that reads the discovery evidence starts from — the
 * robots and sitemap rules, including the ones whose finding comes entirely
 * from a SQL join: a crawl id nothing knows selects no rows, and a rule that
 * answered `[]` for it would report a clean bill of health about a crawl that
 * does not exist (the `links.orphan` precedent, and `runRules`' own).
 *
 * It is NOT the one gate every query rule opens with, and the difference is
 * worth knowing before adding a call. `assertCrawl` below checks existence
 * alone, and the structured-data rules use it because a `discovery_jsonb` they
 * never read must not be able to make them throw. The content and url-hygiene
 * rules nevertheless come through HERE for their existence check and discard
 * the result, which means they do refuse a crawl whose discovery blob is
 * unreadable — a stricter gate than their evidence needs. Two gates, chosen
 * per rule; a new rule picks the one that matches what it actually reads.
 */
export async function readCrawlEvidence(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<CrawlEvidence> {
  const rows = await db
    .select({ siteUrl: crawls.siteUrl, config: crawls.config, discovery: crawls.discovery })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`${ruleId}: no such crawl '${crawlId}'`);
  // `config_jsonb` is NOT NULL and `runCrawl` writes the config it ran with.
  // Anything else is a row we cannot read the crawl's own settings out of, and
  // an empty object here would turn into "this crawl stored no user agent" —
  // a true-sounding message about the wrong problem.
  if (!isRecord(row.config)) {
    throw new Error(`${ruleId}: crawl '${crawlId}' config is not an object`);
  }

  return {
    siteUrl: row.siteUrl,
    discovery: parseDiscovery(row.discovery, ruleId, crawlId),
    config: row.config,
  };
}

/**
 * Refuse a crawl whose `sitemap_urls` rows predate `url_normalised`.
 *
 * Every rule that compares a sitemap entry with a page matches
 * `sitemap_urls.url_normalised` against `pages.url`. That column arrived with
 * migration 0006, NOT NULL with an empty-string default, and the default is the
 * only way an empty string can be in it: `normalizeUrl` returns at least
 * `scheme://host/` for every URL it accepts, and the writer throws rather than
 * storing anything for a URL it rejects (`persistSitemap`, src/crawl/loop.ts).
 * So `url_normalised = ''` means exactly one thing — a row written before the
 * column existed — and it is fully distinguishable at read time.
 *
 * It has to be refused rather than tolerated, because such a row does not join
 * to nothing quietly. It fails the join, and the rules that fire ON a failed
 * join then fire on everything: `sitemap.uncrawled` reports the entire sitemap
 * as never reached, `pages.not-in-sitemap` reports every indexable 200 (its
 * data gate only asks that sitemap rows exist, and they do), and
 * `links.orphan` calls every orphan `inSitemap: false`. A report full of
 * invented findings is the loudest possible way to be wrong, and nothing in the
 * output would say the cause was a schema version.
 *
 * Same ruling as `parseDiscovery`'s refusal of a null `discovery_jsonb`, and
 * the same remedy: re-crawl the site. Re-judging a pre-Phase-4 crawl is not
 * supported (hard rule 7).
 *
 * One indexed lookup per rule invocation — `(crawl_id, url_normalised)` is an
 * index, and this asks it for a single row.
 */
export async function assertNormalisedSitemap(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<void> {
  const rows = await db
    .select({ url: sitemapUrls.url })
    .from(sitemapUrls)
    .where(and(eq(sitemapUrls.crawlId, crawlId), eq(sitemapUrls.urlNormalised, "")))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return;
  throw new Error(
    `${ruleId}: crawl '${crawlId}' has sitemap entries with no normalised spelling ` +
      `(e.g. '${row.url}') — those rows predate the url_normalised column, so every ` +
      "join to `pages` fails and this rule would report the whole sitemap as wrong. " +
      "Re-crawl the site to produce rows the sitemap rules can read",
  );
}

/**
 * The crawl exists — the whole of what a rule needs when its finding comes
 * entirely from a SQL join over the crawl's own tables.
 *
 * The same gate `readCrawlEvidence` opens with, without the discovery blob:
 * a rule that neither reads robots.txt nor the sitemap walk must not start
 * throwing because a `discovery_jsonb` it never looks at is malformed, and must
 * not answer `[]` for a crawl id nothing knows — an empty scan reads exactly
 * like a healthy site (the `sitemap` rules' precedent, and `runRules`' own).
 */
export async function assertCrawl(db: Db, crawlId: string, ruleId: string): Promise<void> {
  const rows = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (rows.length === 0) throw new Error(`${ruleId}: no such crawl '${crawlId}'`);
}

/** The crawl row the host rules read: the seed URL, and the probe or its absence. */
export interface HostProbeEvidence {
  siteUrl: string;
  /**
   * Null means the probe was NOT ATTEMPTED — the caller passed
   * `probeHosts: false`, or the crawl predates the column. It never means "the
   * variants were fine": the probe records a site's behaviour, however bad, as
   * hops. See the `host_probe_jsonb` contract in src/db/schema.ts.
   */
  probe: HostProbeResult | null;
}

/**
 * `host_probe_jsonb` checked against the shape `probeHostVariants` writes,
 * rather than cast to it.
 *
 * Same reasoning as `parseDiscovery` above, and the same consequence if it were
 * skipped: a `statusCode` that arrived as a string would compare unequal to
 * 200, and the rule that exists to say "this http spelling serves a 200" would
 * quietly stop saying it. Every field the host rules branch on — the hop's
 * URL, its status, the variant's start — is checked here, and a mismatch names
 * the crawl.
 *
 * `fetchClass` and `location` are carried as stored: no rule branches on
 * either, they ride along inside the evidence a finding quotes. A rule that
 * starts reading one adds its check here.
 */
function parseHostProbe(value: unknown, ruleId: string, crawlId: string): HostProbeResult {
  const bad = (why: string): never => {
    throw new Error(`${ruleId}: crawl '${crawlId}' host probe evidence ${why}`);
  };

  if (!isRecord(value)) return bad("is not an object");
  const variants = value["variants"];
  if (!Array.isArray(variants)) return bad("has no variants array");

  const parsed: HostProbeVariant[] = [];
  for (const variant of variants) {
    if (!isRecord(variant)) return bad("has a variant that is not an object");
    if (typeof variant["start"] !== "string") return bad("has a variant with no start URL");
    const final = variant["final"];
    if (final !== null && typeof final !== "string") return bad("has a non-string variant final");
    const hops = variant["hops"];
    if (!Array.isArray(hops)) return bad(`has no hops array for variant '${variant["start"]}'`);

    const parsedHops: HostProbeHop[] = [];
    for (const hop of hops) {
      if (!isRecord(hop)) return bad("has a hop that is not an object");
      if (typeof hop["url"] !== "string") return bad("has a hop with no url");
      const status = hop["statusCode"];
      if (status !== null && typeof status !== "number") return bad("has a non-numeric hop status");
      if (typeof hop["fetchClass"] !== "string") return bad("has a hop with no fetch class");
      const location = hop["location"];
      if (location !== null && typeof location !== "string") {
        return bad("has a non-string hop location");
      }
      parsedHops.push({
        url: hop["url"],
        statusCode: status,
        fetchClass: hop["fetchClass"] as FetchClass,
        location,
      });
    }
    parsed.push({ start: variant["start"], hops: parsedHops, final });
  }
  return { variants: parsed };
}

/**
 * The crawl row every host rule starts from.
 *
 * A separate read from `readCrawlEvidence` on purpose, in both directions: the
 * host rules do not need the discovery evidence and must not throw for a crawl
 * whose sitemap walk is unreadable, and the robots and sitemap rules must not
 * start throwing because a `host_probe_jsonb` blob is malformed. Each rule
 * validates what it actually reads.
 */
export async function readHostProbe(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<HostProbeEvidence> {
  const rows = await db
    .select({ siteUrl: crawls.siteUrl, hostProbe: crawls.hostProbe })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`${ruleId}: no such crawl '${crawlId}'`);
  return {
    siteUrl: row.siteUrl,
    probe:
      row.hostProbe === null || row.hostProbe === undefined
        ? null
        : parseHostProbe(row.hostProbe, ruleId, crawlId),
  };
}

/** The crawl row the soft-404 rule reads: the seed URL, and the 404 sample or its absence. */
export interface NotFoundProbeReading {
  siteUrl: string;
  /**
   * Null means the crawl never reached the probe step — it is still running, or
   * it failed before it. `{ skipped }` means the step ran and decided not to
   * fetch, and says why. Neither is a template, and neither is a finding: see
   * the `notfound_probe_jsonb` contract in src/db/schema.ts.
   */
  probe: NotFoundProbeEvidence | null;
}

/**
 * `notfound_probe_jsonb` checked against the two shapes `probeKnownMissing`
 * writes, rather than cast to one of them.
 *
 * Same reasoning as `parseDiscovery` and `parseHostProbe` above, with one
 * sharper edge: `simhash` is stored as a DECIMAL STRING of a signed 64-bit
 * value, and the soft-404 rule turns it into a bigint that goes into a
 * `bit_count(… # …)` comparison. A number, a hex string or a value outside the
 * signed range would either throw somewhere deep inside the SQL layer or —
 * worse — compare against a different bit pattern than the analyzer produced,
 * and every page would look far from the template. It is checked here, where
 * the message can name the crawl.
 *
 * `fetchClass` is carried as stored: no rule branches on it — the soft-404 rule
 * asks `statusCode === 200`, which is the question it actually has — so it rides
 * along inside the evidence. A rule that starts reading it adds its check here.
 */
function parseNotFoundProbe(
  value: unknown,
  ruleId: string,
  crawlId: string,
): NotFoundProbeEvidence {
  const bad = (why: string): never => {
    throw new Error(`${ruleId}: crawl '${crawlId}' notfound probe evidence ${why}`);
  };

  if (!isRecord(value)) return bad("is not an object");

  if ("skipped" in value) {
    if (typeof value["skipped"] !== "string" || value["skipped"].trim() === "") {
      return bad("has a skip with no reason in it");
    }
    return { skipped: value["skipped"] };
  }

  if (typeof value["probeUrl"] !== "string") {
    return bad("is neither a sample (no probeUrl) nor a skip (no skipped)");
  }
  const status = value["statusCode"];
  if (status !== null && typeof status !== "number") return bad("has a non-numeric statusCode");
  if (typeof value["fetchClass"] !== "string") return bad("has no fetch class");
  const wordCount = value["wordCount"];
  if (wordCount !== null && typeof wordCount !== "number") {
    return bad("has a non-numeric wordCount");
  }
  const simhash = value["simhash"];
  if (simhash !== null && typeof simhash !== "string") return bad("has a non-string simhash");
  if (typeof simhash === "string") {
    let parsed: bigint;
    try {
      parsed = BigInt(simhash);
    } catch {
      return bad(`has a simhash '${simhash}' that is not an integer`);
    }
    if (BigInt.asIntN(64, parsed) !== parsed) {
      return bad(`has a simhash '${simhash}' outside the signed 64-bit range`);
    }
  }

  return {
    probeUrl: value["probeUrl"],
    statusCode: status,
    fetchClass: value["fetchClass"] as NotFoundProbeSample["fetchClass"],
    wordCount,
    simhash,
  };
}

/**
 * The crawl row the soft-404 rule starts from.
 *
 * A separate read from the two above, for the reason spelled out on
 * `readHostProbe`: each rule validates what it actually reads, so a malformed
 * blob it does not touch cannot make it throw, and a malformed blob it does
 * touch cannot make it quiet.
 */
export async function readNotFoundProbe(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<NotFoundProbeReading> {
  const rows = await db
    .select({ siteUrl: crawls.siteUrl, notfoundProbe: crawls.notfoundProbe })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`${ruleId}: no such crawl '${crawlId}'`);
  return {
    siteUrl: row.siteUrl,
    probe:
      row.notfoundProbe === null || row.notfoundProbe === undefined
        ? null
        : parseNotFoundProbe(row.notfoundProbe, ruleId, crawlId),
  };
}

/**
 * The user agent the crawl identified itself as — the one robots.txt groups
 * were matched against while crawling, and so the only one a re-parse may use.
 *
 * No default. `CrawlConfig.userAgent` is required and `runCrawl` stores the
 * config it ran with, so an absent value is a row we cannot judge robots.txt
 * for; substituting a generic agent would silently answer for a group the site
 * never wrote about us (hard rule 7, no silent fallbacks).
 */
export function userAgentOf(evidence: CrawlEvidence, ruleId: string, crawlId: string): string {
  const ua = evidence.config["userAgent"];
  if (typeof ua !== "string" || ua.trim() === "") {
    throw new Error(
      `${ruleId}: crawl '${crawlId}' stores no user agent in its config, so the ` +
        "robots.txt groups it crawled under cannot be matched",
    );
  }
  return ua;
}

/**
 * Why the stored robots.txt cannot be re-parsed into a sound answer, or null
 * when it can.
 *
 * Shared by the two rules whose claim is *about the contents of robots.txt* —
 * "it disallows a URL your sitemap lists" and "it declares no sitemap" —
 * because both are unsound in exactly the same cases, and both go quiet
 * together while `robots.check-skipped` says so out loud.
 *
 * An `absent` robots.txt is NOT one of them: no file is a complete answer
 * (allow-all, RFC 9309 §2.3.1.3), and "no file declares a sitemap" is true.
 */
export function robotsUnreadable(discovery: DiscoveryEvidence): string | null {
  const robots = discovery.robots;
  if (robots.truncated) {
    return (
      "the site's robots.txt exceeded the 500KB read cap, so the stored copy is " +
      "a prefix: a rule reading it would find no rule past the cap and conclude " +
      "the URLs are allowed, which is not something this crawl knows"
    );
  }
  if (robots.outcome === "unreachable") {
    return (
      "the site's robots.txt could not be read at all" +
      (robots.note === null ? "" : ` (${robots.note})`) +
      ", so what it permits and what it declares are both unknown"
    );
  }
  if (robots.outcome === "read" && robots.raw === null) {
    return (
      "the crawl recorded robots.txt as read but stored no text for it, so there " +
      "is nothing to re-parse"
    );
  }
  return null;
}

/**
 * The `truncated` note a capped rule writes into its last finding's evidence,
 * in the two shapes it can honestly take. Declared here, beside both functions
 * that produce it, so the report layer has one contract to read and the
 * difference between them is visible in the type rather than in prose.
 *
 * `total` is a promise: the rule counted every case, and listed some of them.
 * `atLeast` is the weaker claim a rule makes when counting the rest would cost
 * more than the cap was there to save — it says how many were SEEN, and
 * nothing about how many exist. A reader may render "and N more" from `total`;
 * from `atLeast` the honest rendering is "and at least N more".
 *
 * A rule that has an exact count must use `total`. Putting a known-incomplete
 * number in that field would be the same defect as a rule that always passes:
 * a true-looking answer to a question nothing behind it answered.
 */
export interface ExactTruncation {
  reported: number;
  total: number;
}
export interface LowerBoundTruncation {
  reported: number;
  atLeast: number;
}
export type TruncationNote = ExactTruncation | LowerBoundTruncation;

/**
 * Write a truncation note onto the last of a capped list of findings.
 *
 * The note rides on the last finding rather than on a site-scoped extra row: an
 * extra row under the same rule id would render the rule's own client-facing
 * copy over a URL-less "and 4,000 more", which is not what that copy says.
 */
function noteOnLast(findings: Finding[], note: TruncationNote): Finding[] {
  const last = findings[findings.length - 1];
  if (last === undefined) return findings;
  findings[findings.length - 1] = {
    ...last,
    evidence: { ...last.evidence, truncated: note },
  };
  return findings;
}

/**
 * Mark a capped list of findings with the EXACT total.
 *
 * The count comes from a `count(*) over ()` window in the rule's own query, or
 * from a full pass that stopped *listing* at the cap — never from the length of
 * what was kept — so a truncated list still says how big the real problem is.
 */
export function noteTruncation(findings: Finding[], total: number): Finding[] {
  if (total <= findings.length) return findings;
  return noteOnLast(findings, { reported: findings.length, total });
}

/**
 * Mark a capped list of findings with a LOWER BOUND: how many cases the rule
 * saw before it stopped looking.
 *
 * For the rule whose cap is on the scan itself rather than on the listing —
 * `content.near-duplicate` selects `cap + 1` pairs out of a join it must not
 * run to completion, so `seen` is `cap + 1` and the real number is unknown and
 * unknowable at that price. Everything else about the note is `noteTruncation`'s
 * behaviour, including where it lands.
 */
export function noteAtLeastTruncation(findings: Finding[], seen: number): Finding[] {
  if (seen <= findings.length) return findings;
  return noteOnLast(findings, { reported: findings.length, atLeast: seen });
}
