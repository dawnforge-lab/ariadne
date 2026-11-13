/**
 * The Phase 29a fixtures: structured data validated, not just found.
 *
 * Each page below makes ONE of the new `schema.*` rules fire once (Gate 29a
 * clause 1), and nothing else, so each is `exact`. Two more pages, a microdata
 * Product and an RDFa Organization, are complete in the markup formats the
 * validator reads beside JSON-LD and fire nothing: they prove the other two
 * extractors feed the same validator rather than being skipped.
 *
 * "Complete" is meant literally. Google's profiles (src/rules/schema-org/
 * google-features.ts) carry long recommended lists, and a page that misses one
 * would fire `schema.google-recommended-missing` and fail its `exact` list, so
 * the complete Product and Organization below carry every field their profiles
 * name. A page that is meant to miss ONE thing carries all the others.
 *
 * `/authored29a/tpl/1` to `/10` are one template: ten pages under one URL
 * shape (`/authored29a/tpl/:id`, one page type), nine with a Product block and
 * one without. Ten is `SCHEMA_TEMPLATE_MIN_PAGES`, and nine of ten is 90%, over
 * `SCHEMA_TEMPLATE_SHARE`, so the tenth is the single `schema.template-
 * inconsistent` finding. The pages of every OTHER page type stay below that
 * floor or below that share, which is why no second finding appears.
 */
import type { Fixture } from "../fixture.js";
import { SHARED_IMAGE_PATH } from "../assets.js";
import { serve } from "../render.js";
import { healthyBody } from "./authored-p3.js";

const SCHEMA = "structured-data";

/**
 * `healthyBody` plus a closing paragraph. Every page here must clear
 * `THIN_WORDS` with room to spare, and the markup it carries is not text, so a
 * page whose prose is only the control recipe's three sections can fall under.
 */
function body(opts: Parameters<typeof healthyBody>[0], closing: string): string {
  return healthyBody({
    ...opts,
    extra: `<p>${closing}</p>${opts.extra === undefined ? "" : `\n${opts.extra}`}`,
  });
}

/** A JSON-LD block, as a `<script>` for `headExtra`. */
function jsonLd(node: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    ...node,
  })}</script>`;
}

/** A Product carrying every field the snippet and merchant-listing profiles name. */
function completeProduct(p: {
  name: string;
  sku: string;
  gtin13: string;
  mpn: string;
  colour: string;
  size: string;
  material: string;
  pattern: string;
  category: string;
}): Record<string, unknown> {
  return {
    "@type": "Product",
    name: p.name,
    image: "https://estuary-supplies.example/img/product.png",
    description: `${p.name}, as described by its own record in the catalogue.`,
    sku: p.sku,
    gtin13: p.gtin13,
    mpn: p.mpn,
    color: p.colour,
    size: p.size,
    material: p.material,
    pattern: p.pattern,
    category: p.category,
    brand: { "@type": "Brand", name: "Estuary Supplies" },
    offers: {
      "@type": "Offer",
      price: "24.00",
      priceCurrency: "GBP",
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      priceValidUntil: "2027-12-31",
    },
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: "4.6",
      reviewCount: "38",
      bestRating: "5",
      worstRating: "1",
    },
    review: {
      "@type": "Review",
      author: { "@type": "Person", name: "Mara Ellison" },
      datePublished: "2026-09-02",
      reviewRating: { "@type": "Rating", ratingValue: "5", bestRating: "5", worstRating: "1" },
    },
  };
}

/** A complete Organization: every field the Organization profile recommends. */
function completeOrganization(): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: "Estuary Supplies",
    url: "https://estuary-supplies.example/",
    logo: "https://estuary-supplies.example/img/logo.png",
    sameAs: ["https://www.example.org/estuary-supplies"],
    address: {
      "@type": "PostalAddress",
      streetAddress: "4 Quay Lane",
      addressLocality: "Faversham",
      postalCode: "ME13 7AA",
      addressCountry: "GB",
    },
    contactPoint: { "@type": "ContactPoint", telephone: "+44-1795-555-0100", contactType: "customer service" },
    telephone: "+44-1795-555-0100",
    email: "hello@estuary-supplies.example",
    description: "A supplier of camp and galley equipment on the north Kent coast.",
  };
}

/** A complete Product as microdata, with `extra` placed inside the Product item. */
function microdataProduct(opts: { extra?: string } = {}): string {
  return (
    `<div itemscope itemtype="https://schema.org/Product">` +
    `<meta itemprop="name" content="Galley whistling kettle">` +
    `<link itemprop="image" href="https://estuary-supplies.example/img/kettle.png">` +
    `<meta itemprop="description" content="A two-litre steel kettle with a folding handle.">` +
    `<meta itemprop="sku" content="KET-2L-STL">` +
    `<meta itemprop="gtin13" content="5012345678900">` +
    `<meta itemprop="mpn" content="K2L-77">` +
    `<meta itemprop="color" content="Steel">` +
    `<meta itemprop="size" content="2 litres">` +
    `<meta itemprop="material" content="Stainless steel">` +
    `<meta itemprop="pattern" content="Plain">` +
    `<meta itemprop="category" content="Galley equipment">` +
    `<div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><meta itemprop="name" content="Estuary Supplies"></div>` +
    `<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">` +
    `<meta itemprop="price" content="32.00"><meta itemprop="priceCurrency" content="GBP">` +
    `<link itemprop="availability" href="https://schema.org/InStock">` +
    `<link itemprop="itemCondition" href="https://schema.org/NewCondition">` +
    `<meta itemprop="priceValidUntil" content="2027-12-31"></div>` +
    `<div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">` +
    `<meta itemprop="ratingValue" content="4.4"><meta itemprop="reviewCount" content="27">` +
    `<meta itemprop="bestRating" content="5"><meta itemprop="worstRating" content="1"></div>` +
    `<div itemprop="review" itemscope itemtype="https://schema.org/Review">` +
    `<div itemprop="author" itemscope itemtype="https://schema.org/Person"><meta itemprop="name" content="Ravi Thorne"></div>` +
    `<meta itemprop="datePublished" content="2026-07-21">` +
    `<div itemprop="reviewRating" itemscope itemtype="https://schema.org/Rating">` +
    `<meta itemprop="ratingValue" content="4"><meta itemprop="bestRating" content="5"><meta itemprop="worstRating" content="1"></div></div>` +
    (opts.extra ?? "") +
    `</div>`
  );
}

const parseError: Fixture = {
  path: "/authored29a/parse-error",
  category: SCHEMA,
  name: "A JSON-LD block that is not JSON",
  expectedIssues: ["schema.parse-error"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Tide table notes on the fixture site",
      metaDescription: "A page whose only structured data block is cut off halfway through an object.",
      // A trailing comma and a missing brace: what a template with an unescaped
      // quote or a half-finished edit leaves behind.
      headExtra: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Tide table notes",</script>`,
      bodyHtml: healthyBody({
        h1: "Tide table notes for the estuary",
        lede: "The block in this head starts as an Article and stops before it finishes, so no parser can read it.",
        what: "A script element declares JSON-LD and holds an object that opens, names a headline, and then ends at a comma. Browsers ignore it without a word, and so does every visitor.",
        why: "Markup that does not parse is markup nobody reads, and nothing on the page says so. The author sees the script in the source and assumes the work is done, while every consumer of the data sees nothing at all, which is worse than a missing block because it looks like a present one.",
        fix: "Generate the block from data with a serializer rather than assembling it from strings, and run the output through a JSON parser in the build, so a page whose markup cannot be read fails there instead of in search.",
      }),
    })),
};

const unknownType: Fixture = {
  path: "/authored29a/unknown-type",
  category: SCHEMA,
  name: "A type name that is a typo",
  expectedIssues: ["schema.unknown-type"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Harbour stove listing on the fixture site",
      metaDescription: "A page whose JSON-LD names a type that schema.org does not define, one letter transposed.",
      headExtra: jsonLd({ "@type": "Prodcut", name: "Harbour two-ring stove" }),
      bodyHtml: body({
        h1: "Harbour two-ring stove",
        lede: "The markup gives this stove a name and a type, and the type is misspelled.",
        what: "One JSON-LD node, typed Prodcut, carrying a name. The letters c and d changed places somewhere between the template author and the file.",
        why: "A consumer that does not recognise a type has no feature to attach the node to, so it drops the node silently. The page keeps its valid-looking markup and earns nothing from it, and the typo survives because no browser, no linter and no build step looks the name up.",
        fix: "Check type names against the vocabulary when the markup is generated, from a list of the names it defines, and fail the build on one that is not there, so a transposed letter is caught before it ships.",
      }, 'A stove listing is the kind of page where a typed record matters most, since the type is what tells a shop feed that the thing described can be bought and compared.'),
    })),
};

const unknownProperty: Fixture = {
  path: "/authored29a/unknown-property",
  category: SCHEMA,
  name: "Microdata Product with a made-up property",
  expectedIssues: ["schema.unknown-property"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Galley kettle listing on the fixture site",
      metaDescription: "A microdata Product, complete on every field Google reads, plus one property schema.org lacks.",
      bodyHtml: body({
        h1: "Galley whistling kettle",
        lede: "The microdata here is a full product record with a single invented property tucked in among the real ones.",
        what: "A Product written as microdata with a brand, an offer, a rating and a review. One field, the spelling of colour used in British shops, is not the property schema.org defines.",
        why: "The vocabulary says color, and a property it does not define is ignored by everything that reads it. Nothing fails and the value never gets used, so the colour a shopper filters by is missing from the feed while the page looks correct.",
        fix: "Take property names from the vocabulary rather than from the language the shop is written in, and validate generated markup against it so a local spelling is reported where it is introduced.",
        extra: microdataProduct({ extra: `<meta itemprop="colour" content="Slate">` }),
      }, 'Of all the ways markup goes wrong this is the most ordinary: the author knew the field, typed it the way they say it, and nothing anywhere pushed back.'),
    })),
};

const pendingProperty: Fixture = {
  path: "/authored29a/pending-property",
  category: SCHEMA,
  name: "Organization with a property still pending",
  expectedIssues: ["schema.property-pending-or-superseded"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "About the Quay Lane office on the fixture site",
      metaDescription: "A complete Organization that also uses a property schema.org holds as pending.",
      headExtra: jsonLd({
        ...completeOrganization(),
        // `authorizedRepresentative` is in the pending area of schema.org: defined,
        // but not yet stable, and its domain includes Organization.
        authorizedRepresentative: { "@type": "Person", name: "Dana Whitcombe" },
      }),
      bodyHtml: body({
        h1: "The Quay Lane office",
        lede: "This organization record is complete, and one of its fields comes from the part of the vocabulary that is still being settled.",
        what: "An Organization with a name, address, contact details and a logo, plus a pending property naming an authorised representative. The property exists, so it is no error, but it is not final.",
        why: "A pending term can be renamed or dropped in a later release of the vocabulary. Markup that leans on one is a small debt the page owner does not know they have, and the first sign of it is a field that quietly stops being read.",
        fix: "Note which terms in the markup are pending when the template is written, prefer a stable one where it exists, and review the pending ones when the vocabulary publishes a release.",
      }, 'None of that is an error today, and the finding says so in its wording; it is a prompt to look again when the vocabulary next changes, not a defect to fix at once.'),
    })),
};

const typeMismatch: Fixture = {
  path: "/authored29a/type-mismatch",
  category: SCHEMA,
  name: "Book whose author is an Offer",
  expectedIssues: ["schema.embedded-type-mismatch"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Estuary pilot book listing on the fixture site",
      metaDescription: "A Book record whose author field holds a node of a type that an author can never be.",
      // The brief's Recipe cannot carry this case: Recipe is a subtype of HowTo in
      // schema.org, and `schema.deprecated-feature` matches by subtype, so every
      // Recipe also fires it (reported in the task report). Book has no Google
      // profile and no deprecated feature, so the mismatch fires alone.
      headExtra: jsonLd({
        "@type": "Book",
        name: "A pilot book for the Swale and the Medway",
        author: { "@type": "Offer" },
        datePublished: "2026-04-02",
        isbn: "9781234567897",
        inLanguage: "en-GB",
        numberOfPages: 212,
      }),
      bodyHtml: body({
        h1: "A pilot book for the Swale and the Medway",
        lede: "The record names a title, a date and an ISBN, and describes the author as something that is sold rather than someone who writes.",
        what: "A Book block with a title, a publication date, an ISBN, a language and a page count. Its author field holds a node typed Offer, which is a thing a seller puts a price on.",
        why: "A property accepts the types its definition lists, and an Offer is none of them for an author. A reader of the markup cannot tell what was meant, so the field is dropped and the byline never reaches a result, though the page carries one in plain sight.",
        fix: "Build nested nodes from the property that holds them, so the author slot is only ever offered a person or an organisation, and check embedded types against the property's range when the markup is generated.",
      }, "A byline is a small thing to get wrong and a large one to lose, because it is the part of a book listing that tells a reader whose hand wrote the pages."),
    })),
};

const eventNoDate: Fixture = {
  path: "/authored29a/event-no-date",
  category: SCHEMA,
  name: "Event with every field but its start date",
  expectedIssues: ["schema.google-required-missing"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Quayside open evening on the fixture site",
      metaDescription: "An Event with every field Google recommends, and the one it requires left out.",
      headExtra: jsonLd({
        "@type": "Event",
        name: "Quayside open evening",
        // startDate is the field left out, on purpose.
        endDate: "2027-03-12T21:00:00+00:00",
        description: "An evening of demonstrations at the boatshed on the quay.",
        eventStatus: "https://schema.org/EventScheduled",
        image: "https://estuary-supplies.example/img/open-evening.png",
        location: {
          "@type": "Place",
          name: "The Quay Boatshed",
          address: {
            "@type": "PostalAddress",
            streetAddress: "4 Quay Lane",
            addressLocality: "Faversham",
            postalCode: "ME13 7AA",
            addressCountry: "GB",
          },
        },
        offers: {
          "@type": "Offer",
          url: "https://estuary-supplies.example/open-evening",
          price: "0",
          priceCurrency: "GBP",
          availability: "https://schema.org/InStock",
          validFrom: "2027-01-05T09:00:00+00:00",
        },
        organizer: { "@type": "Organization", name: "Estuary Supplies", url: "https://estuary-supplies.example/" },
        performer: { "@type": "Person", name: "Ines Calloway" },
      }),
      bodyHtml: body({
        h1: "Quayside open evening",
        lede: "The event markup is detailed in every respect but the one a calendar result cannot do without.",
        what: "An Event with a name, an end, a venue with a postal address, a free offer, an organiser and a performer. It never says when it begins, and a start is what places an event on a day.",
        why: "A required field that is absent makes the whole block ineligible, however much else it carries. The page looks thoroughly marked up, and the completeness is the trap, since nobody reads a long block hunting for the one line that is not there.",
        fix: "Treat the fields a feature requires as the contract of the template and fail the build when one is empty, rather than leaving a field out when the editor leaves a box blank.",
      }, 'The remaining fields are all there, which is the reason a person scanning the block would pass over it: a long record reads as a finished one.'),
    })),
};

const faq: Fixture = {
  path: "/authored29a/faq",
  category: SCHEMA,
  name: "A valid FAQPage, a withdrawn feature",
  expectedIssues: ["schema.deprecated-feature"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Ferry timetable questions on the fixture site",
      metaDescription: "A well-formed FAQPage with two questions and two answers, for a feature that Google no longer shows.",
      headExtra: jsonLd({
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "Does the ferry run on Sundays?",
            acceptedAnswer: { "@type": "Answer", text: "Yes, from ten in the morning until six in the evening." },
          },
          {
            "@type": "Question",
            name: "Can a bicycle be taken aboard?",
            acceptedAnswer: { "@type": "Answer", text: "Bicycles travel free and are stowed at the stern." },
          },
        ],
      }),
      bodyHtml: body({
        h1: "Ferry timetable questions",
        lede: "The markup on this page is correct in every detail, for a result that search stopped showing.",
        what: "A FAQPage with two questions and two accepted answers, each one valid. There is nothing malformed anywhere in the block, and the block answers the questions the page already prints.",
        why: "A feature that has been withdrawn gives nothing back for the markup written for it. It is worth knowing which pages carry it, since the work was real and its payoff is gone, and the question is whether to keep maintaining the block.",
        fix: "Decide per page whether the markup still earns its upkeep. The answers help readers whatever search does with them, so keep the visible text, and drop the block where nothing else reads it.",
      }, 'Whether to keep it is a judgement for the page owner, which is why the finding is information about the markup rather than an instruction to remove it.'),
    })),
};

// ---------------------------------------------------------------------------
// Clean pages in the other two formats: they must fire nothing.
// ---------------------------------------------------------------------------

const cleanMicrodataProduct: Fixture = {
  path: "/authored29a/clean-microdata-product",
  category: SCHEMA,
  name: "A complete Product in microdata",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Steel galley kettle on the fixture site",
      metaDescription: "A Product written as microdata, complete on every required and recommended field.",
      bodyHtml: body({
        h1: "Two-litre steel galley kettle",
        lede: "The record behind this kettle is written into the page as microdata, and it leaves nothing out.",
        what: "A Product item with an image, a brand, an offer, a rating and a review, each one a nested item with the fields its own profile asks for. It is the same data a script block would carry, in the other notation.",
        why: "A validator that read only script blocks would call this page unmarked and hold it to nothing. The page is the control for the claim that attribute markup is read, judged against the same profiles, and found complete.",
        fix: "Nothing to fix. Keep the properties in the template next to the fields they describe, so the markup changes when the product record does and cannot drift from it.",
        extra: microdataProduct(),
      }, 'There is no finding on this page, and that is the whole claim: the validator read a record written into attributes and found it complete.'),
    })),
};

const cleanRdfaOrganization: Fixture = {
  path: "/authored29a/clean-rdfa-organization",
  category: SCHEMA,
  name: "A complete Organization in RDFa",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Estuary Supplies, who we are, on the fixture site",
      metaDescription: "An Organization written as RDFa Lite, with every field Google recommends for it.",
      bodyHtml: healthyBody({
        h1: "Who Estuary Supplies are",
        lede: "The company record on this page is written as RDFa, attribute by attribute, and is as full as the profile asks.",
        what: "An Organization with a name, a link, a logo, a profile elsewhere, a postal address, a contact point, a phone number, an email and a description. Each one is a property attribute on the element that shows it.",
        why: "RDFa is the notation least likely to be checked, since it hides in ordinary elements. This page shows it is read like the others and found complete, so a site that writes its markup this way is judged on the same terms.",
        fix: "Nothing to fix. Where the markup lives in the visible elements, keep the property attribute on the element that carries the value, so an edit to the text edits the data.",
        extra:
          `<div vocab="https://schema.org/" typeof="Organization">` +
          `<span property="name">Estuary Supplies</span>` +
          `<a property="url" href="https://estuary-supplies.example/">home</a>` +
          `<img property="logo" src="${SHARED_IMAGE_PATH}" alt="Estuary Supplies logo" width="120" height="60">` +
          `<a property="sameAs" href="https://www.example.org/estuary-supplies">profile</a>` +
          `<div property="address" typeof="PostalAddress">` +
          `<span property="streetAddress">4 Quay Lane</span><span property="addressLocality">Faversham</span>` +
          `<span property="postalCode">ME13 7AA</span><span property="addressCountry">GB</span></div>` +
          `<div property="contactPoint" typeof="ContactPoint"><span property="telephone">+44-1795-555-0100</span>` +
          `<span property="contactType">customer service</span></div>` +
          `<span property="telephone">+44-1795-555-0100</span>` +
          `<a property="email" href="mailto:hello@estuary-supplies.example">write to us</a>` +
          `<span property="description">A supplier of camp and galley equipment on the north Kent coast.</span>` +
          `</div>`,
      }),
    })),
};

// ---------------------------------------------------------------------------
// A template: ten pages, one URL shape, nine with a Product and one without.
// ---------------------------------------------------------------------------

interface TemplatePage {
  name: string;
  sku: string;
  gtin13: string;
  mpn: string;
  colour: string;
  size: string;
  material: string;
  pattern: string;
  category: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
  closing: string;
}

/** Ten distinct pages (prose is never templated: near-duplicates would fire). The last carries no Product. */
const TEMPLATE_PAGES: TemplatePage[] = [
  {
    name: "Enamel camp mug", sku: "TPL-001", gtin13: "5012345000011", mpn: "M-001", colour: "Speckled blue", size: "350ml", material: "Enamelled steel", pattern: "Speckle", category: "Drinkware",
    lede: "A mug that has been dropped on slipways and still pours straight.",
    what: "The product record behind this page carries every field the listing needs, and the mug is the first of a catalogue that all follows one layout.",
    why: "Pages made from one layout either all carry their markup or let a few lapse unnoticed. Seeing the first of a run complete says what the rest are supposed to look like.",
    fix: "Generate the block from the catalogue row so the layout cannot ship without it.",
    closing: "Everything on the page reads as it would for a shopper: the name, the photograph, the three short sections, and the figures that sit beside the button. The data in the head says the same things in the form a program reads.",
  },
  {
    name: "Folding galley stool", sku: "TPL-002", gtin13: "5012345000028", mpn: "S-002", colour: "Oak", size: "Compact", material: "Ash and canvas", pattern: "Plain", category: "Furniture",
    lede: "Three legs, one seat, and a place to sit while the kettle thinks about it.",
    what: "A stool whose page uses the same template as its siblings, with the product record rendered once as visible text and once as data for search.",
    why: "A shopper never sees the data half, so its absence is invisible until someone counts. A template is the right place to guarantee it, since one edit reaches every page.",
    fix: "Keep the visible fields and the data fields in one component, so neither is edited without the other.",
    closing: "A seat that folds flat is only useful if the listing says so, and the record carries its size and materials for exactly that reason, so a comparison tool can line it up against the other stools without parsing the sentences above.",
  },
  {
    name: "Tidal chart wallet", sku: "TPL-003", gtin13: "5012345000035", mpn: "C-003", colour: "Yellow", size: "A4", material: "Waterproof vinyl", pattern: "Plain", category: "Navigation",
    lede: "Paper charts survive weather better inside this than they do in a pocket.",
    what: "A wallet listed with a price, a stock state, a rating and a short review, all of it written out the same way as the other pages in the run.",
    why: "When a catalogue grows by adding pages, the early ones set the pattern and the late ones copy it. A late page that skips the data is a template fault, which is a different thing to fix than a page fault.",
    fix: "Treat the group as the unit: audit how many of its pages carry a type before looking at any one.",
    closing: "The wallet is cheap, so the page earns little by itself; its value to the shop is as one more complete member of a run, which is why the run is what gets checked and why this page is a good example of how the others should look.",
  },
  {
    name: "Brass deck torch", sku: "TPL-004", gtin13: "5012345000042", mpn: "T-004", colour: "Brass", size: "18cm", material: "Brass", pattern: "Knurled", category: "Lighting",
    lede: "A torch with a lanyard, a lens that unscrews, and weight enough to be found in the dark.",
    what: "A product page like its neighbours: a headline, a photograph with a description, three short sections, and a data record underneath all of it.",
    why: "Consistency across a family is how search learns which pages are products. A family where nine in ten agree gives a clear signal, and the tenth is the page to look at.",
    fix: "Compare each page to the family it belongs to, and report the ones that differ, with the share that agree.",
    closing: "A torch page tends to be found by people who need one now, and they read the price and the stock state before anything else. Those are the very fields that the offer in the record repeats for the programs that answer them.",
  },
  {
    name: "Rope fender set", sku: "TPL-005", gtin13: "5012345000059", mpn: "F-005", colour: "Natural", size: "Pair", material: "Manila rope", pattern: "Woven", category: "Mooring",
    lede: "Two woven fenders that take the knock so the paintwork does not.",
    what: "Another listing from the same template, with its offer, its rating and a customer review given as nested records inside the main one.",
    why: "Nested records are where hand-written markup most often goes wrong, and generated markup is where it most often goes right. A run of identical shape is evidence of the second.",
    fix: "Share one function between all the pages for the nested pieces, so a fix to a rating reaches the whole run.",
    closing: "The pair is sold as a set, so the record gives one price and one size, and the nested rating and review make the page eligible for the star line, provided every field their profile asks for is present as it is here.",
  },
  {
    name: "Slate cheese board", sku: "TPL-006", gtin13: "5012345000066", mpn: "B-006", colour: "Charcoal", size: "30cm", material: "Welsh slate", pattern: "Bevelled", category: "Tableware",
    lede: "A board for the galley table that doubles as a very small chart table.",
    what: "This page is the sixth of ten, carrying a name, an image, a brand, a price in pounds, and the ratings its section of the catalogue shows.",
    why: "Halfway through a group is a good place to ask whether the pattern still holds. It does here, and a reader checking the family can stop counting pages that agree.",
    fix: "Count per group, not per site, because a site total hides a template that lost its markup.",
    closing: "A slate board is heavy and so it ships slowly, and the page says as much in its lower sections. The record underneath adds the material and the bevel, small facts which a filter on a shopping surface can use.",
  },
  {
    name: "Canvas sail bag", sku: "TPL-007", gtin13: "5012345000073", mpn: "G-007", colour: "Sand", size: "60 litres", material: "Cotton canvas", pattern: "Plain", category: "Storage",
    lede: "A roll-top bag sized for a headsail and the odd forgotten shoe.",
    what: "A seventh page from the same layout, written about a different object with the same structure: product data first, a few short paragraphs second.",
    why: "People edit the visible words and leave the data alone, which is how a page and its markup come to disagree. Generating both from one record prevents that kind of drift outright.",
    fix: "Make the record the source and the page its rendering, and let the data block be a second rendering of the same record.",
    closing: "The bag is sold by volume, and that number is the one a buyer compares, so it sits in the size field and again in the visible text. Two renderings of one value is how a page keeps its promises to both audiences.",
  },
  {
    name: "Pewter hip flask", sku: "TPL-008", gtin13: "5012345000080", mpn: "H-008", colour: "Pewter", size: "170ml", material: "Pewter", pattern: "Engraved", category: "Gifts",
    lede: "A flask with a screw cap on a chain, for when the crossing is long and cold.",
    what: "The eighth listing in the group, where the offer, the rating and the review sit beside the brand and the seller's reference numbers.",
    why: "At eight of ten, the layout has proved it can carry the data every time. What remains is whether the last two do, and a group-level view is how that is learned without opening them.",
    fix: "Run the group check after every deploy, and read its output as a list of pages that left the pattern.",
    closing: "Gifts are bought with a date in mind, which makes availability the field that matters most here. The offer states it plainly, along with the condition and a price good until the end of the next year.",
  },
  {
    name: "Cork chart weights", sku: "TPL-009", gtin13: "5012345000097", mpn: "W-009", colour: "Cork", size: "Set of 4", material: "Cork and lead", pattern: "Plain", category: "Navigation",
    lede: "Four small weights that keep a chart flat in a breeze.",
    what: "Ninth of the ten, and the last one to carry a product record, with the same complete set of fields the earlier pages gave.",
    why: "The pages that agree outnumber the one that does not nine to one, which is the proportion at which the odd one out is more likely a fault than a choice.",
    fix: "Report the odd page by name, with how many of its siblings carry the type, and let the owner decide whether it is a fault.",
    closing: "Small cork weights are the sort of item a shop adds late and tests least, yet the page is built the same way as the dearest listing, because the template does not know which products matter more than others.",
  },
  {
    name: "Spare burner head", sku: "TPL-010", gtin13: "5012345000103", mpn: "B-010", colour: "Grey", size: "Standard", material: "Cast iron", pattern: "Plain", category: "Spares",
    lede: "A replacement head for the two-ring stove, and a page that forgot its data.",
    what: "The tenth page uses the same layout as the other nine and carries no structured data at all, though the text on it is as full as theirs.",
    why: "Nothing is wrong with this page taken alone. Set beside nine siblings that all describe a product, it is the one that does not, and a template that works for most pages and not one is a template with a bug.",
    fix: "Find what differs about this page in the template, such as a branch that skips the data for spares, and restore the record.",
    closing: "The page is complete in every way a reader could check by eye, and that is exactly why the gap is hard to find: nothing looks missing, since the record that is not there was never visible in the first place.",
  },
];

const templateFixtures: Fixture[] = TEMPLATE_PAGES.map((p, i) => {
  const hasProduct = i < TEMPLATE_PAGES.length - 1;
  return {
    path: `/authored29a/tpl/${i + 1}`,
    category: SCHEMA,
    name: hasProduct
      ? `Template page ${i + 1} of 10, with its Product`
      : "Template page 10 of 10, the one without a Product",
    expectedIssues: hasProduct ? [] : ["schema.template-inconsistent"],
    exact: true,
    handler: (req, res) =>
      serve(req, res, () => ({
        title: `${p.name} on the fixture site, page ${i + 1} of the run`,
        metaDescription: `${p.name}: a catalogue page from a run of ten that share one layout and, for nine of them, one Product block.`,
        ...(hasProduct ? { headExtra: jsonLd(completeProduct(p)) } : {}),
        bodyHtml: body({ h1: p.name, lede: p.lede, what: p.what, why: p.why, fix: p.fix },
          `${p.closing} The catalogue files it under ${p.category.toLowerCase()}, describes it as ${p.colour.toLowerCase()} and ${p.material.toLowerCase()}, and sells it in the size ${p.size.toLowerCase()}, so the figures a buyer filters on are written down once for the page and once for the record.`,
        ),
      })),
  };
});

export const authoredP29aFixtures: Fixture[] = [
  parseError,
  unknownType,
  unknownProperty,
  pendingProperty,
  typeMismatch,
  eventNoDate,
  faq,
  cleanMicrodataProduct,
  cleanRdfaOrganization,
  ...templateFixtures,
];
