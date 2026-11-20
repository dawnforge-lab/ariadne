/**
 * The Phase 29c fixtures: a page that every internal link names with a generic
 * phrase, so `links.anchors-generic-only` fires once end to end (Gate 29c).
 *
 * `/p29c/generic-target` is reached ONLY from three hub pages, whose links to it
 * say "click here", "read more" and "here". The fixture hub (`/`) does not link
 * the target (`linkedFromHub: false`): its link would carry the fixture's name
 * as anchor text, which is descriptive, and one descriptive anchor from any
 * source is enough to silence the rule. Three inlinks is
 * `GENERIC_ANCHOR_MIN_INLINKS`.
 *
 * Each hub page is the control recipe plus that one link, so each fires exactly
 * `links.non-descriptive-anchor` (its anchor is on the phrase list) and nothing
 * else. The target carries no links of its own.
 */
import type { Fixture } from "../fixture.js";
import { article, serve } from "../render.js";

const TARGET = "/p29c/generic-target";

interface PageCopy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
  /** The paragraph appended after the article; empty for the target. */
  extraHtml: string;
}

function page(
  path: string,
  copy: PageCopy,
  rest: Pick<Fixture, "expectedIssues" | "linkedFromHub" | "name">,
): Fixture {
  return {
    path,
    category: "links",
    ...rest,
    exact: true,
    handler: (req, res) =>
      serve(req, res, () => ({
        title: copy.title,
        metaDescription: copy.description,
        bodyHtml:
          article({
            h1: copy.h1,
            lede: copy.lede,
            withImage: false,
            sections: [
              { h2: "What this page does", body: copy.what },
              { h2: "Why it matters", body: copy.why },
              { h2: "How it gets fixed", body: copy.fix },
            ],
          }) + copy.extraHtml,
      })),
  };
}

const target = page(
  TARGET,
  {
    title: "A page that every link to it describes with a generic phrase",
    description:
      "Three pages on this site link here, and each one uses a phrase such as click here or read more, so nothing pointing at this page says what it is about.",
    h1: "A page whose inbound links never name it",
    lede: "The page is well formed and indexable, and every internal link that reaches it uses an anchor that would read the same on any page of any site.",
    what: "Three other pages link to this one. The words they use are click here, read more and here, and none of them mentions what this page covers, so the only description of it that the rest of the site provides is empty.",
    why: "Anchor text is one of the few places where a link describes its own destination in words. When every link to a page is generic, a visitor scanning the linking pages and a search engine reading their anchors learn nothing about the page they lead to, however much the page itself says.",
    fix: "Change at least one of the links to this page, ideally the most prominent, so that its anchor names the page, for example by using the topic or question the page answers.",
    extraHtml: "",
  },
  {
    name: "Page reached only through generic anchors",
    expectedIssues: ["links.anchors-generic-only"],
    linkedFromHub: false,
  },
);

function hubPage(slug: string, anchor: string, topic: string): Fixture {
  return page(
    `/p29c/${slug}`,
    {
      title: `A page that links to another with the words ${anchor}`,
      description: `This page links to another page of its site with the phrase ${anchor}, an anchor that says nothing about where it leads.`,
      h1: `A link that tells the reader nothing about ${topic}`,
      lede: "The page is well formed, and its single internal link uses an anchor that would read the same on any page of any site.",
      what: `The link at the foot of the page points at a page that this site keeps for a test, and its whole anchor text is ${anchor}. A visitor skimming the links on the page, and a search engine reading the anchor for a clue to the target, learn nothing from it.`,
      why: "Anchor text is one of the few places where a link describes its own destination in words. A page full of links that say click here or read more gives a visitor using a screen reader a list of identical entries to choose between, and it gives a search engine no description of the pages those links lead to.",
      fix: "Write the anchor so it describes the page it points at, for example the name of the page or the question the target answers, and keep generic phrases out of it.",
      extraHtml: `\n<p><a href="${TARGET}">${anchor}</a></p>`,
    },
    {
      name: `Page linking to the generic target as ${anchor}`,
      expectedIssues: ["links.non-descriptive-anchor"],
    },
  );
}

export const authoredP29cFixtures: Fixture[] = [
  target,
  hubPage("generic-hub-click-here", "click here", "its target"),
  hubPage("generic-hub-read-more", "read more", "its destination"),
  hubPage("generic-hub-here", "here", "where it points"),
];
