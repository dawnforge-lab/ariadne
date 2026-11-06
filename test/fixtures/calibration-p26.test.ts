/**
 * The calibration ladders are built to measured specifications; this file
 * checks the specifications hold, so a regenerated glyph table or an edited
 * builder cannot quietly turn a ladder into one whose rungs are not where their
 * labels say. Nothing here crawls — the ladders are crawled by
 * scripts/calibrate-sf.ts, against Screaming Frog, and nowhere else.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serpWidth } from "../../src/rules/serp-width.js";
import { allFixtures } from "./fixture.js";
import {
  CALIBRATION_PREFIX,
  DEPTH_CHAIN_LENGTH,
  EXTERNAL_OUTLINK_LADDER,
  INTERNAL_OUTLINK_LADDER,
  META_PX_BRACKETS,
  META_PX_LADDER,
  NO_PREV_A,
  NO_PREV_B,
  OUTLINK_TARGET_PATH,
  SELF_ONLY_SINGLE,
  TITLE_PX_BRACKETS,
  TITLE_PX_LADDER,
  calibrationFixtures,
  textOfWidth,
} from "./pages/calibration-p26.js";

const fixtures = calibrationFixtures();
const byPath = new Map(fixtures.map((f) => [f.path, f]));

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const fixture = byPath.get(path);
    if (fixture === undefined) {
      res.writeHead(404).end();
      return;
    }
    fixture.handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e === undefined ? resolve() : reject(e))),
  );
});

async function html(path: string): Promise<string> {
  const res = await fetch(`${base}${path}`);
  expect(res.status).toBe(200);
  return res.text();
}

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

describe("the calibration ladders", () => {
  it("are not harness fixtures, and live under one prefix with unique paths", () => {
    const harnessPaths = new Set(allFixtures().map((f) => f.path));
    for (const f of fixtures) {
      expect(f.path.startsWith(`${CALIBRATION_PREFIX}/`)).toBe(true);
      expect(harnessPaths.has(f.path)).toBe(false);
    }
    expect(byPath.size).toBe(fixtures.length);
  });

  it("spaces the even pixel ladders evenly between the stated ends", () => {
    expect(TITLE_PX_LADDER).toHaveLength(12);
    expect(TITLE_PX_LADDER[0]).toBe(150);
    expect(TITLE_PX_LADDER[11]).toBe(600);
    expect(META_PX_LADDER).toHaveLength(12);
    expect(META_PX_LADDER[0]).toBe(300);
    expect(META_PX_LADDER[11]).toBe(1050);
    expect(TITLE_PX_BRACKETS).toEqual([197, 199, 200, 201, 203, 558, 560, 561, 562, 564, 540, 545, 550, 552, 554, 556]);
    expect(META_PX_BRACKETS).toEqual([397, 399, 400, 401, 403, 982, 984, 985, 986, 988]);
  });

  it("builds text within half a pixel of the target, and refuses one it cannot reach", () => {
    for (const target of [150, 333.3, 561, 600]) {
      const w = serpWidth(textOfWidth("Title rung 99", target, "title"), "title")!;
      expect(Math.abs(w - target)).toBeLessThanOrEqual(0.5);
    }
    // The prefix alone is wider than the target: no string reaches it.
    expect(() => textOfWidth("A very long prefix that is already wide", 50, "title")).toThrow(
      /could not build/,
    );
  });

  it("serves each title rung at the width its target names", async () => {
    const targets = [...TITLE_PX_LADDER, ...TITLE_PX_BRACKETS];
    for (const [i, target] of targets.entries()) {
      const page = await html(`${CALIBRATION_PREFIX}/title-px/${String(i + 1).padStart(2, "0")}`);
      const title = decode(/<title>([^<]*)<\/title>/.exec(page)![1]!);
      expect(Math.abs(serpWidth(title, "title")! - target)).toBeLessThanOrEqual(0.5);
    }
  });

  it("serves each description rung at the width its target names", async () => {
    const targets = [...META_PX_LADDER, ...META_PX_BRACKETS];
    for (const [i, target] of targets.entries()) {
      const page = await html(`${CALIBRATION_PREFIX}/meta-px/${String(i + 1).padStart(2, "0")}`);
      const description = decode(/<meta name="description" content="([^"]*)">/.exec(page)![1]!);
      expect(Math.abs(serpWidth(description, "description")! - target)).toBeLessThanOrEqual(0.5);
    }
  });

  it("gives each outlink rung exactly N distinct targets of its kind and no other link", async () => {
    for (const n of INTERNAL_OUTLINK_LADDER) {
      const hrefs = [...(await html(`${CALIBRATION_PREFIX}/outlinks/internal/${n}`)).matchAll(/<a href="([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      expect(new Set(hrefs).size).toBe(n);
      expect(hrefs.every((h) => h.startsWith(`${OUTLINK_TARGET_PATH}?n=`))).toBe(true);
    }
    for (const n of EXTERNAL_OUTLINK_LADDER) {
      const hrefs = [...(await html(`${CALIBRATION_PREFIX}/outlinks/external/${n}`)).matchAll(/<a href="([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      expect(new Set(hrefs).size).toBe(n);
      expect(hrefs.every((h) => h.startsWith("https://example.com/"))).toBe(true);
    }
  });

  it("answers the outlink target for any n, with a title naming it", async () => {
    expect(await html(`${OUTLINK_TARGET_PATH}?n=1001`)).toContain(
      "<title>Calibration outlink target number 1001</title>",
    );
  });

  it("delays a response-time rung by its stated milliseconds", async () => {
    const started = Date.now();
    await html(`${CALIBRATION_PREFIX}/slow/500`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it("gives the pagination probe a rel=next on page 1 and no rel=prev on page 2", async () => {
    const a = await html(NO_PREV_A);
    const b = await html(NO_PREV_B);
    expect(a).toContain(`<link rel="next" href="${base}${NO_PREV_B}">`);
    expect(a).not.toContain('rel="prev"');
    expect(b).not.toMatch(/rel="(?:prev|next)"/);
  });

  it("gives the hreflang probe exactly one alternate, to itself, and no x-default", async () => {
    const page = await html(SELF_ONLY_SINGLE);
    const alternates = [...page.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)];
    expect(alternates.map((m) => [m[1], m[2]])).toEqual([["en", `${base}${SELF_ONLY_SINGLE}`]]);
  });

  it("chains the depth rungs one link at a time, with only the first linked from the hub", async () => {
    for (let level = 1; level <= DEPTH_CHAIN_LENGTH; level++) {
      const f = byPath.get(`${CALIBRATION_PREFIX}/depth/${level}`)!;
      expect(f.linkedFromHub).toBe(level === 1);
      expect(f.inSitemap).toBe(false);
      const hrefs = [...(await html(f.path)).matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs).toEqual(level < DEPTH_CHAIN_LENGTH ? [`${CALIBRATION_PREFIX}/depth/${level + 1}`] : []);
    }
  });
});
