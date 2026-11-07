import { describe, expect, it } from "vitest";
import { directiveRules } from "../../src/rules/page/directives.js";
import { RESTRICTIVE_DIRECTIVES, UNAVAILABLE_AFTER_WARN_DAYS } from "../../src/rules/thresholds.js";
import { expectSilentOnNonOkFetches, mkPage, mkV1Page, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(directiveRules, "directiveRules");
const DAY_MS = 86_400_000;
const FETCHED = new Date("2026-09-08T12:00:00.000Z");

/** An `unavailable_after` meta whose date lies `days` after the page's fetch. */
function expiring(days: number) {
  return mkPage({
    fetchedAt: FETCHED,
    robotsMeta: `unavailable_after: ${new Date(FETCHED.getTime() + days * DAY_MS).toUTCString()}`,
  });
}

const BROKEN = [
  { robotsMeta: "nofollow" },
  { robotsMeta: "nosnippet" },
  { robotsMeta: "unavailable_after: 25 Jun 2010 15:00:00 PST" },
  { robotsMetas: [{ name: "googlebot", content: "noindex" }] },
];

describe("directiveRules metadata", () => {
  it("defines exactly the four directive rules", () => {
    expect(directiveRules.map((r) => r.id).sort()).toEqual([
      "directives.bot-conflict",
      "directives.restrictive",
      "directives.unavailable-after",
      "indexability.nofollow",
    ]);
  });

  it("all are warning page rules in the indexability category on CHECK-04", () => {
    for (const r of directiveRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.severity, r.id).toBe("warning");
      expect(r.category, r.id).toBe("indexability");
      expect(r.checkIds, r.id).toEqual(["CHECK-04"]);
    }
  });

  it("is silent on the clean page and on every non-OK fetch", () => {
    for (const r of directiveRules) expect(r.run(mkPage()), r.id).toHaveLength(0);
    expectSilentOnNonOkFetches(directiveRules, BROKEN);
  });
});

describe("indexability.nofollow", () => {
  const r = rule("indexability.nofollow");

  it("fires on nofollow in the meta, the header, or both, saying which", () => {
    const meta = r.run(mkPage({ robotsMeta: "index, nofollow" }));
    expect(meta).toHaveLength(1);
    expect(meta[0]!.evidence).toEqual({
      source: "meta",
      robotsMeta: "index, nofollow",
      xRobotsTag: null,
    });
    expect(r.run(mkPage({ xRobotsTag: "nofollow" }))[0]!.evidence).toMatchObject({
      source: "header",
    });
    expect(
      r.run(mkPage({ robotsMeta: "nofollow", xRobotsTag: "googlebot: nofollow" }))[0]!.evidence,
    ).toMatchObject({ source: "both" });
  });

  it("reads a nofollow written after an unavailable_after date (PR #22 re-review M1)", () => {
    expect(
      r.run(mkPage({ robotsMeta: "unavailable_after: 25 Jun 2010 15:00:00 PST nofollow" })),
    ).toHaveLength(1);
  });

  it("reads whitespace-delimited directives as saysNoindex does (PR #22 review)", () => {
    expect(r.run(mkPage({ robotsMeta: "noindex nofollow", isIndexable: false }))).toHaveLength(1);
    expect(r.run(mkPage({ xRobotsTag: "noarchive none", isIndexable: false }))).toHaveLength(1);
    expect(r.run(mkPage({ robotsMeta: "noindex  follow", isIndexable: false }))).toHaveLength(0);
    expect(
      rule("directives.restrictive").run(mkPage({ robotsMeta: "noarchive NOSNIPPET" }))[0]!
        .evidence,
    ).toEqual({ directives: ["nosnippet"] });
  });

  it("fires on none, which is noindex plus nofollow", () => {
    expect(r.run(mkPage({ robotsMeta: "none", isIndexable: false }))).toHaveLength(1);
    expect(r.run(mkPage({ xRobotsTag: "NONE" }))).toHaveLength(1);
  });

  // Review Focus 2: tokens are bounded, a substring is not a directive.
  it("does not fire on a token that merely contains the word", () => {
    for (const v of ["nofollowing", "followed, nofollowers", "nonevent", "index, follow"]) {
      expect(r.run(mkPage({ robotsMeta: v })), v).toHaveLength(0);
      expect(r.run(mkPage({ xRobotsTag: v })), v).toHaveLength(0);
    }
  });
});

describe("directives.restrictive", () => {
  const r = rule("directives.restrictive");

  it("fires on each restrictive directive and quotes it", () => {
    for (const d of RESTRICTIVE_DIRECTIVES) {
      const out = r.run(mkPage({ robotsMeta: `index, ${d}` }));
      expect(out, d).toHaveLength(1);
      expect(out[0]!.evidence, d).toEqual({ directives: [d] });
    }
  });

  it("lists every matched token once, in the order found, meta before header", () => {
    const out = r.run(
      mkPage({ robotsMeta: "noimageindex, nosnippet", xRobotsTag: "nosnippet, max-snippet:0" }),
    );
    expect(out[0]!.evidence).toEqual({
      directives: ["noimageindex", "nosnippet", "max-snippet:0"],
    });
  });

  it("reads the header too, and ignores the bot prefix", () => {
    expect(r.run(mkPage({ xRobotsTag: "googlebot: nosnippet" }))).toHaveLength(1);
  });

  // Review Focus 2.
  it("does not fire on a permissive or merely similar token", () => {
    for (const v of [
      "max-snippet:-1",
      "max-snippet:50",
      "max-snippet:05",
      "max-image-preview:large",
      "noimageindexer",
      "nosnippets",
      "max-snippet:0x",
    ]) {
      expect(r.run(mkPage({ robotsMeta: v })), v).toHaveLength(0);
    }
  });
});

describe("directives.unavailable-after", () => {
  const r = rule("directives.unavailable-after");

  it("fires on a date already past at fetch, with a negative daysFromFetch", () => {
    const out = r.run(
      mkPage({ fetchedAt: FETCHED, robotsMeta: "unavailable_after: 25 Jun 2010 15:00:00 PST" }),
    );
    expect(out).toHaveLength(1);
    const ev = out[0]!.evidence as {
      unavailableAfter: string;
      dateParsed: boolean;
      daysFromFetch: number;
    };
    expect(ev.unavailableAfter).toBe("25 Jun 2010 15:00:00 PST");
    expect(ev.dateParsed).toBe(true);
    expect(ev.daysFromFetch).toBeLessThan(0);
  });

  it("judges against the page's own fetch time: 29 days fires, 31 is silent", () => {
    expect(UNAVAILABLE_AFTER_WARN_DAYS).toBe(30);
    const near = r.run(expiring(29));
    expect(near).toHaveLength(1);
    expect(near[0]!.evidence).toMatchObject({ dateParsed: true, daysFromFetch: 29 });
    expect(r.run(expiring(31))).toHaveLength(0);
    // The boundary is not reported: a threshold nobody can meet is no threshold.
    expect(r.run(expiring(30))).toHaveLength(0);
  });

  it("fires on a date that does not parse, without a daysFromFetch", () => {
    const out = r.run(mkPage({ robotsMeta: "unavailable_after: soon, nofollow" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({ unavailableAfter: "soon", dateParsed: false });
  });

  it("does not guess at loose text a general date parser would accept (PR #22 review)", () => {
    // Date.parse read "June 25" (cut at the comma) as 25 June 2001.
    const out = r.run(
      mkPage({ fetchedAt: FETCHED, robotsMeta: "unavailable_after: June 25, 2010" }),
    );
    expect(out.map((f) => f.evidence)).toEqual([
      { unavailableAfter: "June 25", dateParsed: false },
    ]);
  });

  it("reads the date, not the directive after it (PR #22 re-review M1)", () => {
    const out = r.run(
      mkPage({
        fetchedAt: FETCHED,
        robotsMeta: "unavailable_after: 25 Jun 2010 15:00:00 PST nofollow",
      }),
    );
    expect(out[0]!.evidence).toMatchObject({
      unavailableAfter: "25 Jun 2010 15:00:00 PST",
      dateParsed: true,
    });
  });

  it("keeps an RFC 1123 date whole across its comma", () => {
    const out = r.run(
      mkPage({
        fetchedAt: FETCHED,
        robotsMeta: "noindex, unavailable_after: Fri, 25 Jun 2010 15:00:00 GMT, nofollow",
      }),
    );
    expect(out[0]!.evidence).toEqual({
      unavailableAfter: "Fri, 25 Jun 2010 15:00:00 GMT",
      dateParsed: true,
      daysFromFetch: Math.floor((Date.UTC(2010, 5, 25, 15) - FETCHED.getTime()) / DAY_MS),
    });
  });

  it("reads a zone-less date-time as UTC and says so in the evidence", () => {
    const at = new Date(FETCHED.getTime() + 10 * DAY_MS).toISOString().slice(0, 19);
    const out = r.run(mkPage({ fetchedAt: FETCHED, robotsMeta: `unavailable_after: ${at}` }));
    expect(out[0]!.evidence).toEqual({
      unavailableAfter: at,
      dateParsed: true,
      assumedUtc: true,
      daysFromFetch: 10,
    });
  });

  it("reads the header, and takes the earliest date when both carry one", () => {
    const out = r.run(
      mkPage({
        fetchedAt: FETCHED,
        robotsMeta: "unavailable_after: 2040-01-01T00:00:00Z",
        xRobotsTag: "unavailable_after: 25 Jun 2010 15:00:00 PST",
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({ unavailableAfter: "25 Jun 2010 15:00:00 PST" });
  });

  it("is silent on a far-future date and on a page with no fetch time to judge against", () => {
    expect(r.run(expiring(400))).toHaveLength(0);
    expect(
      r.run(mkPage({ fetchedAt: null, robotsMeta: "unavailable_after: 25 Jun 2010 15:00:00 PST" })),
    ).toHaveLength(0);
  });
});

describe("directives.bot-conflict", () => {
  const r = rule("directives.bot-conflict");
  const metas = (...entries: [string, string][]) =>
    entries.map(([name, content]) => ({ name, content }));

  it("fires stricter when googlebot says noindex and robots says index (the spec example)", () => {
    const out = r.run(
      mkPage({ robotsMeta: "index", robotsMetas: metas(["googlebot", "noindex"]) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({
      conflicts: [
        {
          bot: "googlebot",
          differs: [{ directive: "noindex", direction: "stricter" }],
          botDirectives: "noindex",
          robotsDirectives: "index",
        },
      ],
    });
  });

  it("with no robots meta, a bot nofollow is stricter than the index, follow default", () => {
    const out = r.run(mkPage({ robotsMeta: null, robotsMetas: metas(["bingbot", "nofollow"]) }));
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({
      conflicts: [
        {
          bot: "bingbot",
          differs: [{ directive: "nofollow", direction: "stricter" }],
          robotsDirectives: null,
        },
      ],
    });
  });

  it("is silent when the bot meta is merely silent on a directive robots carries", () => {
    // Google combines the bot meta with the generic one: googlebot still gets
    // noindex here, and nofollow below, from the generic meta.
    expect(
      r.run(
        mkPage({ robotsMeta: "noindex, follow", robotsMetas: metas(["googlebot", "noarchive"]) }),
      ),
    ).toHaveLength(0);
    expect(
      r.run(
        mkPage({ robotsMeta: "noindex, nofollow", robotsMetas: metas(["googlebot", "noindex"]) }),
      ),
    ).toHaveLength(0);
  });

  it("fires overridden when the bot meta permits what robots restricts", () => {
    const out = r.run(
      mkPage({ robotsMeta: "noindex", robotsMetas: metas(["googlebot", "index"]) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({
      conflicts: [
        { bot: "googlebot", differs: [{ directive: "noindex", direction: "overridden" }] },
      ],
    });
  });

  it("all overrides follow only where robots restricts it", () => {
    const out = r.run(mkPage({ robotsMeta: "nofollow", robotsMetas: metas(["bingbot", "all"]) }));
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({
      conflicts: [
        { bot: "bingbot", differs: [{ directive: "nofollow", direction: "overridden" }] },
      ],
    });
  });

  it("a bot meta that permits and restricts the same directive is not an override", () => {
    expect(
      r.run(mkPage({ robotsMeta: "noindex", robotsMetas: metas(["googlebot", "index, noindex"]) })),
    ).toHaveLength(0);
  });

  it("counts none as noindex and nofollow, and is one finding per page", () => {
    const out = r.run(
      mkPage({
        robotsMeta: "index, follow",
        robotsMetas: metas(["googlebot", "none"], ["bingbot", "noindex"]),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({
      conflicts: [
        {
          bot: "googlebot",
          differs: [
            { directive: "noindex", direction: "stricter" },
            { directive: "nofollow", direction: "stricter" },
          ],
        },
        { bot: "bingbot", differs: [{ directive: "noindex", direction: "stricter" }] },
      ],
    });
    expect(
      r.run(mkPage({ robotsMeta: "none", robotsMetas: metas(["googlebot", "noindex, nofollow"]) })),
    ).toHaveLength(0);
  });

  it("is silent when the bot meta repeats robots, or there is no bot meta", () => {
    expect(
      r.run(mkPage({ robotsMeta: "noindex", robotsMetas: metas(["googlebot", "noindex"]) })),
    ).toHaveLength(0);
    expect(
      r.run(mkPage({ robotsMeta: null, robotsMetas: metas(["googlebot", "index, follow"]) })),
    ).toHaveLength(0);
    expect(r.run(mkPage({ robotsMeta: "noindex", robotsMetas: [] }))).toHaveLength(0);
  });

  it("is silent on a v1 row", () => {
    expect(r.run(mkV1Page({ robotsMeta: "noindex" }))).toHaveLength(0);
  });
});
