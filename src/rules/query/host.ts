/**
 * The host-variant rules: what the site does when you ask for it by another of
 * its names.
 *
 * Their entire input is `crawls.host_probe_jsonb`, written once per crawl by
 * `probeHostVariants` before the frontier is seeded. No page-level evidence can
 * answer these questions — the crawl only ever fetches the one spelling it was
 * seeded with — and no rule may fetch (hard rule 2), so the probe's stored
 * chains are the whole of what these rules know.
 *
 * All four are site-scoped: a variant is a property of the site's DNS and
 * server configuration, not of any page. Three of them read the probe, and the
 * fourth exists because a probe that did not run is a check that did not run,
 * and that has to be visible (hard rule 7).
 */
// `hostProbeStarts` comes from the pure url-utils module, not from
// src/crawl/host-probe.ts: the probe's own module imports the fetch stack, and
// a value-import of it here would pull undici into every rule run (hard rule 2
// — rules read the database). The types beside it are erased at compile time
// and cost nothing.
import type { HostProbeResult, HostProbeVariant } from "../../crawl/host-probe.js";
import { hostProbeStarts } from "../../crawl/parse/url-utils.js";
import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import { readHostProbe } from "./crawl-evidence.js";

const CATEGORY = "host" as const;

const HTTP_200: RuleIdentity = { id: "host.http-serves-200", severity: "warning" };
const DUPLICATE: RuleIdentity = { id: "host.duplicate-host-200", severity: "warning" };
const LEGACY: RuleIdentity = { id: "host.legacy-host-reachable", severity: "info" };
const SKIPPED: RuleIdentity = { id: "host.probe-skipped", severity: "info" };

/**
 * Where a chain actually ended, or null when it ended nowhere.
 *
 * The last hop rather than `variant.final`, because the two say different
 * things: `final` is the URL that answered, and the hop beside it carries the
 * status that answer had. A chain that ran out of hop budget, was refused by
 * the URL policy, or hit a DNS failure has a last hop and no final.
 */
function terminal(variant: HostProbeVariant): { url: string; statusCode: number | null } | null {
  const last = variant.hops[variant.hops.length - 1];
  return last === undefined ? null : { url: last.url, statusCode: last.statusCode };
}

/**
 * A probe URL, parsed. Throws rather than skipping: the parse in
 * `crawl-evidence` checked that these are strings, and a string here that is
 * not a URL is a row nothing of ours wrote (hard rule 7).
 */
function parseProbeUrl(url: string, ruleId: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${ruleId}: host probe URL '${url}' is not a URL`);
  }
}

/**
 * Whether this spelling serves a page AT ITS OWN HOST — a terminal 200 whose
 * URL is still on the host the chain started from.
 *
 * The host comparison is the whole rule for CHECK-15, and reading the terminal
 * status alone would invert it: every well-configured spelling redirects INTO
 * the canonical host, so its chain also ends on a 200 — the canonical host's
 * own. Counting that would report the redirect that fixes the problem as the
 * problem. A chain that redirects within its own host (`www.site.com` ->
 * `www.site.com/home`) does still serve the site under that name, which is why
 * this asks about the host rather than about the number of hops.
 *
 * The scheme is deliberately not compared: `https://www` landing on
 * `http://www` is still the www host serving the site, and the plaintext half
 * of that is `host.http-serves-200`'s finding.
 */
function servesOwnHost200(variant: HostProbeVariant, ruleId: string): boolean {
  const end = terminal(variant);
  if (end === null || end.statusCode !== 200) return false;
  return parseProbeUrl(end.url, ruleId).host === parseProbeUrl(variant.start, ruleId).host;
}

/** The site's own spellings, as `hostProbeStarts` derived them for the probe. */
function siteSpellings(siteUrl: string): Set<string> {
  // The same function the probe itself used, over the same `siteUrl`, so these
  // strings are exactly the variant starts the probe recorded for the site.
  // It throws on a siteUrl that is not http(s) — a crawls row no crawl of ours
  // produced, and not a site to report host findings about.
  return new Set(hostProbeStarts(siteUrl));
}

/**
 * Run `fires` over a crawl's probe, or nothing at all when there is no probe.
 *
 * The null gate is shared by the three reading rules and is the reason
 * `host.probe-skipped` exists: silence here means "not attempted", and a rule
 * that answered anyway would be reporting a clean bill of health about four
 * requests nobody made. The probe reaches `fires` non-null, so no rule below
 * has to restate the gate.
 */
async function withProbe(
  db: Db,
  crawlId: string,
  self: RuleIdentity,
  fires: (probe: HostProbeResult, siteUrl: string) => Finding[],
): Promise<Finding[]> {
  const evidence = await readHostProbe(db, crawlId, self.id);
  if (evidence.probe === null) return [];
  return fires(evidence.probe, evidence.siteUrl);
}

/**
 * Spellings that end on an `http://` URL with a 200.
 *
 * The condition is the TERMINAL hop, not the start: what matters is whether the
 * site's answer is served over plaintext, and a chain that starts at
 * `http://` and redirects into `https://` ends on an https hop and is exactly
 * the configuration this rule wants to see. A chain that redirects the other
 * way — an https spelling landing on an http 200 — is a downgrade, and it fires
 * here for the same reason.
 *
 * One finding per variant: two http spellings serving 200 are two entries in
 * the server config, and collapsing them would hide one behind the other.
 */
function httpServes200(probe: HostProbeResult): Finding[] {
  const findings: Finding[] = [];
  for (const variant of probe.variants) {
    const end = terminal(variant);
    if (end === null || end.statusCode !== 200) continue;
    if (parseProbeUrl(end.url, HTTP_200.id).protocol !== "http:") continue;
    findings.push(
      queryFinding(HTTP_200, {
        pageId: null,
        pageUrl: variant.start,
        evidence: { variant: variant.start, hops: variant.hops },
        dedupeKey: variant.start,
      }),
    );
  }
  return findings;
}

/**
 * Both https spellings of the site's own host answering 200 in their own right.
 *
 * One finding, not two: the fault is the missing redirect BETWEEN them, and it
 * is fixed once. The dedupe key names the pair rather than either host.
 *
 * A site addressed by an IP literal has one spelling per scheme (there is no
 * `www.203.0.113.7`), so `hostProbeStarts` derived no www variant, there is
 * only one https spelling, and the rule returns before it looks anything up —
 * rather than reporting a duplicate host that does not exist.
 */
function duplicateHost200(probe: HostProbeResult, siteUrl: string): Finding[] {
  const https = [...siteSpellings(siteUrl)].filter((s) => s.startsWith("https://"));
  if (https.length < 2) return [];

  const walked = https
    .map((start) => probe.variants.find((v) => v.start === start))
    .filter((v): v is HostProbeVariant => v !== undefined);
  // Both spellings must have been probed AND both must serve a page under
  // their own name. One of the two answering 404, redirecting to the other, or
  // not resolving at all is the canonical-host configuration working.
  if (walked.length !== https.length) return [];
  if (!walked.every((v) => servesOwnHost200(v, DUPLICATE.id))) return [];

  return [
    queryFinding(DUPLICATE, {
      pageId: null,
      pageUrl: null,
      evidence: {
        variants: walked.map((v) => v.start),
        finals: walked.map((v) => v.final),
      },
      dedupeKey: "www-apex",
    }),
  ];
}

/**
 * A host the site used to live on that still serves a page of its own.
 *
 * "Legacy" is decided by subtraction: any variant the probe walked whose start
 * is not one of the site's own spellings came from `legacyHosts`, which is the
 * only other source of starts `hostProbeStarts` has. Reading the config's list
 * instead would mean re-deriving the same strings from operator input a second
 * time, and disagreeing with the probe if either ever changed.
 *
 * Info, not a warning: a reachable legacy domain is sometimes deliberate (a
 * brand kept alive, a regional site), and the fault — duplicate content under
 * two brands, or link equity stranded on the old name — is the agent's call
 * with the redirect map in front of it.
 */
function legacyHostReachable(probe: HostProbeResult, siteUrl: string): Finding[] {
  const own = siteSpellings(siteUrl);
  return probe.variants
    .filter((v) => !own.has(v.start) && servesOwnHost200(v, LEGACY.id))
    .map((variant) =>
      queryFinding(LEGACY, {
        pageId: null,
        pageUrl: variant.start,
        evidence: { variant: variant.start, hops: variant.hops },
        dedupeKey: variant.start,
      }),
    );
}

/**
 * The three rules above, and the statement that they could not run.
 *
 * The fourth id is the `robots.check-skipped` precedent applied to this column:
 * copy is looked up by rule id, so "the host probe did not run" cannot be
 * rendered under "The site serves 200 over http" — that would be a false
 * statement to a client about their own server. One skip rule for all three,
 * because all three are gated on the same absent column and go quiet together.
 */
export const hostRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: HTTP_200.id,
    checkIds: ["CHECK-14"],
    category: CATEGORY,
    severity: HTTP_200.severity,
    ...copyFor(HTTP_200.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => withProbe(db, crawlId, HTTP_200, httpServes200),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: DUPLICATE.id,
    checkIds: ["CHECK-15"],
    category: CATEGORY,
    severity: DUPLICATE.severity,
    ...copyFor(DUPLICATE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => withProbe(db, crawlId, DUPLICATE, duplicateHost200),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: LEGACY.id,
    checkIds: ["CHECK-15"],
    category: CATEGORY,
    severity: LEGACY.severity,
    ...copyFor(LEGACY.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => withProbe(db, crawlId, LEGACY, legacyHostReachable),
  }),

  // Both checks, because the probe is the only evidence either has.
  defineRule<QueryRule>({
    kind: "query",
    id: SKIPPED.id,
    checkIds: ["CHECK-14", "CHECK-15"],
    category: CATEGORY,
    severity: SKIPPED.severity,
    ...copyFor(SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const evidence = await readHostProbe(db, crawlId, SKIPPED.id);
      if (evidence.probe !== null) return [];
      return [
        queryFinding(SKIPPED, {
          pageId: null,
          pageUrl: null,
          evidence: {
            skipped:
              "this crawl recorded no host-variant probe, so what the site's " +
              "other spellings answer — the http variants, the www/apex pair, " +
              "any legacy domain — is unknown. The probe is skipped when a " +
              "crawl is started with `probeHosts: false`",
            siteUrl: evidence.siteUrl,
          },
          dedupeKey: "site",
        }),
      ];
    },
  }),
];
