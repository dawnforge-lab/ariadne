/**
 * The fixture contract: one engineered page, one set of rule ids it must make
 * the engine produce.
 *
 * A fixture is not a unit test. It is a page served over real HTTP, crawled by
 * the real crawler, judged by the real rules, and read back out of the `issues`
 * table — so `expectedIssues` is an end-to-end claim about the whole engine,
 * not about one function.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { absorbedFixtures } from "./pages/absorbed.js";
import { controlFixture } from "./pages/control.js";

export interface Fixture {
  /** Path this fixture is served at, e.g. "/head/missing-title". */
  path: string;
  /** Grouping, for reading a failure quickly. */
  category: string;
  name: string;
  /**
   * Rule ids that MUST fire on this path. Not "the only rules that may fire":
   * a page can trip a rule it was not built for, and the harness asserts
   * containment. The one page that must fire *nothing* is `/control`.
   */
  expectedIssues: string[];
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Every fixture the site serves. Task 9 adds to this collection — the absorbed
 * pages and the control page are what Task 8 put in it.
 */
export function allFixtures(): Fixture[] {
  return [...absorbedFixtures, controlFixture];
}
