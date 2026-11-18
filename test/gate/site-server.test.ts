/**
 * The gate fixture's own guarantees, checked cheaply.
 *
 * The 50k gate runs from scripts, not from `npm test` — but the three
 * properties the gate's conclusions rest on are pure functions of the page
 * count, so they cost milliseconds to verify here: the site is deterministic,
 * the link graph reaches every page from `/`, and the sitemap shards declare
 * every URL exactly once. A fixture that quietly failed any of those would turn
 * a crawler defect into a green gate.
 */
import { describe, expect, it } from "vitest";
import { SITEMAP_MAX_BYTES } from "../../src/crawl/sitemap-stream.js";
import { plantSwitch, portSwitch, siteFixture, sitemapHreflangSwitch, startSiteServer } from "./site-server.js";

const PAGES = 1_000;
const BASE = "http://127.0.0.1:9999";
const site = siteFixture.layout(PAGES);
const OFF = { sitemapHreflang: false };
const ON = { sitemapHreflang: true };

describe("gate site fixture", () => {
  it("splits the index space into home, products and blog with nothing left over", () => {
    expect(site.products + site.blog + 1).toBe(PAGES);
    expect(siteFixture.pathOfIndex(0, site)).toBe("/");
    expect(siteFixture.pathOfIndex(1, site)).toBe("/products/p0");
    expect(siteFixture.pathOfIndex(site.products + 1, site)).toBe("/blog/0");
  });

  it("round-trips every index through its path", () => {
    for (let index = 0; index < PAGES; index++) {
      expect(siteFixture.indexOfPath(siteFixture.pathOfIndex(index, site), site)).toBe(index);
    }
  });

  it("404s outside the index space", () => {
    expect(siteFixture.page(`/products/p${site.products}`, site, BASE)).toBeNull();
    expect(siteFixture.page(`/blog/${site.blog}`, site, BASE)).toBeNull();
    expect(siteFixture.page("/nothing/here", site, BASE)).toBeNull();
  });

  it("serves byte-identical HTML for a path, every time", () => {
    const once = siteFixture.page("/products/p42", site, BASE);
    const twice = siteFixture.page("/products/p42", site, BASE);
    expect(once).toBe(twice);
    // Distinct pages are distinct documents, not one page under many URLs.
    expect(siteFixture.page("/products/p43", site, BASE)).not.toBe(once);
  });

  it("serves pages of roughly the intended weight", () => {
    const html = siteFixture.page("/products/p7", site, BASE) ?? "";
    expect(Buffer.byteLength(html)).toBeGreaterThan(12_000);
    expect(Buffer.byteLength(html)).toBeLessThan(20_000);
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('hreflang="fr"');
  });

  it("reaches every page from the home page through links alone", () => {
    const seen = new Uint8Array(PAGES);
    const queue = [0];
    seen[0] = 1;
    let reached = 1;
    while (queue.length > 0) {
      const index = queue.pop() as number;
      for (const target of siteFixture.linkTargets(index, site)) {
        if (seen[target] === 1) continue;
        seen[target] = 1;
        reached++;
        queue.push(target);
      }
    }
    expect(reached).toBe(PAGES);
  });

  it("declares every URL exactly once across the sitemap shards", () => {
    const declared = new Set<string>();
    for (let shard = 0; shard < siteFixture.sitemapShards; shard++) {
      const xml = siteFixture.sitemapShard(shard, site, BASE, OFF);
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const loc = match[1] as string;
        expect(declared.has(loc)).toBe(false);
        declared.add(loc);
      }
    }
    expect(declared.size).toBe(PAGES);
    expect(declared.has(`${BASE}/`)).toBe(true);
  });

  it("serves over HTTP what the pure core says it should", async () => {
    const server = await startSiteServer(PAGES);
    try {
      const page = await fetch(`${server.base}/products/p3`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toBe(siteFixture.page("/products/p3", site, server.base));

      const robots = await fetch(`${server.base}/robots.txt`);
      expect(await robots.text()).toContain("Crawl-delay: 0");

      const missing = await fetch(`${server.base}/products/p999999`);
      expect(missing.status).toBe(404);
      await missing.text();
    } finally {
      await server.close();
    }
  });
});

/**
 * The Phase 26c gate switch, `GATE_SITEMAP_HREFLANG=1`. Off must be the
 * baseline fixture byte for byte (the memory comparison is like for like only
 * then); on must change the sitemap shards and nothing else.
 */
describe("gate site fixture: sitemap hreflang switch", () => {
  /** The shard builder as it was before the switch: the off output's oracle. */
  function legacyShard(shard: number, base: string): string {
    const per = Math.ceil(site.pages / siteFixture.sitemapShards);
    const start = shard * per;
    const end = Math.min(start + per, site.pages);
    const urls: string[] = [];
    for (let index = start; index < end; index++) {
      urls.push(`<url><loc>${base}${siteFixture.pathOfIndex(index, site)}</loc><lastmod>2026-08-25</lastmod></url>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
  }

  /** `<loc>` -> its alternates, code -> href, read off one shard. */
  function alternatesOf(xml: string): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    for (const entry of xml.matchAll(/<url><loc>([^<]+)<\/loc>(.*?)<\/url>/g)) {
      const codes = new Map<string, string>();
      for (const link of (entry[2] as string).matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)) {
        expect(codes.has(link[1] as string), `one code once in ${entry[1]}`).toBe(false);
        codes.set(link[1] as string, link[2] as string);
      }
      out.set(entry[1] as string, codes);
    }
    return out;
  }

  it("reads the switch from GATE_SITEMAP_HREFLANG, and refuses anything but 1, 0 or unset", () => {
    expect(sitemapHreflangSwitch({})).toBe(false);
    expect(sitemapHreflangSwitch({ GATE_SITEMAP_HREFLANG: "" })).toBe(false);
    expect(sitemapHreflangSwitch({ GATE_SITEMAP_HREFLANG: "0" })).toBe(false);
    expect(sitemapHreflangSwitch({ GATE_SITEMAP_HREFLANG: "1" })).toBe(true);
    expect(() => sitemapHreflangSwitch({ GATE_SITEMAP_HREFLANG: "yes" })).toThrow(
      /GATE_SITEMAP_HREFLANG must be 1, 0 or unset/,
    );
  });

  it("serves the shards it always served when off", () => {
    for (let shard = 0; shard < siteFixture.sitemapShards; shard++) {
      expect(siteFixture.sitemapShard(shard, site, BASE, OFF)).toBe(legacyShard(shard, BASE));
    }
  });

  it("gives every <url> at least 10 locales and x-default, all served pages, every cluster reciprocal", () => {
    const all = new Map<string, Map<string, string>>();
    for (let shard = 0; shard < siteFixture.sitemapShards; shard++) {
      for (const [loc, codes] of alternatesOf(siteFixture.sitemapShard(shard, site, BASE, ON))) {
        all.set(loc, codes);
      }
    }
    expect(all.size).toBe(PAGES);
    let widest = 0;
    for (const [loc, codes] of all) {
      expect(codes.size, loc).toBeGreaterThanOrEqual(11);
      widest = Math.max(widest, codes.size);
      expect(codes.has("x-default"), loc).toBe(true);
      expect(codes.has("en") || codes.has("fr"), "never a code the page HTML states").toBe(false);
      for (const [code, href] of codes) {
        expect(href.startsWith(BASE), href).toBe(true);
        expect(siteFixture.indexOfPath(href.slice(BASE.length), site), href).not.toBeNull();
        if (code === "x-default") continue;
        expect(siteFixture.hreflangLocales).toContain(code);
        // Reciprocal: the target names the same cluster, so it lists `loc` back.
        expect(all.get(href), `${href} lists ${loc}`).toEqual(codes);
      }
    }
    // 1,000 pages: 90 clusters, the last 10 left over join the 90th (21 + x-default).
    expect(widest).toBe(siteFixture.hreflangLocales.length + 1);
  });

  it("keeps every shard of the 50,000-page gate site under the protocol's 50 MB", () => {
    const gate = siteFixture.layout(50_000);
    for (let shard = 0; shard < siteFixture.sitemapShards; shard++) {
      let bytes = 0;
      for (const piece of siteFixture.sitemapShardPieces(shard, gate, "http://127.0.0.1:65535", ON)) {
        bytes += Buffer.byteLength(piece);
      }
      expect(bytes).toBeGreaterThan(15 * 1024 * 1024);
      expect(bytes).toBeLessThan(SITEMAP_MAX_BYTES);
    }
  });

  it("changes the sitemap shards over HTTP and nothing else", async () => {
    const off = await startSiteServer(PAGES, OFF);
    const on = await startSiteServer(PAGES, ON);
    expect(off.sitemapHreflang).toBe(false);
    expect(on.sitemapHreflang).toBe(true);
    const read = async (server: typeof off, path: string) => {
      const response = await fetch(`${server.base}${path}`);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        body: (await response.text()).replaceAll(server.base, "BASE"),
      };
    };
    try {
      for (const path of ["/", "/products/p3", "/blog/7", "/robots.txt", "/sitemap.xml", "/media/1-0.jpg", "/sitemap-9.xml"]) {
        expect(await read(on, path), path).toEqual(await read(off, path));
      }
      for (let shard = 0; shard < siteFixture.sitemapShards; shard++) {
        const plain = await read(off, `/sitemap-${shard}.xml`);
        const annotated = await read(on, `/sitemap-${shard}.xml`);
        expect(plain.body).toBe(legacyShard(shard, "BASE"));
        expect(annotated.status).toBe(200);
        expect(annotated.type).toBe(plain.type);
        expect(annotated.body).toContain("<xhtml:link ");
        // Strip what the switch adds and the shard is the plain one.
        const stripped = annotated.body
          .replace(' xmlns:xhtml="http://www.w3.org/1999/xhtml"', "")
          .replace(/<xhtml:link [^>]*\/>/g, "");
        expect(stripped).toBe(plain.body);
      }
    } finally {
      await off.close();
      await on.close();
    }
  });
});

/**
 * The Phase 29c plant, `GATE_PLANT=1` (R12): three index sets whose answers a
 * crawl diff can be checked against. Off is the baseline fixture; on changes
 * only what R12 names.
 */
describe("gate site fixture: planted variant", () => {
  const SMALL = 2_500;
  const small = siteFixture.layout(SMALL);
  const planted = siteFixture.layout(SMALL, true);
  const sets = siteFixture.plantedSets(SMALL);
  const OFF_PLAIN = { sitemapHreflang: false, plant: false };
  const ON_PLANT = { sitemapHreflang: false, plant: true };

  const titleOf = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";

  it("reads the switch from GATE_PLANT, and refuses anything but 1, 0 or unset", () => {
    expect(plantSwitch({})).toBe(false);
    expect(plantSwitch({ GATE_PLANT: "" })).toBe(false);
    expect(plantSwitch({ GATE_PLANT: "0" })).toBe(false);
    expect(plantSwitch({ GATE_PLANT: "1" })).toBe(true);
    expect(() => plantSwitch({ GATE_PLANT: "yes" })).toThrow(/GATE_PLANT must be 1, 0 or unset/);
  });

  it("reads GATE_PORT: unset is ephemeral, an integer 1..65535 is the port, anything else is refused", () => {
    expect(portSwitch({})).toBe(0);
    expect(portSwitch({ GATE_PORT: "" })).toBe(0);
    expect(portSwitch({ GATE_PORT: "45791" })).toBe(45_791);
    for (const bad of ["0", "70000", "abc", "1.5"]) {
      expect(() => portSwitch({ GATE_PORT: bad })).toThrow(/GATE_PORT must be an integer/);
    }
  });

  it("plants R12's index sets: 5 titles, 2 statuses, 1 removed at 2,500 pages, disjoint", () => {
    expect(sets.titles).toHaveLength(5);
    expect(sets.statuses).toHaveLength(2);
    expect(sets.removed).toHaveLength(1);
    const indices = (paths: string[]): number[] =>
      paths.map((path) => siteFixture.indexOfPath(path, small) as number);
    expect(indices(sets.titles)).toEqual([250, 750, 1250, 1750, 2250]);
    expect(indices(sets.statuses)).toEqual([500, 1500]);
    expect(indices(sets.removed)).toEqual([1000]);
    expect(new Set([...sets.titles, ...sets.statuses, ...sets.removed]).size).toBe(8);
    expect(siteFixture.plantedSets(50_000).titles).toHaveLength(100);
    expect(siteFixture.plantedSets(50_000).statuses).toHaveLength(50);
    expect(siteFixture.plantedSets(50_000).removed).toHaveLength(25);
  });

  it("changes only <title> on a retitled page, to `Retitled <original>`", () => {
    for (const path of sets.titles) {
      const before = siteFixture.page(path, small, BASE) as string;
      const after = siteFixture.page(path, planted, BASE) as string;
      expect(titleOf(after)).toBe(`Retitled ${titleOf(before)}`);
      expect(after.replace(/<title>[^<]*<\/title>/, "")).toBe(before.replace(/<title>[^<]*<\/title>/, ""));
    }
  });

  it("leaves every other page byte-identical to the baseline", () => {
    const touched = new Set(sets.titles);
    for (const index of [0, 1, 249, 251, 499, 501, 999, 1001, 2499]) {
      const path = siteFixture.pathOfIndex(index, small);
      if (touched.has(path)) continue;
      // Pages that link to the removed page lose one anchor; compare the rest.
      const strip = (html: string): string => html.replace(/<li><a href="[^"]*">[^<]*<\/a><\/li>\n?/g, "");
      expect(strip(siteFixture.page(path, planted, BASE) as string), path).toBe(
        strip(siteFixture.page(path, small, BASE) as string),
      );
    }
  });

  it("answers 410 for the status set, 404 for the removed set, and 200 otherwise", async () => {
    const server = await startSiteServer(SMALL, ON_PLANT);
    try {
      for (const path of sets.statuses) {
        const response = await fetch(`${server.base}${path}`);
        expect(response.status, path).toBe(410);
        await response.text();
      }
      for (const path of sets.removed) {
        const response = await fetch(`${server.base}${path}`);
        expect(response.status, path).toBe(404);
        await response.text();
      }
      for (const path of [...sets.titles, "/", "/products/p3"]) {
        const response = await fetch(`${server.base}${path}`);
        expect(response.status, path).toBe(200);
        await response.text();
      }
    } finally {
      await server.close();
    }
  });

  it("answers the baseline when plant is off, 410 and 404 sets included", async () => {
    const server = await startSiteServer(SMALL, OFF_PLAIN);
    try {
      for (const path of [...sets.statuses, ...sets.removed]) {
        const response = await fetch(`${server.base}${path}`);
        expect(response.status, path).toBe(200);
        await response.text();
      }
    } finally {
      await server.close();
    }
  });

  it("lists a removed page in no link and no sitemap shard", () => {
    const removed = new Set(sets.removed.map((path) => `${BASE}${path}`));
    const removedIndex = siteFixture.indexOfPath(sets.removed[0] as string, small) as number;
    for (let index = 0; index < SMALL; index++) {
      expect(siteFixture.linkTargets(index, planted)).not.toContain(removedIndex);
    }
    for (let shard = 0; shard < siteFixture.sitemapShards; shard++) {
      const xml = siteFixture.sitemapShard(shard, planted, BASE, OFF_PLAIN);
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        expect(removed.has(match[1] as string)).toBe(false);
      }
    }
    // Pages elsewhere still link: the plant removes anchors to one page only.
    expect(siteFixture.linkTargets(0, planted).length).toBeGreaterThanOrEqual(siteFixture.linksPerPage - 1);
  });

  it("declares every non-removed URL exactly once across the planted shards", () => {
    const declared = new Set<string>();
    for (let shard = 0; shard < siteFixture.sitemapShards; shard++) {
      for (const match of siteFixture.sitemapShard(shard, planted, BASE, OFF_PLAIN).matchAll(/<loc>([^<]+)<\/loc>/g)) {
        expect(declared.has(match[1] as string)).toBe(false);
        declared.add(match[1] as string);
      }
    }
    expect(declared.size).toBe(SMALL - sets.removed.length);
  });

  it("reaches every non-removed page from / through links alone", () => {
    const removed = new Set(sets.removed.map((path) => siteFixture.indexOfPath(path, small) as number));
    const seen = new Uint8Array(SMALL);
    const queue = [0];
    seen[0] = 1;
    let reached = 1;
    while (queue.length > 0) {
      const index = queue.pop() as number;
      for (const target of siteFixture.linkTargets(index, planted)) {
        if (seen[target] === 1) continue;
        seen[target] = 1;
        reached++;
        queue.push(target);
      }
    }
    expect(reached).toBe(SMALL - removed.size);
    for (const index of removed) expect(seen[index]).toBe(0);
  });
});
