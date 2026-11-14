/**
 * Google rich-result profiles: for each Search feature, which schema.org types
 * it reads and which properties Google's documentation requires or recommends.
 *
 * Hand-written from the Google Search Central structured-data pages (each
 * feature's `docUrl`), read on `GOOGLE_DOCS_READ`. The facts are Google's; the
 * structure and the wording here are ours. Every property name is checked
 * against the schema.org vocabulary in `test/rules/google-features.test.ts`.
 *
 * How the lists were cut from the pages:
 *  - `required` is the page's required table. A row the page waives in a stated
 *    situation carries that waiver (`unlessNested`, `forType`, …) rather than
 *    being dropped.
 *  - `recommended` is the page's recommended table, minus beta rows and minus
 *    rows the page limits to a situation the markup cannot show ("only if the
 *    video expires", "only for sites that review other businesses", "if
 *    applicable"). Reporting those as missing on every node would accuse sites
 *    the advice never addressed.
 *  - A dotted path (`offers.price`) reads "some member of `offers` carries
 *    `price`" — one complete member is enough (`carries`).
 *
 * Re-reading the pages is a deliberate commit that bumps `GOOGLE_DOCS_READ` and
 * RULESET_VERSION; nothing here is synced.
 */
import { schemaOrgName } from "../../crawl/parse/schema-names.js";
import { carries, describes, hasValue, isBareReference, membersOf } from "./values.js";
import { isKnownType, isSubtypeOf } from "./vocabulary.js";

/** The day the Google Search Central pages behind these profiles were read. */
export const GOOGLE_DOCS_READ = "2026-11-13";

export interface Requirement {
  /** What a missing requirement is reported as, e.g. "offers.price" or "review | aggregateRating". */
  label: string;
  /** The dotted property paths the requirement reads; each starts at a vocabulary property. */
  paths: readonly string[];
  met(node: Record<string, unknown>, ctx: { nested: boolean }): boolean;
}

export interface GoogleFeature {
  id: string;
  name: string;
  docUrl: string;
  /** Schema.org types the feature reads; their subtypes match too. */
  appliesTo: readonly string[];
  /** "top": the block's root node only. "any": a node at any depth. */
  depth: "top" | "any";
  /**
   * For a nested match: the types (and their subtypes) the parent node must
   * have one of. Absent: a nested node matches whatever its parent.
   */
  nestedUnder?: readonly string[];
  /** A further condition on the node, beyond its type. */
  applies?(node: Record<string, unknown>): boolean;
  /** Feature ids which, when they also match the same node, drop this one. */
  skipWhen?: readonly string[];
  required: readonly Requirement[];
  recommended: readonly Requirement[];
}

/** `path` carries a usable value (see `carries`). */
export function has(path: string): Requirement {
  const steps = path.split(".");
  return { label: path, paths: [path], met: (node) => carries(node, steps) };
}

/** Met when any of `reqs` is met. */
export function anyOf(label: string, ...reqs: Requirement[]): Requirement {
  return {
    label,
    paths: reqs.flatMap((r) => r.paths),
    met: (node, ctx) => reqs.some((r) => r.met(node, ctx)),
  };
}

/**
 * Waived on a nested node (Google's "omit itemReviewed when the review is
 * nested"), and on a node carrying an `@id`: another node may point at it
 * (`"review": {"@id": …}` from a `@graph` sibling), which makes it nested in
 * every sense Google reads, and nothing in one block can show it is not.
 */
export function unlessNested(req: Requirement): Requirement {
  return {
    ...req,
    met: (node, ctx) => ctx.nested || hasValue(node["@id"]) || req.met(node, ctx),
  };
}

/** Asked only of a node whose type is, or descends from, `type`. */
function forType(type: string, req: Requirement): Requirement {
  return { ...req, met: (node, ctx) => !nodeIsA(node, type) || req.met(node, ctx) };
}

/**
 * Asked only when `path` holds something more than bare references
 * (`describes`): a referenced node is described elsewhere.
 */
function whenPresent(path: string, req: Requirement): Requirement {
  const steps = path.split(".");
  return { ...req, met: (node, ctx) => !describes(node, steps) || req.met(node, ctx) };
}

/** Waived when every one of `paths` is present. */
function waivedWhenAll(paths: readonly string[], req: Requirement): Requirement {
  const split = paths.map((p) => p.split("."));
  return {
    ...req,
    met: (node, ctx) => split.every((steps) => carries(node, steps)) || req.met(node, ctx),
  };
}

/** Waived when any one of `paths` is present. */
function waivedWhenAny(paths: readonly string[], req: Requirement): Requirement {
  const split = paths.map((p) => p.split("."));
  return {
    ...req,
    met: (node, ctx) => split.some((steps) => carries(node, steps)) || req.met(node, ctx),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The node's schema.org types that the vocabulary knows. */
function knownTypesOf(node: unknown): string[] {
  if (!isRecord(node)) return [];
  return membersOf(node["@type"])
    .map((t) => (typeof t === "string" ? schemaOrgName(t) : null))
    .filter((t): t is string => t !== null && isKnownType(t));
}

function nodeIsA(node: unknown, type: string): boolean {
  return knownTypesOf(node).some((t) => isSubtypeOf(t, type));
}

/**
 * Whether a crumb's `item` stands in for its `name` (Google: `name` is not
 * needed when `item` is a Thing carrying its own). Only a node does: one that
 * carries a name, or a bare reference that may resolve to a named node. A URL
 * string is no name — `carries`' text-names-its-node reading must not apply
 * here, or a crumb with a URL item and no name would pass Google's
 * "Missing field name" error.
 */
function itemNamesItself(item: unknown): boolean {
  return membersOf(item).some(
    (m) => isBareReference(m) || (isRecord(m) && carries(m, ["name"])),
  );
}

/** A crumb's `position` as a number, when it is one (a number, or a numeric string). */
function numericPosition(item: unknown): number | null {
  if (!isRecord(item)) return null;
  const p = item["position"];
  if (typeof p === "number" && Number.isFinite(p)) return p;
  if (typeof p === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(p)) return Number(p);
  return null;
}

/**
 * A requirement on every list item of a BreadcrumbList (`membersOf`, so an
 * `@list`-wrapped list reads like an array). `exceptLast` waives it on the last
 * crumb (Google: the last crumb's `item` may be omitted, the page's own URL
 * standing in) — and "last" is read both ways, so the requirement is waived on
 * the last member in document order AND on every crumb carrying the highest
 * numeric `position`. An absent `itemListElement` meets it vacuously — the
 * `itemListElement` requirement reports that.
 */
function everyListItem(
  field: "position" | "name" | "item",
  exceptLast: boolean,
  met: (item: Record<string, unknown>) => boolean,
): Requirement {
  const label = `itemListElement.${field}`;
  return {
    label,
    paths: [label],
    met: (node) => {
      const members = membersOf(node["itemListElement"]);
      let judged = members;
      if (exceptLast) {
        const positions = members.map(numericPosition);
        const numeric = positions.filter((p): p is number => p !== null);
        const highest = numeric.length > 0 ? Math.max(...numeric) : null;
        judged = members.filter(
          (_m, i) => i !== members.length - 1 && (highest === null || positions[i] !== highest),
        );
      }
      return judged.every((m) => isRecord(m) && met(m));
    },
  };
}

const each = (...paths: string[]): Requirement[] => paths.map(has);

const DOCS = "https://developers.google.com/search/docs/appearance/structured-data/";

/** The price and currency alternatives of an Offer, as the merchant-listing page states them. */
const OFFER_PRICE = anyOf(
  "offers.price | offers.priceSpecification.price",
  has("offers.price"),
  has("offers.priceSpecification.price"),
);
const OFFER_CURRENCY = anyOf(
  "offers.priceCurrency | offers.priceSpecification.priceCurrency",
  has("offers.priceCurrency"),
  has("offers.priceSpecification.priceCurrency"),
);

/**
 * The GTIN spellings the merchant-listing page accepts. `GTIN_FIELDS`' `ean` is
 * not a schema.org property and is left out; `isbn` is on the page (valid on a
 * node co-typed Book).
 */
const GTIN = anyOf(
  "gtin",
  ...each("gtin", "gtin8", "gtin12", "gtin13", "gtin14", "isbn"),
);

/**
 * The types Google's review-snippet page lists as reviewable. A nested Review
 * or AggregateRating matches its feature only under a parent of one of these
 * (or a subtype): a rating nested in an Article earns no review snippet, and
 * judging it would report missing fields for a feature that cannot apply
 * (29a T5 review, narrowing R0.4).
 */
export const REVIEWABLE_PARENTS: readonly string[] = [
  "Book",
  "Course",
  "CreativeWorkSeason",
  "CreativeWorkSeries",
  "Episode",
  "Event",
  "Game",
  "HowTo",
  "LocalBusiness",
  "MediaObject",
  "Movie",
  "MusicPlaylist",
  "MusicRecording",
  "Organization",
  "Product",
  "Recipe",
  "SoftwareApplication",
];

/** Whether `offers` holds a node typed Offer (or a subtype) that is not an AggregateOffer (R0.4). */
function holdsSingleOffer(node: Record<string, unknown>): boolean {
  return membersOf(node["offers"]).some((offer) =>
    knownTypesOf(offer).some((t) => isSubtypeOf(t, "Offer") && !isSubtypeOf(t, "AggregateOffer")),
  );
}

/**
 * Whether the node is a ProductGroup (or a subtype): a schema.org subtype of
 * Product that the two Product features must not read. Google's
 * product-variants page asks only a `name` of the group and puts the offers on
 * its `hasVariant` Products, which are the nodes the features are about;
 * reading the group as a Product would report `review | aggregateRating |
 * offers` missing on Google's own example (29a final review I1). A variant
 * page's own top-level Product is still judged. The group gets no profile of
 * its own (the final review judged one optional), so it is matched by no
 * feature and reported missing nothing.
 */
function isProductGroup(node: Record<string, unknown>): boolean {
  return nodeIsA(node, "ProductGroup");
}

export const GOOGLE_FEATURES: readonly GoogleFeature[] = [
  {
    id: "article",
    name: "Article",
    docUrl: `${DOCS}article`,
    appliesTo: ["Article", "NewsArticle", "BlogPosting"],
    depth: "top",
    required: [],
    recommended: each(
      "author",
      "author.name",
      "author.url",
      "dateModified",
      "datePublished",
      "headline",
      "image",
    ),
  },
  {
    id: "breadcrumb",
    name: "Breadcrumb",
    docUrl: `${DOCS}breadcrumb`,
    appliesTo: ["BreadcrumbList"],
    depth: "top",
    required: [
      has("itemListElement"),
      everyListItem("position", false, (m) => carries(m, ["position"])),
      // A crumb whose `item` is a node carrying its own name needs no `name`.
      everyListItem("name", false, (m) => carries(m, ["name"]) || itemNamesItself(m["item"])),
      everyListItem("item", true, (m) => carries(m, ["item"])),
    ],
    recommended: [],
  },
  {
    id: "product-snippet",
    name: "Product snippet",
    docUrl: `${DOCS}product-snippet`,
    appliesTo: ["Product"],
    depth: "top",
    applies: (node) => !isProductGroup(node),
    required: [
      has("name"),
      anyOf("review | aggregateRating | offers", ...each("review", "aggregateRating", "offers")),
      // The page's Offer table requires a price; its AggregateOffer table a
      // lowPrice. Asked only when offers alone qualify the snippet: a product
      // with a review or rating qualifies without them.
      waivedWhenAny(
        ["review", "aggregateRating"],
        whenPresent(
          "offers",
          anyOf(
            "offers.price | offers.priceSpecification.price | offers.lowPrice",
            ...each("offers.price", "offers.priceSpecification.price", "offers.lowPrice"),
          ),
        ),
      ),
    ],
    recommended: [
      ...each("aggregateRating", "review", "offers", "offers.availability"),
      OFFER_CURRENCY,
      has("offers.priceValidUntil"),
    ],
  },
  {
    id: "merchant-listing",
    name: "Merchant listing",
    docUrl: `${DOCS}merchant-listing`,
    appliesTo: ["Product"],
    depth: "top",
    applies: (node) => !isProductGroup(node) && holdsSingleOffer(node),
    required: [has("name"), has("image"), OFFER_PRICE, OFFER_CURRENCY],
    recommended: [
      ...each("aggregateRating", "brand", "brand.name", "category", "color", "description"),
      GTIN,
      ...each(
        "material",
        "mpn",
        "pattern",
        "review",
        "size",
        "sku",
        "offers.availability",
        "offers.itemCondition",
        "offers.priceValidUntil",
      ),
    ],
  },
  {
    id: "review",
    name: "Review snippet",
    docUrl: `${DOCS}review-snippet`,
    appliesTo: ["Review"],
    depth: "any",
    nestedUnder: REVIEWABLE_PARENTS,
    required: [
      has("author"),
      has("author.name"),
      unlessNested(has("itemReviewed")),
      unlessNested(has("itemReviewed.name")),
      // "The rating may be omitted when the markup carries an author and a review date."
      waivedWhenAll(["author", "datePublished"], has("reviewRating")),
      waivedWhenAll(["author", "datePublished"], has("reviewRating.ratingValue")),
    ],
    recommended: each("datePublished", "reviewRating.bestRating", "reviewRating.worstRating"),
  },
  {
    id: "aggregate-rating",
    name: "Review snippet (aggregate rating)",
    docUrl: `${DOCS}review-snippet`,
    appliesTo: ["AggregateRating"],
    depth: "any",
    nestedUnder: REVIEWABLE_PARENTS,
    required: [
      unlessNested(has("itemReviewed")),
      unlessNested(has("itemReviewed.name")),
      has("ratingValue"),
      anyOf("ratingCount | reviewCount", ...each("ratingCount", "reviewCount")),
    ],
    recommended: each("bestRating", "worstRating"),
  },
  {
    id: "organization",
    name: "Organization",
    docUrl: `${DOCS}organization`,
    appliesTo: ["Organization"],
    depth: "top",
    skipWhen: ["local-business"],
    required: [],
    recommended: each(
      "name",
      "url",
      "logo",
      "sameAs",
      "address",
      "contactPoint",
      "telephone",
      "email",
      "description",
    ),
  },
  {
    id: "local-business",
    name: "Local business",
    docUrl: `${DOCS}local-business`,
    appliesTo: ["LocalBusiness"],
    depth: "top",
    required: each("name", "address"),
    recommended: [
      ...each("telephone", "url", "geo", "openingHoursSpecification", "priceRange"),
      // "For food establishments": `menu` is superseded by `hasMenu` in schema.org.
      forType("FoodEstablishment", anyOf("menu | hasMenu", ...each("menu", "hasMenu"))),
      forType("FoodEstablishment", has("servesCuisine")),
    ],
  },
  {
    id: "event",
    name: "Event",
    docUrl: `${DOCS}event`,
    appliesTo: ["Event"],
    depth: "top",
    // The page: events take place at a physical location, a Place with an address.
    required: each("name", "startDate", "location", "location.address"),
    recommended: each(
      "description",
      "endDate",
      "eventStatus",
      "image",
      "location.name",
      "offers",
      "offers.availability",
      "offers.price",
      "offers.priceCurrency",
      "offers.validFrom",
      "offers.url",
      "organizer",
      "organizer.name",
      "organizer.url",
      "performer",
      "performer.name",
    ),
  },
  {
    id: "recipe",
    name: "Recipe",
    docUrl: `${DOCS}recipe`,
    appliesTo: ["Recipe"],
    depth: "top",
    required: each("name", "image"),
    recommended: each(
      "aggregateRating",
      "author",
      "cookTime",
      "datePublished",
      "description",
      "keywords",
      "nutrition.calories",
      "prepTime",
      "recipeCategory",
      "recipeCuisine",
      "recipeIngredient",
      "recipeInstructions",
      "recipeYield",
      "totalTime",
      "video",
    ),
  },
  {
    id: "video",
    name: "Video",
    docUrl: `${DOCS}video`,
    appliesTo: ["VideoObject"],
    depth: "top",
    required: each("name", "thumbnailUrl", "uploadDate"),
    recommended: [
      anyOf("contentUrl | embedUrl", ...each("contentUrl", "embedUrl")),
      anyOf("creator | author", ...each("creator", "author")),
      anyOf("creator.name | author.name", ...each("creator.name", "author.name")),
      anyOf("creator.url | author.url", ...each("creator.url", "author.url")),
      ...each("description", "duration"),
      anyOf("ineligibleRegion | regionsAllowed", ...each("ineligibleRegion", "regionsAllowed")),
      ...each(
        "interactionStatistic",
        "interactionStatistic.interactionType",
        "interactionStatistic.userInteractionCount",
      ),
    ],
  },
  {
    id: "job-posting",
    name: "Job posting",
    docUrl: `${DOCS}job-posting`,
    appliesTo: ["JobPosting"],
    depth: "top",
    required: [
      ...each("title", "description", "datePosted", "hiringOrganization"),
      // A fully remote job may name applicantLocationRequirements instead.
      anyOf(
        "jobLocation | applicantLocationRequirements",
        ...each("jobLocation", "applicantLocationRequirements"),
      ),
    ],
    recommended: each(
      "applicantLocationRequirements",
      "baseSalary",
      "directApply",
      "employmentType",
      "identifier",
      "jobLocationType",
      "validThrough",
    ),
  },
  {
    id: "software-app",
    name: "Software app",
    docUrl: `${DOCS}software-app`,
    appliesTo: ["SoftwareApplication"],
    depth: "top",
    required: [
      has("name"),
      has("offers.price"),
      anyOf("aggregateRating | review", ...each("aggregateRating", "review")),
    ],
    recommended: each("applicationCategory", "operatingSystem"),
  },
];

/** Features Google has withdrawn: markup for them earns no rich result. */
export const DEPRECATED_FEATURES: readonly { id: string; type: string; restriction: string }[] = [
  {
    id: "faq",
    type: "FAQPage",
    restriction: "Google no longer shows FAQ rich results (since May 7, 2026)",
  },
  {
    id: "how-to",
    type: "HowTo",
    restriction: "Google no longer shows HowTo rich results (since September 2023)",
  },
];
