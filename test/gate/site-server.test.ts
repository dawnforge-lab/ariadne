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
import { siteFixture, startSiteServer } from "./site-server.js";

const PAGES = 1_000;
const BASE = "http://127.0.0.1:9999";
const site = siteFixture.layout(PAGES);

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
      const xml = siteFixture.sitemapShard(shard, site, BASE);
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
