/**
 * ONE VALUE, TWO WRITERS, ONE STRING.
 *
 * A findings table is rendered twice from the same evidence: by the CSV writer
 * (`evidenceCell`, src/api/csv.ts) into the file a client downloads, and by the
 * demo page (`valueText`, src/demo/index.html) into the table they are looking
 * at while they click Download. Both docblocks call the other one its twin, and
 * until this file nothing checked the claim — so the twins had already drifted:
 * a scalar array nested inside a column's object joined with `|` in the CSV and
 * with `, ` in the page, because the CSV reached that array through `walk`,
 * which serves the OLDER views and their pipe.
 *
 * ## Why the page's copy is executed rather than read
 *
 * `valueText` is inline JavaScript in a served HTML file: there is no module to
 * import and no browser in this suite. `test/demo/flow.test.ts` asserts the
 * page's CODE PATHS by reading its source, which is right for "does the header
 * come from `columns`" and useless for "what string does this produce". So the
 * four functions are LIFTED OUT OF THE FILE BY NAME (`./lift.ts`, shared with
 * test/demo/metric-number.test.ts) and run here against the same inputs as the
 * TypeScript. The lift is brace-balanced and fails loudly if a function is
 * renamed or removed, which is the only way this test can go stale without
 * going red.
 *
 * ## The one difference that is deliberate
 *
 * The CSV bounds a cell (`EVIDENCE_MAX_LEAVES`, `EVIDENCE_MAX_CELL`,
 * `EVIDENCE_MAX_VALUE`) because a spreadsheet cell cannot grow; the page's
 * table wraps and does not clip. Every case below therefore sits well inside
 * those caps, where the two are required to agree exactly. The caps themselves
 * are `test/api/csv.test.ts`'s to prove.
 */
import { describe, expect, it } from "vitest";

import { evidenceCell } from "../../src/api/csv.js";
import { liftFunctions } from "./lift.js";

const pageValueText = liftFunctions<(value: unknown) => string>(
  ["valueText", "isScalarList", "leaves", "scalarText"],
  "valueText",
);

describe("the CSV cell and the demo cell are the same string", () => {
  /**
   * The battery, each entry a shape a rule actually writes.
   *
   * The nested scalar array (`truncated`-shaped and `chain`-shaped) is the case
   * that used to differ, and it is here twice — once one level down, once two —
   * because the separator was passed down a recursion and a one-level fix would
   * have looked green.
   */
  const cases: Array<[string, unknown]> = [
    ["a missing key", undefined],
    ["a null", null],
    ["a string", "  a   title  with   space "],
    ["a number", 404],
    ["a boolean", false],
    ["an empty array", []],
    ["a scalar array", ["https://site/a", "https://site/b", "https://site/c"]],
    ["a scalar array holding a null", ["a", null, "b"]],
    ["an empty object", {}],
    ["an object of scalars", { total: 12, capped: true }],
    ["an object holding an empty object", { closest: {} }],
    ["an object holding a scalar array", { chain: ["https://a", "https://b"], hops: 2 }],
    [
      "an object holding an object holding a scalar array",
      { truncated: { total: 900, sample: ["x", "y", "z"] } },
    ],
    [
      "an array of objects, one with a scalar array of its own",
      [
        { url: "https://site/a", statuses: [301, 200] },
        { url: "https://site/b", statuses: [404] },
      ],
    ],
    ["an object holding an empty array", { sources: [] }],
    ["an object holding a null", { anchor: null }],
  ];

  for (const [name, value] of cases) {
    it(`renders ${name} identically`, () => {
      expect(pageValueText(value)).toBe(evidenceCell(value));
    });
  }

  // The regression itself, spelled out rather than left implicit in the table
  // above: a comma on BOTH sides, and no pipe anywhere in a report cell.
  it("joins a nested scalar array with a comma on both sides", () => {
    const value = { chain: ["https://a", "https://b"], hops: 2 };
    expect(evidenceCell(value)).toBe("chain=https://a, https://b; hops=2");
    expect(pageValueText(value)).toBe("chain=https://a, https://b; hops=2");
  });
});
