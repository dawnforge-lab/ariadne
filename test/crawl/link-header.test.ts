import { describe, expect, it } from "vitest";
import { parseLinkHeader } from "../../src/crawl/link-header.js";

describe("parseLinkHeader (RFC 8288)", () => {
  it("reads two entries from one value", () => {
    expect(
      parseLinkHeader(['<https://x/de>; rel="alternate"; hreflang="de", <https://x/en>; rel="alternate"; hreflang="en"']),
    ).toEqual({
      entries: [
        { uri: "https://x/de", params: { rel: "alternate", hreflang: "de" } },
        { uri: "https://x/en", params: { rel: "alternate", hreflang: "en" } },
      ],
      malformed: 0,
    });
  });

  it("reads entries spread across two header values", () => {
    expect(
      parseLinkHeader(['<https://x/c>; rel="canonical"', '<https://x/fr>; rel="alternate"; hreflang="fr"']),
    ).toEqual({
      entries: [
        { uri: "https://x/c", params: { rel: "canonical" } },
        { uri: "https://x/fr", params: { rel: "alternate", hreflang: "fr" } },
      ],
      malformed: 0,
    });
  });

  it("keeps a comma inside the <URI>", () => {
    expect(parseLinkHeader(['<https://x/a,b>; rel="alternate"; hreflang="de"'])).toEqual({
      entries: [{ uri: "https://x/a,b", params: { rel: "alternate", hreflang: "de" } }],
      malformed: 0,
    });
  });

  it("reads a quoted value with a comma and escaped quotes", () => {
    expect(parseLinkHeader(['<https://x/t>; rel="alternate"; title="a, \\"b\\"", <https://x/u>; rel=next'])).toEqual({
      entries: [
        { uri: "https://x/t", params: { rel: "alternate", title: 'a, "b"' } },
        { uri: "https://x/u", params: { rel: "next" } },
      ],
      malformed: 0,
    });
  });

  it("reads an unquoted rel, lower-cases parameter names and keeps rel's value", () => {
    expect(parseLinkHeader(["<https://x/de>;REL=Alternate ; HrefLang=de-DE"])).toEqual({
      entries: [{ uri: "https://x/de", params: { rel: "Alternate", hreflang: "de-DE" } }],
      malformed: 0,
    });
  });

  it("keeps the first occurrence of a repeated parameter (RFC 8288 §3.3)", () => {
    expect(parseLinkHeader(['<https://x/a>; rel="alternate"; rel="canonical"']).entries).toEqual([
      { uri: "https://x/a", params: { rel: "alternate" } },
    ]);
  });

  it("reads a parameter with no value as the empty string", () => {
    expect(parseLinkHeader(["<https://x/a>; rel=preload; nopush"]).entries).toEqual([
      { uri: "https://x/a", params: { rel: "preload", nopush: "" } },
    ]);
  });

  it("skips and counts a malformed entry, and reads the ones around it", () => {
    expect(
      parseLinkHeader([
        '<https://x/de>; rel="alternate"; hreflang="de", https://x/no-brackets; rel="alternate", <https://x/en>; rel="alternate"; hreflang="en"',
      ]),
    ).toEqual({
      entries: [
        { uri: "https://x/de", params: { rel: "alternate", hreflang: "de" } },
        { uri: "https://x/en", params: { rel: "alternate", hreflang: "en" } },
      ],
      malformed: 1,
    });
  });

  it("counts an unclosed <, an unterminated quote and junk after the URI as malformed", () => {
    expect(parseLinkHeader(["<https://x/never-closed; rel=alternate"])).toEqual({ entries: [], malformed: 1 });
    expect(parseLinkHeader(['<https://x/q>; title="open'])).toEqual({ entries: [], malformed: 1 });
    expect(parseLinkHeader(['<https://x/j> junk; rel="next", <https://x/ok>; rel="next"'])).toEqual({
      entries: [{ uri: "https://x/ok", params: { rel: "next" } }],
      malformed: 1,
    });
    // A param with no name is malformed; a quoted comma in the broken entry
    // does not end it early.
    expect(parseLinkHeader(['<https://x/n>; ="a, b", <https://x/ok>'])).toEqual({
      entries: [{ uri: "https://x/ok", params: {} }],
      malformed: 1,
    });
  });

  it("ignores empty list elements and empty values", () => {
    expect(parseLinkHeader(["", " , ,<https://x/a>; rel=next,, "])).toEqual({
      entries: [{ uri: "https://x/a", params: { rel: "next" } }],
      malformed: 0,
    });
  });
});
