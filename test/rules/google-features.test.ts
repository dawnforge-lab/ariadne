import { describe, expect, it } from "vitest";

import {
  DEPRECATED_FEATURES,
  GOOGLE_DOCS_READ,
  GOOGLE_FEATURES,
  anyOf,
  has,
  unlessNested,
} from "../../src/rules/schema-org/google-features.js";
import { isKnownType, propertyDef } from "../../src/rules/schema-org/vocabulary.js";

describe("Google rich-result profiles", () => {
  it("records the day the Google pages were read", () => {
    expect(GOOGLE_DOCS_READ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("names only vocabulary types", () => {
    for (const f of GOOGLE_FEATURES) {
      for (const t of f.appliesTo) expect(isKnownType(t), `${f.id}: ${t}`).toBe(true);
    }
    for (const d of DEPRECATED_FEATURES) expect(isKnownType(d.type), d.id).toBe(true);
  });

  it("starts every requirement path at a vocabulary property", () => {
    for (const f of GOOGLE_FEATURES) {
      for (const req of [...f.required, ...f.recommended]) {
        expect(req.paths.length, `${f.id}: ${req.label}`).toBeGreaterThan(0);
        for (const path of req.paths) {
          for (const step of path.split(".")) {
            expect(propertyDef(step), `${f.id}: ${req.label} → ${step}`).toBeDefined();
          }
        }
      }
    }
  });

  it("has unique ids, a docUrl on Google's structured-data pages, and known skipWhen ids", () => {
    const ids = GOOGLE_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of GOOGLE_FEATURES) {
      expect(f.docUrl).toMatch(
        /^https:\/\/developers\.google\.com\/search\/docs\/appearance\/structured-data\/[a-z-]+$/,
      );
      for (const s of f.skipWhen ?? []) expect(ids).toContain(s);
    }
    const deprecatedIds = DEPRECATED_FEATURES.map((d) => d.id);
    expect(deprecatedIds).toEqual(["faq", "how-to"]);
  });

  it("reads a dotted path through an object or an array of objects, one member being enough", () => {
    const req = has("offers.price");
    expect(req.label).toBe("offers.price");
    expect(req.met({ offers: { price: 0 } }, { nested: false })).toBe(true);
    expect(req.met({ offers: [{}, { price: "9.99" }] }, { nested: false })).toBe(true);
    expect(req.met({ offers: [{ price: "" }, {}] }, { nested: false })).toBe(false);
    expect(req.met({ offers: "9.99" }, { nested: false })).toBe(false);
    expect(req.met({}, { nested: false })).toBe(false);
  });

  it("anyOf is met by one alternative and labels the group", () => {
    const req = anyOf("review | aggregateRating", has("review"), has("aggregateRating"));
    expect(req.label).toBe("review | aggregateRating");
    expect(req.paths).toEqual(["review", "aggregateRating"]);
    expect(req.met({ aggregateRating: {} }, { nested: false })).toBe(true);
    expect(req.met({}, { nested: false })).toBe(false);
  });

  it("unlessNested waives a requirement on a nested node only", () => {
    const req = unlessNested(has("itemReviewed"));
    expect(req.label).toBe("itemReviewed");
    expect(req.met({}, { nested: true })).toBe(true);
    expect(req.met({}, { nested: false })).toBe(false);
  });
});
