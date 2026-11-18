/**
 * The renderer's image stand-ins and the per-<img> classification (Phase 29b
 * Task 3), as pure functions. The browser half — a real Chromium answering
 * image requests with these SVGs and measuring the boxes — is in
 * renderer.test.ts; this file pins the arithmetic and the in-page srcset parser
 * against hand-built inputs, where every expected number is derivable by eye.
 */
import { describe, expect, it } from "vitest";

import {
  IMAGE_LOOKUP_CONCURRENCY,
  IMAGES_MEASURE_SCRIPT,
  MAX_RENDER_IMAGES,
  RENDER_IMAGES_KEPT,
  SRCSET_LOOKUP_SCRIPT,
  SRCSET_MAX_SIBLINGS,
  checkStoredImage,
  classifyImages,
  perRenderLookup,
  readImageMeasurement,
  readSrcsetReply,
  srcsetStandIn,
  standInSvg,
  type ImageDimensionLookup,
  type ImageLoadState,
  type RenderImage,
  type StoredImage,
} from "../../src/crawl/render/image-stand-in.js";
import { RENDER_CONSOLE_MAX_CHARS } from "../../src/crawl/render/console-capture.js";

type Served = StoredImage & { widthFrom: RenderImage["widthFrom"] };

const BASE = "https://shop.example/";

describe("standInSvg", () => {
  it("is an empty SVG of exactly the intrinsic size", () => {
    expect(standInSvg(1600, 1200)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"/>',
    );
  });

  it("refuses a size that is not a positive integer", () => {
    expect(() => standInSvg(0, 10)).toThrow(RangeError);
    expect(() => standInSvg(10, -1)).toThrow(RangeError);
    expect(() => standInSvg(10.5, 10)).toThrow(RangeError);
    expect(() => standInSvg(Number.NaN, 10)).toThrow(RangeError);
  });
});

describe("classifyImages", () => {
  it("counts hidden, unrequested and undimensioned images and measures the rest", () => {
    const u = (p: string) => `${BASE}${p}`;
    const served = new Map<string, Served>([
      [u("wide.png"), { width: 1600, height: 1200, bytes: 90_000, widthFrom: "stored" }],
      [u("exact.png"), { width: 800, height: 600, bytes: 40_000, widthFrom: "stored" }],
      [u("mid.png"), { width: 1000, height: 750, bytes: null, widthFrom: "srcset-w" }],
    ]);
    const requested = new Set([
      u("hidden.png"),
      u("nodims.png"),
      u("wide.png"),
      u("exact.png"),
      u("mid.png"),
    ]);
    const result = classifyImages(
      {
        total: 7,
        rows: [
          [u("hidden.png"), 0, 0, "eager", "loaded"],
          [u("lazy.png"), 400, 300, "lazy", "loaded"],
          [u("plain.png"), 400, 300, "eager", "loaded"],
          [u("nodims.png"), 400, 300, "eager", "loaded"],
          [u("wide.png"), 400, 300, "eager", "loaded"],
          [u("exact.png"), 800, 600, "eager", "loaded"],
          [u("mid.png"), 600, 450, "eager", "loaded"],
        ],
      },
      served,
      requested,
    );

    expect(result).toMatchObject({
      total: 7,
      examined: 7,
      measured: 3,
      hidden: 1,
      lazyUnloaded: 1,
      notRequested: 1,
      noDimensions: 1,
      broken: 0,
      widerThanDisplayed: 2,
      standIns: 3,
    });
    // Only images wider than their box are kept, worst waste first:
    // 1600×1200 − 400×300 = 1,800,000 and 1000×750 − 600×450 = 480,000.
    expect(result.kept).toEqual([
      {
        url: u("wide.png"),
        cut: false,
        intrinsicWidth: 1600,
        intrinsicHeight: 1200,
        displayedWidth: 400,
        displayedHeight: 300,
        wastedPixels: 1_800_000,
        bytes: 90_000,
        widthFrom: "stored",
      },
      {
        url: u("mid.png"),
        cut: false,
        intrinsicWidth: 1000,
        intrinsicHeight: 750,
        displayedWidth: 600,
        displayedHeight: 450,
        wastedPixels: 480_000,
        bytes: null,
        widthFrom: "srcset-w",
      },
    ]);
  });

  it("counts a stand-in the browser could not display as broken, never measured", () => {
    // I1: e.g. a cors-mode request the stand-in did not satisfy. A broken
    // image still has a box (the browser's broken-image glyph), which must
    // never be read as an oversized image.
    const url = `${BASE}cors.png`;
    const result = classifyImages(
      { total: 1, rows: [[url, 16, 16, "eager", "broken"]] },
      new Map<string, Served>([[url, { width: 1600, height: 1200, bytes: 1, widthFrom: "stored" }]]),
      new Set([url]),
    );
    expect(result).toMatchObject({ broken: 1, measured: 0, widerThanDisplayed: 0, standIns: 1 });
    expect(result.kept).toEqual([]);
  });

  it("counts a served stand-in still loading at measurement as noDimensions, never measured", () => {
    // Its box (an attribute or CSS size, or an alt-text box) was laid out
    // without the image, so it is neither judged nor counted as measured.
    const url = `${BASE}late.png`;
    const result = classifyImages(
      { total: 1, rows: [[url, 40, 16, "eager", "loading"]] },
      new Map<string, Served>([[url, { width: 1600, height: 1200, bytes: 1, widthFrom: "stored" }]]),
      new Set([url]),
    );
    expect(result).toMatchObject({ noDimensions: 1, measured: 0, widerThanDisplayed: 0, standIns: 1 });
    expect(result.kept).toEqual([]);
  });

  it("counts an image still loading with no currentSrc yet as noDimensions, not notRequested", () => {
    // Chromium reports an empty currentSrc until the image's answer arrives:
    // an image whose stand-in lookup was still running when the page was
    // measured. A lazy one stays lazyUnloaded, as documented.
    const result = classifyImages(
      {
        total: 2,
        rows: [
          ["", 200, 100, "auto", "loading"],
          ["", 200, 100, "lazy", "loading"],
        ],
      },
      new Map<string, Served>(),
      new Set([`${BASE}slow.png`]),
    );
    expect(result).toMatchObject({ noDimensions: 1, lazyUnloaded: 1, notRequested: 0, measured: 0 });
  });

  it("calls a box under 1×1 in either direction hidden, before anything else", () => {
    const url = `${BASE}a.png`;
    const served = new Map<string, Served>([
      [url, { width: 100, height: 100, bytes: 1, widthFrom: "stored" }],
    ]);
    const result = classifyImages(
      { total: 2, rows: [[url, 0, 40, "eager", "loaded"], [url, 40, 0, "lazy", "loaded"]] },
      served,
      new Set([url]),
    );
    expect(result.hidden).toBe(2);
    expect(result.measured).toBe(0);
  });

  it("keeps the 50 worst of 60 wider images, and says how many there were", () => {
    const served = new Map<string, Served>();
    const requested = new Set<string>();
    const rows: [string, number, number, string, ImageLoadState][] = [];
    for (let i = 0; i < 60; i += 1) {
      const url = `${BASE}img-${String(i).padStart(2, "0")}.png`;
      served.set(url, { width: 1000 + i, height: 500, bytes: i, widthFrom: "stored" });
      requested.add(url);
      rows.push([url, 100, 50, "eager", "loaded"]);
    }
    const result = classifyImages({ total: 60, rows }, served, requested);
    expect(result.measured).toBe(60);
    expect(result.widerThanDisplayed).toBe(60);
    expect(result.kept.length).toBe(RENDER_IMAGES_KEPT);
    expect(RENDER_IMAGES_KEPT).toBe(50);
    // Widest (most wasted) first: img-59 down to img-10.
    expect(result.kept[0]!.url).toBe(`${BASE}img-59.png`);
    expect(result.kept[49]!.url).toBe(`${BASE}img-10.png`);
  });

  it("breaks a wasted-pixel tie by bytes (unknown last), then by url", () => {
    const served = new Map<string, Served>([
      [`${BASE}b.png`, { width: 200, height: 100, bytes: null, widthFrom: "stored" }],
      [`${BASE}a.png`, { width: 200, height: 100, bytes: null, widthFrom: "stored" }],
      [`${BASE}c.png`, { width: 200, height: 100, bytes: 5, widthFrom: "stored" }],
    ]);
    const urls = [...served.keys()];
    const result = classifyImages(
      { total: 3, rows: urls.map((u) => [u, 100, 100, "eager", "loaded"] as [string, number, number, string, ImageLoadState]) },
      served,
      new Set(urls),
    );
    expect(result.kept.map((k) => k.url)).toEqual([`${BASE}c.png`, `${BASE}a.png`, `${BASE}b.png`]);
  });

  it("never reports negative waste: an image shown larger than it is wastes nothing", () => {
    const url = `${BASE}up.png`;
    const result = classifyImages(
      { total: 1, rows: [[url, 400, 400, "eager", "loaded"]] },
      new Map<string, Served>([[url, { width: 100, height: 100, bytes: 1, widthFrom: "stored" }]]),
      new Set([url]),
    );
    expect(result.measured).toBe(1);
    expect(result.widerThanDisplayed).toBe(0);
    expect(result.kept).toEqual([]);
  });

  it("stores a url through the console's cap, and says it was cut", () => {
    const url = `${BASE}${"x".repeat(RENDER_CONSOLE_MAX_CHARS + 50)}.png`;
    const result = classifyImages(
      { total: 1, rows: [[url, 10, 10, "eager", "loaded"]] },
      new Map<string, Served>([[url, { width: 100, height: 100, bytes: 1, widthFrom: "stored" }]]),
      new Set([url]),
    );
    expect(result.kept[0]!.cut).toBe(true);
    expect(result.kept[0]!.url.length).toBe(RENDER_CONSOLE_MAX_CHARS);
  });
});

describe("perRenderLookup (M2)", () => {
  /** A lookup whose answers the test releases by hand, recording each call. */
  function manualLookup() {
    const calls: string[][] = [];
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const lookup: ImageDimensionLookup = async (urls) => {
      calls.push([...urls]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      return new Map(urls.map((u) => [u, { width: 10, height: 10, bytes: null }]));
    };
    const releaseAll = async (): Promise<void> => {
      // Let the queued calls reach the lookup first.
      await new Promise((r) => setTimeout(r, 0));
      while (pending.length > 0) {
        pending.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    return { lookup, calls, pending, releaseAll, max: () => maxInFlight };
  }

  it("asks for each URL once per render, however often the page requests it", async () => {
    const m = manualLookup();
    const once = perRenderLookup(m.lookup);
    const a = once(["u1"]);
    const b = once(["u1"]);
    const c = once(["u1", "u2"]);
    await m.releaseAll();
    await Promise.all([a, b, c]);
    expect(m.calls).toEqual([["u1"], ["u2"]]);
    expect((await c).size).toBe(2);
  });

  it(`never has more than ${IMAGE_LOOKUP_CONCURRENCY} lookups waiting on the database at once`, async () => {
    expect(IMAGE_LOOKUP_CONCURRENCY).toBe(4);
    const m = manualLookup();
    const capped = perRenderLookup(m.lookup);
    const all = Array.from({ length: 12 }, (_, i) => capped([`u${i}`]));
    await new Promise((r) => setTimeout(r, 0));
    expect(m.pending.length).toBe(IMAGE_LOOKUP_CONCURRENCY);
    await m.releaseAll();
    const answers = await Promise.all(all);
    expect(answers.every((a) => a.size === 1)).toBe(true);
    expect(m.calls.length).toBe(12);
    expect(m.max()).toBe(IMAGE_LOOKUP_CONCURRENCY);
  });

  it("passes a rejection through to every caller of that URL: it is ours", async () => {
    const failing = perRenderLookup(async () => {
      throw new Error("db down");
    });
    await expect(failing(["u"])).rejects.toThrow("db down");
    await expect(failing(["u"])).rejects.toThrow("db down");
  });
});

describe("checkStoredImage", () => {
  it("passes a real size through and throws on an impossible one: the lookup is ours", () => {
    expect(checkStoredImage({ width: 1, height: 2, bytes: null }, "u")).toEqual({
      width: 1,
      height: 2,
      bytes: null,
    });
    for (const bad of [
      { width: 0, height: 2, bytes: 1 },
      { width: 1, height: 2 ** 31, bytes: 1 },
      { width: 1.5, height: 2, bytes: 1 },
      { width: 1, height: 2, bytes: -1 },
    ]) {
      expect(() => checkStoredImage(bad, "https://a/b.png"), JSON.stringify(bad)).toThrow(
        /impossible size for https:\/\/a\/b\.png/,
      );
    }
  });
});

describe("srcsetStandIn", () => {
  it("takes the descriptor's width and the stored sibling's aspect ratio", () => {
    expect(srcsetStandIn(1600, { width: 400, height: 300, bytes: 9 })).toEqual({
      width: 1600,
      height: 1200,
      bytes: null,
      widthFrom: "srcset-w",
    });
  });

  it("gives no stand-in when the derived height rounds below one pixel", () => {
    expect(srcsetStandIn(1, { width: 1000, height: 1, bytes: null })).toBeNull();
  });
});

/**
 * The in-page srcset lookup, run in Node over a stand-in `document`: the
 * script reads only `document.baseURI` and `querySelectorAll`, and the parser
 * inside it is the HTML spec's "parse a srcset attribute" algorithm, which is
 * what these cases pin.
 */
function lookup(
  srcsets: string[],
  requestUrl: string,
  baseURI = BASE,
): unknown {
  const elements = srcsets.map((s) => ({ getAttribute: (n: string) => (n === "srcset" ? s : null) }));
  const fakeDocument = { baseURI, querySelectorAll: () => elements };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("document", `return (${SRCSET_LOOKUP_SCRIPT});`)(fakeDocument) as (
    url: string,
  ) => unknown;
  return fn(requestUrl);
}

describe("SRCSET_LOOKUP_SCRIPT", () => {
  it("finds the request's candidate and names its siblings, resolved", () => {
    expect(lookup(["a-400.png 400w, a-1600.png 1600w"], `${BASE}a-1600.png`)).toEqual({
      w: 1600,
      candidates: [`${BASE}a-400.png`],
    });
  });

  it("answers null when no srcset names the request", () => {
    expect(lookup(["a-400.png 400w"], `${BASE}other.png`)).toBeNull();
  });

  it("gives w null for a density candidate", () => {
    expect(lookup(["a.png 1x, a@2x.png 2x"], `${BASE}a@2x.png`)).toEqual({
      w: null,
      candidates: [`${BASE}a.png`],
    });
  });

  it("keeps commas inside a URL and splits on the comma after a descriptor", () => {
    expect(
      lookup(["/img/a,b.png 300w,/img/c.png 600w"], `${BASE}img/a,b.png`),
    ).toEqual({ w: 300, candidates: [`${BASE}img/c.png`] });
  });

  it("strips trailing commas from a descriptor-less URL", () => {
    expect(lookup(["x.png,, y.png 2x"], `${BASE}x.png`)).toEqual({
      w: null,
      candidates: [`${BASE}y.png`],
    });
  });

  it("drops a candidate whose descriptors are invalid, as the spec does", () => {
    // `0w` is an error, `400w 2x` is an error, `100h` without a width is an
    // error, `(a b) 400w` keeps the parenthesised future-compat token whole
    // and still errors on it.
    for (const srcset of ["a.png 0w", "a.png 400w 2x", "a.png 100h", "a.png (a b) 400w"]) {
      expect(lookup([srcset], `${BASE}a.png`), srcset).toBeNull();
    }
    // A valid w + h pair is accepted; the width is what is returned.
    expect(lookup(["a.png 400w 300h"], `${BASE}a.png`)).toEqual({ w: 400, candidates: [] });
  });

  it("matches the request without its fragment, and does not list it as its own sibling", () => {
    expect(
      lookup(["a.png#x 400w, a.png 400w, b.png 800w"], `${BASE}a.png`),
    ).toEqual({ w: 400, candidates: [`${BASE}b.png`] });
  });

  it("searches once more when the parser finishes, if the element did not exist yet", async () => {
    // The preload scanner's request arrives before the tree builder made the
    // element: the first search misses while the document is `loading`.
    const elements: Array<{ getAttribute: (n: string) => string | null }> = [];
    let listener: (() => void) | null = null;
    const fakeDocument = {
      baseURI: BASE,
      readyState: "loading",
      querySelectorAll: () => elements,
      addEventListener: (type: string, fn: () => void) => {
        if (type === "readystatechange") listener = fn;
      },
      removeEventListener: () => {
        listener = null;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("document", `return (${SRCSET_LOOKUP_SCRIPT});`)(fakeDocument) as (
      url: string,
    ) => unknown;
    const pending = fn(`${BASE}b.png`);
    expect(pending).toBeInstanceOf(Promise);

    elements.push({ getAttribute: () => "a.png 400w, b.png 800w" });
    fakeDocument.readyState = "interactive";
    (listener as unknown as () => void)();
    await expect(pending).resolves.toEqual({ w: 800, candidates: [`${BASE}a.png`] });
    expect(listener).toBeNull();
  });

  it("answers a miss at once when the document is already parsed", () => {
    const fakeDocument = { baseURI: BASE, readyState: "interactive", querySelectorAll: () => [] };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("document", `return (${SRCSET_LOOKUP_SCRIPT});`)(fakeDocument) as (
      url: string,
    ) => unknown;
    expect(fn(`${BASE}b.png`)).toBeNull();
  });

  it("lists at most SRCSET_MAX_SIBLINGS siblings", () => {
    const many = Array.from({ length: SRCSET_MAX_SIBLINGS + 10 }, (_, i) => `s${i}.png ${i + 1}w`);
    const reply = lookup([[...many, "target.png 9999w"].join(", ")], `${BASE}target.png`) as {
      candidates: string[];
    };
    expect(reply.candidates.length).toBe(SRCSET_MAX_SIBLINGS);
  });
});

describe("readSrcsetReply", () => {
  it("accepts the script's own shapes", () => {
    expect(readSrcsetReply(null)).toBeNull();
    expect(readSrcsetReply({ w: 400, candidates: ["https://a/b.png"] })).toEqual({
      w: 400,
      candidates: ["https://a/b.png"],
    });
    expect(readSrcsetReply({ w: null, candidates: [] })).toEqual({ w: null, candidates: [] });
  });

  it("treats anything else as no answer: a page can replace the globals the script uses", () => {
    for (const bad of [
      42,
      { w: "400", candidates: [] },
      { w: 0, candidates: [] },
      { w: 2 ** 31, candidates: [] },
      { w: 1.5, candidates: [] },
      { w: 400, candidates: [7] },
      { w: 400 },
      { w: 400, candidates: Array.from({ length: SRCSET_MAX_SIBLINGS + 1 }, () => "x") },
    ]) {
      expect(readSrcsetReply(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("IMAGES_MEASURE_SCRIPT and readImageMeasurement", () => {
  it("caps the rows at MAX_RENDER_IMAGES in the script itself", () => {
    expect(MAX_RENDER_IMAGES).toBe(1000);
    expect(IMAGES_MEASURE_SCRIPT).toContain(String(MAX_RENDER_IMAGES));
  });

  it("accepts the script's shape", () => {
    const value = { total: 2, rows: [["https://a/b.png", 10, 20, "lazy", "loaded"], ["https://a/c.png", 0, 0, "eager", "loading"]] };
    expect(readImageMeasurement(value)).toEqual(value);
  });

  it("throws on any other shape, naming it", () => {
    for (const bad of [
      null,
      { total: -1, rows: [] },
      { total: 1, rows: [["u", 1, 1]] },
      { total: 1, rows: [["u", 1, 1, "eager"]] },
      { total: 1, rows: [["u", 1, 1, "eager", "no"]] },
      { total: 1, rows: [["u", 1, 1, "eager", false]] },
      { total: 1, rows: [["u", "1", 1, "eager", "loaded"]] },
      { total: 1, rows: [["u", 1.5, 1, "eager", "loaded"]] },
      { total: 0, rows: [["u", 1, 1, "eager", "loaded"]] },
    ]) {
      expect(() => readImageMeasurement(bad), JSON.stringify(bad)).toThrow(/image measurement/);
    }
  });
});
